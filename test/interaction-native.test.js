// Jiuwen interactions follow native dsh semantics under approval policy `never`:
// plan review / SwarmFlow human turns are questions (dsh-user-questions, like dsh's exit_plan_mode),
// tool permission asks go to ctx.approval (rejected under `never`, never fail open).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractor } from '../src/interaction.js'

const agent = { id: 'a' }
const never = () => ({ asked: [], async request(r) { this.asked.push(r); return 'rejected' } })
const uq = (answer) => ({ asked: [], async ask(r) { this.asked.push(r); return typeof answer === 'function' ? answer(r) : answer } })
const make = (svc, cfg = {}) => createInteractor({ config: () => ({ approvalTimeoutMs: 500, questionTimeoutMs: 500, noUiAnswer: 'proceed', ...cfg }), services: () => ({ agents: { get: () => agent }, ...svc }) })
const planPayload = { request_id: 'r1', questions: [{ question: 'Approve the plan?', options: [{ label: 'Execute', value: 'execute' }, { label: 'Reject', value: 'reject' }], card_id: 'c1' }], plan: '# Plan\n1. do it' }

test('plan.approval_required under policy never: asked via user-questions (as native exit_plan_mode), approve → allow', async () => {
  const approval = never(); const q = uq({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  const r = await make({ approval, userQuestions: q })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(r.outcome, 'allowed-once')
  assert.deepEqual(r.answers, [{ selected_options: ['execute'], custom_input: '', card_id: 'c1' }])
  assert.equal(approval.asked.length, 0, 'not routed through ctx.approval')
  assert.equal(q.asked[0].agent, agent)
  assert.equal(q.asked[0].questions[0].detail, '# Plan\n1. do it')
})

test('plan review: keep planning with feedback → reject + feedback; timeout → reject (never fails open)', async () => {
  const fb = await make({ approval: never(), userQuestions: uq({ answers: [{ id: 'plan-review', selected: [], custom: 'add tests first' }] }) })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(fb.outcome, 'rejected')
  assert.deepEqual(fb.answers[0], { selected_options: ['reject'], custom_input: 'add tests first', card_id: 'c1' })
  const slow = await make({ approval: never(), userQuestions: uq(() => new Promise(() => {})) }, { approvalTimeoutMs: 50 })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(slow.outcome, 'timeout'); assert.equal(slow.answers[0].selected_options[0], 'reject')
})

test('plan review without a user-questions channel falls back to ctx.approval (never → rejected)', async () => {
  const approval = never()
  const r = await make({ approval })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(r.outcome, 'rejected'); assert.equal(approval.asked[0].toolName, 'exit_plan_mode')
  // user-questions present but no answerer (throws) → also falls back to ctx.approval
  const a2 = { async request() { return 'allowed-once' } }
  const r2 = await make({ approval: a2, userQuestions: { async ask() { throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' }) } } })({ eventType: 'plan.approval_required', payload: planPayload }, 's')
  assert.equal(r2.outcome, 'allowed-once')
})

test('permission_interrupt (a real tool permission ask) still goes to ctx.approval: rejected under never, even with user-questions', async () => {
  const approval = never(); const q = uq({ answers: [{ selected: ['Approve'] }] })
  const r = await make({ approval, userQuestions: q })({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', request_id: 'p', questions: [{ question: 'run bash?', tool_name: 'bash', options: [{ value: 'allow_once' }, { value: 'reject' }] }] } }, 's')
  assert.equal(r.outcome, 'rejected'); assert.equal(r.answers[0].selected_options[0], 'reject')
  assert.equal(approval.asked[0].toolName, 'bash'); assert.equal(q.asked.length, 0)
  // confirm_interrupt for a named (non-plan) tool is a permission ask too
  const c = await make({ approval: never(), userQuestions: q })({ eventType: 'chat.ask_user_question', payload: { source: 'confirm_interrupt', request_id: 'c', tool_name: 'write_file', questions: [{ question: 'ok?' }] } }, 's')
  assert.equal(c.outcome, 'rejected'); assert.equal(q.asked.length, 0)
})

const swarm = { source: 'swarmflow_human', request_id: 'sw', questions: [{ question: 'Approve the outline?', options: [] }], swarmflow_meta: { run_id: 'r', correlation_id: 'c', agent_name: 'Lead' } }
test('swarmflow_human under policy never: user-questions card (approve / typed reply / reject), not auto-rejected', async () => {
  const approval = never()
  let r = await make({ approval, userQuestions: uq({ answers: [{ id: 'swarmflow-human', selected: ['Approve'] }] }) })({ eventType: 'chat.ask_user_question', payload: swarm }, 's')
  assert.equal(r.answerText, 'approved'); assert.equal(approval.asked.length, 0)
  r = await make({ approval, userQuestions: uq({ answers: [{ id: 'swarmflow-human', selected: [], custom: 'tighten section 2' }] }) })({ eventType: 'chat.ask_user_question', payload: swarm }, 's')
  assert.equal(r.answerText, 'tighten section 2')
  r = await make({ approval, userQuestions: uq({ answers: [{ id: 'swarmflow-human', selected: ['Reject'] }] }) })({ eventType: 'chat.ask_user_question', payload: swarm }, 's')
  assert.match(r.answerText, /^rejected/)
  r = await make({ approval, userQuestions: uq(() => new Promise(() => {})) }, { approvalTimeoutMs: 30 })({ eventType: 'chat.ask_user_question', payload: swarm }, 's')
  assert.equal(r.answerText, 'rejected (timeout)')
  // No user-questions: legacy ctx.approval path (never → rejected).
  r = await make({ approval })({ eventType: 'chat.ask_user_question', payload: swarm }, 's')
  assert.equal(r.answerText, 'rejected (rejected)'); assert.equal(approval.asked.length, 1)
})
