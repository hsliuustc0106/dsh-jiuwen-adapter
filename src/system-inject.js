/**
 * injectSystem: forward the host system prompt to Jiuwen once per mapped session, as a prefixed block
 * on the query (Jiuwen chat.send has no system/instructions field; params are session_id, query, mode,
 * cwd, project_dir, workspace_dir, trusted_dirs, mcp, ...). Generic: whatever system/developer text the
 * host supplies for the session (any profile, any role) is forwarded verbatim in `full` mode (default);
 * nothing role-specific is detected. Resent only when its hash changes (marked as a replacement).
 * Every helper fails soft: on any error the caller sends the plain query (old behaviour).
 */
import { createHash } from 'node:crypto'
import { contentToText } from './messages.js'
import { fsRouteHint } from './fs-route.js'

export const SYSTEM_OPEN = '[System instructions from host]'
export const SYSTEM_CLOSE = '[/System]'
export const SYSTEM_MAX_BYTES = 64 * 1024
export const SYSTEM_UPDATED = '[System instructions from host — updated; they replace the previous host instructions]'

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

// FlyBot top-level sections we keep for 'persona' (core/src/host/prompt.js, groups.js).
const PERSONA_H1 = [/^# Your identity\s*$/, /^# This group chat\s*$/]
// FlyBot team/tool rules inside the identity section: everything from here on is host tooling.
const IDENTITY_STOP = /^## (How your Bot team works|You are the Main Bot)\s*$/
const LANGUAGE_LINE = /^- Reply in the user's language\.\s*$/m

/** Persona/instructions/group/language part of a FlyBot system prompt ('' when no markers found). */
export function extractPersona(system) {
  const lines = String(system || '').split('\n')
  const parts = []
  let cur = null
  const flush = () => { if (cur) { const t = cur.join('\n').trim(); if (t) parts.push(t) } cur = null }
  let stopped = false
  for (const line of lines) {
    if (/^# /.test(line)) {
      flush(); stopped = false
      if (PERSONA_H1.some(r => r.test(line))) cur = [line]
      continue
    }
    if (!cur || stopped) continue
    if (IDENTITY_STOP.test(line)) { stopped = true; continue }
    cur.push(line)
  }
  flush()
  if (!parts.length) return ''
  if (LANGUAGE_LINE.test(system)) parts.push("Reply in the user's language.")
  return parts.join('\n\n')
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
export function applySystemInjection(query, options, mapping, mode, fallbackPersona, maxBytes = SYSTEM_MAX_BYTES) {
  try {
    if (mode !== 'persona' && mode !== 'full') return { query }
    const sys = latestSystemText(options)
    if (!sys) return { query }
    // persona: FlyBot markers first (unchanged); else the dsh persona sections, only if present in this prompt.
    let body = mode === 'full' ? sys : extractPersona(sys)
    if (!body && mode === 'persona') body = genericPersona(sys, fallbackPersona)
    if (!body) return { query }
    const capped = capBytes(body, maxBytes)
    const hash = systemHash(`${mapping?.jiuwenSessionId || ''}\n${mode}\n${capped}`)
    if (mapping?.systemHash === hash) return { query }
    const open = mapping?.systemHash ? SYSTEM_UPDATED : SYSTEM_OPEN
    return { query: `${open}\n${capped}\n${SYSTEM_CLOSE}\n\n${query}`, hash, updated: Boolean(mapping?.systemHash), bytes: Buffer.byteLength(capped) }
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
