/** Generic host system prompt passthrough (injectSystem: full, default). No role detection. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySystemInjection, capBytes, SYSTEM_OPEN, SYSTEM_UPDATED, SYSTEM_CLOSE } from '../src/system-inject.js'
import { resolveConfig as loadConfig } from '../src/config.js'

const opts = (system, extra = []) => ({ system, messages: [...extra, { role: 'user', content: 'hi' }] })
const run = (sys, mapping, max) => applySystemInjection('USER', opts(sys), mapping, 'full', undefined, max)
// Turn loop that persists the hash like the adapter does (recordTurn).
function session(id) {
  const m = { jiuwenSessionId: id }
  return (sys, max) => { const r = run(sys, m, max); if (r.hash) m.systemHash = r.hash; return r }
}

test('generic profile: plain chat system prompt forwarded once, verbatim, before the user query', () => {
  const turn = session('j1')
  const sys = 'You are a helpful assistant for ACME.\n## Style\nBe brief.'
  const r1 = turn(sys)
  assert.equal(r1.query, `${SYSTEM_OPEN}\n${sys}\n${SYSTEM_CLOSE}\n\nUSER`)
  assert.equal(r1.updated, false)
  assert.equal(turn(sys).query, 'USER') // deduped: not resent
  assert.equal(turn(sys).query, 'USER')
})

test('superagent Router-like prompt: role sections reach Jiuwen unchanged (no special casing)', () => {
  const sys = '# Router\nThe orchestrator decides candidates.\n## dispatch\nRoute with orchestrator_route; kind stop when asked.\n## subscriptions\nA follow_up goes to its worker.'
  const r = session('router')(sys)
  for (const h of ['## dispatch', '## subscriptions', 'orchestrator_route']) assert.ok(r.query.includes(h), h)
})

test('superagent Worker-like prompt: Ticket scope etc. forwarded; separate sessions dedupe independently', () => {
  const sys = 'You are a coding agent.\n## Ticket scope\nSmall local changes.\n## Communication\nReport to the router.'
  const a = session('w1'), b = session('w2')
  assert.match(a(sys).query, /## Ticket scope/)
  assert.match(b(sys).query, /## Ticket scope/) // other Jiuwen session gets its own copy
  assert.equal(a(sys).query, 'USER')
})

test('in-history system/developer message wins over options.system', () => {
  const r = applySystemInjection('USER', opts('old', [{ role: 'developer', content: 'NEW ROLE RULES' }]), { jiuwenSessionId: 'x' }, 'full')
  assert.match(r.query, /NEW ROLE RULES/); assert.doesNotMatch(r.query, /\nold\n/)
})

test('mid-session change: resent once with an explicit replacement marker, then deduped again', () => {
  const turn = session('j2')
  turn('rules v1')
  assert.equal(turn('rules v1').query, 'USER')
  const r = turn('rules v2')
  assert.ok(r.query.startsWith(`${SYSTEM_UPDATED}\nrules v2\n${SYSTEM_CLOSE}`))
  assert.equal(r.updated, true)
  assert.equal(turn('rules v2').query, 'USER')
})

test('oversize: capped to maxBytes with a clear truncation marker; default cap 64 KiB', () => {
  const big = 'x'.repeat(100_000)
  const r = session('big')(big, 4096)
  const body = r.query.slice(SYSTEM_OPEN.length + 1, r.query.indexOf(`\n${SYSTEM_CLOSE}`))
  assert.ok(Buffer.byteLength(body) <= 4096)
  assert.match(body, /\[host system prompt truncated by dsh-jiuwen adapter: kept 4096 of 100000 bytes\]$/)
  assert.ok(Buffer.byteLength(capBytes('é'.repeat(40_000))) <= 64 * 1024)
  assert.equal(capBytes('short', 4096), 'short')
})

test('config: default full + 64 KiB; off/persona and max bytes configurable (raw and env)', () => {
  const d = loadConfig({}, { env: {} })
  assert.equal(d.injectSystem, 'full'); assert.equal(d.injectSystemMaxBytes, 65536)
  assert.equal(loadConfig({ injectSystem: 'off' }, { env: {} }).injectSystem, 'off')
  assert.equal(loadConfig({ injectSystemMaxBytes: 20000 }, { env: {} }).injectSystemMaxBytes, 20000)
  assert.equal(loadConfig({}, { env: { JIUWEN_INJECT_SYSTEM_MAX_BYTES: '9000' } }).injectSystemMaxBytes, 9000)
  assert.equal(loadConfig({ injectSystemMaxBytes: 10 }, { env: {} }).injectSystemMaxBytes, 65536)
  assert.equal(applySystemInjection('USER', opts('rules'), {}, 'off').query, 'USER')
})
