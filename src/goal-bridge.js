/**
 * Jiuwen goal report → dsh goal.
 *
 * With dsh's goal tools passed through, the goal lives in dsh (host-sync no longer arms Jiuwen's
 * own goal). A Jiuwen model may still call its built-in `submit_goal_report` (directly or through
 * the progressive `tool_call`), e.g. for a goal set with `/jiuwen goal`. Before, `complete` then
 * finished only Jiuwen's copy: dsh kept driving goal rounds until round-limit and ended `blocked`.
 * This bridge mirrors an accepted `complete` / `blocked` report onto dsh's `update_goal` (after
 * `get_goal` for the id/revision), through the same pipeline as a passthrough call, while the
 * dsh turn that carries it is still open (dsh-tool-goal requires the live calling agent).
 */
const ACCEPTED = /Goal report accepted \(status:\s*(complete|blocked|continue)\)/i

function parse(v) {
  if (v && typeof v === 'object') return v
  try { return JSON.parse(String(v ?? '')) } catch { return {} }
}

/**
 * @param {{ callTool: (sid: string, name: string, args: object) => Promise<{ isError: boolean, text: string }>,
 *   exposed: (sid: string) => string[], enabled?: () => boolean, logger?: any }} deps
 */
export function createGoalBridge({ callTool, exposed, enabled = () => true, logger }) {
  /** `${sid}|${toolCallId}` → report arguments (for the blocked reason). */
  const calls = new Map()

  async function mirror(sid, status, report) {
    const have = exposed(sid) || []
    if (!have.includes('update_goal') || !have.includes('get_goal')) return { skipped: 'goal-tools-not-exposed' }
    const g = await callTool(sid, 'get_goal', {})
    if (g?.isError) return { skipped: 'get_goal-failed', error: String(g.text).slice(0, 200) }
    const goal = parse(g?.text)?.goal
    if (!goal?.id || goal.phase !== 'active') return { skipped: goal ? `phase-${goal.phase}` : 'no-goal' }
    const args = { goal_id: goal.id, revision: goal.revision, action: status }
    if (status === 'blocked') args.blocked_reason = String(report?.remaining_work || report?.evidence || 'Jiuwen reported the goal blocked').slice(0, 2000)
    const r = await callTool(sid, 'update_goal', args)
    if (r?.isError) logger?.info?.(`[dsh-jiuwen] goal bridge: dsh update_goal ${status} refused: ${String(r.text).slice(0, 200)}`)
    else logger?.info?.(`[dsh-jiuwen] goal bridge: Jiuwen submit_goal_report ${status} → dsh goal ${goal.id} ${status}`)
    return { action: status, goalId: goal.id, isError: Boolean(r?.isError) }
  }

  /**
   * Observe one adapter stream event; returns a promise when a dsh goal update was started.
   * @param {string} sid dsh session id
   * @param {{ type: string, name?: string, id?: string, arguments?: string, result?: string, success?: boolean }} e
   */
  function observe(sid, e) {
    if (!e || !sid || !enabled()) return undefined
    if (e.type === 'tool_call') {
      const a = parse(e.arguments)
      const report = e.name === 'submit_goal_report' ? a : (e.name === 'tool_call' && a?.name === 'submit_goal_report' ? parse(a.args ?? a.arguments) : null)
      if (report && e.id) calls.set(`${sid}|${e.id}`, report)
      return undefined
    }
    if (e.type !== 'tool_result' || (e.name !== 'submit_goal_report' && e.name !== 'tool_call')) return undefined
    const key = `${sid}|${e.id}`
    const report = calls.get(key)
    calls.delete(key)
    if (e.success === false) return undefined
    const m = ACCEPTED.exec(String(e.result ?? ''))
    // Jiuwen normalizes the status (an invalid one becomes `continue`): trust its acknowledgement.
    const status = m ? m[1].toLowerCase() : (e.name === 'submit_goal_report' ? String(report?.status || '').toLowerCase() : '')
    if (status !== 'complete' && status !== 'blocked') return undefined
    return mirror(sid, status, report).catch(err => { logger?.warn?.(`[dsh-jiuwen] goal bridge failed: ${err?.message || err}`); return { error: String(err?.message || err) } })
  }

  return { observe, mirror }
}
