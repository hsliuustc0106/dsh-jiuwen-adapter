/**
 * Route Jiuwen's side-effecting built-in FS/shell tools onto the dsh MCP passthrough
 * (sandbox, approval, background jobs) instead of Jiuwen's unsandboxed builtins.
 *
 * Side-effecting only: bash / write_file / edit_file are denied on the Jiuwen side.
 * Non-side-effect tools (read_file, todo_*, memory_*, tool_search, …) stay enabled.
 * The agent is pointed at mcp_<server>_bash|write|edit|read|glob|grep.
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

/** Short hint appended once per mapped session (system-inject style). */
export function fsRouteHint(serverName = 'dsh-tools') {
  const t = dshFsToolNames(serverName)
  return [
    '[Host FS routing]',
    `Jiuwen built-in bash / write_file / edit_file are denied. For shell and file IO use the dsh passthrough tools (sandboxed, approval-gated, background-job capable):`,
    `- shell: ${t.bash}`,
    `- write: ${t.write}`,
    `- edit: ${t.edit}`,
    `- read: ${t.read}`,
    `- glob/grep: ${t.glob}, ${t.grep}`,
    '[/Host FS routing]',
  ].join('\n')
}

/**
 * Deny Jiuwen side-effecting builtins so the model is forced onto the MCP tools.
 * Fail-soft: missing Gateway method / permission service = no throw.
 */
export async function denyJiuwenSideEffectTools(rpc, logger) {
  if (typeof rpc !== 'function') return { ok: false, reason: 'no-rpc' }
  const results = []
  for (const tool of JIUWEN_SIDE_EFFECT_TOOLS) {
    try {
      await rpc('permissions.tools.update', { tool, level: 'deny' }, { timeoutMs: 10_000 })
      results.push({ tool, level: 'deny' })
    } catch (e) {
      logger?.warn?.(`[dsh-jiuwen] mapJiuwenFsToDsh: deny ${tool} failed: ${e?.message || e}`)
      results.push({ tool, error: String(e?.message || e).slice(0, 120) })
    }
  }
  return { ok: results.every(r => !r.error), results }
}

/** Exposed tools matching `patterns` (exact names or `prefix*` globs), in exposed order, de-duplicated. */
export function selectCoreTools(exposed = [], patterns = DEFAULT_CORE_TOOLS) {
  const res = patterns.map(p => new RegExp(`^${String(p).split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
  const ordered = []
  for (const re of res) for (const n of exposed) if (re.test(n) && !ordered.includes(n)) ordered.push(n)
  return ordered
}

/**
 * Passthrough tools the host prompt itself tells the model to use (named verbatim as a word in the
 * system text). Generic: works for any host whose instructions reference its tools by name.
 */
export function toolsNamedInText(exposed = [], text = '', max = 12) {
  const t = String(text || '')
  if (!t) return []
  return exposed.filter(n => n.length >= 4 && new RegExp(`(^|[^A-Za-z0-9_])${n.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(t)).slice(0, max)
}

/** Default host tools announced as "core" (generic shell/file IO names used by dsh and most hosts). */
export const DEFAULT_CORE_TOOLS = Object.freeze(['bash', 'read', 'edit', 'write', 'glob', 'grep'])

/**
 * Jiuwen progressive tools keep every MCP tool behind tool_search/tool_call. Without changing Jiuwen,
 * the adapter can still spare the per-tool discovery round trips: name the session's core host tools
 * exactly, once, and ask for a single batched tool_search that authorizes all of them.
 * Returns '' when none of `coreTools` is exposed.
 */
export function coreToolsHint(serverName, exposed = [], coreTools = DEFAULT_CORE_TOOLS) {
  const names = selectCoreTools(exposed, coreTools)
  if (!names.length) return ''
  const full = names.map(n => `mcp_${serverName}_${n}`)
  return [
    '[Host core tools]',
    `Core host tools for this session: ${full.join(', ')}.`,
    `They are deferred tools. Before the first one you need, make ONE tool_search call with query "${names.join(' ')} ${full.join(' ')}" and limit ${Math.max(names.length + 2, 5)}; that authorizes all of them for this session. Then call them through tool_call by these exact names. Do not tool_search for them again; only search for other tools.`,
    '[/Host core tools]',
  ].join('\n')
}
