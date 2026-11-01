// Jiuwen submit_goal_report → dsh update_goal, and host-sync not arming Jiuwen's goal when dsh goal tools are routed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGoalBridge } from '../src/goal-bridge.js'
import { installHostSync } from '../src/host-sync.js'
import { SessionStore } from '../src/session-store.js'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
const GOALS = ['get_goal', 'update_goal', 'create_goal']

function bridge({ goal = { id: 'g1', revision: 3, phase: 'active' }, exposed = GOALS, enabled = true } = {}) {
  const calls = []
  const b = createGoalBridge({
    exposed: () => exposed,
    enabled: () => enabled,
    callTool: async (sid, name, args) => { calls.push([sid, name, args]); return name === 'get_goal' ? { isError: false, text: JSON.stringify({ goal }) } : { isError: false, text: '{"ok":true}' } },
  })
  return { b, calls }
}

test('direct submit_goal_report complete → dsh get_goal + update_goal complete (id/revision from dsh)', async () => {
  const { b, calls } = bridge()
  assert.equal(b.observe('s', { type: 'tool_call', name: 'submit_goal_report', id: 't1', arguments: JSON.stringify({ status: 'complete', evidence: 'all tests pass' }) }), undefined)
  const p = b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 't1', result: 'Goal report accepted (status: complete)', success: true })
  assert.ok(p, 'returns a promise the adapter awaits before finish')
  assert.deepEqual(await p, { action: 'complete', goalId: 'g1', isError: false })
  assert.deepEqual(calls.map(c => c[1]), ['get_goal', 'update_goal'])
  assert.deepEqual(calls[1][2], { goal_id: 'g1', revision: 3, action: 'complete' })
})

test('via progressive tool_call{name:submit_goal_report} blocked → update_goal blocked with reason', async () => {
  const { b, calls } = bridge()
  b.observe('s', { type: 'tool_call', name: 'tool_call', id: 't2', arguments: JSON.stringify({ name: 'submit_goal_report', args: { status: 'blocked', remaining_work: 'needs API key from user' } }) })
  await b.observe('s', { type: 'tool_result', name: 'tool_call', id: 't2', result: 'Goal report accepted (status: blocked)' })
  assert.deepEqual(calls[1][2], { goal_id: 'g1', revision: 3, action: 'blocked', blocked_reason: 'needs API key from user' })
})

test('continue / failed / unrelated tool_call / no active goal / goal tools not exposed / disabled → nothing', async () => {
  let r = bridge()
  r.b.observe('s', { type: 'tool_call', name: 'submit_goal_report', id: 'a', arguments: '{"status":"continue"}' })
  assert.equal(r.b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 'a', result: 'Goal report accepted (status: continue)' }), undefined)
  assert.equal(r.b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 'b', result: 'Goal report accepted (status: complete)', success: false }), undefined)
  assert.equal(r.b.observe('s', { type: 'tool_result', name: 'tool_call', id: 'c', result: 'grep: 3 matches' }), undefined)
  assert.equal(r.calls.length, 0)
  r = bridge({ goal: { id: 'g1', revision: 1, phase: 'complete' } })
  assert.deepEqual(await r.b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 'd', result: 'Goal report accepted (status: complete)' }), { skipped: 'phase-complete' })
  assert.deepEqual(r.calls.map(c => c[1]), ['get_goal'])
  r = bridge({ exposed: ['bash', 'read'] })
  assert.deepEqual(await r.b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 'e', result: 'Goal report accepted (status: complete)' }), { skipped: 'goal-tools-not-exposed' })
  r = bridge({ enabled: false })
  assert.equal(r.b.observe('s', { type: 'tool_result', name: 'submit_goal_report', id: 'f', result: 'Goal report accepted (status: complete)' }), undefined)
})

function rig({ cfg = {}, exposed, services = {} } = {}) {
  const listeners = {}
  const calls = []
  const ctx = { on(n, fn) { (listeners[n] ||= []).push(fn); return () => {} } }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'gb-')), 'm.json'))
  const g = { rpc: async (m, p) => { calls.push([m, p]); return {} } }
  const config = () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }], mapJiuwenFsToDsh: true, toolPassthrough: 'mcp', toolAllowlist: ['*'], ...cfg })
  installHostSync({ ctx, config, sessions, gateway: () => g, logger: {}, services: () => services, mcpBridge: { exposed: () => exposed } })
  const fire = (n, ...a) => { for (const fn of listeners[n] || []) fn(...a) }
  return { calls, fire }
}
const jw = (id) => ({ id, header: { config: { provider: 'jiuwen' } } })
const goalCalls = r => r.calls.filter(c => c[0] === 'command.goal').map(c => c[1].action)

test('host-sync: dsh goal tools routed → set/pause/resume not mirrored to Jiuwen; clear still is', async () => {
  const r = rig({ exposed: ['bash', ...GOALS] })
  const goal = { objective: 'Ship it', phase: 'active' }
  r.fire('session/event', jw('g1'), { type: 'goal/change', data: { operation: 'create', goal } })
  r.fire('goal/changed', { agent: { session: jw('g1') }, change: { operation: 'create', goal } })
  await tick()
  assert.deepEqual(goalCalls(r), [])
  r.fire('session/event', jw('g1'), { type: 'goal/change', data: { operation: 'clear' } })
  await tick()
  assert.deepEqual(goalCalls(r), ['clear'])
})

test('host-sync: not routed (hideJiuwenBuiltins off / routing off / update_goal not exposed) → Jiuwen goal armed as before', async () => {
  const goal = { objective: 'Ship it', phase: 'active' }
  for (const opts of [{ cfg: { hideJiuwenBuiltins: 'off' }, exposed: GOALS }, { cfg: { mapJiuwenFsToDsh: false }, exposed: GOALS }, { exposed: ['bash'] }]) {
    const r = rig(opts)
    r.fire('session/event', jw('g2'), { type: 'goal/change', data: { operation: 'create', goal } })
    await tick()
    assert.deepEqual(goalCalls(r), ['set'], JSON.stringify(opts))
  }
  // No turn prepared yet: decided from dsh's registered tools + allowlist.
  const r = rig({ exposed: [], services: { tools: { get: n => (n === 'update_goal' ? { name: n } : undefined) } } })
  r.fire('session/event', jw('g3'), { type: 'goal/change', data: { operation: 'create', goal } })
  await tick()
  assert.deepEqual(goalCalls(r), [])
})
