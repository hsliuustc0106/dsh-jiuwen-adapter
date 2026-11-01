import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpBridge, sessionMcpName, proxyRegistration, mcpCallTimeoutMs, schemasRev } from '../src/mcp-bridge.js'
import { auxSessionId } from '../src/adapter.js'
import { denyJiuwenSideEffectTools, resetSentPermissions } from '../src/fs-route.js'

const tmp = mkdtempSync(join(tmpdir(), 'jw-hyg-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
let n = 0
function bridge(cfg = {}, rpcImpl) {
  const dir = join(tmp, `b${n++}`)
  const calls = []
  const c = { toolAllowlist: ['*'], toolApproval: 'none', toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools', mcpStateDir: join(dir, 'state'), jiuwenMcpStateFile: join(dir, 'jw.json'), mcpGcOnStart: false, ...cfg }
  const b = createMcpBridge({ config: () => c, services: () => ({}), rpc: async (m, p) => { calls.push([m, p]); return rpcImpl ? rpcImpl(m, p) : {} } })
  mkdirSync(dir, { recursive: true })
  return { b, calls, c, dir }
}
const tools = [{ name: 'read', description: 'r' }, { name: 'bash', description: 'b' }]
const markConnected = (c, sid) => {
  const name = sessionMcpName('dsh-tools', sid)
  const stateDir = join(c.mcpStateDir, 's', name.slice(10))
  let rev
  try { rev = schemasRev(JSON.parse(readFileSync(join(stateDir, 'schemas.json'), 'utf8'))) } catch { /* no union yet */ }
  const reg = proxyRegistration(name, stateDir, mcpCallTimeoutMs(c), rev)
  writeFileSync(c.jiuwenMcpStateFile, JSON.stringify({ mcp: { [name]: { ...reg, state: 'connected' } } }))
}

test('item1: idle TTL releases the per-session proxy (disconnect + delete_custom)', async () => {
  const { b, calls } = bridge({ mcpSessionIdleMs: 50 })
  const r = await b.prepare(tools, 'idle-s')
  assert.deepEqual(await b.sweepIdle(Date.now()), [], 'fresh session is kept')
  const out = await b.sweepIdle(Date.now() + 1000)
  assert.equal(out.length, 1)
  assert.ok(calls.some(c => c[0] === 'mcp.delete_custom' && c[1].name === r.mcpServerName))
  assert.deepEqual(b.exposed('idle-s'), [])
  await b.dispose()
})

test('item1: idle TTL 0 disables the sweep', async () => {
  const { b, calls } = bridge({ mcpSessionIdleMs: 0 })
  await b.prepare(tools, 'keep')
  assert.deepEqual(await b.sweepIdle(Date.now() + 1e9), [])
  assert.ok(!calls.some(c => c[0] === 'mcp.delete_custom'))
  await b.dispose()
})

test('item1: release keeps the registration when another live process serves the session', async () => {
  const { b, calls, c } = bridge()
  const r = await b.prepare(tools, 'shared')
  const dir = join(c.mcpStateDir, 's', r.mcpServerName.slice(10))
  writeFileSync(join(dir, `ep-${process.ppid}.json`), JSON.stringify({ pid: process.ppid, tools: [] }))
  const out = await b.releaseSession('shared')
  assert.equal(out.shared, true)
  assert.ok(!calls.some(x => x[0] === 'mcp.delete_custom'))
  assert.ok(existsSync(dir))
  await b.dispose()
})

test('item1: startup GC deletes only stale, local, unowned dsh-tools-<sha16> servers', async () => {
  const { b, calls, c } = bridge({ mcpGcOnStart: true, mcpGcGraceMs: 1000 }, (m) => m === 'mcp.list'
    ? { items: [{ name: 'dsh-tools-aaaaaaaaaaaaaaaa' }, { name: 'dsh-tools-bbbbbbbbbbbbbbbb' }, { name: 'dsh-tools-cccccccccccccccc' }, { name: 'dsh-tools-dddddddddddddddd' }, { name: 'other-server' }, { name: 'dsh-tools' }] }
    : {})
  const sdir = (k) => join(c.mcpStateDir, 's', k.repeat(16))
  const old = (Date.now() - 3600_000) / 1000
  for (const k of ['a', 'b', 'd']) { mkdirSync(sdir(k), { recursive: true }); utimesSync(sdir(k), old, old) }
  writeFileSync(join(sdir('b'), `ep-${process.ppid}.json`), JSON.stringify({ pid: process.ppid })); utimesSync(sdir('b'), old, old) // live owner
  writeFileSync(join(sdir('d'), 'ep-999999.json'), JSON.stringify({ pid: 999999 })); utimesSync(sdir('d'), old, old) // dead owner
  // c: no local state dir → not ours → untouched
  const r = await b.gcStale()
  assert.deepEqual(r.removed.sort(), ['dsh-tools-aaaaaaaaaaaaaaaa', 'dsh-tools-dddddddddddddddd'])
  const deleted = calls.filter(x => x[0] === 'mcp.delete_custom').map(x => x[1].name).sort()
  assert.deepEqual(deleted, r.removed.sort())
  assert.ok(!existsSync(sdir('a')) && existsSync(sdir('b')))
  await b.dispose()
})

test('item1: GC respects the grace window and mcpGcOnStart:false', async () => {
  const list = () => ({ items: [{ name: 'dsh-tools-eeeeeeeeeeeeeeee' }] })
  const { b, c } = bridge({ mcpGcOnStart: true, mcpGcGraceMs: 60_000 }, (m) => (m === 'mcp.list' ? list() : {}))
  mkdirSync(join(c.mcpStateDir, 's', 'e'.repeat(16)), { recursive: true })
  assert.deepEqual((await b.gcStale()).removed, [])
  const off = bridge({ mcpGcOnStart: false })
  assert.equal((await off.b.gcStale()).skipped, true)
  await b.dispose(); await off.b.dispose()
})

test('item2: reconnect only when the published tool set changes (names, descriptions, schemas)', async () => {
  const { b, calls, c } = bridge()
  markConnected(c, 'h')
  await b.prepare(tools, 'h') // first: file new → changed → reconnect on a connected record
  const count = (m) => calls.filter(x => x[0] === m).length
  const d0 = count('mcp.disconnect')
  await b.prepare(tools, 'h')
  await b.prepare([...tools].reverse(), 'h')
  assert.equal(count('mcp.disconnect'), d0, 'same set → no reconnect')
  await b.prepare([{ name: 'read', description: 'r2' }, tools[1]], 'h')
  assert.equal(count('mcp.disconnect'), d0 + 1, 'description change → reconnect')
  await b.prepare([...tools, { name: 'grep', description: 'g' }], 'h')
  assert.equal(count('mcp.disconnect'), d0 + 2, 'new tool → reconnect')
  const name = sessionMcpName('dsh-tools', 'h')
  const stateDir = join(c.mcpStateDir, 's', name.slice(10))
  const rev = schemasRev(JSON.parse(readFileSync(join(stateDir, 'schemas.json'), 'utf8')))
  writeFileSync(c.jiuwenMcpStateFile, JSON.stringify({ mcp: { [name]: { ...proxyRegistration(name, stateDir, mcpCallTimeoutMs(c), rev), state: 'connected' } } }))
  await b.dispose()
  // New process, same on-disk set, connected record → no register, no reconnect (survives restart).
  const b2 = createMcpBridge({ config: () => c, services: () => ({}), rpc: async (m, p) => { calls.push([m, p]); return {} } })
  const before = calls.length
  await b2.prepare([...tools, { name: 'grep', description: 'g' }], 'h')
  assert.equal(calls.length, before)
  // File deleted (e.g. by GC/cleanup) → republished and reconnected, never silently skipped.
  rmSync(join(c.mcpStateDir, 's', sessionMcpName('dsh-tools', 'h').slice(10), 'schemas.json'))
  await b2.prepare(tools, 'h')
  assert.ok(calls.slice(before).some(x => x[0] === 'mcp.connect'))
  await b2.dispose()
})

test('item3: aux session id is stable per main session; fresh mode is legacy', () => {
  assert.equal(auxSessionId('jw-1'), 'jw-1-aux')
  assert.equal(auxSessionId('jw-1', 'stable'), auxSessionId('jw-1', 'stable'))
  assert.notEqual(auxSessionId('jw-1'), 'jw-1')
  assert.match(auxSessionId('jw-1', 'fresh'), /^jw-1-aux-[a-z0-9]+$/)
})

test('item4: permissions.tools.update sent once per payload per target; failures retried', async () => {
  resetSentPermissions()
  const calls = []
  let fail = true
  const rpc = async (m, p) => { calls.push(p.tool); if (fail && p.tool === 'edit_file') throw new Error('x') }
  await denyJiuwenSideEffectTools(rpc, null, { target: 'g1' })
  assert.equal(calls.length, 3)
  fail = false
  await denyJiuwenSideEffectTools(rpc, null, { target: 'g1' })
  assert.deepEqual(calls.slice(3), ['edit_file'], 'only the failed one is retried')
  await denyJiuwenSideEffectTools(rpc, null, { target: 'g1' })
  assert.equal(calls.length, 4)
  await denyJiuwenSideEffectTools(rpc, null, { target: 'g2' })
  assert.equal(calls.length, 7, 'other gateway target → sent')
  resetSentPermissions('g1')
  await denyJiuwenSideEffectTools(rpc, null, { target: 'g1' })
  assert.equal(calls.length, 10)
})

test('itemI: default allowlist is * (all host tools); core is opt-in with extras + host-declared tools', async () => {
  const { resolveConfig } = await import('../src/config.js')
  assert.deepEqual(resolveConfig({}, { env: {} }).toolAllowlist, ['*'])
  assert.deepEqual(resolveConfig({ toolAllowlistExtra: ['x_*'] }, { env: {} }).toolAllowlist, ['*'], 'extras ignored with *')
  const d = resolveConfig({ toolAllowlist: 'core' }, { env: {} })
  assert.ok(!d.toolAllowlist.includes('*') && !d.toolAllowlist.includes('core'))
  assert.ok(['bash', 'read', 'edit', 'write', 'glob', 'grep', 'skill'].every(t => d.toolAllowlist.includes(t)))
  assert.ok(resolveConfig({ toolAllowlist: ['core', 'web_*'], toolAllowlistExtra: ['orchestrator_*'] }, { env: {} }).toolAllowlist.includes('orchestrator_*'))
  assert.ok(resolveConfig({}, { env: { JIUWEN_TOOL_ALLOWLIST: 'core' } }).toolAllowlist.includes('grep'))
  const all = bridge({})
  await all.b.prepare([{ name: 'bash' }, { name: 'web_fetch' }, { name: 'plugin_tool' }], 'all')
  assert.deepEqual(all.b.exposed('all').sort(), ['bash', 'plugin_tool', 'web_fetch'], 'default: Jiuwen sees every host tool')
  await all.b.dispose()
  const { b } = bridge({ toolAllowlist: d.toolAllowlist, toolHostDeclared: true })
  await b.prepare([{ name: 'bash' }, { name: 'web_fetch' }, { name: 'report', passthrough: true }, { name: 'x', meta: { jiuwenPassthrough: true } }], 'i')
  assert.deepEqual(b.exposed('i').sort(), ['bash', 'report', 'x'])
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_fetch' } }, 'i')
  assert.ok(r.result.isError, 'not admitted → not callable')
  const off = bridge({ toolAllowlist: d.toolAllowlist, toolHostDeclared: false })
  await off.b.prepare([{ name: 'report', passthrough: true }, { name: 'bash' }], 'j')
  assert.deepEqual(off.b.exposed('j'), ['bash'])
  await b.dispose(); await off.b.dispose()
})

test('GC lists custom MCPs with filter local and falls back to Jiuwen state.json', async () => {
  // Jiuwen maps unknown filters (e.g. 'all') to 'builtin', which never lists custom servers.
  const { b, calls, c } = bridge({ mcpGcOnStart: true, mcpGcGraceMs: 1000 }, (m) => (m === 'mcp.list' ? { items: [] } : {}))
  const old = (Date.now() - 3600_000) / 1000
  const d = join(c.mcpStateDir, 's', 'f'.repeat(16)); mkdirSync(d, { recursive: true }); utimesSync(d, old, old)
  writeFileSync(c.jiuwenMcpStateFile, JSON.stringify({ mcp: { ['dsh-tools-' + 'f'.repeat(16)]: { state: 'connected' } } }))
  const r = await b.gcStale()
  assert.equal(calls.find(x => x[0] === 'mcp.list')[1].filter, 'local')
  assert.deepEqual(r.removed, ['dsh-tools-' + 'f'.repeat(16)])
  await b.dispose()
})
