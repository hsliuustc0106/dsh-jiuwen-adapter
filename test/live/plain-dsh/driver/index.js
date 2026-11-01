// Test driver for a real plain dsh web profile: drives the Host services the web API uses
// (sessionController, schedule, permissionPresets, workspaceController, skills, goals, planMode)
// and writes normalized results to $DRIVER_OUT. Test-only (test/live/plain-dsh.mjs), not part of the plugin.
import { writeFileSync, mkdirSync } from 'node:fs'
import * as FS from 'node:fs'
const require_fs = () => FS
import { createHash, randomUUID } from 'node:crypto'
export const name = 'plain-driver'
const tick = ms => new Promise(r => setTimeout(r, ms))
const textOf = m => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
const DROP = new Set(['time', 'ts', 'at', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs', 'elapsedMs', 'latencyMs', 'firstTokenMs', 'scheduledAt', 'nextAt', 'nextRunAt', 'lastRunAt', 'createdAtMs', 'mtime', 'timestamp', 'clientTimeZone', 'date', 'dt'])
function normalizer() {
  const ids = new Map(); const tok = s => { if (!ids.has(s)) ids.set(s, `<id${ids.size}>`); return ids.get(s) }
  const UUIDISH = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dsh-[0-9a-f]{16}|web_[0-9a-z_]+|call[-_][\w-]+|schedule-<id\d+>)/gi
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) { if (DROP.has(k)) continue; o[k] = walk(v[k]) } return o }
    if (typeof v === 'string') return v.replace(UUIDISH, tok).replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d(\[[^\]]+\])?)/g, '<ts>').replace(/\/tmp\/[\w./-]+/g, '<tmp>')
    if (typeof v === 'number' && v > 1e12) return '<epoch>'
    return v
  }
  return walk
}
// Union of the dsh-tools passthrough schema files (per-session dirs `s/<key>/`, plus the legacy single file).
function mcpSchemaNames(re) {
  const root = `${process.env.HOME}/.cache/dsh-jiuwen/mcp/dsh-tools`
  const files = [`${root}/schemas.json`]
  try { for (const d of FS.readdirSync(`${root}/s`)) files.push(`${root}/s/${d}/schemas.json`) } catch {}
  const names = new Set()
  for (const f of files) { try { for (const x of JSON.parse(FS.readFileSync(f, 'utf8'))) if (re.test(x.name)) names.add(x.name) } catch {} }
  return names.size ? [...names].sort() : `ERR no schemas under ${root}`
}
export function apply(ctx) {
  const OUT = process.env.DRIVER_OUT
  if (!OUT) return
  const MODE = process.env.DRIVER_MODE || 'ref'
  const SANDBOX = process.env.DRIVER_CWD || '/tmp'
  const out = { mode: MODE, steps: [], errors: [], jw: [] }
  const step = (k, v) => out.steps.push([k, v])
  let log = () => {}
  const err = (k, e) => out.errors.push(`${k}: ${String(e?.message || e).slice(0, 200)}`)
  const unhandled = []
  process.on('unhandledRejection', e => unhandled.push(String(e?.message || e).slice(0, 200)))
  const L = () => process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).sort().join()
  const flush0 = () => { try { mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(OUT + '.partial', JSON.stringify(out, null, 1)) } catch {} }
  log = (...a) => { console.error('[driver]', ...a); flush0() }
  setTimeout(async () => {
    log('start')
    const g = n => ctx.get(n)
    const sc = g('sessionController'), agents = g('agents'), sessions = g('sessions')
    out.services = Object.fromEntries(['sessionController', 'schedule', 'permissionPresets', 'workspaceController', 'workspaceRegistry', 'skills', 'goals', 'planMode', 'sessionTitle', 'workingDirectory', 'llm', 'jiuwenAdapter', 'mcpResources', 'agentPresets', 'sessionPersistence'].map(n => [n, g(n) !== undefined]))
    out.providers = (g('llm')?.listProviders?.() || []).map(p => p.id).sort()
    out.listeners0 = L()
    const norm = normalizer()
    const agentOf = id => agents.get?.(id) || sessions.get(id)?.agent
    const waitIdle = async (id, ms = 60_000) => { const t = Date.now() + ms; await tick(300); while (Date.now() < t) { const a = agentOf(id); if (a && typeof a.whenIdle === 'function') { await Promise.race([a.whenIdle(), tick(ms)]); return } await tick(200) } }
    const prompt = async (id, text) => { await sc.prompt({ requestId: `r-${randomUUID()}`, sessionId: id, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal); await waitIdle(id) }
    const evs = id => { try { return sessions.get(id)?.snapshotEvents?.() || [] } catch { return [] } }
    const lastReply = id => evs(id).filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).at(-1) || ''
    const scenario = async (label, model) => {
      const r = {}
      log(label, 'create'); const { sessionId: id } = await sc.create({ cwd: SANDBOX }, new AbortController().signal)
      r.id = id
      if (model) { try { await sc.selectModel({ sessionId: id, ...model }, new AbortController().signal) } catch (e) { err(`${label} selectModel`, e) } }
      log(label, 'prompt1', id); await prompt(id, `TAG:${label}1 hello`); log(label, 'reply1', lastReply(id))
      r.reply1 = lastReply(id)
      const agent = agentOf(id)
      try { await sc.rename({ sessionId: id, title: `${label} 标题 ✓` }, new AbortController().signal) } catch (e) { err(`${label} rename`, e) }
      try { const pm = g('agentPresets')?.serviceFor?.(agent, 'planMode') ?? g('planMode'); r.planSvc = !!pm; pm?.set(agent, true); await tick(200); pm?.set(agent, false) } catch (e) { err(`${label} plan`, e) }
      try {
        const gl = g('goals'); let s = gl.create(agent, { objective: `${label} goal`, maxGoalRounds: 3 }); await tick(300)
        const ref = () => { const x = gl.get?.(agent)?.goal ?? gl.get?.(agent) ?? s?.goal ?? s; return { id: x.id, revision: x.revision } }
        const ph = () => (gl.get?.(agent)?.goal ?? gl.get?.(agent))?.phase ?? (gl.get?.(agent)?.goal ?? gl.get?.(agent))?.status
        r.goalPhase0 = ph()
        if (r.goalPhase0 === 'active') { s = gl.pause(agent, ref()); await tick(300); s = gl.resume(agent, ref()); await tick(300) }
        gl.clear(agent, ref()); await tick(300)
      } catch (e) { err(`${label} goal`, e) }
      log(label, 'ops done'); await waitIdle(id, 30_000)
      try { const s = await g('schedule').create(id, { title: `${label} sched`, prompt: 'ping', every_seconds: 7200 }); r.schedule = norm(s); r.scheduleList = norm(await g('schedule').list({ sessionId: id })) } catch (e) { err(`${label} schedule`, e) }
      try { const pp = g('permissionPresets'); r.presetCatalog = norm(pp.catalog()); r.presetBefore = pp.current(sessions.get(id)); pp.set(sessions.get(id), 'read-only'); await tick(500); r.presetAfter = pp.current(sessions.get(id)) } catch (e) { err(`${label} preset`, e) }
      try { const live = agentOf(id); const reg = g('agentPresets')?.serviceFor?.(live, 'skills') ?? g('skills'); r.skills = (await reg.list({ cwd: SANDBOX, scope: live })).map(s => s.name).filter(n => /probe/.test(n)).sort() } catch (e) { err(`${label} skills`, e) }
      log(label, 'prompt2'); await prompt(id, `TAG:${label}2 again`)
      r.reply2 = lastReply(id)
      log(label, 'fork'); try { const f = await sc.fork({ sessionId: id }, new AbortController().signal); r.fork = f.sessionId; await prompt(f.sessionId, `TAG:${label}f on fork`); r.forkReply = lastReply(f.sessionId); r.forkEvents = norm(evs(f.sessionId).map(e => ({ type: e.type, data: e.data }))) } catch (e) { err(`${label} fork`, e) }
      try { const s = (await g('schedule').list({ sessionId: id })); for (const x of (s.schedules || s.items || s || [])) if (x?.id) await g('schedule').delete({ sessionId: id, id: x.id }) } catch (e) { err(`${label} schedule.delete`, e) }
      r.events = norm(evs(id).map(e => ({ type: e.type, data: e.data })))
      r.types = [...new Set(evs(id).map(e => e.type))].sort()
      r.hash = createHash('sha1').update(JSON.stringify(r.events)).digest('hex').slice(0, 16)
      return r
    }
    // Extra plugins (MODE=ext): compaction, session-turn-outline, mcp-client (echo), time-context, ralph, terminal, worktree, auto-review.
    if (MODE === 'ext') {
      const api = g('jiuwenAdapter')
      const sl = () => { try { return require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } }
      const last = tag => sl().filter(x => x.tag === tag && !/Generate the session title/.test(x.last || '')).at(-1)
      out.ext = { tools: (() => { try { const t = g('tools'); return (t.list?.() || t.names?.() || []).map(x => x?.name || x).filter(n => /ralph|terminal|worktree|echo|mcp__/i.test(n)).sort() } catch (e) { return 'ERR ' + e.message } })() }
      const routes = [['p', { provider: 'standin', model: 'standin-m1' }], ...(api ? [['j', { provider: 'jiuwen', model: 'jiuwen-default' }]] : [])]
      for (const [k, model] of routes) {
        const r = out.ext[k] = {}
        try {
          const { sessionId: id } = await sc.create({ cwd: SANDBOX }, new AbortController().signal); await sc.selectModel({ sessionId: id, ...model }, new AbortController().signal)
          for (let i = 1; i <= 3; i++) await prompt(id, `TAG:${k}x${i} turn ${i} ` + 'filler '.repeat(200))
          r.replies = [1, 2, 3].map(i => /stand-in reply/.test(evs(id).filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message))[i - 1] || ''))
          r.timeCtx = [1, 2, 3].map(i => last(`${k}x${i}`)?.timeCtx)
          const sess = sessions.get(id)
          try { r.outline = g('sessionProjections')?.stateOf?.(sess, 'turnOutline')?.turns?.length } catch (e) { r.outline = 'ERR ' + e.message }
          const jw0 = api?.sessions.get(id)?.jiuwenSessionId
          const cnt = async () => ((await api.gateway.rpc('session.list', { limit: 500 }))?.sessions || []).find(x => x.session_id === jw0)?.message_count
          const before = k === 'j' ? await cnt() : undefined
          try { const ag = agentOf(id); const cs = g('agentPresets')?.serviceFor?.(ag, 'compaction') ?? g('compaction'); r.compactSvc = !!cs; const res = await cs.compactNow(ag, new AbortController().signal); r.compact = res === null ? 'null' : typeof res } catch (e) { r.compact = 'ERR ' + String(e.message).slice(0, 160) }
          await waitIdle(id, 30_000)
          r.compactEvents = evs(id).filter(e => /compact/i.test(e.type)).map(e => e.type)
          await prompt(id, `TAG:${k}x4 after compaction`)
          r.afterCompact = lastReply(id); r.afterUsers = last(`${k}x4`)?.users
          if (k === 'j') { r.jwSame = api.sessions.get(id)?.jiuwenSessionId === jw0; r.msgBefore = before; r.msgAfter = await cnt() }
          // mcp-client echo tool (non-jiuwen: direct tool call; jiuwen: via dsh-tools passthrough, approval-gated → bounded deny)
          const t0 = Date.now()
          await prompt(id, `TAG:${k}echo ${k === 'j' ? 'MCP' : 'TOOL'}:mcp__echo__echo:{"text":"hi-${k}"}`)
          r.echo = { reply: lastReply(id).slice(0, 200), ms: Date.now() - t0, picked: sl().filter(x => x.tag === `${k}echo` && x.picked).at(-1)?.picked }
          // auto-review preset
          try { const pp = g('permissionPresets'); const cat = pp.catalog?.(); r.catalog = Array.isArray(cat) ? cat.map(x => x?.name || x?.id || x) : Object.keys(cat?.presets || cat || {}); const p0 = k === 'j' ? await api.gateway.rpc('permissions.tools.get', {}) : null; pp.set(sess, 'read-only'); await tick(800); const p1 = k === 'j' ? await api.gateway.rpc('permissions.tools.get', {}) : null; pp.set(sess, 'auto'); await tick(800); r.presetAuto = pp.current(sess); const p2 = k === 'j' ? await api.gateway.rpc('permissions.tools.get', {}) : null; r.perm = k === 'j' ? { ro: p1?.tools?.bash, auto: p2?.tools?.bash, base: p0?.tools?.bash } : undefined; r.perm0 = p0 } catch (e) { r.preset = 'ERR ' + e.message }
          if (k === 'j') r.jwId = jw0
        } catch (e) { err(`ext ${k}`, e.stack || e) }
      }
      out.ext.schemas = mcpSchemaNames(/ralph|terminal|worktree|echo/i)
      out.listeners1 = L(); out.unhandled = unhandled
      writeFileSync(OUT, JSON.stringify(out, null, 1)); return
    }
    // Interrupt-on-busy (MODE=busy, PR #4): a slow turn, then two user messages while it runs.
    // jiuwen: chat.interrupt, the two messages coalesce into ONE resend step with the interruption note.
    // non-jiuwen: dsh's own queueing, which must be identical with / without the adapter.
    if (MODE === 'busy') {
      const api = g('jiuwenAdapter')
      const sl = () => { try { return require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } }
      out.busy = {}
      const base = sl().length // the stand-in log is shared across runs: only look at this run's requests
      const mine = () => sl().slice(base)
      const routes = [['p', { provider: 'standin', model: 'standin-m1' }], ...(api ? [['j', { provider: 'jiuwen', model: 'jiuwen-default' }]] : [])]
      const send = (id, text) => sc.prompt({ requestId: `r-${randomUUID()}`, sessionId: id, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal).catch(e => err(`busy send ${text.slice(0, 20)}`, e))
      for (const [k, model] of routes) {
        const r = out.busy[k] = {}
        try {
          const { sessionId: id } = await sc.create({ cwd: SANDBOX }, new AbortController().signal); await sc.selectModel({ sessionId: id, ...model }, new AbortController().signal)
          await prompt(id, `TAG:${k}b0 warm up`)
          const n0 = evs(id).filter(e => e.type === 'assistant/message').length
          const t0 = Date.now()
          send(id, `TAG:${k}b1 SLOW12000 long task`)
          await tick(3000)
          send(id, `TAG:${k}b2 actually do this instead`)
          await tick(400)
          send(id, `TAG:${k}b3 and this too`)
          await tick(1500); await waitIdle(id, 90_000)
          r.ms = Date.now() - t0
          r.replies = evs(id).filter(e => e.type === 'assistant/message').slice(n0).map(e => textOf(e.data.message).slice(0, 160))
          r.reqs = mine().filter(x => /^(p|j)b[123]$/.test(x.tag) && x.tag.startsWith(k) && !/Generate the session title/.test(x.last || '')).map(x => ({ tag: x.tag, users: x.users, note: !!x.busyNote, tags: x.tags, last: (x.last || '').slice(0, 120) }))
          r.types = [...new Set(evs(id).map(e => e.type))].sort()
          if (k === 'j') {
            r.jwId = api.sessions.get(id)?.jiuwenSessionId
            // the next turn is a normal turn again (no stale note)
            await prompt(id, `TAG:${k}b4 next`)
            r.after = { reply: lastReply(id).slice(0, 120), note: !!mine().filter(x => x.tag === 'jb4').at(-1)?.busyNote }
          }
        } catch (e) { err(`busy ${k}`, e.stack || e) }
      }
      out.listeners1 = L(); out.unhandled = unhandled
      writeFileSync(OUT, JSON.stringify(out, null, 1)); return
    }
    // Memory-module plugins (MODE=mem): dsh-agent-instructions (AGENTS.md), dsh-session-reference (dsh-session:<id>),
    // dsh-experimental-session-search (session_search tool), checked for a non-jiuwen and a jiuwen session.
    if (MODE === 'mem') {
      const api = g('jiuwenAdapter')
      const sl = () => { try { return require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } }
      const last = tag => sl().filter(x => x.tag === tag && !/Generate the session title/.test(x.last || '')).at(-1)
      out.mem = {}
      const diag = id => evs(id).filter(e => /error|tool\/(call|result)|turn\/end|step\/end/.test(e.type)).slice(-6).map(e => `${e.type}:${JSON.stringify(e.data).slice(0, 220)}`)
      const routes = [['p', { provider: 'standin', model: 'standin-m1' }], ...(api ? [['j', { provider: 'jiuwen', model: 'jiuwen-default' }]] : [])]
      try {
        for (const [k, model] of routes) {
          const r = out.mem[k] = {}
          const mk = async () => { const { sessionId } = await sc.create({ cwd: SANDBOX }, new AbortController().signal); await sc.selectModel({ sessionId, ...model }, new AbortController().signal); return sessionId }
          const src = await mk(); await prompt(src, `TAG:${k}src remember MARKREFSRC${k.toUpperCase()} zebra-${k}`)
          r.src = { reply: lastReply(src), agentsMd: (last(`${k}src`)?.allMarks || []).includes('MARKAGENTSMD') }
          const ref = await mk(); await prompt(ref, `TAG:${k}ref what did dsh-session:${Buffer.from(JSON.stringify(src), 'utf8').toString('base64url')} say?`)
          const t = last(`${k}ref`); r.ref = { reply: lastReply(ref), marks: t?.marks, allMarks: t?.allMarks, diag: diag(ref) }
          await prompt(ref, `TAG:${k}ref2 and now?`)
          const t2 = last(`${k}ref2`); r.ref2 = { marks: t2?.marks, allMarks: t2?.allMarks }
          const jev = []; const offEv = api?.onEvent?.(e => { if (/tool/.test(e.type)) jev.push(`${e.type}:${String(e.name || '')}:${JSON.stringify(e.result ?? e.output ?? e.text ?? e.content ?? '').slice(0, 300)}`) })
          const t0 = Date.now()
          const ss = await mk(); await prompt(ss, `TAG:${k}ss ${k === 'j' ? 'MCP' : 'TOOL'}:session_search:{"query":"zebra-${k}"}`)
          offEv?.()
          const t3 = last(`${k}ss`); r.search = { reply: lastReply(ss).slice(0, 400), toolNames: (sl().filter(x => x.tag === `${k}ss` && x.toolNames?.length).at(-1) || {}).toolNames, picked: sl().filter(x => x.tag === `${k}ss` && x.picked).at(-1)?.picked, missing: sl().filter(x => x.tag === `${k}ss` && x.missingTool).at(-1)?.missingTool, diag: diag(ss), jiuwenToolEvents: jev, ms: Date.now() - t0 }
          if (k === 'j') r.jwIds = [src, ref, ss].map(id => api.sessions.get(id)?.jiuwenSessionId)
        }
      } catch (e) { err('mem', e.stack || e) }
      out.listeners1 = L(); out.unhandled = unhandled
      writeFileSync(OUT, JSON.stringify(out, null, 1)); return
    }
    try {
      // (a) non-jiuwen session on the pi-ai stand-in route: must be identical with / without the adapter.
      out.plain = await scenario('plain', { provider: 'standin', model: 'standin-m1' })
      // (b) jiuwen session: plugin effects read back from Jiuwen.
      const api = g('jiuwenAdapter')
      if (MODE === 'jw' && api) {
        const ok = (n, p, d = '') => out.jw.push(`${p ? 'PASS' : 'FAIL'} ${n}${d ? ` — ${String(d).slice(0, 180)}` : ''}`)
        const hb0 = await api.gateway.heartbeatConf().catch(() => null)
        const perm0 = await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)
        const j = await scenario('jw', { provider: 'jiuwen', model: 'jiuwen-default' })
        out.jwScenario = { planSvc: j.planSvc, reply1: j.reply1, reply2: j.reply2, forkReply: j.forkReply, types: j.types, skills: j.skills, presetAfter: j.presetAfter }
        const m = api.sessions.get(j.id)
        const rows = (await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []
        const row = rows.find(x => x.session_id === m?.jiuwenSessionId)
        ok('turns reach Jiuwen (stand-in)', /stand-in reply jw1/.test(j.reply1) && /stand-in reply jw2/.test(j.reply2), `${j.reply1} | ${j.reply2}`)
        ok('title (session controller rename) → Jiuwen', row?.title === 'jw 标题 ✓', row?.title)
        ok('workdir (create cwd) → mapping.projectDir', m?.projectDir === SANDBOX, m?.projectDir)
        const hb1 = await api.gateway.heartbeatConf().catch(() => null)
        ok('dsh-schedule every 7200 → Jiuwen heartbeat', Number(hb1?.every) === 7200, JSON.stringify(hb1))
        const perm1 = await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)
        // FS routing (default with the MCP passthrough) denies Jiuwen's bash/write_file/edit_file itself (adapter-first: already at
        // plugin start, so no observable "change"); presets no longer re-level them (be6b36a). Either way read-only → all three deny.
        { const lv = t => { const v = perm1?.tools?.[t]; return typeof v === 'string' ? v : v?.level }
          ok('dsh-permission-presets read-only → Jiuwen bash/write/edit deny', ['bash', 'write_file', 'edit_file'].every(t => lv(t) === 'deny'), JSON.stringify(['bash', 'write_file', 'edit_file'].map(lv))) }
        const fm = api.sessions.get(j.fork)
        ok('session controller fork → Jiuwen fork', fm?.forkedFrom === m?.jiuwenSessionId && rows.concat((await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []).some(x => x.session_id === fm?.jiuwenSessionId), JSON.stringify(fm || {}).slice(0, 160))
        ok('fork turn on Jiuwen fork', /stand-in reply jwf/.test(j.forkReply || ''), j.forkReply)
        ok('dsh-plan-mode (preset-scoped) on/off → Jiuwen chat mode cleared', j.planSvc && api.sessions.get(j.id)?.chatMode !== 'agent.plan', api.sessions.get(j.id)?.chatMode)
        const g0 = await api.gateway.rpc('command.goal', { session_id: m.jiuwenSessionId, action: 'get' }).catch(e => ({ e: e.message }))
        ok('goal cleared in Jiuwen after dsh clear', !g0?.goal, JSON.stringify(g0).slice(0, 120))
        // agent dispose / archive must NOT delete the Jiuwen session (dsh has no delete).
        try { await g('workspaceController')?.archiveSession?.({ sessionId: j.fork, stopActivity: true }) } catch (e) { err('archive', e) }
        try { const h = agentOf(j.id); await (agents.dispose?.(j.id) ?? h?.dispose?.()) } catch (e) { err('dispose', e) }
        await tick(3000)
        const rows2 = (await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []
        ok('agent dispose keeps the Jiuwen session + mapping', rows2.some(x => x.session_id === m.jiuwenSessionId) && !!api.sessions.get(j.id), m.jiuwenSessionId)
        ok('archive keeps the Jiuwen fork', rows2.some(x => x.session_id === fm?.jiuwenSessionId), fm?.jiuwenSessionId)
        // restore Jiuwen globals touched by sync
        // Since be6b36a the adapter owns the global Jiuwen permissions it routes (perm-ledger: bash/write_file/edit_file and,
        // with dsh's subagent passed through, subagent_spawn/task_tool) and keeps them while routing is on; the sanctioned
        // way to hand them back is `/jiuwen permissions release confirm` (prior level, or the override removed).
        { let rel; try { rel = await api.command(j.id, 'permissions release confirm') } catch (e) { err('perm release', e) }
          ok('/jiuwen permissions release confirm restores the adapter-owned levels', /^Restored: /.test(String(rel?.text ?? rel ?? '')) && !/failed/.test(String(rel?.text ?? rel ?? '')), String(rel?.text ?? rel ?? '').slice(0, 160)) }
        if (hb0) await api.gateway.rpc('heartbeat.set_conf', hb0).catch(e => err('hb restore', e))
        if (perm0) for (const [tool, v] of Object.entries(perm0.tools || perm0)) { const level = typeof v === 'string' ? v : v?.level; if (level && ['bash', 'write_file', 'edit_file'].includes(tool)) await api.gateway.rpc('permissions.tools.update', { tool, level }).catch(e => err('perm restore', e)) }
        ok('heartbeat restored', JSON.stringify(await api.gateway.heartbeatConf().catch(() => null)) === JSON.stringify(hb0))
        { const permEnd = await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)
          let base = perm0; try { const b = JSON.parse(require_fs().readFileSync(process.env.DRIVER_PERM_BEFORE, 'utf8')); if (b && typeof b === 'object') base = b } catch { /* own baseline */ }
          const t0 = base?.tools || {}, t1 = permEnd?.tools || {}
          ok('permissions restored (as before this dsh process started)', JSON.stringify(t1) === JSON.stringify(t0), Object.keys({ ...t0, ...t1 }).filter(k => JSON.stringify(t0[k]) !== JSON.stringify(t1[k])).map(k => `${k}:${JSON.stringify(t0[k])}→${JSON.stringify(t1[k])}`).join(' ') || 'non-tool keys differ') }
        const sl = (() => { try { return require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } })()
        const t1 = sl.filter(x => x.tag === 'jw1').at(-1), t2 = sl.filter(x => x.tag === 'jw2').at(-1), tf = sl.filter(x => x.tag === 'jwf').at(-1)
                ok('agent-preset skill (dsh-skill-filesystem) reaches Jiuwen (index + loader tool by default, or body)', [t1, t2].some(t => (t?.marks || []).includes('MARKSKILLBODY') || ((t?.skillIndex || []).includes('plain-probe-skill') && /_skill$/.test(t?.skillLoader || ''))), JSON.stringify([t1?.marks, t1?.skillIndex, t1?.skillLoader, t2?.marks]))
        ok('fork turn continues the Jiuwen fork (not a transcript resend)', tf && !/user: /.test(tf.last || '') && tf.users > 2, JSON.stringify({ users: tf?.users, last: (tf?.last || '').slice(-80) }))
        try {
          const { sessionId: mid } = await sc.create({ cwd: SANDBOX, agentPreset: 'minimal' }, new AbortController().signal)
          await sc.selectModel({ sessionId: mid, provider: 'jiuwen', model: 'jiuwen-default' }, new AbortController().signal)
          await prompt(mid, 'TAG:jwm1 hi'); await prompt(mid, 'TAG:jwm2 again')
          const sl2 = require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
          const m1 = sl2.filter(x => x.tag === 'jwm1').at(-1), m2 = sl2.filter(x => x.tag === 'jwm2').at(-1)
          // injectSystem=full (default since PR #3): the whole host system prompt, the web default persona included, is forwarded once per session and not resent unchanged.
          ok('dsh-persona preset (minimal) and the web default prompt → forwarded once, not resent unchanged', m1?.persona && !m2?.persona && t1?.persona && !t2?.persona, JSON.stringify({ m1: m1?.persona, m2: m2?.persona, def1: t1?.persona, def2: t2?.persona }))
          out.minimalId = api.sessions.get(mid)?.jiuwenSessionId
        } catch (e) { err('minimal preset', e) }
        out.jwIds = [m?.jiuwenSessionId, fm?.jiuwenSessionId]
      }
    } catch (e) { err('driver', e.stack || e) }
    out.listeners1 = L()
    out.unhandled = unhandled
    mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true })
    writeFileSync(OUT, JSON.stringify(out, null, 1))
  }, Number(process.env.DRIVER_DELAY || 6000))
}
