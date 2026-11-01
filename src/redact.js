/**
 * Best-effort masking of credential-looking values in text the adapter forwards to Jiuwen as prompt
 * or tool-result text (host skill bodies/descriptions, the skill loader tool's output). Generic
 * patterns only: it reduces accidental leakage, it is NOT a guarantee. Unknown token formats, values
 * split across lines, or encoded secrets will pass through. Never echoes the value it masks.
 */
const R = '[REDACTED]'
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]
// Authorization headers / bearer tokens: `Authorization: Bearer x`, `Bearer x`, `Basic x`.
const AUTH_HEADER = /\b(Authorization|Proxy-Authorization)(["']?\s*[:=]\s*["']?)(Bearer|Basic|Token|Bot)?(\s*)([^\s"',;]+)/gi
const BEARER = /\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]{6,})/g
// Credentials in URLs: scheme://user:pass@host
const URL_CRED = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@"'`]+):([^\s@/"'`]+)@/gi
// key = value, key: value, "key": "value" (JSON/YAML/env), short values included (>= 3 chars).
const KEY = '[A-Za-z0-9_.-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH[_-]?KEY|CLIENT[_-]?SECRET|SESSION[_-]?KEY|COOKIE)[A-Za-z0-9_.-]*'
const SECRET_ASSIGN = new RegExp(`(["']?)\\b(${KEY})\\1(\\s*[:=]\\s*)(["']?)([^\\s"'\`,;}]{3,})\\4`, 'gi')

const placeholder = (v) => /^\$\{?[A-Za-z_]/.test(v) || /^<.*>$/.test(v) || /^\{\{/.test(v) || /^(true|false|null|none|undefined|required|optional|string|\*+|x+|\.\.\.|REDACTED|\[REDACTED\])$/i.test(v) || v.startsWith(R)

/** Mask credential-looking values (generic, best-effort; never echoes the value). */
export function redactSecrets(text) {
  let out = String(text ?? '')
  for (const re of SECRET_PATTERNS) out = out.replace(re, R)
  out = out.replace(URL_CRED, (m, s, u, p) => (placeholder(p) ? m : `${s}${u}:${R}@`))
  out = out.replace(AUTH_HEADER, (m, k, sep, scheme = '', sp, v) => (placeholder(v) ? m : `${k}${sep}${scheme}${sp}${R}`))
  out = out.replace(BEARER, (m, k, sp, v) => (placeholder(v) ? m : `${k}${sp}${R}`))
  out = out.replace(SECRET_ASSIGN, (m, kq, k, sep, q, v) => (placeholder(v) ? m : `${kq}${k}${kq}${sep}${q}${R}${q}`))
  return out
}
