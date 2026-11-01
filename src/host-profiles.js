/**
 * Optional, user-supplied host prompt knowledge, kept out of the generic path. The adapter ships no
 * host-specific profile. A profile tells it which top-level `# ` sections of a host system prompt are
 * the persona (for injectSystem: 'persona'), where host tooling starts inside them, and which
 * `session/event` types mean "group roster changed" (syncGroup re-injects the persona).
 *
 *   hostProfile: {
 *     personaSections: ['^# Identity$'],              // regex strings (or RegExp), per line
 *     personaStop: ['^## Tool rules$'],               // inside a kept section: drop from here on
 *     personaAlways: [{ match: '^- Be brief\\.$', line: 'Be brief.' }], // append `line` when `match` is in the prompt
 *     groupEvents: ['my-host/group-changed'],
 *   }
 *
 * Default (no hostProfile): no persona sections (persona mode uses the generic dsh persona source)
 * and no group events.
 */
export const NO_PROFILE = Object.freeze({ name: 'none', personaSections: [], personaStop: [], personaAlways: [], groupEvents: [] })

const toRe = (p, flags) => (p instanceof RegExp ? p : new RegExp(String(p), flags))

/** Normalize the `hostProfile` config object; anything else → no profile. */
export function resolveHostProfile(v) {
  if (!v || typeof v !== 'object') return NO_PROFILE
  const arr = (x) => (Array.isArray(x) ? x : [])
  return {
    name: String(v.name || 'custom'),
    personaSections: arr(v.personaSections).map(p => toRe(p)),
    personaStop: arr(v.personaStop).map(p => toRe(p)),
    personaAlways: arr(v.personaAlways).filter(a => a && a.match && a.line).map(a => ({ match: toRe(a.match, 'm'), line: String(a.line) })),
    groupEvents: arr(v.groupEvents).map(String),
  }
}

/** Persona part of a system prompt per `profile` ('' when the profile has no sections or none match). */
export function extractProfilePersona(system, profile) {
  const p = resolveHostProfile(profile)
  if (!p.personaSections.length) return ''
  const parts = []
  let cur = null
  let stopped = false
  const flush = () => { if (cur) { const t = cur.join('\n').trim(); if (t) parts.push(t) } cur = null }
  for (const line of String(system || '').split('\n')) {
    if (/^# /.test(line)) {
      flush(); stopped = false
      if (p.personaSections.some(r => r.test(line))) cur = [line]
      continue
    }
    if (!cur || stopped) continue
    if (p.personaStop.some(r => r.test(line))) { stopped = true; continue }
    cur.push(line)
  }
  flush()
  if (!parts.length) return ''
  for (const a of p.personaAlways) if (a.match.test(system)) parts.push(a.line)
  return parts.join('\n\n')
}
