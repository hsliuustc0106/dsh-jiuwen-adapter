/**
 * Opt-in dsh → Jiuwen tool passthrough over MCP (toolPassthrough: 'mcp').
 *
 * Per-dsh-session MCP servers: each dsh session gets its own Jiuwen registration
 * (`mcpServerName-<sha16>`) and its own proxy stateDir, so tools/call is attributed
 * to the calling session (Bug 5: no cross-session ownerOf guessing).
 *
 * Serves allowlisted dsh tool schemas on a private 127.0.0.1 HTTP endpoint (path
 * /mcp/<sessionKey>, random bearer token) and executes tools/call inside dsh via
 * ToolService.get(name, agent). Each call is gated by dsh approval unless
 * toolApproval: 'none'.
 *
 * Jiuwen never connects to that endpoint directly. One stable stdio MCP proxy
 * (bin/jiuwen-mcp-proxy.mjs) is registered per dsh session under a unique name
 * and owned by Jiuwen; each dsh process drops an endpoint file into that
 * session's state dir. releaseSession() cleans up on session end, after
 * `mcpSessionIdleMs` without a turn or tool call, and (only for registrations no
 * live process still serves) at startup via a one-shot garbage collection of
 * stale `<mcpServerName>-<sha16>` custom servers.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const PROXY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jiuwen-mcp-proxy.mjs')
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const writeAtomic = (f, data, mode = 0o600) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, data, { mode }); renameSync(t, f) }

/** Stable short MCP server name for one dsh session. */
export function sessionMcpName(base, sessionId) {
  const h = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  return `${base}-${h}`
}

/** Desired Jiuwen registration for the stable proxy. */
export function proxyRegistration(name, stateDir, callTimeoutMs) {
  return { name, transport: 'stdio', command: process.execPath, args: [PROXY_PATH, stateDir], timeout_s: Math.ceil(callTimeoutMs / 1000) }
}

/** Is Jiuwen's persisted record already our connected proxy (same command/args)? */
export function isProxyConnected(record, reg) {
  return Boolean(record && record.state === 'connected' && record.transport === 'stdio'
    && record.command === reg.command && JSON.stringify(record.args || []) === JSON.stringify(reg.args))
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }
/** Tool names advertised by live ep-<pid>.json endpoint files (dead pids ignored). */
export function liveToolNames(dir) {
  const out = new Set()
  let files = []
  try { files = readdirSync(dir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return out }
  for (const n of files) {
    const e = readJson(join(dir, n), null)
    if (e && Number(e.pid) && alive(Number(e.pid))) for (const t of e.tools || []) out.add(t)
  }
  return out
}

/** Live endpoint files in `dir` other than `selfFile` (dead pids ignored). */
export function otherLiveEndpoints(dir, selfFile) {
  let files = []
  try { files = readdirSync(dir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return 0 }
  let n = 0
  for (const f of files) {
    const p = join(dir, f)
    if (selfFile && p === selfFile) continue
    const e = readJson(p, null)
    if (e && Number(e.pid) && Number(e.pid) !== process.pid && alive(Number(e.pid))) n++
  }
  return n
}

export function matchesAllowlist(name, list) {
  return (list || []).some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1))
    return p === name
  })
}

const FS_HINT = new Set(['bash', 'write', 'edit', 'read', 'glob', 'grep'])
const describeTool = (s) => {
  let d = String(s.description || s.name)
  if (FS_HINT.has(s.name)) d = `[PREFERRED sandboxed dsh path — use instead of Jiuwen built-in] ${d}`
  return d.slice(0, 4000)
}

export function createMcpBridge({ config, services, rpc, logger }) {
  let server, listenReady, token
  /** sessionId → { key, name, stateDir, schemas: Map, epFile, needsRegister } */
  const sessions = new Map()
  /** sessionKey → sessionId (path routing) */
  const byKey = new Map()

  const cfg = () => config()
  const rootStateDir = () => cfg().mcpStateDir || join(homedir(), '.cache', 'dsh-jiuwen', 'mcp', cfg().mcpServerName)
  const jiuwenState = () => cfg().jiuwenMcpStateFile || join(process.env.JIUWEN_HOME || join(homedir(), '.jiuwenswarm'), 'agent', 'workspace', 'mcp', 'state.json')

  const toText = (v) => {
    if (typeof v === 'string') return v
    if (v && Array.isArray(v.content)) return v.content.map(b => (b?.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
    try { return JSON.stringify(v) } catch { return String(v) }
  }

  function ensureEntry(sessionId) {
    let e = sessions.get(sessionId)
    if (e) return e
    const key = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
    const name = sessionMcpName(cfg().mcpServerName, sessionId)
    const stateDir = join(rootStateDir(), 's', key)
    e = { key, name, stateDir, schemas: new Map(), epFile: undefined, needsRegister: false, registered: false, sessionId, lastUsed: Date.now(), inflight: 0 }
    sessions.set(sessionId, e)
    byKey.set(key, sessionId)
    return e
  }

  async function callTool(sessionId, name, args) {
    const c = cfg()
    const e = sessions.get(sessionId)
    if (!e?.schemas.has(name) || !matchesAllowlist(name, c.toolAllowlist)) {
      return { isError: true, text: `tool ${name} is not exposed by dsh (session=${sessionId})` }
    }
    const { tools, approval, agents } = services()
    let agent
    try { agent = agents?.get?.(sessionId) } catch { agent = undefined }
    let def
    try { def = agent ? tools?.get?.(name, agent) ?? agent.ctx?.tools?.get?.(name, agent) : undefined } catch { def = undefined }
    if (!def?.execute) def = tools?.get?.(name)
    if (!def?.execute) return { isError: true, text: `dsh tool ${name} not found (session=${sessionId})` }
    if (c.toolApproval !== 'none' && !matchesAllowlist(name, c.toolApprovalExempt || [])) {
      let outcome = 'unavailable'
      if (approval?.request && agent) {
        let timer
        try {
          outcome = await Promise.race([
            approval.request({ agent, toolName: name, reason: `JiuwenSwarm wants to run dsh tool ${name}` }),
            new Promise(r => { timer = setTimeout(() => r('timeout'), c.approvalTimeoutMs); timer.unref?.() }),
          ])
        } catch { outcome = 'unavailable' } finally { clearTimeout(timer) }
      }
      if (outcome !== 'allowed-once') return { isError: true, text: `dsh denied ${name} (${outcome})` }
    }
    e.lastUsed = Date.now(); e.inflight++
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), c.toolCallTimeoutMs)
    try {
      const result = await def.execute(args ?? {}, {
        callId: `jiuwen-${randomUUID()}`, name, arguments: args ?? {}, agent, signal: ac.signal,
        deferContext() {}, concludeTurn() {},
      })
      return { isError: false, text: toText(result) }
    } catch (error) {
      return { isError: true, text: `dsh tool ${name} failed: ${error?.message || error}` }
    } finally { clearTimeout(t); e.inflight--; e.lastUsed = Date.now() }
  }

  async function handle(sessionId, msg) {
    const e = sessions.get(sessionId)
    const { id, method, params } = msg || {}
    const ok = (result) => ({ jsonrpc: '2.0', id, result })
    if (method === 'initialize') {
      return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: e?.name || cfg().mcpServerName, version: '0.1.0' } })
    }
    if (method === 'ping') return ok({})
    if (method === 'tools/list') {
      const list = [...(e?.schemas.values() || [])].filter(s => matchesAllowlist(s.name, cfg().toolAllowlist))
        .map(s => ({ name: s.name, description: describeTool(s), inputSchema: s.parameters || s.inputSchema || { type: 'object', properties: {} } }))
      return ok({ tools: list })
    }
    if (method === 'tools/call') {
      const r = await callTool(sessionId, String(params?.name || ''), params?.arguments)
      return ok({ content: [{ type: 'text', text: r.text.slice(0, 200_000) }], isError: r.isError })
    }
    if (id === undefined) return null
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }

  /**
   * Merge this turn's schemas into the proxy's schemas.json. Returns true only when the published
   * tool set (names, descriptions, input schemas) actually changed on disk. The comparison is
   * against the file itself, not an in-memory signature, so it stays correct across dsh
   * processes sharing one session dir, adapter restarts, and a deleted/rewritten file.
   */
  function publishSchemas(e) {
    mkdirSync(e.stateDir, { recursive: true, mode: 0o700 })
    const f = join(e.stateDir, 'schemas.json')
    let raw = null
    try { raw = readFileSync(f, 'utf8') } catch { raw = null }
    let prev = []
    try { prev = raw ? JSON.parse(raw) : [] } catch { prev = [] }
    if (!Array.isArray(prev)) prev = []
    const byName = new Map(prev.map(t => [t.name, t]))
    for (const sch of e.schemas.values()) {
      byName.set(sch.name, { name: sch.name, description: describeTool(sch), inputSchema: sch.parameters || sch.inputSchema || { type: 'object', properties: {} } })
    }
    const next = JSON.stringify([...byName.values()])
    if (next === raw) return false
    writeAtomic(f, next, 0o644)
    return true
  }

  async function ensureRegistered(e, changed) {
    const c = cfg()
    const reg = proxyRegistration(e.name, e.stateDir, c.toolCallTimeoutMs)
    const record = readJson(jiuwenState(), {})?.mcp?.[e.name]
    const timeoutMs = c.mcpRpcTimeoutMs ?? 30_000
    if (isProxyConnected(record, reg)) {
      // Reconnect only when the published tool set changed (the proxy re-reads tools/list on connect).
      if (changed) { await rpc('mcp.disconnect', { name: reg.name }, { timeoutMs }); await rpc('mcp.connect', { name: reg.name }, { timeoutMs }) }
      return { reused: !changed, reconnected: changed }
    }
    await rpc('mcp.register_custom', reg, { timeoutMs })
    const r = await rpc('mcp.connect', { name: reg.name }, { timeoutMs })
    return { registered: true, connect: r }
  }

  function writeEp(e) {
    if (!token || !server) return
    const port = server.address()?.port
    if (!port) return
    const url = `http://127.0.0.1:${port}/mcp/${e.key}`
    e.epFile = join(e.stateDir, `ep-${process.pid}.json`)
    mkdirSync(e.stateDir, { recursive: true, mode: 0o700 })
    writeAtomic(e.epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...e.schemas.keys()], sessionId: e.sessionId }))
    return url
  }

  function removeEp(e) {
    if (e?.epFile) { try { unlinkSync(e.epFile) } catch { /* gone */ } e.epFile = undefined }
  }

  const removeAllEps = () => { for (const e of sessions.values()) removeEp(e) }

  /**
   * Release one session: drop our endpoint; delete the Jiuwen registration + state dir unless
   * another live dsh process still serves this session (then only our endpoint goes).
   */
  async function release(sessionId, reason = 'release') {
    const e = sessions.get(sessionId)
    if (!e) return null
    sessions.delete(sessionId)
    byKey.delete(e.key)
    const self = e.epFile
    removeEp(e)
    const out = { name: e.name, reason }
    if (otherLiveEndpoints(e.stateDir, self) > 0) { out.shared = true; return out }
    const timeoutMs = cfg().mcpRpcTimeoutMs ?? 30_000
    try { out.disconnect = await rpc('mcp.disconnect', { name: e.name }, { timeoutMs }) } catch (err) { out.disconnect = String(err?.message || err) }
    try { out.delete = await rpc('mcp.delete_custom', { name: e.name }, { timeoutMs }) } catch (err) { out.delete = String(err?.message || err) }
    try { rmSync(e.stateDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return out
  }

  // ── idle TTL: release sessions with no turn/tool call for mcpSessionIdleMs (0 = off) ──
  let sweeper
  const idleMs = () => { const v = Number(cfg().mcpSessionIdleMs ?? 30 * 60_000); return Number.isFinite(v) && v > 0 ? v : 0 }
  async function sweepIdle(now = Date.now()) {
    const ttl = idleMs()
    if (!ttl) return []
    const out = []
    for (const [id, e] of [...sessions]) {
      if (e.inflight > 0 || e.preparing > 0 || now - e.lastUsed < ttl) continue
      try { out.push(await release(id, 'idle')) } catch (err) { logger?.debug?.(`[dsh-jiuwen] idle MCP release failed: ${err?.message || err}`) }
    }
    if (out.length) logger?.info?.(`[dsh-jiuwen] released ${out.length} idle per-session MCP proxy registration(s)`)
    return out
  }
  function startSweeper() {
    const ttl = idleMs()
    if (sweeper || !ttl) return
    sweeper = setInterval(() => { sweepIdle().catch(() => {}) }, Math.max(1000, Math.min(60_000, Math.floor(ttl / 4))))
    sweeper.unref?.()
  }

  // ── startup GC of stale per-session registrations (once per bridge, fail-soft) ──
  let gcDone
  /**
   * Delete `<mcpServerName>-<sha16>` custom servers that no live process owns. Only touches names
   * whose state dir exists under this adapter's mcpStateDir (so registrations made by another host
   * or another state dir are never removed), has no live endpoint file, and has not been modified
   * for `mcpGcGraceMs` (so a process that is registering right now is left alone).
   */
  async function gcStale(now = Date.now()) {
    const c = cfg()
    if (c.mcpGcOnStart === false) return { skipped: true }
    const timeoutMs = c.mcpRpcTimeoutMs ?? 30_000
    const grace = Number(c.mcpGcGraceMs ?? 120_000)
    let listed
    try { listed = await rpc('mcp.list', { filter: 'all' }, { timeoutMs }) } catch (err) { return { error: String(err?.message || err) } }
    const items = Array.isArray(listed) ? listed : (listed?.items || listed?.servers || [])
    const esc = String(c.mcpServerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${esc}-([a-f0-9]{16})$`)
    const own = new Set([...sessions.values()].map(e => e.name))
    const removed = []
    for (const it of items) {
      const name = String(it?.name || it?.id || it || '')
      const m = re.exec(name)
      if (!m || own.has(name)) continue
      const dir = join(rootStateDir(), 's', m[1])
      let st
      try { st = statSync(dir) } catch { continue } // not ours (or already cleaned): never touch
      if (now - st.mtimeMs < grace) continue
      if (otherLiveEndpoints(dir) > 0) continue
      try { await rpc('mcp.disconnect', { name }, { timeoutMs }) } catch { /* may be disconnected */ }
      try { await rpc('mcp.delete_custom', { name }, { timeoutMs }) } catch (err) { logger?.debug?.(`[dsh-jiuwen] MCP GC delete ${name}: ${err?.message || err}`); continue }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      removed.push(name)
    }
    if (removed.length) logger?.info?.(`[dsh-jiuwen] removed ${removed.length} stale per-session MCP registration(s)`)
    return { removed }
  }

  function startListen() {
    if (listenReady) return listenReady
    token = randomBytes(24).toString('hex')
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const m = /^\/mcp\/([a-f0-9]{16})\/?$/.exec(req.url || '')
      if (!m) { res.writeHead(404).end(); return }
      const sessionId = byKey.get(m[1])
      if (!sessionId) { res.writeHead(404).end(); return }
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 10_000_000) req.destroy() })
      req.on('end', async () => {
        let msg
        try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
        const out = Array.isArray(msg)
          ? (await Promise.all(msg.map(x => handle(sessionId, x)))).filter(Boolean)
          : await handle(sessionId, msg)
        if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      })
    })
    server.unref?.()
    server.keepAliveTimeout = 1000
    server.on('connection', (sock) => sock.unref?.())
    listenReady = new Promise((resolve) => {
      server.once('error', (error) => resolve({ error: String(error?.message || error) }))
      server.listen(0, '127.0.0.1', () => {
        process.off('exit', removeAllEps); process.once('exit', removeAllEps) // compat-allow: ep-file cleanup, detached in stop()
        resolve({ ok: true })
      })
    })
    return listenReady
  }

  return {
    /**
     * Refresh exposed schemas for this dsh session; register a per-session MCP server.
     * Returns { url, mcpServerName, ... } — caller must put mcpServerName into chat.send mcp[].
     */
    async prepare(tools, sessionId) {
      const e = ensureEntry(sessionId)
      e.lastUsed = Date.now()
      e.schemas.clear()
      for (const t of tools || []) if (t?.name && matchesAllowlist(t.name, cfg().toolAllowlist)) e.schemas.set(t.name, t)
      if (!e.schemas.size) return null

      const lr = await startListen()
      if (lr?.error) return { error: lr.error, mcpServerName: e.name }
      startSweeper()
      if (!gcDone) { gcDone = gcStale().catch(() => ({})) } // background: never delays the turn
      e.preparing = (e.preparing || 0) + 1

      const url = writeEp(e)
      try {
        const changed = publishSchemas(e)
        writeEp(e)
        let out = { url, mcpServerName: e.name }
        if (e.needsRegister || !e.registered) {
          Object.assign(out, await ensureRegistered(e, changed))
          e.needsRegister = false
          if (!out.error) e.registered = true
        } else if (changed) {
          Object.assign(out, await ensureRegistered(e, true))
        } else {
          out.reused = true
        }
        logger?.info?.(`[dsh-jiuwen] dsh tools exposed via per-session MCP "${e.name}" (${e.schemas.size} schema(s), session=${sessionId})`)
        return out
      } catch (error) {
        logger?.warn?.(`[dsh-jiuwen] MCP passthrough registration failed: ${error?.message || error}`)
        return { url, mcpServerName: e.name, error: String(error?.message || error) }
      } finally { e.preparing--; e.lastUsed = Date.now() }
    },

    /** Drop one session's registration + endpoint (session end / dispose). */
    async releaseSession(sessionId) { return release(sessionId, 'session-end') },

    /** Release sessions idle for >= mcpSessionIdleMs (also runs on an unref'd timer). */
    sweepIdle,
    /** Startup GC of stale per-session registrations (runs once, in the background, on first prepare). */
    gcStale,

    exposed: (sessionId) => {
      if (sessionId) return [...(sessions.get(sessionId)?.schemas.keys() || [])]
      const all = new Set()
      for (const e of sessions.values()) for (const n of e.schemas.keys()) all.add(n)
      return [...all]
    },

    sessionServerName: (sessionId) => sessions.get(sessionId)?.name || sessionMcpName(cfg().mcpServerName, sessionId),

    async verify(sessionId) {
      const name = sessionId ? (sessions.get(sessionId)?.name || sessionMcpName(cfg().mcpServerName, sessionId)) : cfg().mcpServerName
      try {
        const r = await rpc('mcp.show', { name }, { timeoutMs: cfg().mcpRpcTimeoutMs ?? 30_000 })
        const it = r?.item || r || {}
        const tools = (Array.isArray(it.tools) ? it.tools : []).map(t => t?.name || t).filter(Boolean).map(String)
        return { name, registered: true, state: it.connection_state || it.state || 'unknown', category: it.category, tools, exposed: this.exposed(sessionId) }
      } catch (err) {
        const msg = String(err?.message || err)
        return { name, registered: /not found/i.test(msg) ? false : undefined, error: msg.slice(0, 200), tools: [], exposed: this.exposed(sessionId) }
      }
    },

    async dispose() {
      for (const e of sessions.values()) removeEp(e)
      process.off('exit', removeAllEps)
      if (sweeper) { clearInterval(sweeper); sweeper = undefined }
      if (server) { server.close(); server = undefined; listenReady = undefined }
      sessions.clear(); byKey.clear()
    },

    /** Explicit teardown of all session registrations (e.g. /jiuwen mcp-reset). */
    async unregister() {
      const timeoutMs = cfg().mcpRpcTimeoutMs ?? 30_000
      const out = { sessions: [] }
      for (const e of sessions.values()) {
        const one = { name: e.name }
        try { one.disconnect = await rpc('mcp.disconnect', { name: e.name }, { timeoutMs }) } catch (err) { one.disconnect = String(err?.message || err) }
        try { one.delete = await rpc('mcp.delete_custom', { name: e.name }, { timeoutMs }) } catch (err) { one.delete = String(err?.message || err) }
        e.needsRegister = true; e.registered = false
        out.sessions.push(one)
      }
      // Also try base name (legacy single-server registrations).
      const base = cfg().mcpServerName
      try { out.disconnect = await rpc('mcp.disconnect', { name: base }, { timeoutMs }) } catch (err) { out.disconnect = String(err?.message || err) }
      try { out.delete = await rpc('mcp.delete_custom', { name: base }, { timeoutMs }) } catch (err) { out.delete = String(err?.message || err) }
      return out
    },

    /** Test helper: handle as a given session (no HTTP). */
    _handle: (msg, sessionId = [...sessions.keys()][0]) => handle(sessionId, msg),
    _sessions: sessions,
  }
}
