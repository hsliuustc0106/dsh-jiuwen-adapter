/**
 * Interrupt-on-busy (onBusyMessage): a new host user message on a session whose Jiuwen turn is
 * running → chat.interrupt, settle, coalesce queued messages into one step, resend with a note.
 * Unit (registry) + mock gateway (bin/mock-gateway.mjs) coverage.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startMock, makeHost } from './helpers/mock-host.js'
import { createBusyRegistry, interruptNote, isUserMessage } from '../src/busy-interrupt.js'
import { INTERRUPTED_MARK } from '../src/gateway-transport.js'
import { resolveConfig } from '../src/config.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

const sleep = ms => new Promise(r => setTimeout(r, ms))
const txt = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const user = t => [{ role: 'user', content: t }]
const LONG = 'slow ' + 'x'.repeat(300) // mock streams 20 chars / 300 ms → ~5 s turn

function fakeInbox() {
  const lists = { 'next-turn': [], 'next-step': [] }
  return {
    lists,
    get nextTurn() { return lists['next-turn'] },
    get nextStep() { return lists['next-step'] },
    splice(target, start, del, ins) { return lists[target].splice(start, del, ...ins) },
  }
}
function setup(config = {}, services = {}) {
  const listeners = {}
  const traceFile = join(mock.dir, `trace-${Math.random()}.jsonl`)
  const h = makeHost(mock, { traceFile, postCancelSettleMs: 400, ...config }, { listeners, services })
  const send = (agent, message = { source: { kind: 'user' }, content: [{ type: 'text', text: 'new' }] }) => {
    for (const fn of listeners['agent/inbox/inserted'] || []) fn({ agent, message })
  }
  const trace = () => { try { return readFileSync(traceFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
  return { h, send, trace, listeners }
}

test('config: onBusyMessage defaults to interrupt; env JIUWEN_ON_BUSY_MESSAGE overrides; invalid → default', () => {
  assert.equal(resolveConfig({}, { env: {} }).onBusyMessage, 'interrupt')
  assert.equal(resolveConfig({ onBusyMessage: 'queue' }, { env: {} }).onBusyMessage, 'queue')
  assert.equal(resolveConfig({ onBusyMessage: 'interrupt' }, { env: { JIUWEN_ON_BUSY_MESSAGE: 'queue' } }).onBusyMessage, 'queue')
  assert.equal(resolveConfig({ onBusyMessage: 'bogus' }, { env: {} }).onBusyMessage, 'interrupt')
  assert.equal(resolveConfig({}, { env: {} }).interruptSettleMs, 8000)
  assert.equal(resolveConfig({}, { env: { JIUWEN_INTERRUPT_SETTLE_MS: '1234' } }).interruptSettleMs, 1234)
})

test('registry unit: idle/queue/ignored/coalesced/deferred/question, settle promotes next-turn → next-step, note once', () => {
  let mode = 'interrupt'
  const inbox = fakeInbox()
  const recs = []
  const reg = createBusyRegistry({ config: () => ({ onBusyMessage: mode }), agentFor: () => ({ inbox }), trace: r => recs.push(r) })
  const u = { source: { kind: 'user' } }
  assert.equal(reg.noteMessage('a', u), 'idle')
  const st = reg.begin('a')
  let fired = 0
  st.attach(() => fired++)
  assert.equal(reg.noteMessage('a', { source: { kind: 'user-question-reply' } }), 'ignored')
  assert.equal(reg.noteMessage('a', { source: { kind: 'runtime-context' } }), 'ignored')
  mode = 'queue'
  assert.equal(reg.noteMessage('a', u), 'queue')
  mode = 'interrupt'
  assert.equal(reg.noteMessage('a', u), 'interrupt')
  assert.equal(reg.noteMessage('a', u), 'coalesced')
  assert.equal(reg.noteMessage('a', u), 'coalesced')
  assert.equal(fired, 1, 'one chat.interrupt per turn')
  inbox.lists['next-turn'].push({ id: 1 }, { id: 2 }, { id: 3 })
  st.settled({ by: 'interrupt_result' })
  assert.deepEqual(inbox.nextStep.map(m => m.id), [1, 2, 3])
  assert.equal(inbox.nextTurn.length, 0)
  st.end()
  assert.equal(reg.isBusy('a'), false)
  const note = reg.takeNote('a')
  assert.match(note, /interrupted/); assert.match(note, /3 new messages/); assert.match(note, /NOT rolled back/)
  assert.equal(reg.takeNote('a'), undefined)
  assert.ok(recs.some(r => r.at === 'turn-interrupt' && r.phase === 'settled' && r.promoted === 3))
  // attach after the request still fires (message raced the chat.send)
  const st2 = reg.begin('b'); assert.equal(reg.noteMessage('b', u), 'interrupt'); let f2 = 0; st2.attach(() => f2++); assert.equal(f2, 1)
  // approval pending → deferred; question pending → left to interaction.js
  const st3 = reg.begin('c'); reg.setAwaiting('c', 'approval'); assert.equal(reg.noteMessage('c', u), 'deferred'); st3.end()
  const st4 = reg.begin('d'); reg.setAwaiting('d', 'question'); assert.equal(reg.noteMessage('d', u), 'question'); st4.end()
  assert.equal(isUserMessage({ content: 'x' }), true)
  // Plugin relays of a person's message interrupt; automation / injected notices do not.
  assert.equal(isUserMessage({ role: 'user', source: { kind: 'some-im-bridge', form: 'relay' } }), true)
  assert.equal(isUserMessage({ role: 'user', source: { kind: 'some-im-bridge', form: 'notice', summary: 'job ended' } }), false)
  for (const kind of ['schedule', 'goal', 'subagent-settled', 'agent-message', 'user-question-reply']) assert.equal(isUserMessage({ source: { kind } }), false, kind)
  assert.equal(isUserMessage({ source: { kind: 'x' } }, ['x']), false, 'busyIgnoreSources override')
  assert.match(interruptNote(1), /a new message/)
})

test('mock gateway: new user message interrupts the running Jiuwen turn, ends stop, resend carries the note', async () => {
  const agent = { id: 'bi-1', inbox: fakeInbox() }
  const { h, send, trace } = setup({}, { agents: { get: id => (id === 'bi-1' ? agent : undefined) } })
  const t0 = Date.now()
  setTimeout(() => { agent.inbox.lists['next-turn'].push({ id: 'm1' }); send(agent) }, 700)
  const cs = await h.run({ sessionId: 'bi-1', messages: user(LONG) })
  const took = Date.now() - t0
  assert.equal(cs.at(-1).type, 'finish'); assert.equal(cs.at(-1).reason.kind, 'stop')
  assert.ok(txt(cs).endsWith(INTERRUPTED_MARK), txt(cs))
  assert.ok(took < 3500, `interrupted early (${took} ms)`)
  assert.deepEqual(agent.inbox.nextStep.map(m => m.id), ['m1'], 'queued message moved to the step boundary')
  const jw = h.api.jiuwenSessionId('bi-1')
  const st = await mock.rpc('debug.state')
  assert.equal(st.interrupts.filter(p => p.session_id === jw && p.intent === 'cancel').length, 1)
  // Host loop's next step: history + new user message → Jiuwen gets the note + the new text only.
  const cs2 = await h.run({ sessionId: 'bi-1', messages: [...user(LONG), { role: 'assistant', content: txt(cs) }, ...user('ping change of plan')] })
  assert.equal(cs2.at(-1).reason.kind, 'stop')
  const hist = (await mock.rpc('debug.state')).history[jw]
  const lastUser = hist.filter(m => m.role === 'user').at(-1).content
  assert.match(lastUser, /previous turn was interrupted/)
  assert.match(lastUser, /NOT rolled back/)
  assert.match(lastUser, /ping change of plan$/)
  assert.doesNotMatch(lastUser, /xxxxxxxx/, 'old request not resent')
  const tr = trace()
  assert.ok(tr.some(r => r.at === 'turn-interrupt' && r.phase === 'requested'))
  assert.ok(tr.some(r => r.at === 'turn-interrupt' && r.phase === 'settled' && r.settledBy === 'interrupt_result'))
  assert.ok(tr.some(r => r.at === 'turn-interrupt' && r.phase === 'resend'))
  assert.ok(tr.some(r => r.at === 'turn-end' && r.interrupted === true))
  // Note is consumed once: a third turn has no note.
  await h.run({ sessionId: 'bi-1', messages: [...user('a'), { role: 'assistant', content: 'b' }, ...user('ping again')] })
  const hist3 = (await mock.rpc('debug.state')).history[jw]
  assert.doesNotMatch(hist3.filter(m => m.role === 'user').at(-1).content, /interrupted/)
})

test('mock gateway: several messages during the interrupt coalesce into one interrupt + one resend step', async () => {
  const agent = { id: 'bi-2', inbox: fakeInbox() }
  const { h, send, trace } = setup({}, { agents: { get: () => agent } })
  // A burst: three messages land before the interrupt settles (queued follow-ups + one steer).
  setTimeout(() => {
    agent.inbox.lists['next-turn'].push({ id: 'a' }); send(agent)
    agent.inbox.lists['next-turn'].push({ id: 'b' }); send(agent)
    agent.inbox.lists['next-step'].push({ id: 's' }); send(agent)
  }, 600)
  const cs = await h.run({ sessionId: 'bi-2', messages: user(LONG) })
  assert.equal(cs.at(-1).reason.kind, 'stop')
  const jw = h.api.jiuwenSessionId('bi-2')
  assert.equal((await mock.rpc('debug.state')).interrupts.filter(p => p.session_id === jw).length, 1)
  assert.deepEqual(agent.inbox.nextStep.map(m => m.id), ['s', 'a', 'b'], 'all pending input in one step, order kept')
  assert.equal(agent.inbox.nextTurn.length, 0)
  const settled = trace().find(r => r.phase === 'settled')
  assert.equal(settled.messages, 3); assert.equal(settled.promoted, 2)
  assert.equal(trace().filter(r => r.phase === 'coalesced').length, 2)
  const cs2 = await h.run({ sessionId: 'bi-2', messages: [...user(LONG), { role: 'assistant', content: txt(cs) }, ...user('ping one'), ...user('ping two'), ...user('ping three')] })
  assert.equal(cs2.at(-1).reason.kind, 'stop')
  const lastUser = (await mock.rpc('debug.state')).history[jw].filter(m => m.role === 'user').at(-1).content
  assert.match(lastUser, /3 new messages/)
  assert.match(lastUser, /ping one\n\nping two\n\nping three$/)
})

test("mock gateway: onBusyMessage='queue' keeps the old behaviour (no interrupt, full answer, no note)", async () => {
  const agent = { id: 'bq', inbox: fakeInbox() }
  const { h, send, trace } = setup({ onBusyMessage: 'queue' }, { agents: { get: () => agent } })
  setTimeout(() => { agent.inbox.lists['next-turn'].push({ id: 'q' }); send(agent) }, 500)
  const q = 'slow ' + 'q'.repeat(60)
  const cs = await h.run({ sessionId: 'bq', messages: user(q) })
  assert.equal(cs.at(-1).reason.kind, 'stop')
  assert.ok(!txt(cs).includes(INTERRUPTED_MARK))
  assert.match(txt(cs), /qqqqqqqqqq/)
  const jw = h.api.jiuwenSessionId('bq')
  assert.equal((await mock.rpc('debug.state')).interrupts.filter(p => p.session_id === jw).length, 0)
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), ['q'], 'host inbox untouched')
  assert.ok(!trace().some(r => r.at === 'turn-interrupt'))
})

test('mock gateway: approval pending → interrupt deferred until the card resolves, then interrupts', async () => {
  const agent = { id: 'ba', inbox: fakeInbox() }
  let resolvedAt = 0
  const approval = { request: () => new Promise(r => setTimeout(() => { resolvedAt = Date.now(); r('allowed-once') }, 900)) }
  const { h, send, trace } = setup({}, { agents: { get: () => agent }, approval })
  setTimeout(() => send(agent), 300) // arrives while the approval card is open
  const cs = await h.run({ sessionId: 'ba', messages: user('need permission') })
  assert.equal(cs.at(-1).reason.kind, 'stop')
  const tr = trace()
  const req = tr.find(r => r.at === 'turn-interrupt' && r.phase !== 'settled')
  assert.equal(req.phase, 'deferred'); assert.equal(req.awaiting, 'approval')
  const st = await mock.rpc('debug.state')
  assert.ok(st.answers.some(a => a.source === 'permission_interrupt'), 'the approval answer still reached Jiuwen (not auto-rejected)')
  assert.ok(resolvedAt > 0)
  const settled = tr.find(r => r.phase === 'settled')
  assert.ok(settled, 'deferred interrupt fired after the approval')
  assert.ok(Date.parse(settled.t) >= resolvedAt - 5, 'interrupt only after the approval resolved')
})

test('mock gateway: host stop during the interrupt settle wins (aborted, no note)', async () => {
  const agent = { id: 'bs', inbox: fakeInbox() }
  const { h, send } = setup({ interruptSettleMs: 5000 }, { agents: { get: () => agent } })
  const ac = new AbortController()
  // swarm-run never finishes nor answers the interrupt, so the settle wait is long enough to abort into.
  setTimeout(() => send(agent), 300)
  setTimeout(() => ac.abort(), 700)
  const cs = await h.run({ sessionId: 'bs', signal: ac.signal, messages: user('swarm-run go') })
  assert.equal(cs.at(-1).reason.kind, 'aborted')
  await h.run({ sessionId: 'bs', messages: [...user('x'), { role: 'assistant', content: 'y' }, ...user('ping after stop')] })
  const jw = h.api.jiuwenSessionId('bs')
  const lastUser = (await mock.rpc('debug.state')).history[jw].filter(m => m.role === 'user').at(-1).content
  assert.doesNotMatch(lastUser, /interrupted/)
})

test('mock gateway: aux calls (compaction/title) and non-user inbox events never interrupt', async () => {
  const agent = { id: 'bx', inbox: fakeInbox() }
  const { h, send } = setup({}, { agents: { get: () => agent } })
  setTimeout(() => send(agent, { source: { kind: 'runtime-context' } }), 400)
  const cs = await h.run({ sessionId: 'bx', messages: user('slow ' + 'z'.repeat(40)) })
  assert.ok(!txt(cs).includes(INTERRUPTED_MARK))
  const c = await h.run({ sessionId: 'bx', purpose: 'compaction', messages: [...user('a'), { role: 'assistant', content: 'b' }, ...user('summarize')] })
  assert.equal(c.at(-1).reason.kind, 'stop')
  const jw = h.api.jiuwenSessionId('bx')
  assert.equal((await mock.rpc('debug.state')).interrupts.filter(p => p.session_id === jw).length, 0)
})

test('mock gateway: a message during the resend\'s post-cancel settle → resend not sent; its text is carried into the next resend (live plain-dsh fix)', async () => {
  const agent = { id: 'bi-carry', inbox: fakeInbox() }
  const { h, send, trace } = setup({}, { agents: { get: () => agent } })
  setTimeout(() => send(agent), 700)
  const cs1 = await h.run({ sessionId: 'bi-carry', messages: user(LONG) })
  assert.ok(txt(cs1).endsWith(INTERRUPTED_MARK))
  const jw = h.api.jiuwenSessionId('bi-carry')
  const sends0 = ((await mock.rpc('debug.state')).history[jw] || []).filter(m => m.role === 'user').length
  // The resend step (message B) starts; message C lands while the transport still waits out the post-cancel settle.
  setTimeout(() => send(agent), 150)
  const hist1 = [...user(LONG), { role: 'assistant', content: txt(cs1) }]
  const cs2 = await h.run({ sessionId: 'bi-carry', messages: [...hist1, ...user('MSG-B do this instead')] })
  assert.equal(cs2.at(-1).reason.kind, 'stop')
  assert.equal(txt(cs2), INTERRUPTED_MARK)
  let users = ((await mock.rpc('debug.state')).history[jw] || []).filter(m => m.role === 'user')
  assert.equal(users.length, sends0, 'B was not sent to Jiuwen (send-then-cancel would drop it unrecorded)')
  // Next step: the host's trailing user message is C only; Jiuwen must still get B.
  await h.run({ sessionId: 'bi-carry', messages: [...hist1, ...user('MSG-B do this instead'), { role: 'assistant', content: txt(cs2) }, ...user('MSG-C and this too')] })
  users = ((await mock.rpc('debug.state')).history[jw] || []).filter(m => m.role === 'user')
  const last = users.at(-1).content
  assert.match(last, /2 new messages/)
  assert.match(last, /not seen by you yet/)
  assert.ok(last.indexOf('MSG-B') > 0 && last.indexOf('MSG-B') < last.indexOf('MSG-C'), last)
  assert.equal((last.match(/previous turn was interrupted/g) || []).length, 1, 'one note, B carried without its own note')
  const tr = trace()
  assert.ok(tr.some(r => r.at === 'turn-interrupt' && r.phase === 'settled' && r.settledBy === 'before-send' && r.carried > 0))
  // consumed once
  await h.run({ sessionId: 'bi-carry', messages: [...user('x'), { role: 'assistant', content: 'y' }, ...user('MSG-D')] })
  assert.doesNotMatch(((await mock.rpc('debug.state')).history[jw] || []).filter(m => m.role === 'user').at(-1).content, /interrupted|MSG-B/)
})
