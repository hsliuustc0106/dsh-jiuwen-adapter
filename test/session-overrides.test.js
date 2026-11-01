import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSessionOverride } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { makeRig } from './helpers/fake-turn.js'

test('matchSessionOverride: preset glob preferred, match legacy, all set keys must match', () => {
  const list = resolveConfig({ sessionOverrides: [{ preset: 'review*', modelName: 'm1' }, { preset: 'coder', match: 'a-*', chatMode: 'plan' }, { match: 'w-*', modelName: 'm3' }, { modelName: 'nokey' }] }, { env: {} }).sessionOverrides
  assert.equal(list.length, 3, 'entries without preset/match are dropped')
  assert.equal(matchSessionOverride(list, 'x', 'reviewer').modelName, 'm1')
  assert.equal(matchSessionOverride(list, 'b-1', 'coder'), undefined)
  assert.equal(matchSessionOverride(list, 'a-1', 'coder').chatMode, 'plan')
  assert.equal(matchSessionOverride(list, 'w-1', undefined).modelName, 'm3')
  assert.equal(matchSessionOverride(list, 'z', undefined), undefined)
})

test('integration: sessionOverrides precedence request > catalog > /jiuwen mode > override > default', async () => {
  const raw = { chatMode: 'agent', models: [{ id: 'jiuwen-default', name: 'd' }, { id: 'cat', name: 'c', chatMode: 'team', modelName: 'catm' }], sessionOverrides: [{ preset: 'fast*', modelName: 'ovm', chatMode: 'plan', agentTemplateName: 'ovt' }] }
  const r = makeRig(raw, { profileFor: (id) => (id.startsWith('p') ? 'fast-worker' : 'other') })
  await r.turn('p1')
  assert.equal(r.sent[0].overrides.modelName, 'ovm', 'override beats plugin default')
  assert.equal(r.sent[0].overrides.chatMode, 'plan')
  assert.equal(r.sent[0].overrides.agentTemplateName, 'ovt')
  await r.turn('p2', { model: 'cat' })
  assert.equal(r.sent[1].overrides.chatMode, 'team', 'catalog beats override')
  assert.equal(r.sent[1].overrides.modelName, 'catm')
  await r.turn('p3', { providerOptions: { jiuwen: { chatMode: 'agent', modelName: 'req' } } })
  assert.equal(r.sent[2].overrides.chatMode, 'agent', 'request beats override')
  assert.equal(r.sent[2].overrides.modelName, 'req')
  r.sessions.update('p4', { chatMode: 'team', modelName: 'mine' })
  await r.turn('p4')
  assert.equal(r.sent[3].overrides.chatMode, 'team', '/jiuwen mode beats override')
  assert.equal(r.sent[3].overrides.modelName, 'mine')
  await r.turn('q1')
  assert.equal(r.sent[4].overrides.modelName, undefined, 'non-matching profile untouched')
  assert.equal(r.sent[4].overrides.chatMode, 'agent')
})
