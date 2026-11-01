// AgentServer's own end-of-run status ({is_processing:false}, is_complete only on the envelope) must
// end the dsh turn even without a closing chat.final (seen after schedule_create: Jiuwen idle, dsh
// never got the assistant message / turn end until requestTimeoutMs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from '../bin/_ws-server.mjs'
import { GatewayTransport } from '../src/gateway-transport.js'

const ev = (event, payload = {}) => JSON.stringify({ type: 'event', event, payload: { event_type: event, ...payload } })
async function server(script) {
  const wss = await WebSocketServer({ port: 0, host: '127.0.0.1' })
  const port = wss.port
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    ws.send(JSON.stringify({ type: 'event', event: 'connection.ack', payload: {} }))
    ws.on('message', (raw) => { let f; try { f = JSON.parse(String(raw)) } catch { return } if (f.method === 'chat.send') script(ws, f) })
  })
  return { url: `ws://127.0.0.1:${port}/ws`, close: () => wss.close?.() }
}
async function collect(url) {
  const t = new GatewayTransport({ gatewayURL: url, userId: 't', requestTimeoutMs: 8000, finalGraceMs: 50, terminalFinalGraceMs: 80 })
  const chunks = []
  const t0 = Date.now()
  for await (const c of t.stream({ provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: 'remind me' }] }, { jiuwenSessionId: 's1' })) chunks.push(c)
  return { ms: Date.now() - t0, text: chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), last: chunks.at(-1) }
}

test('processing_status {is_processing:false} without is_complete ends the turn (no chat.final)', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.processing_status', { is_processing: true, request_id: f.id }))
    ws.send(ev('chat.tool_call', { tool_call: { name: 'schedule_create', id: 'c1', arguments: '{}' }, request_id: f.id }))
    ws.send(ev('chat.tool_result', { tool_name: 'schedule_create', tool_call_id: 'c1', result: 'ok', request_id: f.id }))
    ws.send(ev('chat.delta', { content: 'Reminder set.', request_id: f.id }))
    setTimeout(() => ws.send(ev('chat.processing_status', { is_processing: false, request_id: f.id })), 30)
  })
  try {
    const r = await collect(s.url)
    assert.equal(r.last.type, 'finish')
    assert.equal(r.last.reason?.kind, 'stop')
    assert.match(r.text, /Reminder set\./)
    assert.ok(r.ms < 3000, `ended promptly (${r.ms} ms), not at requestTimeoutMs`)
  } finally { await s.close() }
})

test('frames after the idle status keep the turn open (grace), so a late answer is not cut off', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.processing_status', { is_processing: false, request_id: f.id }))
    setTimeout(() => ws.send(ev('chat.delta', { content: 'late ', request_id: f.id })), 20)
    setTimeout(() => ws.send(ev('chat.final', { content: 'late answer', request_id: f.id })), 50)
  })
  try {
    const r = await collect(s.url)
    assert.equal(r.last.type, 'finish')
    assert.match(r.text, /late answer|late /)
  } finally { await s.close() }
})

// Live regression (guard-live 2026-11-01, be6b36a): every turn opens a fresh socket, and the Gateway
// delivers the PREVIOUS turn's late terminal status of the same session on it right after chat.send
// ({is_processing:false, is_complete:true, request_id:<previous turn>}). It must not end this turn.
const STALE = { is_processing: false, is_complete: true, request_id: 'dsh-previous-turn', session_id: 's1' }

test('previous turn\'s late status on the new socket does not end the turn (no empty reply)', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.processing_status', STALE))
    setTimeout(() => ws.send(ev('chat.processing_status', { is_processing: true, request_id: f.id })), 40)
    setTimeout(() => ws.send(ev('chat.delta', { content: 'turn two answer', request_id: f.id })), 300)
    setTimeout(() => ws.send(ev('chat.processing_status', { is_processing: false, request_id: f.id })), 340)
  })
  try {
    const r = await collect(s.url)
    assert.equal(r.last.reason?.kind, 'stop')
    assert.match(r.text, /turn two answer/)
  } finally { await s.close() }
})

test('a foreign is_complete after this turn streamed text does not cut it short', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.delta', { content: 'part one, ', request_id: f.id }))
    setTimeout(() => ws.send(ev('chat.processing_status', STALE)), 20)
    setTimeout(() => ws.send(ev('chat.delta', { content: 'part two', request_id: f.id })), 250)
    setTimeout(() => ws.send(ev('chat.processing_status', { is_processing: false, is_complete: true, request_id: f.id })), 280)
  })
  try {
    const r = await collect(s.url)
    assert.equal(r.text, 'part one, part two')
  } finally { await s.close() }
})

test('a mid-turn drop after a foreign idle status still fails soft with an error finish (not an empty stop)', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.processing_status', STALE))
    ws.send(ev('chat.processing_status', { is_processing: true, request_id: f.id }))
    setTimeout(() => ws.terminate?.() ?? ws.close(), 60)
  })
  try {
    const t = new GatewayTransport({ gatewayURL: s.url, userId: 't', requestTimeoutMs: 8000, finalGraceMs: 50, terminalFinalGraceMs: 80, recoverOnDrop: false })
    const chunks = []
    for await (const c of t.stream({ provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: 'x' }] }, { jiuwenSessionId: 's1' })) chunks.push(c)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason?.kind, 'error')
  } finally { await s.close() }
})

test('the answered ask_user request id counts as this turn (typed answer resumes it)', async () => {
  const s = await server((ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.delta', { content: 'resumed answer', request_id: 'dsh-question-turn' }))
    setTimeout(() => ws.send(ev('chat.processing_status', { is_processing: false, request_id: 'dsh-question-turn' })), 20)
  })
  try {
    const t = new GatewayTransport({ gatewayURL: s.url, userId: 't', requestTimeoutMs: 3000, finalGraceMs: 50, terminalFinalGraceMs: 80 })
    const mapping = { jiuwenSessionId: 's1', pendingQuestion: { payload: { source: 'ask_user_interrupt', request_id: 'dsh-question-turn', questions: [{}] } } }
    const chunks = []; const t0 = Date.now()
    for await (const c of t.stream({ provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: 'blue' }] }, mapping)) chunks.push(c)
    assert.equal(chunks.at(-1).reason?.kind, 'stop')
    assert.ok(Date.now() - t0 < 2500, 'ended on its own status, not at requestTimeoutMs')
  } finally { await s.close() }
})
