// Regression: plain-dsh's "permissions restored" check compared the post-release Jiuwen state with the raw state
// before the dsh process started. An earlier process in the same suite (routing on) had left adapter-owned
// subagent_spawn/task_tool denies, which the release correctly removed → false FAIL (pjwfirst, 2026-11-01 guard).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permBaseline } from './live/perm-baseline.mjs'

const ledger = tools => ({ version: 1, targets: { 'ws://127.0.0.1:19000/ws': { tools } } })

test('perm baseline: adapter-owned entries left by an earlier process count at their prior', () => {
  const before = { tools: { acp_chat: 'ask', bash: 'deny', subagent_spawn: 'deny', task_tool: 'deny' } }
  const L = ledger({
    subagent_spawn: { level: 'deny', prior: null, owner: 'route' },
    task_tool: { level: 'deny', prior: null, owner: 'route' },
  })
  assert.deepEqual(permBaseline(before, L), { tools: { acp_chat: 'ask', bash: 'deny' } })
})

test('perm baseline: prior level restored; a value changed outside the adapter is left as is', () => {
  const before = { tools: { bash: 'deny', write_file: 'allow' }, other: 1 }
  const L = ledger({ bash: { level: 'deny', prior: 'ask' }, write_file: { level: 'deny', prior: 'ask' } })
  assert.deepEqual(permBaseline(before, L), { tools: { bash: 'ask', write_file: 'allow' }, other: 1 })
})

test('perm baseline: no ledger / no state → unchanged', () => {
  const before = { tools: { bash: 'allow' } }
  assert.deepEqual(permBaseline(before, null), before)
  assert.equal(permBaseline(null, ledger({})), null)
})
