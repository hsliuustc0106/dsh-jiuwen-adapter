import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GatewayTransport } from '../src/gateway-transport.js'
import { spawnMockGateway } from './helpers/spawn-mock-gateway.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('gateway unary RPCs: models.list history.get mcp.list', async () => {
  const mock = await spawnMockGateway()
  const { port } = mock
  try {
    const t = new GatewayTransport({
      gatewayURL: `ws://127.0.0.1:${port}/ws`,
      accessToken: 'test-token',
      userId: 'rpc-user',
      requestTimeoutMs: 10_000,
    })
    // Seed history via a chat turn
    const chunks = []
    for await (const c of t.stream(
      { provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] },
      { jiuwenSessionId: 'rpc-sess' },
    )) chunks.push(c)
    assert.match(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /pong|tool/)

    const models = await t.modelsList()
    assert.ok(models.models?.some(m => m.id === 'jiuwen-default'))

    const hist = await t.historyGet('rpc-sess')
    assert.ok((hist.messages || []).length >= 2)

    const mcp = await t.mcpList('builtin')
    assert.ok(mcp.items?.length >= 1)

    const mem = await t.memoryStatus('rpc-sess')
    assert.equal(mem.enabled, true)

    const meta = await t.sessionMetadata('rpc-sess')
    assert.equal(meta.mock_auth?.has_token, true)
  } finally {
    await mock.stop()
  }
})
