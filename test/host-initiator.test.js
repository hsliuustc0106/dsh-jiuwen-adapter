// Host passthrough re-enters the agent driver's initiator context (dsh-tool-goal authenticates its
// caller with ctx.agents.currentInitiator(); a proxy-socket call has no such context on its own).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpBridge } from '../src/mcp-bridge.js'

function setup({ withInitiator = true, liveAgent } = {}) {
  const store = new AsyncLocalStorage()
  const agent = { id: 's1', status: 'running' }
  const seen = []
  const agents = { get: () => liveAgent ?? agent, currentInitiator: () => store.getStore(), ...(withInitiator ? { withInitiator: (a, op) => store.run(a, op) } : {}) }
  // a goal-like tool: refuses unless the caller is the current initiator, as dsh-tool-goal does
  const tools = {
    get: () => ({ name: 'create_goal' }),
    async execute(exec) {
      seen.push(agents.currentInitiator()?.id)
      if (agents.get(exec.agent.id) !== exec.agent || agents.currentInitiator() !== exec.agent) return { isError: true, content: [{ type: 'text', text: 'goal tools require the exact live calling agent inside its active driver' }] }
      return { isError: false, content: [{ type: 'text', text: 'goal created' }] }
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'jw-init-'))
  const b = createMcpBridge({
    config: () => ({ toolAllowlist: ['*'], toolApproval: 'host', mcpServerName: 'dsh-tools', mcpStateDir: join(dir, 's'), jiuwenMcpStateFile: join(dir, 'jw.json'), mcpGcOnStart: false }),
    services: () => ({ tools, agents }),
    rpc: async () => ({}),
  })
  return { b, agent, seen, cleanup: async () => { await b.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}
const call = (b) => b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_goal', arguments: { objective: 'x' } } }, 's1')

test('host passthrough runs the dsh tool inside the live agent initiator context (goal tools work)', async () => {
  const s = setup()
  try {
    await s.b.prepare([{ name: 'create_goal', description: 'g' }], 's1')
    const r = await call(s.b)
    assert.equal(r.result.isError, false, r.result.content[0].text)
    assert.equal(r.result.content[0].text, 'goal created')
    assert.deepEqual(s.seen, ['s1'])
  } finally { await s.cleanup() }
})

test('without agents.withInitiator (older dsh) the call still runs, unchanged', async () => {
  const s = setup({ withInitiator: false })
  try {
    await s.b.prepare([{ name: 'create_goal', description: 'g' }], 's1')
    const r = await call(s.b)
    assert.equal(r.result.isError, true)
    assert.deepEqual(s.seen, [undefined])
  } finally { await s.cleanup() }
})
