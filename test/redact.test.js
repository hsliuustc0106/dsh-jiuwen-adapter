import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../src/redact.js'
import { redactSecrets as fromHostSync } from '../src/host-sync.js'
import { createMcpBridge } from '../src/mcp-bridge.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const no = (s, v) => assert.ok(!redactSecrets(s).includes(v), `${s} -> ${redactSecrets(s)}`)
test('redact: JSON, YAML, env, short values', () => {
  no('{"apiKey":"abc123"}', 'abc123')
  no('{ "client_secret": "s3cr" }', 's3cr')
  no('password: hunter', 'hunter')
  no('export OPENAI_API_KEY=sk-live', 'sk-live')
  no("token='xyz'", 'xyz')
  assert.equal(fromHostSync, redactSecrets)
})
test('redact: Authorization / Bearer / URL credentials', () => {
  no('Authorization: Bearer abcdef.ghijk', 'abcdef.ghijk')
  no('-H "Authorization: Basic dXNlcjpwYXNz"', 'dXNlcjpwYXNz')
  no('curl -H "Bearer qwertyuiop"', 'qwertyuiop')
  no('postgres://admin:pa55w0rd@db:5432/x', 'pa55w0rd')
  assert.match(redactSecrets('postgres://admin:pa55w0rd@db'), /admin:\[REDACTED\]@db/)
})
test('redact: placeholders and prose stay readable', () => {
  for (const s of ['API_KEY=${API_KEY}', 'token: <your-token>', 'password: {{PASS}}', 'apiKey: required', 'Set the token in settings.', 'https://example.com/a@b', 'Authorization: ${AUTH}']) assert.equal(redactSecrets(s), s)
})
test('redact: index-mode skill loader output is masked (opt-out redactSkillOutput:false)', async () => {
  const mk = (extra) => createMcpBridge({
    config: () => ({ toolAllowlist: ['*'], toolApproval: 'none', toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools', mcpStateDir: join(mkdtempSync(join(tmpdir(), 'rd-')), 's'), jiuwenMcpStateFile: '/nonexistent', mcpGcOnStart: false, skillLoaderTool: 'skill', ...extra }),
    services: () => ({ tools: { get: (n) => ({ execute: async () => (n === 'skill' ? 'use apiKey: abc12345 here' : 'apiKey: abc12345') }) } }),
    rpc: async () => ({}),
  })
  for (const [extra, want] of [[{}, false], [{ redactSkillOutput: false }, true]]) {
    const b = mk(extra)
    await b.prepare([{ name: 'skill' }, { name: 'read' }], 's')
    const sk = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill', arguments: {} } }, 's')
    assert.equal(sk.result.content[0].text.includes('abc12345'), want)
    const rd = await b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's')
    assert.ok(rd.result.content[0].text.includes('abc12345'), 'other tools untouched')
    await b.dispose()
  }
})
