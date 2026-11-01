// An approval / plan-review card the adapter stops waiting for (approvalTimeoutMs) is withdrawn on
// the dsh side: the host request's signal aborts, so dsh-user-approval records approval/decided
// (cancelled) instead of leaving approval/asked open with the card still shown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractor } from '../src/interaction.js'

const agent = { id: 'a' }
const make = (svc, cfg = {}) => createInteractor({ config: () => ({ approvalTimeoutMs: 50, questionTimeoutMs: 500, noUiAnswer: 'proceed', ...cfg }), services: () => ({ agents: { get: () => agent }, ...svc }) })
// a host request that only settles when its signal aborts (like dsh-user-approval waiting for a click)
const pending = (log) => (r) => new Promise((resolve) => { r.signal.addEventListener('abort', () => { log.push('aborted'); resolve('cancelled') }, { once: true }) })
const permPayload = { request_id: 'r1', source: 'permission_interrupt', questions: [{ tool_name: 'read_file', question: 'read /x/.plans/p.md' }] }
const planPayload = { request_id: 'r2', questions: [{ question: 'Approve the plan?', card_id: 'c1' }], plan: '# Plan' }

test('Jiuwen permission ask: timeout denies and withdraws the host approval request', async () => {
  const log = []
  const approval = { request: pending(log) }
  const r = await make({ approval })({ eventType: 'chat.ask_user_question', payload: permPayload }, 's')
  assert.equal(r.outcome, 'timeout')
  assert.equal(r.answers[0].selected_options[0] === 'allow_once', false)
  await new Promise(res => setImmediate(res))
  assert.deepEqual(log, ['aborted'])
})

test('plan review card: timeout rejects and withdraws the question card', async () => {
  const log = []
  const userQuestions = { ask: pending(log) }
  const r = await make({ approval: { async request() { return 'rejected' } }, userQuestions })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(r.outcome, 'timeout')
  await new Promise(res => setImmediate(res))
  assert.deepEqual(log, ['aborted'])
})

test('an answered approval is not aborted; the turn signal still cancels a pending one', async () => {
  const log = []
  const ok = await make({ approval: { async request(r) { r.signal.addEventListener('abort', () => log.push('aborted')); return 'allowed-once' } } })({ eventType: 'chat.ask_user_question', payload: permPayload }, 's')
  assert.equal(ok.outcome, 'allowed-once'); assert.deepEqual(log, [])
  const ac = new AbortController(); const log2 = []
  const p = make({ approval: { request: pending(log2) } }, { approvalTimeoutMs: 0 })({ eventType: 'chat.ask_user_question', payload: permPayload, signal: ac.signal }, 's', ac.signal)
  setTimeout(() => ac.abort(), 20)
  await p
  assert.deepEqual(log2, ['aborted'])
})
