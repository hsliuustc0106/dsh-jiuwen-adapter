#!/usr/bin/env node
// Opt-in plain-dsh plugin compatibility matrix (`npm run test:plain-dsh`): real dsh web profiles, no FlyBot.
// Profiles: pref (dsh-base + dsh-web-app + driver), pjw (+ adapter last), pjwfirst (adapter first).
// (a) non-jiuwen sessions produce the same normalized events / fork / schedules / skills / preset in all three;
// (b) jiuwen sessions pass every read-back check (title, workdir, schedule, permissions, fork, plan, goal, dispose/archive, skills);
// (c) no errors, no unhandled rejections, in both load orders.
//   JIUWEN_LIVE=1, DSH_BIN=<dsh binary>; JW_USE_STANDIN_CMD / JW_RESTORE_CMD as in run.mjs (Jiuwen must answer via the stand-in).
//   PLAIN_DSH_PORT (default 3471). Jiuwen state is snapshotted and restored exactly.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, GATEWAY, STANDIN_LOG, STANDIN_PORT, gatewayUp, skip, startStandin, sh, sleep, waitGateway, snapshot, restore } from './lib.mjs'

const nested = process.env.JIUWEN_LIVE_NESTED === '1'
if (process.env.JIUWEN_LIVE !== '1') skip('set JIUWEN_LIVE=1')
const BIN = process.env.DSH_BIN
if (!BIN || !existsSync(BIN)) skip('set DSH_BIN to a dsh binary')
if (!(await gatewayUp())) skip(`Gateway offline at ${GATEWAY}`)
if (!nested && !process.env.JW_USE_STANDIN_CMD) skip('set JW_USE_STANDIN_CMD / JW_RESTORE_CMD (Jiuwen must answer via the stand-in)')
const PORT = Number(process.env.PLAIN_DSH_PORT || 3471)
const HOME = mkdtempSync(join(tmpdir(), 'plain-dsh-'))
const DRIVER = join(ROOT, 'test/live/plain-dsh/driver')
const BUNDLES = { pref: ['@plain/driver'], pjw: ['@dsh-jiuwen/adapter', '@plain/driver'], pjwfirst: ['@dsh-jiuwen/adapter', '@plain/driver'] }
// memory-module profiles: the same three plus the opt-in session-search bundle (agent-instructions, session-query-sqlite and session-reference are already in dsh-base / dsh-web-app)
const MEM = '@deepseek-ai/dsh-experimental-session-search'
for (const k of Object.keys(BUNDLES)) BUNDLES[`mem-${k}`] = BUNDLES[k]
// extra-plugin profiles: ralph, persistent terminal, worktree, auto-review bundles + time-context and mcp-client (echo fixture) inserts
const EXT = ['@deepseek-ai/dsh-experimental-ralph-bundle', '@deepseek-ai/dsh-experimental-terminal-bundle', '@deepseek-ai/dsh-experimental-tool-worktree', '@deepseek-ai/dsh-experimental-auto-review']
for (const k of ['pref', 'pjw', 'pjwfirst']) BUNDLES[`ext-${k}`] = BUNDLES[k]
const EXT_PATCH = name => `- insert:
    - id: ext-time-context
      name: '@deepseek-ai/dsh-time-context'
    - id: ext-mcp-echo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: echo
        command: ${process.execPath}
        args:
          - ${join(ROOT, 'scripts/fixtures/mcp-echo.mjs')}
${name.endsWith('pref') ? '' : `- id: llm-jiuwen
  config:
    approvalTimeoutMs: 5000
`}`
const PATCH = `- id: llm-pi-ai
  config:
    providers:
      standin:
        api: openai-completions
        baseURL: http://127.0.0.1:${STANDIN_PORT}/v1
        apiKeyEnv: STANDIN_API_KEY
        displayName: Stand-in
        models:
          - id: standin-m1
- id: agent-default-model
  config:
    provider: standin
    model: standin-m1
- id: system-prompt
  config:
    personaPrefix: You are Plain-Probe, powered by {{model}}. Answer briefly.
`
function profile(name) {
  const dir = join(HOME, '.dsh/profiles', name); mkdirSync(join(dir, 'node_modules/@plain'), { recursive: true })
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const plain = name.replace(/^(mem|ext)-/, '')
  const extra = name.startsWith('mem-') ? [MEM] : name.startsWith('ext-') ? EXT : []
  const bundles = plain === 'pjwfirst' ? ['@dsh-jiuwen/adapter', ...base, ...extra, '@plain/driver'] : [...base, ...extra, ...BUNDLES[name]]
  const deps = { '@plain/driver': `link:${DRIVER}`, ...(name.endsWith('pref') ? {} : { '@dsh-jiuwen/adapter': `link:${ROOT}` }) }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: deps, dsh: { profile: { bundles } } }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n'); writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
  symlinkSync(DRIVER, join(dir, 'node_modules/@plain/driver'))
  if (!name.endsWith('pref')) { mkdirSync(join(dir, 'node_modules/@dsh-jiuwen'), { recursive: true }); symlinkSync(ROOT, join(dir, 'node_modules/@dsh-jiuwen/adapter')) }
}
const SKILL = '---\nname: plain-probe-skill\ndescription: plain dsh probe skill\n---\nMARKSKILLBODY plain probe.\n'
for (const d of ['.agents/skills/plain-probe-skill', '.dsh/skills/plain-probe-skill']) { mkdirSync(join(HOME, d), { recursive: true }); writeFileSync(join(HOME, d, 'SKILL.md'), SKILL) }
mkdirSync(join(HOME, 'sandbox'))
writeFileSync(join(HOME, 'sandbox/AGENTS.md'), '# Project notes\nMARKAGENTSMD: this workspace is the plain-dsh memory probe.\n')
for (const p of Object.keys(BUNDLES)) profile(p)

async function run(name, mode) {
  const out = join(HOME, `out-${name}-${mode}.json`)
  // selectModel persists the default model; reset the patch before every run
  const trace = join(HOME, `trace-${name}-${mode}.jsonl`)
  writeFileSync(join(HOME, '.dsh/profiles', name, 'cordis.patch.yml'), PATCH + (name.startsWith('ext-') ? EXT_PATCH(name) : '') + (mode === 'busy' && !name.endsWith('pref') ? `- id: llm-jiuwen\n  config:\n    traceFile: ${trace}\n` : ''))
  const env = { ...process.env, HOME, STANDIN_API_KEY: 'standin-no-secret', STANDIN_LOG, DRIVER_OUT: out, DRIVER_MODE: mode, DRIVER_CWD: join(HOME, 'sandbox') }
  delete env.DSH_HOME
  const p = spawn(BIN, ['--profile', name, '--host', '127.0.0.1', '--port', String(PORT), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let log = ''; p.stdout.on('data', d => { log += d }); p.stderr.on('data', d => { log += d })
  let exited = false; p.on('exit', () => { exited = true })
  for (let i = 0; i < 240 && !existsSync(out) && !exited; i++) await sleep(1000)
  await sleep(1000); try { process.kill(-p.pid, 'SIGINT') } catch {}
  await sleep(3000); try { process.kill(-p.pid, 'SIGKILL') } catch {}
  if (!existsSync(out)) return { err: 'no driver output', log: log.slice(-1500) }
  return { ...JSON.parse(readFileSync(out, 'utf8')), log, trace: existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) : [] }
}

const results = []
// Extra plugins: compaction, session-turn-outline, mcp-client, time-context, ralph, terminal, worktree, auto-review.
function extChecks(X) {
  const sig = o => JSON.stringify({ r: o.ext?.p?.replies, o: o.ext?.p?.outline, c: o.ext?.p?.compact, ce: o.ext?.p?.compactEvents, e: o.ext?.p?.echo?.reply, a: o.ext?.p?.presetAuto, t: o.ext?.p?.timeCtx })
  for (const [k, o] of Object.entries(X)) {
    check(`ext ${k}: driver ran, no errors`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify([o.errors, o.unhandled]))
    const p = o.ext?.p || {}
    check(`ext ${k} non-jiuwen: turns + turn outline + compaction + mcp-client echo + auto preset`, p.replies?.every(Boolean) && p.outline === 3 && p.compact === 'object' && /echo:hi-p/.test(p.echo?.reply || '') && p.presetAuto === 'auto', JSON.stringify(p).slice(0, 300))
    check(`ext ${k} non-jiuwen: time-context reaches the model`, p.timeCtx?.[0] === true)
    const j = o.ext?.j
    if (!j) continue
    check(`ext ${k} jiuwen: turns + turn outline (dsh projection of Jiuwen turns)`, j.replies?.every(Boolean) && j.outline === 3, JSON.stringify(j).slice(0, 200))
    check(`ext ${k} jiuwen: dsh compaction runs locally — same Jiuwen session, no extra Jiuwen turn, next turn ok`, j.compact === 'object' && j.jwSame && j.msgAfter - j.msgBefore === 4 && /stand-in reply jx4/.test(j.afterCompact || ''), JSON.stringify({ c: j.compact, same: j.jwSame, m: [j.msgBefore, j.msgAfter], a: j.afterCompact }))
    check(`ext ${k} jiuwen: time-context is not forwarded (Jiuwen stamps its own)`, j.timeCtx?.every(x => x === false), JSON.stringify(j.timeCtx))
    check(`ext ${k} jiuwen: mcp-client tool reaches Jiuwen via dsh-tools; approval-gated, bounded deny without UI`, /^mcp_dsh-tools(-[0-9a-f]{16})?_mcp__echo__echo$/.test(j.echo?.picked || '') && /dsh denied mcp__echo__echo/.test(j.echo?.reply || '') && j.echo?.ms < 20000, JSON.stringify(j.echo))
    check(`ext ${k} jiuwen: auto-review preset → Jiuwen ask (was left at the previous level)`, j.perm?.ro === 'deny' && j.perm?.auto === 'ask', JSON.stringify(j.perm))
    if (o.ext?.j) check(`ext ${k}: ralph / terminal / worktree / mcp-client tools published to Jiuwen`, ['create_worktree', 'mcp__echo__echo', 'ralph', 'terminal_open'].every(n => (o.ext?.schemas || []).includes(n)), JSON.stringify(o.ext?.schemas))
  }
  if (X.ref && X.last && X.first) check('ext (a) non-jiuwen results identical without / with adapter, both load orders', sig(X.ref) === sig(X.last) && sig(X.ref) === sig(X.first), [sig(X.ref), sig(X.last), sig(X.first)].join(' | '))
}
// Interrupt-on-busy (PR #4): a slow turn, then two user messages while it runs.
function busyChecks(B) {
  const pSig = o => JSON.stringify({ n: o.busy?.p?.replies?.length, tags: (o.busy?.p?.reqs || []).map(x => x.tags), note: (o.busy?.p?.reqs || []).some(x => x.note) })
  for (const [k, o] of Object.entries(B)) {
    check(`busy ${k}: driver ran, no errors`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify([o.errors, o.unhandled]))
    const p = o.busy?.p || {}
    check(`busy ${k} non-jiuwen: dsh queues the messages; no interruption note`, p.replies?.length >= 2 && !(p.reqs || []).some(x => x.note), JSON.stringify(p).slice(0, 300))
    const j = o.busy?.j
    if (!j) continue
    const reqs = j.reqs || []
    const resend = reqs.filter(x => x.note)
    check(`busy ${k} jiuwen: the slow turn is interrupted (turn ends well before SLOW12000)`, j.ms < 11000 && (o.trace || []).some(t => t.at === 'turn-interrupt' && t.phase === 'requested'), JSON.stringify({ ms: j.ms }))
    check(`busy ${k} jiuwen: both messages coalesce into ONE resend with the interruption note`, resend.length === 1 && ['TAG:jb2', 'TAG:jb3'].every(t => resend[0].tags?.includes(t)) && !reqs.some(x => !x.note && x.tags?.some(t => /jb[23]/.test(t))), JSON.stringify(reqs))
    check(`busy ${k} jiuwen: the resend answers on the same Jiuwen session; the next turn has no stale note`, /stand-in reply jb2/.test(j.replies?.at(-1) || '') && /stand-in reply jb4/.test(j.after?.reply || '') && j.after?.note === false, JSON.stringify({ r: j.replies, a: j.after }))
  }
  if (B.ref && B.last && B.first) check('busy (a) non-jiuwen behaviour identical without / with adapter, both load orders', pSig(B.ref) === pSig(B.last) && pSig(B.ref) === pSig(B.first), [pSig(B.ref), pSig(B.last), pSig(B.first)].join(' | '))
}
// Memory-module plugins: dsh-agent-instructions (AGENTS.md), dsh-session-reference (dsh-session:<id>), dsh-experimental-session-search.
function memoryChecks(M) {
  const has = (a, m) => (a || []).includes(m)
  for (const [k, o] of Object.entries(M)) {
    check(`mem ${k}: driver ran, no errors`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify(o.errors))
    const p = o.mem?.p || {}
    check(`mem ${k} non-jiuwen: AGENTS.md reaches the model`, p.src?.agentsMd === true)
    check(`mem ${k} non-jiuwen: session reference snapshot reaches the model`, has(p.ref?.allMarks, 'MARKREFSRCP') && !!p.ref?.reply, JSON.stringify(p.ref))
    check(`mem ${k} non-jiuwen: session_search finds the earlier session`, /Session search results \(\d+\)/.test(p.search?.reply || ''), JSON.stringify(p.search).slice(0, 300))
    const j = o.mem?.j
    if (!j) continue
    check(`mem ${k} jiuwen: AGENTS.md reaches Jiuwen`, j.src?.agentsMd === true)
    check(`mem ${k} jiuwen: session reference snapshot reaches Jiuwen`, has(j.ref?.marks, 'MARKREFSRCJ') && /stand-in reply jref/.test(j.ref?.reply || ''), JSON.stringify(j.ref).slice(0, 300))
    check(`mem ${k} jiuwen: next turn does not resend AGENTS.md / reference (Jiuwen keeps history)`, !has(j.ref2?.marks, 'MARKREFSRCJ') && !has(j.ref2?.marks, 'MARKAGENTSMD') && has(j.ref2?.allMarks, 'MARKREFSRCJ'), JSON.stringify(j.ref2))
    check(`mem ${k} jiuwen: session_search via dsh-tools MCP finds the earlier session (no approval prompt)`, /Session search results/.test(j.search?.reply || '') && /zebra-j|MARKREFSRCJ/.test(j.search?.reply || '') && j.search?.ms < 30000, JSON.stringify(j.search).slice(0, 400))
    check(`mem ${k} jiuwen: no clash with Jiuwen memory (own memory tools + prefixed dsh tools)`, (j.search?.toolNames || []).some(n => /memory/.test(n)) && (j.search?.toolNames || []).every(n => !/^session_search$/.test(n)), JSON.stringify(j.search?.toolNames))
  }
  const sig = o => JSON.stringify([o.mem?.p?.src?.agentsMd, !!o.mem?.p?.ref?.reply, /Session search results/.test(o.mem?.p?.search?.reply || '')])
  if (M.ref && M.last && M.first) check('mem (a) non-jiuwen results identical without / with adapter, both load orders', sig(M.ref) === sig(M.last) && sig(M.ref) === sig(M.first))
}
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + String(detail).slice(0, 300) : ''}`) }
const snap = nested ? null : await snapshot()
const standin = nested ? { stop() {} } : await startStandin()
try {
  if (!nested) { sh(process.env.JW_USE_STANDIN_CMD); if (!(await waitGateway())) throw new Error('Gateway did not come back') }
  const ONLY = process.env.PLAIN_DSH_ONLY || 'all'
  const R = ONLY === 'mem' || ONLY === 'ext' || ONLY === 'busy' ? {} : { pref: await run('pref', 'plain'), pjwPlain: await run('pjw', 'plain'), pjwfirstPlain: await run('pjwfirst', 'plain'), pjw: await run('pjw', 'jw'), pjwfirst: await run('pjwfirst', 'jw') }
  if (ONLY === 'all' || ONLY === 'plain') {
  const RAW_IDS = new Set(['id', 'fork']) // raw dsh session ids (random per run); the normalized events carry the rest
  const cmp = o => Object.fromEntries(Object.entries(o.plain || {}).filter(([k]) => !RAW_IDS.has(k)))
  const key = o => JSON.stringify(cmp(o))
  const why = (a, b) => Object.keys({ ...cmp(a), ...cmp(b) }).filter(k => JSON.stringify(cmp(a)[k]) !== JSON.stringify(cmp(b)[k])).map(k => `${k}: ${JSON.stringify(a.plain?.[k]).slice(0, 200)} ≠ ${JSON.stringify(b.plain?.[k]).slice(0, 200)}`).join(' | ')
  if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP, JSON.stringify(R))
  for (const [k, o] of Object.entries(R)) check(`${k}: driver ran, no errors / unhandled rejections`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify([o.errors, o.unhandled]))
  check('(a) non-jiuwen session identical without / with adapter (adapter last)', key(R.pref) === key(R.pjwPlain), why(R.pref, R.pjwPlain))
  check('(a) non-jiuwen session identical without / with adapter (adapter first)', key(R.pref) === key(R.pjwfirstPlain), why(R.pref, R.pjwfirstPlain))
  for (const k of ['pjw', 'pjwfirst']) {
    const jw = R[k].jw || []
    check(`(b) ${k}: all Jiuwen read-back checks pass (${jw.filter(x => String(x).startsWith('PASS')).length}/${jw.length})`, jw.length >= 16 && jw.every(x => String(x).startsWith('PASS')), jw.filter(x => !String(x).startsWith('PASS')).join(' | '))
    for (const line of jw) console.log(`      ${line}`.slice(0, 160))
  }
  check('(c) same jiuwen results in both load orders', JSON.stringify((R.pjw.jw || []).map(x => String(x).split(' — ')[0])) === JSON.stringify((R.pjwfirst.jw || []).map(x => String(x).split(' — ')[0])))
  check('(c) listeners: the adapter adds at most one process exit listener', ['pjw', 'pjwfirst'].every(k => { const n = s => Number((String(R[k][s] || '').match(/exit:(\d+)/) || [])[1] || 0); return n('listeners1') - n('listeners0') <= 1 }))
  }
  if (ONLY === 'all' || ONLY === 'ext') {
    const X = process.env.PLAIN_DSH_EXT_QUICK ? { last: await run('ext-pjw', 'ext') } : { ref: await run('ext-pref', 'ext'), last: await run('ext-pjw', 'ext'), first: await run('ext-pjwfirst', 'ext') }
    if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP + '.ext.json', JSON.stringify(X))
    extChecks(X)
  }
  if (ONLY === 'all' || ONLY === 'busy') {
    const B = process.env.PLAIN_DSH_BUSY_QUICK ? { last: await run('pjw', 'busy') } : { ref: await run('pref', 'busy'), last: await run('pjw', 'busy'), first: await run('pjwfirst', 'busy') }
    if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP + '.busy.json', JSON.stringify(B))
    busyChecks(B)
  }
  if (ONLY === 'all' || ONLY === 'mem') {
    const M = process.env.PLAIN_DSH_MEM_QUICK ? { last: await run('mem-pjw', 'mem') } : { ref: await run('mem-pref', 'mem'), last: await run('mem-pjw', 'mem'), first: await run('mem-pjwfirst', 'mem') }
    if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP + '.mem.json', JSON.stringify(M))
    memoryChecks(M)
  }
} finally {
  if (!nested) { sh(process.env.JW_RESTORE_CMD); await waitGateway() }
  standin.stop()
  if (snap) { const diff = await restore(snap); check('Jiuwen state restored exactly', diff.length === 0, diff.join(',')) }
  rmSync(HOME, { recursive: true, force: true })
}
console.log(`\nplain-dsh: ${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
