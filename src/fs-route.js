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
