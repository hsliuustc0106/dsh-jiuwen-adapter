/**
 * injectSystem: forward the host system prompt to Jiuwen once per mapped session, as a prefixed block
 * on the query (Jiuwen chat.send has no system/instructions field; params are session_id, query, mode,
 * cwd, project_dir, workspace_dir, trusted_dirs, mcp, ...). Generic: whatever system/developer text the
 * host supplies for the session (any profile, any role) is forwarded verbatim in `full` mode (default);
 * nothing role-specific is detected. Resent only when its hash changes (marked as a replacement).
 * Mid-session updates default to section-level `diff` (safety gates may still send full).
 * Optional hostSystemSectionsAllow / Deny filter sections by heading before hash/diff.
 * Every helper fails soft: on any error the caller sends the plain query (old behaviour).
 */
import { createHash } from 'node:crypto'
import { contentToText } from './messages.js'
import { fsRouteHint } from './fs-route.js'
import { extractProfilePersona } from './host-profiles.js'

export const SYSTEM_OPEN = '[System instructions from host]'
export const SYSTEM_CLOSE = '[/System]'
export const SYSTEM_MAX_BYTES = 64 * 1024
export const SYSTEM_UPDATED = '[System instructions from host — updated; they replace the previous host instructions]'
export const SYSTEM_PARTIAL = '[System instructions from host — partial update; each section below replaces the earlier host section with the same heading, all other host sections stay in force]'

/**
 * Split a prompt into heading-delimited sections (markdown `#`..`###` headings; text before the first
 * heading is the preamble). Keys are the heading line plus an occurrence index, so duplicates stay distinct.
 */
export function splitSections(text) {
  const out = []
  const seen = new Map()
  let cur = { head: '', lines: [] }
  const flush = () => {
    const n = (seen.get(cur.head) || 0) + 1; seen.set(cur.head, n)
    out.push({ key: `${cur.head}#${n}`, head: cur.head, text: cur.lines.join('\n') })
  }
  let fence = null // inside a ``` / ~~~ fenced block: `# comment` lines there are not headings
  for (const line of String(text || '').split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null
      cur.lines.push(line)
      continue
    }
    if (!fence && /^#{1,3} \S/.test(line)) { flush(); cur = { head: line.trim(), lines: [line] } } else cur.lines.push(line)
  }
  flush()
  return out.filter(s => s.head || s.text.trim())
}

/** { key: hash } per section (stored on the mapping; never the text itself). */
/**
 * Filter host system text by markdown heading before inject/hash/diff.
 * `allow` / `deny` are regexes (or strings compiled as RegExp) tested against each section's
 * heading line (`# Title`, `## …`, `### …`). The preamble (text before the first heading) has
 * an empty heading `""`.
 *  - empty allow + empty deny → unchanged (all sections)
 *  - non-empty allow → keep only sections whose heading matches at least one allow pattern
 *  - non-empty deny → drop sections whose heading matches any deny pattern (applied after allow)
 * No built-in denylist. Fenced-code-safe via splitSections.
 */
export function filterHostSystemSections(text, { allow = [], deny = [] } = {}) {
  const toRe = (p) => (p instanceof RegExp ? p : new RegExp(String(p)))
  const allowRe = (Array.isArray(allow) ? allow : []).map(toRe)
  const denyRe = (Array.isArray(deny) ? deny : []).map(toRe)
  if (!allowRe.length && !denyRe.length) return text
  const kept = splitSections(text).filter((s) => {
    if (allowRe.length && !allowRe.some((r) => r.test(s.head))) return false
    if (denyRe.length && denyRe.some((r) => r.test(s.head))) return false
    return true
  })
  return kept.map((s) => s.text).join('\n')
}

export function sectionHashes(text) {
  const m = {}
  for (const s of splitSections(text)) m[s.key] = createHash('sha256').update(s.text).digest('hex').slice(0, 12)
  return m
}

/**
 * Section-level delta between the previously sent prompt (by section hashes) and `text`.
 * Returns undefined when a delta is not safe/useful (no baseline, preamble changed, reordering, or the
 * delta is not clearly smaller than the full prompt).
 */
export function systemDelta(prevHashes, text, maxRatio = 0.6) {
  if (!prevHashes || typeof prevHashes !== 'object' || !Object.keys(prevHashes).length) return undefined
  const secs = splitSections(text)
  const cur = sectionHashes(text)
  const changed = secs.filter(s => prevHashes[s.key] !== cur[s.key])
  const removed = Object.keys(prevHashes).filter(k => !(k in cur))
  if (!changed.length && !removed.length) return undefined
  if (changed.some(s => !s.head)) return undefined // preamble has no heading to anchor a replacement
  const prevOrder = Object.keys(prevHashes).filter(k => k in cur)
  const curOrder = secs.map(s => s.key).filter(k => k in prevHashes)
  if (prevOrder.join('\u0000') !== curOrder.join('\u0000')) return undefined
  const body = [
    ...changed.map(s => s.text.trim()),
    ...(removed.length ? [`Removed host sections (no longer apply): ${removed.map(k => k.replace(/#\d+$/, '')).join('; ')}`] : []),
  ].join('\n\n')
  if (Buffer.byteLength(body) > maxRatio * Buffer.byteLength(text)) return undefined
  return { body, changed: changed.length, removed: removed.length }
}

/** Latest system text: in-history system/developer messages win over options.system. */
export function latestSystemText(options) {
  const msgs = Array.isArray(options?.messages) ? options.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const role = m?.role || (m?.source?.kind === 'system-prompt' ? 'system' : undefined)
    if (role === 'system' || role === 'developer') {
      const t = contentToText(m.content).trim()
      if (t) return t
    }
  }
  return typeof options?.system === 'string' ? options.system.trim() : ''
}

/** Persona sections of `system` per a user-supplied hostProfile (see host-profiles.js); '' without one. */
export function extractPersona(system, profile) {
  return extractProfilePersona(system, profile)
}

/** dsh persona text (from persona-capture), forwarded only when it is literally in the current system prompt. */
export function genericPersona(system, persona) {
  const t = typeof persona === 'string' ? persona.trim() : ''
  if (!t) return ''
  const out = []
  for (const para of t.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    if (!/\{\{[^}]+\}\}/.test(para)) { if (!system.includes(para)) return ''; out.push(para); continue }
    // dsh interpolates section variables ({{model}}, …): forward the rendered text from the prompt.
    const parts = para.split(/\{\{[^}]+\}\}/).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const m = new RegExp(parts.join('([^\\n]{0,200}?)')).exec(system)
    if (!m) return ''
    out.push(m[0])
  }
  return out.join('\n\n')
}

export function capBytes(text, max = SYSTEM_MAX_BYTES) {
  const buf = Buffer.from(text, 'utf8')
  if (!(max > 0) || buf.length <= max) return text
  const marker = `\n…[host system prompt truncated by dsh-jiuwen adapter: kept ${max} of ${buf.length} bytes]`
  const keep = Math.max(0, max - Buffer.byteLength(marker))
  return `${buf.subarray(0, keep).toString('utf8').replace(/\uFFFD+$/, '')}${marker}`
}

export function systemHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * @returns {{ query: string, hash?: string }} query with the block prefixed when it is new for
 * this mapping (hash differs from mapping.systemHash); otherwise the query unchanged.
 */
export function applySystemInjection(query, options, mapping, mode, fallbackPersona, maxBytes = SYSTEM_MAX_BYTES, updateMode = 'diff', hostProfile = undefined, sectionFilter = undefined) {
  try {
    if (mode !== 'persona' && mode !== 'full') return { query }
    const sys = latestSystemText(options)
    if (!sys) return { query }
    // persona: the host profile's persona sections first (hostProfile), else the dsh persona sections, only if present in this prompt.
    let body = mode === 'full' ? sys : extractProfilePersona(sys, hostProfile)
    if (!body && mode === 'persona') body = genericPersona(sys, fallbackPersona)
    if (!body) return { query }
    if (sectionFilter && (sectionFilter.allow?.length || sectionFilter.deny?.length)) {
      body = filterHostSystemSections(body, sectionFilter)
      if (!body.trim()) return { query }
    }
    const capped = capBytes(body, maxBytes)
    const hash = systemHash(`${mapping?.jiuwenSessionId || ''}\n${mode}\n${capped}`)
    if (mapping?.systemHash === hash) return { query }
    const sections = sectionHashes(capped)
    if (mapping?.systemHash && updateMode === 'diff') {
      const d = systemDelta(mapping.systemSections, capped)
      if (d) return { query: `${SYSTEM_PARTIAL}\n${d.body}\n${SYSTEM_CLOSE}\n\n${query}`, hash, sections, updated: true, delta: true, bytes: Buffer.byteLength(d.body), fullBytes: Buffer.byteLength(capped) }
    }
    const open = mapping?.systemHash ? SYSTEM_UPDATED : SYSTEM_OPEN
    return { query: `${open}\n${capped}\n${SYSTEM_CLOSE}\n\n${query}`, hash, sections, updated: Boolean(mapping?.systemHash), bytes: Buffer.byteLength(capped) }
  } catch {
    return { query }
  }
}

/** Append the FS-routing hint once per mapped session when mapJiuwenFsToDsh is on. */
export function applyFsRouteInjection(query, mapping, enabled, serverName) {
  try {
    if (!enabled) return { query }
    const hint = fsRouteHint(serverName)
    const hash = systemHash(`fs-route:${mapping?.jiuwenSessionId || ''}\n${hint}`)
    if (mapping?.fsRouteHash === hash) return { query }
    return { query: `${hint}\n\n${query}`, hash }
  } catch {
    return { query }
  }
}

