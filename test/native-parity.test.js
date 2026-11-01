// Jiuwen-side behaviour matches native dsh: no adapter-own timeouts/gates on top of dsh's pipeline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createMcpBridge, sessionMcpName, isProxyConnected, proxyRegistration, mcpCallTimeoutMs } from '../src/mcp-bridge.js'
import { createInteractor, isDshPassthroughTool } from '../src/interaction.js'
import { resolveConfig } from '../src/config.js'
import { installHostSync } from '../src/host-sync.js'
import { SessionStore } from '../src/session-store.js'
import { handle as proxyHandle } from '../bin/jiuwen-mcp-proxy.mjs'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

test('defaults: no adapter approval / call timeout (native has none); transport budget 1 h; caps widen it', () => {
  const c = resolveConfig({}, { env: {} })
  assert.equal(c.approvalTimeoutMs, 0)
  assert.equal(c.toolCallTimeoutMs, 0)
  assert.equal(mcpCallTimeoutMs(c), 3_600_000)
  assert.equal(mcpCallTimeoutMs({ toolCallTimeoutMs: 60_000, approvalTimeoutMs: 30_000 }), 95_000)
  assert.equal(mcpCallTimeoutMs({ toolCallTimeoutMs: 60_000, approvalTimeoutMs: 30_000, toolApproval: 'none' }), 65_000)
  assert.equal(mcpCallTimeoutMs({ mcpCallTimeoutMs: 42_000 }), 42_000)
  assert.equal(resolveConfig({ approvalTimeoutMs: 5000, toolCallTimeoutMs: 7000 }, { env: {} }).approvalTimeoutMs, 5000)
})

test('a changed call budget re-registers the proxy (old records kept timeout_s 120)', () => {
  const reg = proxyRegistration('dsh-tools-0123456789abcdef', '/x', 3_600_000)
  assert.equal(isProxyConnected({ ...reg, state: 'connected', timeout_s: 120 }, reg), false)
  assert.equal(isProxyConnected({ ...reg, state: 'connected' }, reg), true)
  const { timeout_s, ...noTimeout } = reg
  assert.equal(isProxyConnected({ ...noTimeout, state: 'connected' }, reg), true, 'record without timeout_s: unchanged behaviour')
  assert.equal(timeout_s, 3600)
})

function rig(cfg = {}, svc = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jw-parity-'))
  const c = { toolAllowlist: ['*'], toolApproval: 'host', mcpServerName: 'dsh-tools', mcpStateDir: join(dir, 'state'), jiuwenMcpStateFile: join(dir, 'jw.json'), mcpGcOnStart: false, ...cfg }
  const b = createMcpBridge({ config: () => c, services: () => svc, rpc: async () => ({}) })
  return { b, c, dir }
}

test('host mode: no adapter abort by default; the dsh turn signal cancels the call like a native one', async () => {
  const agent = { id: 's1' }
  let seen
  const tools = {
    get: () => ({ name: 'bash' }),
    execute: async (exec) => {
      seen = exec
      await new Promise((resolve) => { const t = setTimeout(resolve, 150); exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) })
      return exec.signal.aborted ? { isError: true, content: [{ type: 'text', text: 'Error: ABORTED' }] } : { isError: false, content: [{ type: 'text', text: 'done' }] }
    },
  }
  const { b } = rig({}, { tools, agents: { get: () => agent } })
  const turn = new AbortController()
  await b.prepare([{ name: 'bash' }], 's1', { signal: turn.signal })
  let r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.isError, false); assert.equal(r.result.content[0].text, 'done')
  assert.equal(seen.agent, agent)
  const p = b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  await tick(20); turn.abort()
  r = await p
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /ABORTED/)
  await b.dispose()
})

test('admission: tools admitted in an earlier turn (or published to Jiuwen) stay callable; dsh registry decides', async () => {
  const ran = []
  const tools = { get: () => ({}), execute: async (exec) => { ran.push(exec.name); return { isError: false, content: [{ type: 'text', text: `ran ${exec.name}` }] } } }
  const { b, c } = rig({}, { tools, agents: { get: () => ({ id: 's2' }) } })
  await b.prepare([{ name: 'read' }, { name: 'web_fetch' }], 's2')
  await b.prepare([{ name: 'read' }], 's2') // web_fetch not in this request (e.g. turn-scoped catalog)
  let r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_fetch', arguments: {} } }, 's2')
  assert.equal(r.result.isError, false, r.result.content[0].text)
  await b.prepare([], 's2') // host-sync ensure-proxy call keeps everything
  r = await b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's2')
  assert.equal(r.result.isError, false)
  // endpoint advertises the union + the call budget the proxy should wait for
  const key = sessionMcpName('dsh-tools', 's2').slice('dsh-tools-'.length)
  const ep = JSON.parse(readFileSync(join(c.mcpStateDir, 's', key, `ep-${process.pid}.json`), 'utf8'))
  assert.deepEqual(ep.tools.sort(), ['read', 'web_fetch'])
  assert.equal(ep.callTimeoutMs, 3_600_000)
  await b.dispose()
  // A new process (fresh bridge) that has only seen `read` still serves `web_fetch` from schemas.json.
  const b2 = createMcpBridge({ config: () => c, services: () => ({ tools, agents: { get: () => ({ id: 's2' }) } }), rpc: async () => ({}) })
  await b2.prepare([{ name: 'read' }], 's2')
  r = await b2._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_fetch', arguments: {} } }, 's2')
  assert.equal(r.result.isError, false)
  // ...but not when the current allowlist excludes it.
  c.toolAllowlist = ['read']
  r = await b2._handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, 's2')
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /not exposed/)
  await b2.dispose()
})

test('proxy waits for the budget the dsh process advertises (not a fixed 600 s / 120 s)', async () => {
  const srv = createServer((req, res) => { setTimeout(() => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'slow ok' }] } })), 150) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'jw-proxy-'))
  const ep = { pid: process.pid, url: `http://127.0.0.1:${srv.address().port}/`, token: 't', ts: Date.now(), tools: ['bash'] }
  writeFileSync(join(dir, `ep-${process.pid}.json`), JSON.stringify({ ...ep, callTimeoutMs: 50 }))
  let r = await proxyHandle(dir, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash' } })
  assert.equal(r.result.isError, true, 'advertised 50 ms budget applies')
  writeFileSync(join(dir, `ep-${process.pid}.json`), JSON.stringify({ ...ep, callTimeoutMs: 5000 }))
  r = await proxyHandle(dir, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash' } })
  assert.equal(r.result.content[0].text, 'slow ok')
  srv.close()
})

const never = () => { const asked = []; return { asked, request: async (q) => { asked.push(q); return 'rejected' } } }
const interactor = (cfg, svc) => createInteractor({ config: () => ({ approvalTimeoutMs: 0, questionTimeoutMs: 0, noUiAnswer: 'x', mcpServerName: 'dsh-tools', ...cfg }), services: () => svc })

test('Jiuwen permission ask about a dsh passthrough tool is delegated to dsh (no second gate under never)', async () => {
  assert.equal(isDshPassthroughTool('mcp_dsh-tools-0123456789abcdef_bash'), true)
  assert.equal(isDshPassthroughTool('mcp_dsh-tools_read'), true)
  assert.equal(isDshPassthroughTool('mcp_amap_search'), false)
  assert.equal(isDshPassthroughTool('bash'), false)
  const ask = (tool) => ({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', request_id: 'p', questions: [{ question: `run ${tool}?`, tool_name: tool, options: [{ value: 'allow_once' }, { value: 'reject' }] }] } })
  let approval = never()
  let r = await interactor({ toolApproval: 'host' }, { approval, agents: { get: () => ({ id: 's' }) } })(ask('mcp_dsh-tools-0123456789abcdef_bash'), 's')
  assert.equal(r.outcome, 'delegated'); assert.equal(r.answers[0].selected_options[0], 'allow_once'); assert.equal(approval.asked.length, 0)
  // A foreign MCP tool / Jiuwen builtin is a real ask → ctx.approval (rejected under never).
  r = await interactor({ toolApproval: 'host' }, { approval, agents: { get: () => ({ id: 's' }) } })(ask('mcp_amap_search'), 's')
  assert.equal(r.outcome, 'rejected'); assert.equal(approval.asked.length, 1)
  // toolApproval 'none' runs definitions directly (no dsh gate): never delegate there.
  approval = never()
  r = await interactor({ toolApproval: 'none' }, { approval, agents: { get: () => ({ id: 's' }) } })(ask('mcp_dsh-tools_bash'), 's')
  assert.equal(r.outcome, 'rejected'); assert.equal(approval.asked.length, 1)
})

test('approval wait has no adapter timeout by default; the turn signal still withdraws it', async () => {
  let resolveAsk
  const approval = { request: (q) => new Promise((resolve) => { resolveAsk = resolve; q.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true }) }) }
  const ac = new AbortController()
  const p = interactor({}, { approval, agents: { get: () => ({ id: 's' }) } })({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', questions: [{ question: 'q', tool_name: 'bash' }] }, signal: ac.signal }, 's')
  await tick(60)
  resolveAsk('allowed-once')
  const r = await p
  assert.equal(r.outcome, 'allowed-once')
})

test('permission presets do not re-allow Jiuwen builtins that mapJiuwenFsToDsh routes through dsh', async () => {
  const calls = []
  const handlers = new Map()
  const ctx = { on: (n, fn) => { handlers.set(n, [...(handlers.get(n) || []), fn]); return () => {} }, get: () => undefined }
  const dir = mkdtempSync(join(tmpdir(), 'jw-preset-')); mkdirSync(dir, { recursive: true })
  const sessions = new SessionStore(join(dir, 'm.json'))
  const g = { rpc: async (m, p) => { calls.push([m, p]); return {} } }
  const run = async (cfg) => {
    calls.length = 0
    handlers.clear()
    installHostSync({ ctx, config: () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }], ...cfg }), sessions, gateway: () => g, logger: {}, services: () => ({}) })
    const s = { id: `p-${String(cfg.mapJiuwenFsToDsh)}`, header: { config: { provider: 'jiuwen' } } }
    for (const fn of handlers.get('session/event') || []) fn(s, { type: 'permission/preset', data: { preset: 'workspace-write' } })
    await tick()
    for (const fn of handlers.get('session/event') || []) fn(s, { type: 'permission/preset', data: { preset: 'full-access' } })
    await tick()
    return calls.filter(c => c[0] === 'permissions.tools.update').map(c => c[1].tool)
  }
  assert.deepEqual(await run({ mapJiuwenFsToDsh: true, toolPassthrough: 'mcp' }), [], 'routed builtins stay denied')
  assert.deepEqual(await run({ mapJiuwenFsToDsh: false, toolPassthrough: 'mcp' }), ['bash', 'write_file', 'edit_file'], 'unrouted: preset still mirrors')
})
