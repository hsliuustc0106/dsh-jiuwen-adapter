/**
 * Route Jiuwen's side-effecting built-in FS/shell tools onto the dsh MCP passthrough
 * (sandbox, approval, background jobs) instead of Jiuwen's unsandboxed builtins.
 *
 * Side-effecting bash / write_file / edit_file are denied on the Jiuwen side (and, with
 * hideJiuwenBuiltins: 'deny', the delegation built-ins whose children could not act). Other
 * duplicates of a dsh tool (read_file, grep, glob, skill_tool, goal tools, …) are hidden softly:
 * the prompt hint maps them to mcp_<server>_<tool> and their permission asks are decided by the
 * adapter (interaction.js), never a dsh card. Global Jiuwen permission writes are owned and
 * reversible (perm-ledger.js).
 */
export const JIUWEN_SIDE_EFFECT_TOOLS = Object.freeze(['bash', 'write_file', 'edit_file'])

/** dsh tool name → preferred Jiuwen-visible MCP name (server-prefixed). */
export function dshFsToolNames(serverName = 'dsh-tools') {
  const p = `mcp_${serverName}_`
  return {
    bash: `${p}bash`,
    write: `${p}write`,
    edit: `${p}edit`,
    read: `${p}read`,
    glob: `${p}glob`,
    grep: `${p}grep`,
  }
}

/**
 * Jiuwen built-ins that duplicate a dsh tool → that dsh tool. With dsh tool routing on
 * (mapJiuwenFsToDsh + the MCP passthrough) these are "hidden": the model is told to use the dsh
 * tool, Jiuwen permission asks for them are decided by the adapter (never a dsh card), and the
 * side-effecting / delegation ones are denied on the Jiuwen side. Only entries whose dsh
 * counterpart is actually exposed through the passthrough this session apply.
 */
export const JIUWEN_DUPLICATE_BUILTINS = Object.freeze({
  bash: 'bash',
  write_file: 'write',
  edit_file: 'edit',
  read_file: 'read',
  glob: 'glob',
  grep: 'grep',
  list_files: 'glob',
  skill_tool: 'skill',
  subagent_spawn: 'subagent',
  task_tool: 'subagent',
  fetch_webpage: 'web_fetch',
  free_search: 'web_search',
  paid_search: 'web_search',
  get_current_goal: 'get_goal',
  submit_goal_report: 'update_goal',
})

/** Read-only file built-ins Jiuwen itself uses on its own data dir (plan files, skills, memory). */
export const JIUWEN_INTERNAL_READ_TOOLS = Object.freeze(['read_file', 'glob', 'grep', 'list_files'])

/**
 * Delegation built-ins denied on the Jiuwen side when routing is on and dsh's `subagent` tool is
 * passed through (hideJiuwenBuiltins: 'deny', the default): Jiuwen's own sub-agents get neither the
 * dsh-tools MCP nor Jiuwen's (denied) bash / write_file / edit_file, so they cannot act; delegation
 * goes through dsh's `subagent` tool instead. Not the read-only file tools (Jiuwen's plan mode and
 * skill loading read its own data dir with them) and not network/goal tools (other Jiuwen clients).
 */
export const JIUWEN_HIDE_DENY_TOOLS = Object.freeze(['subagent_spawn', 'task_tool'])

/** `mcp_<server>_<tool>` as Jiuwen names a passthrough tool. */
export function mcpToolName(serverName, tool) { return `mcp_${serverName || 'dsh-tools'}_${tool}` }

/**
 * Duplicate built-ins that apply for an exposed dsh tool set: [{ builtin, dsh, mcp }].
 * `exposed` undefined = unknown → assume dsh's core file/shell tools (bash/read/write/edit/glob/grep).
 */
export function routedBuiltins(exposed, serverName = 'dsh-tools') {
  const have = Array.isArray(exposed) ? new Set(exposed.map(String)) : new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep'])
  return Object.entries(JIUWEN_DUPLICATE_BUILTINS)
    .filter(([, dsh]) => have.has(dsh))
    .map(([builtin, dsh]) => ({ builtin, dsh, mcp: mcpToolName(serverName, dsh) }))
}

/** The dsh tool a Jiuwen built-in is routed to in this session, or undefined. */
export function routedCounterpart(builtin, exposed) {
  const dsh = JIUWEN_DUPLICATE_BUILTINS[String(builtin || '')]
  if (!dsh) return undefined
  if (Array.isArray(exposed) && !exposed.map(String).includes(dsh)) return undefined
  return dsh
}

/**
 * Is `p` inside Jiuwen's own data dir (`~/.jiuwenswarm` or $JIUWENSWARM_DATA_DIR, i.e. any path with
 * a `.jiuwenswarm` segment)? Jiuwen reads its plan files (`…/.plans/*.md`), installed skills and
 * memory there; those internal reads are allowed, never turned into a dsh card.
 */
export function isJiuwenInternalPath(p, env = process.env) {
  let s = String(p || '').trim()
  if (!s) return false
  if (s.startsWith('~/')) s = `${env.HOME || ''}/${s.slice(2)}`
  s = s.replace(/\\/g, '/')
  if (s.split('/').some(seg => seg === '..')) return false
  if (s.split('/').includes('.jiuwenswarm')) return true
  const dataDir = String(env.JIUWENSWARM_DATA_DIR || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return Boolean(dataDir) && (s === dataDir || s.startsWith(`${dataDir}/`))
}

/**
 * Short hint appended once per mapped session (system-inject style): which Jiuwen built-ins are
 * hidden here and the dsh tool to use instead. `exposed`: the dsh tool names passed through this
 * session (undefined = unknown → the core file/shell set).
 */
export function fsRouteHint(serverName = 'dsh-tools', exposed, mode = 'deny') {
  const legacy = mode === 'off'
  const rows = routedBuiltins(exposed, serverName).filter(r => !legacy || JIUWEN_SIDE_EFFECT_TOOLS.includes(r.builtin) || ['read_file', 'glob', 'grep'].includes(r.builtin))
  const byDsh = new Map()
  for (const r of rows) byDsh.set(r.mcp, [...(byDsh.get(r.mcp) || []), r.builtin])
  const has = (b) => !legacy && rows.some(r => r.builtin === b)
  return [
    '[Host FS routing]',
    'Jiuwen built-in bash / write_file / edit_file are denied. This session runs inside dsh: Jiuwen built-ins that duplicate a dsh tool are hidden here — call the dsh passthrough tool instead (sandboxed, approval-gated, background-job capable):',
    ...[...byDsh].map(([mcp, builtins]) => `- ${builtins.join(' / ')} → ${mcp}`),
    ...(has('read_file') ? ['Permission asks for the hidden built-ins are declined automatically (reads of Jiuwen\'s own data dir, e.g. its plan files, are allowed).'] : []),
    ...(has('subagent_spawn') ? [`Delegate with ${mcpToolName(serverName, 'subagent')} (Jiuwen sub-agents cannot run shell/file tools here).`] : []),
    ...(has('submit_goal_report') ? [`Goals live in dsh: read them with ${mcpToolName(serverName, 'get_goal')} and finish them with ${mcpToolName(serverName, 'update_goal')} (action complete / blocked).`] : []),
    '[/Host FS routing]',
  ].join('\n')
}

/** Per-process record of permissions.tools.update payloads already applied, keyed by `<target>|<tool>`. */
const sentPermissions = new Map()
/** Forget what was sent (tests; or after the Gateway target lost its state). */
export function resetSentPermissions(target) {
  if (target === undefined) { sentPermissions.clear(); return }
  for (const k of [...sentPermissions.keys()]) if (k.startsWith(`${target}|`)) sentPermissions.delete(k)
}

/**
 * Deny Jiuwen side-effecting builtins. Each `permissions.tools.update` is sent only when its payload
 * differs from the last one successfully sent to the same Gateway `target` in this process (many
 * plugin instances / sessions in one dsh process share it); failures are retried next time.
 */
export async function denyJiuwenSideEffectTools(rpc, logger, { target = 'default' } = {}) {
  if (typeof rpc !== 'function') return { ok: false, reason: 'no-rpc' }
  const results = []
  for (const tool of JIUWEN_SIDE_EFFECT_TOOLS) {
    const key = `${target}|${tool}`
    const payload = JSON.stringify({ tool, level: 'deny' })
    if (sentPermissions.get(key) === payload) { results.push({ tool, level: 'deny', cached: true }); continue }
    try {
      await rpc('permissions.tools.update', { tool, level: 'deny' }, { timeoutMs: 10_000 })
      sentPermissions.set(key, payload)
      results.push({ tool, level: 'deny' })
    } catch (e) {
      logger?.warn?.(`[dsh-jiuwen] mapJiuwenFsToDsh: deny ${tool} failed: ${e?.message || e}`)
      results.push({ tool, error: String(e?.message || e).slice(0, 120) })
    }
  }
  return { ok: results.every(r => !r.error), results }
}
