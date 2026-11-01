/**
 * Host-specific prompt knowledge, kept out of the generic path. A profile tells the adapter which
 * top-level sections of a host system prompt are the persona (for injectSystem: 'persona'), where
 * host tooling starts inside them, and which session events mean "group roster changed".
 *
 * Select with `hostProfile: 'flybot' | 'none'` (default 'none'), or pass a custom object:
 *   { personaSections: ['^# Your identity$'], personaStop: ['^## Tools$'], personaAlways: [{ match: '...', line: '...' }], groupEvents: ['group/members'] }
 * Patterns are regex strings (or RegExp) matched per line.
 */
export const HOST_PROFILES = Object.freeze({
  none: Object.freeze({ name: 'none', personaSections: [], personaStop: [], personaAlways: [], groupEvents: ['group/members'] }),
  // FlyBot core/src/host/prompt.js, groups.js
  flybot: Object.freeze({
    name: 'flybot',
    personaSections: [/^# Your identity\s*$/, /^# This group chat\s*$/],
    personaStop: [/^## (How your Bot team works|You are the Main Bot)\s*$/],
    personaAlways: [{ match: /^- Reply in the user's language\.\s*$/m, line: "Reply in the user's language." }],
    groupEvents: ['plugin:group', 'group/members', 'ds-bot/group'],
  }),
})

const toRe = (p, flags) => (p instanceof RegExp ? p : new RegExp(String(p), flags))

/** Resolve `hostProfile` config (name or object) to a normalized profile; unknown names → none. */
export function resolveHostProfile(v) {
  if (v && typeof v === 'object') {
    const arr = (x) => (Array.isArray(x) ? x : [])
    return {
      name: String(v.name || 'custom'),
      personaSections: arr(v.personaSections).map(p => toRe(p)),
      personaStop: arr(v.personaStop).map(p => toRe(p)),
      personaAlways: arr(v.personaAlways).filter(a => a && a.match && a.line).map(a => ({ match: toRe(a.match, 'm'), line: String(a.line) })),
      groupEvents: Array.isArray(v.groupEvents) ? v.groupEvents.map(String) : HOST_PROFILES.none.groupEvents,
    }
  }
  return HOST_PROFILES[String(v || 'none')] || HOST_PROFILES.none
}

/** Persona part of a system prompt per `profile` ('' when the profile has no sections or none match). */
export function extractProfilePersona(system, profile = HOST_PROFILES.none) {
  const p = resolveHostProfile(profile)
  if (!p.personaSections.length) return ''
  const lines = String(system || '').split('\n')
  const parts = []
  let cur = null
  let stopped = false
  const flush = () => { if (cur) { const t = cur.join('\n').trim(); if (t) parts.push(t) } cur = null }
  for (const line of lines) {
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
