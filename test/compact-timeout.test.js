import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from '../bin/_ws-server.mjs'
import { GatewayTransport, LLM_BACKED_RPCS } from '../src/gateway-transport.js'
import { createJiuwenCommand } from '../src/commands.js'

// Gateway stand-in: acks, then answers each unary method after `delays[method]` ms (default 0).
async function gateway(delays = {}) {
  const port = 20051 + Math.floor(Math.random() * 2000)
  const wss = await WebSocketServer({ port, host: '127.0.0.1' })
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'event', event: 'connection.ack', payload: {} }))
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw))
      setTimeout(() => { try { ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true, payload: { result: `${f.method} done` } })) } catch { /* closed */ } }, delays[f.method] ?? 0)
    })
  })
  return { url: `ws://127.0.0.1:${port}/ws`, close: () => wss.close?.() }
}

test('model-backed unary commands (compact/btw/recap) are the LLM_BACKED_RPCS set', () => {
  assert.deepEqual([...LLM_BACKED_RPCS].sort(), ['command.btw', 'command.compact', 'command.recap'])
})

test('command.compact/btw/recap get one model call budget (requestTimeoutMs); other unary RPCs keep 30 s', async () => {
  const gw = await gateway({ 'command.compact': 300 })
  try {
    const t = new GatewayTransport({ gatewayURL: gw.url, userId: 't', requestTimeoutMs: 180_000 })
    const budgets = {}
    const unary = t._unary.bind(t)
    t._unary = (ws, method, params, ms) => { budgets[method] = ms; return unary(ws, method, params, ms) }
    assert.deepEqual(await t.compact('s1'), { result: 'command.compact done' })
    await t.btw('s1', 'q'); await t.recap('s1'); await t.sessionList()
    await t.rpc('command.compact', {}, { timeoutMs: 5_000 })
    assert.deepEqual(budgets, { 'command.compact': 5_000, 'command.btw': 180_000, 'command.recap': 180_000, 'session.list': 30_000 })
    // a short requestTimeoutMs never shrinks the model-backed budget below the unary default
    const t2 = new GatewayTransport({ gatewayURL: gw.url, userId: 't', requestTimeoutMs: 1_000 })
    const b2 = {}; const u2 = t2._unary.bind(t2); t2._unary = (ws, m, p, ms) => { b2[m] = ms; return u2(ws, m, p, ms) }
    await t2.compact('s1')
    assert.equal(b2['command.compact'], 30_000)
    // an ordinary unary RPC past its budget: TIMEOUT without mayStillComplete
    const gw2 = await gateway({ 'session.list': 500 })
    try {
      const t3 = new GatewayTransport({ gatewayURL: gw2.url, userId: 't', requestTimeoutMs: 10_000 })
      await assert.rejects(t3.rpc('session.list', {}, { timeoutMs: 100 }), e => e.code === 'TIMEOUT' && e.method === 'session.list' && e.mayStillComplete === false)
    } finally { await gw2.close() }
  } finally { await gw.close() }
})

test('a model-backed command past its budget fails as TIMEOUT with mayStillComplete', async () => {
  const gw = await gateway({ 'command.compact': 1_000 })
  try {
    const t = new GatewayTransport({ gatewayURL: gw.url, userId: 't', requestTimeoutMs: 10_000 })
    await assert.rejects(t.rpc('command.compact', { session_id: 's' }, { timeoutMs: 150 }), e => e.code === 'TIMEOUT' && e.mayStillComplete === true && e.timeoutMs === 150 && /command\.compact timed out/.test(e.message))
  } finally { await gw.close() }
})

test('/jiuwen compact: a late Gateway answer is reported as still running, not as an error', async () => {
  const timeout = Object.assign(new Error('RPC command.compact timed out'), { code: 'TIMEOUT', method: 'command.compact', timeoutMs: 180_000, mayStillComplete: true })
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j1' }) }, gateway: () => ({ compact: async () => { throw timeout } }), config: () => ({}) })
  const r = await cmd.definition.handler({ agent: { id: 'd' }, rawInput: 'compact' })
  assert.equal(r.kind, 'success')
  assert.match(r.text, /command\.compact is still running on the Gateway after 180 s/)
  assert.match(r.text, /\/jiuwen status/)
})

test('/jiuwen: an ordinary RPC timeout is still an error with the Gateway hint', async () => {
  const timeout = Object.assign(new Error('RPC session.list timed out'), { code: 'TIMEOUT', method: 'session.list', timeoutMs: 30_000, mayStillComplete: false })
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j1' }) }, gateway: () => ({ sessionList: async () => { throw timeout } }), config: () => ({}) })
  const r = await cmd.definition.handler({ agent: { id: 'd' }, rawInput: 'sessions' })
  assert.equal(r.kind, 'error')
  assert.match(r.text, /Gateway did not answer in time/)
})
