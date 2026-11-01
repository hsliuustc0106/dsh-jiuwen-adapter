/**
 * Expected Jiuwen global tool permissions after `/jiuwen permissions release confirm`.
 *
 * The plain-dsh suite runs several dsh processes against one Jiuwen and one adapter permission
 * ledger (HOME/jiuwen-adapter/jiuwen-permissions.json). While dsh tool routing is on, a process
 * keeps its owned denies (bash/write_file/edit_file, subagent_spawn/task_tool) and re-applies them
 * on the next turn even after a release, so the Jiuwen state seen right before a later process
 * starts still holds those adapter-owned levels. A release restores each owned entry to its
 * recorded `prior` (or removes the override), so the baseline is the live state with every
 * ledger-owned entry put back to its prior — not the raw pre-process state.
 *
 * @param {{ tools?: Record<string, any> } | null} perm  permissions.tools.get result
 * @param {any} ledger  parsed jiuwen-permissions.json ({ targets: { [gw]: { tools: { [t]: { level, prior } } } } })
 */
export function permBaseline(perm, ledger) {
  if (!perm || typeof perm !== 'object') return perm ?? null
  const tools = { ...(perm.tools || {}) }
  for (const t of Object.values(ledger?.targets || {})) {
    for (const [tool, rec] of Object.entries(t?.tools || {})) {
      const cur = tools[tool]
      const lvl = typeof cur === 'string' ? cur : cur?.['*'] ?? cur?.level
      if (lvl !== rec?.level) continue // changed outside the adapter: a release leaves it alone
      if (rec.prior == null) delete tools[tool]
      else tools[tool] = rec.prior
    }
  }
  return { ...perm, tools }
}
