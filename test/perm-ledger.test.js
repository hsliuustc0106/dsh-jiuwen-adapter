// Owned, reversible Jiuwen global permission writes (dsh tool routing / preset mirror).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPermissionLedger } from '../src/perm-ledger.js'
import { startMock, makeHost } from './helpers/mock-host.js'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

function fakeJiuwen(initial = {}) {
  const tools = { ...initial }
  const calls = []
  const rpc = async (m, p = {}) => {
    calls.push([m, p])
    if (m === 'permissions.tools.get') return { tools: { ...tools } }
    if (m === 'permissions.tools.update') { tools[p.tool] = p.level; return { tools: { ...tools } } }
    if (m === 'permissions.tools.delete') { if (!(p.tool in tools)) throw new Error('tool not found in permissions.tools'); delete tools[p.tool]; return { tools: { ...tools } } }
    throw new Error(`unknown ${m}`)
  }
  return { tools, calls, rpc }
}
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'jiuwen-permissions.json')
const DENY3 = { bash: 'deny', write_file: 'deny', edit_file: 'deny' }

test('routing on: denies with the prior level recorded; routing off: restores exactly that', async () => {
  const j = fakeJiuwen({ bash: 'allow', write_file: 'allow' })
  const l = createPermissionLedger({ file: tmpFile(), rpc: j.rpc, target: 'ws://a' })
  const r1 = await l.reconcile(DENY3)
  assert.deepEqual(r1.applied, ['bash', 'write_file', 'edit_file'])
  assert.deepEqual(j.tools, { bash: 'deny', write_file: 'deny', edit_file: 'deny' })
  assert.deepEqual(l.entries().bash, { ...l.entries().bash, level: 'deny', prior: 'allow', owner: 'route' })
  j.calls.length = 0
  const again = await l.reconcile(DENY3)
  assert.deepEqual(again.applied, [], 'idempotent')
  assert.equal(j.calls.filter(c => c[0] !== 'permissions.tools.get').length, 0, 'no writes when already applied')
  const off = await l.reconcile({})
  assert.deepEqual(off.released.sort(), ['bash', 'edit_file', 'write_file'])
  assert.deepEqual(j.tools, { bash: 'allow', write_file: 'allow' }, 'prior levels back; edit_file had none → override removed')
  assert.deepEqual(l.entries(), {})
})

test('never stomps a user value: changed after the adapter wrote it → ownership dropped, left alone', async () => {
  const j = fakeJiuwen({ bash: 'allow' })
  const l = createPermissionLedger({ file: tmpFile(), rpc: j.rpc })
  await l.reconcile({ bash: 'deny' })
  j.tools.bash = 'ask' // the user changes it in Jiuwen
  const r = await l.reconcile({ bash: 'deny' })
  assert.deepEqual(r.dropped, ['bash'])
  assert.equal(j.tools.bash, 'ask', 'user value kept, not re-denied')
  await l.reconcile({})
  assert.equal(j.tools.bash, 'ask', 'not restored either')
  // A user value equal to the adapter's is not adopted once a ledger exists.
  j.tools.write_file = 'deny'
  const r2 = await l.reconcile({}, { adopt: DENY3 })
  assert.deepEqual(r2.adopted, [])
  assert.equal(j.tools.write_file, 'deny')
})

test('pre-ledger routed denies are adopted on the first run and restored (removed) when routing is off', async () => {
  // Stale state left by older adapter versions: bash/write_file/edit_file=deny, no ledger file.
  const j = fakeJiuwen({ bash: 'deny', write_file: 'deny', edit_file: 'deny', write: 'ask' })
  const file = tmpFile()
  const l = createPermissionLedger({ file, rpc: j.rpc })
  const r = await l.reconcile(DENY3, { adopt: DENY3 })
  assert.deepEqual(r.adopted, ['bash', 'write_file', 'edit_file'])
  assert.deepEqual(r.applied, [])
  const off = await l.reconcile({}, { adopt: DENY3 })
  assert.deepEqual(off.released.sort(), ['bash', 'edit_file', 'write_file'])
  assert.deepEqual(j.tools, { write: 'ask' }, "Jiuwen's own entries (write=ask) are never touched")
})

test('preset mirror writes are owned too; routing keeps the original prior when it takes an entry over', async () => {
  const j = fakeJiuwen({ bash: 'ask' })
  const l = createPermissionLedger({ file: tmpFile(), rpc: j.rpc })
  j.tools.bash = 'allow'; await l.record('bash', 'allow', { owner: 'preset', prior: 'ask' })
  await l.reconcile({ bash: 'deny' })
  assert.equal(l.entries().bash.prior, 'ask')
  assert.equal(l.entries().bash.owner, 'route')
  await l.reconcile({})
  assert.equal(j.tools.bash, 'ask')
  // release(): everything the adapter owns, any owner.
  j.tools.edit_file = 'allow'; await l.record('edit_file', 'allow', { owner: 'preset', prior: null })
  const rel = await l.release()
  assert.deepEqual(rel.released, ['edit_file'])
  assert.equal('edit_file' in j.tools, false)
})

test('Gateway unavailable: nothing written, reported not ok (retried next turn)', async () => {
  const l = createPermissionLedger({ file: tmpFile(), rpc: async () => { throw new Error('down') } })
  const r = await l.reconcile(DENY3)
  assert.equal(r.ok, false)
  assert.equal(existsSync(l.file), false)
})

test('plugin: routing off restores the adapter-owned entries at start; /jiuwen permissions shows + releases them', async () => {
  const mock = await startMock()
  try {
    await mock.rpc('permissions.tools.update', { tool: 'bash', level: 'deny' })
    await mock.rpc('permissions.tools.update', { tool: 'subagent_spawn', level: 'deny' })
    writeFileSync(join(mock.dir, 'jiuwen-permissions.json'), JSON.stringify({ version: 1, targets: { [mock.url]: { tools: {
      bash: { level: 'deny', prior: 'allow', owner: 'route' },
      subagent_spawn: { level: 'deny', prior: null, owner: 'route' },
    } } } }))
    makeHost(mock, { mapJiuwenFsToDsh: false })
    await tick(2200)
    const t = (await mock.rpc('permissions.tools.get')).tools
    assert.equal(t.bash, 'allow', 'prior restored')
    assert.equal('subagent_spawn' in t, false, 'override removed (there was none before)')
    assert.deepEqual(JSON.parse(readFileSync(join(mock.dir, 'jiuwen-permissions.json'), 'utf8')).targets[mock.url].tools, {})
    // Command surface.
    await mock.rpc('permissions.tools.update', { tool: 'edit_file', level: 'deny' })
    writeFileSync(join(mock.dir, 'jiuwen-permissions.json'), JSON.stringify({ version: 1, targets: { [mock.url]: { tools: { edit_file: { level: 'deny', prior: null, owner: 'route' } } } } }))
    const h = makeHost(mock, { mapJiuwenFsToDsh: true, hostSync: false })
    assert.match((await h.cmd('permissions')).text, /adapter-owned: edit_file=deny \(route; was unset\)/)
    assert.match((await h.cmd('permissions release')).text, /Would restore edit_file: deny → \(unset\)/)
    assert.match((await h.cmd('permissions release confirm')).text, /Restored: edit_file/)
    assert.equal('edit_file' in (await mock.rpc('permissions.tools.get')).tools, false)
  } finally { mock.stop() }
})

test('plugin: routing on denies bash/write_file/edit_file (+ subagent_spawn/task_tool when dsh subagent is passed through, hideJiuwenBuiltins deny)', async () => {
  for (const [hide, expectSub] of [['deny', true], ['prompt', false]]) {
    const mock = await startMock()
    try {
      const h = makeHost(mock, { hideJiuwenBuiltins: hide, mcpStateDir: join(mock.dir, 'mcp'), mcpGcOnStart: false })
      const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
      await h.run({ sessionId: `route-${hide}`, messages: [{ role: 'user', content: 'hi' }], tools: [tool('bash'), tool('read'), tool('subagent')] })
      const t = (await mock.rpc('permissions.tools.get')).tools
      assert.equal(t.bash, 'deny', hide)
      assert.equal(t.write_file, 'deny', hide)
      assert.equal(t.edit_file, 'deny', hide)
      assert.equal(t.subagent_spawn === 'deny', expectSub, hide)
      assert.equal(t.task_tool === 'deny', expectSub, hide)
      const owned = JSON.parse(readFileSync(join(mock.dir, 'jiuwen-permissions.json'), 'utf8')).targets[mock.url].tools
      assert.equal(owned.bash.prior, 'allow', 'prior recorded for restore')
    } finally { mock.stop() }
  }
})
