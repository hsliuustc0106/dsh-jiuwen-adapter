// The live guard's stand-in model must recognise the adapter's hostSkillInject:index block (the default
// since be6b36a), so the live skill checks follow the real contract (index + loader tool) instead of a
// body marker that index mode never sends. Uses the adapter's own injector, so a format change breaks here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySkillBodyInjection } from '../src/host-sync.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function withStandin(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'standin-test-'))
  const logFile = join(dir, 'standin.jsonl')
  const p = spawn(process.execPath, [join(ROOT, 'test/fixtures/stand-in.mjs')], { env: { ...process.env, PORT: '0', STANDIN_LOG: logFile }, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise(r => p.once('exit', r))
  try {
    const port = await new Promise((res, rej) => {
      let buf = ''
      p.stdout.on('data', d => { buf += d; const m = /stand-in on (\d+)/.exec(buf); if (m) { p.stdout.resume(); res(Number(m[1])) } })
      p.once('exit', c => rej(new Error(`stand-in exited ${c}`)))
    })
    const ask = async (content, tools = []) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content }], tools: tools.map(name => ({ type: 'function', function: { name, parameters: {} } })) }) })
      await r.text()
      return readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
    }
    await fn(ask)
  } finally { p.kill(); await exited; rmSync(dir, { recursive: true, force: true }) }
}

const mapping = { skillBodies: [{ name: 'jw-probe-skill', description: 'probe skill', content: 'MARKSKILLBODY follow the probe.' }] }

test('stand-in reads the adapter index block: skill names + loader tool (plain and Jiuwen-JSON-escaped)', async () => {
  const q = applySkillBodyInjection('TAG:k1 use skill', mapping, { mode: 'index', loaderTool: 'mcp_dsh-tools-0123456789abcdef_skill' })
  assert.match(q, /index only/)
  await withStandin(async (ask) => {
    const plain = await ask(q, ['mcp_dsh-tools-0123456789abcdef_skill'])
    assert.deepEqual(plain.skillIndex, ['jw-probe-skill'])
    assert.equal(plain.skillLoader, 'mcp_dsh-tools-0123456789abcdef_skill')
    assert.equal(plain.skillLoaderOffered, true)
    assert.deepEqual(plain.marks, [], 'index mode sends no body')
    // Jiuwen wraps the user text in a JSON envelope (escaped newlines)
    const wrapped = await ask(`你收到一条消息：\n${JSON.stringify({ source: 'web', content: q })}`)
    assert.deepEqual(wrapped.skillIndex, ['jw-probe-skill'])
    assert.equal(wrapped.skillLoaderOffered, false, 'loader named but not in this request\'s tools (progressive discovery)')
  })
})

test('stand-in: body mode still shows the body marker and no index', async () => {
  const q = applySkillBodyInjection('TAG:k2 use skill', mapping, { mode: 'body' })
  await withStandin(async (ask) => {
    const r = await ask(q)
    assert.deepEqual(r.marks, ['MARKSKILLBODY'])
    assert.equal(r.skillIndex, undefined)
  })
})
