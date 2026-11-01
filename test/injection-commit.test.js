import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRig } from './helpers/fake-turn.js'

const SYS = '# Rules\nBe terse.\n# Tools\nUse read.'
const sysTurn = (r, id) => r.turn(id, { system: SYS, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'hi' }] })
const injected = (q) => /Be terse/.test(q)

test('injected state is pending until the first Jiuwen event, then committed together', async () => {
  const r = makeRig({ injectSystem: 'full' })
  r.setScript(() => [{ throw: 'send failed' }]) // Jiuwen never accepted the turn
  await sysTurn(r, 's1')
  assert.ok(injected(r.sent[0].query))
  assert.equal(r.sessions.get('s1').systemHash, undefined, 'nothing committed on a failed send')
  r.setScript(() => [{ event: { type: 'text' } }, { throw: 'dropped mid-turn' }])
  await sysTurn(r, 's1')
  assert.ok(injected(r.sent[1].query), 're-sent after the failure')
  assert.ok(r.sessions.get('s1').systemHash, 'committed on first event even if the turn later fails')
  r.setScript(() => [{ event: { type: 'text' } }, { end: { reason: { kind: 'stop' } } }])
  await sysTurn(r, 's1')
  assert.ok(!injected(r.sent[2].query), 'not re-sent once committed')
})

test('hash persistence across an adapter restart (system block not re-sent)', async () => {
  const r = makeRig({ injectSystem: 'full' })
  await sysTurn(r, 'p1')
  assert.ok(injected(r.sent[0].query))
  const h = r.sessions.get('p1').systemHash
  r.restart()
  assert.equal(r.sessions.get('p1').systemHash, h, 'hash reloaded from disk')
  await sysTurn(r, 'p1')
  assert.ok(!injected(r.sent[1].query))
})
