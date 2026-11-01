import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRig } from './helpers/fake-turn.js'
import { SKILL_INDEX_OPEN, SKILL_BODY_OPEN } from '../src/host-sync.js'

const bridgeWith = (exposed) => ({ prepare: async () => ({ mcpServerName: 'dsh-tools' }), exposed: () => exposed })
const tools = [{ name: 'bash' }, { name: 'skill' }]
const SK = [{ name: 'deploy', content: 'Step 1 secret apiKey: abc12345', description: 'Deploy things' }]

test('integration: index-mode skills → index when the loader is passed through; index-only (no body dump) otherwise', async () => {
  const withLoader = makeRig({ toolPassthrough: 'mcp', hostSkillInject: 'index' }, { mcpBridge: bridgeWith(['bash', 'skill']) })
  withLoader.sessions.update('a', { skillBodies: SK })
  await withLoader.turn('a', { tools })
  const q = withLoader.sent[0].query
  assert.ok(q.includes(SKILL_INDEX_OPEN) && q.includes('mcp_dsh-tools_skill') && q.includes('Deploy things'))
  assert.ok(!q.includes('Step 1'), 'no body in index mode')
  const warns = []
  const noLoader = makeRig({ toolPassthrough: 'mcp', hostSkillInject: 'index' }, { mcpBridge: bridgeWith(['bash']), logger: { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} } })
  noLoader.sessions.update('b', { skillBodies: SK })
  await noLoader.turn('b', { tools })
  const q2 = noLoader.sent[0].query
  assert.ok(q2.includes(SKILL_INDEX_OPEN) && q2.includes('Deploy things'), 'stays index-only')
  assert.ok(!q2.includes(SKILL_BODY_OPEN) && !q2.includes('Step 1'), 'no silent body fallback')
  assert.ok(warns.some((w) => /index-only|skill loader/i.test(String(w))), 'warns clearly')
})

test('integration: skill injection hash persists across restart; re-sent only when the set changes', async () => {
  const r = makeRig({ toolPassthrough: 'mcp', hostSkillInject: 'index' }, { mcpBridge: bridgeWith(['bash', 'skill']) })
  r.sessions.update('s', { skillBodies: SK })
  await r.turn('s', { tools })
  assert.ok(r.sent[0].query.includes(SKILL_INDEX_OPEN))
  r.restart()
  await r.turn('s', { tools })
  assert.ok(!r.sent[1].query.includes(SKILL_INDEX_OPEN), 'not re-sent after restart')
  r.sessions.update('s', { skillBodies: [...SK, { name: 'lint', content: 'Run lint', description: 'Lint' }] })
  await r.turn('s', { tools })
  assert.ok(r.sent[2].query.includes('lint'))
})

test('integration: interrupted turn → resend carries the note once, injected state committed by the first event', async () => {
  let pending = { note: '[previous turn interrupted]', count: 1 }
  const busy = {
    takeResend: () => { const r = pending; pending = undefined; return r },
    begin: () => ({ attach() {}, settled() {}, end() {} }),
    clearNote() {},
    setAwaiting() {},
  }
  const r = makeRig({ injectSystem: 'full', onBusyMessage: 'interrupt' }, { busy })
  const SYS = '# Rules\nBe terse.'
  r.setScript(() => [{ event: { type: 'text' } }, { end: { reason: { kind: 'stop' } } }])
  await r.turn('i', { system: SYS })
  assert.ok(r.sent[0].query.startsWith('[previous turn interrupted]') || r.sent[0].query.includes('[previous turn interrupted]'))
  assert.ok(r.sent[0].query.includes('Be terse'))
  await r.turn('i', { system: SYS })
  assert.ok(!r.sent[1].query.includes('[previous turn interrupted]'), 'note only once')
  assert.ok(!r.sent[1].query.includes('Be terse'), 'system committed on the interrupted turn, not re-sent')
})
