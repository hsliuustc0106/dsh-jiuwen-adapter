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
