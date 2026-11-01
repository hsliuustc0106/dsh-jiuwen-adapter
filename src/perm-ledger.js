/**
 * Owned, reversible Jiuwen global tool-permission writes.
 *
 * Jiuwen's `permissions.tools` levels are global (config.yaml): one value is shared by every
 * session and client of that Jiuwen, and the Gateway offers no per-session deny. The adapter only
 * writes them for dsh tool routing (deny Jiuwen's bash / write_file / edit_file and, optionally,
 * its delegation built-ins) and for the permission-preset mirror. Each write is recorded here with
 * the level that was there before (`prior`), per Gateway target, so the adapter can:
 *  - re-apply its entries idempotently (no write when the value is already what it wrote),
 *  - restore exactly the entries it owns when routing is turned off or on `/jiuwen permissions
 *    release` (prior level, or remove the override when there was none),
 *  - never stomp a user value: an owned entry whose current value differs from what the adapter
 *    last wrote was changed by someone else → ownership is dropped and the value is left alone.
 *
 * Entries written before this ledger existed (the routed side-effect denies) are adopted when they
 * hold exactly the adapter's value; on release they are removed (Jiuwen's defaults apply).
 */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LEVELS = new Set(['allow', 'ask', 'deny'])

function levelOf(v) {
  const s = v && typeof v === 'object' ? v['*'] : v
  const l = String(s ?? '').trim().toLowerCase()
  return LEVELS.has(l) ? l : null
}

/**
 * @param {{ file: string, rpc: (method: string, params?: object, opts?: object) => Promise<any>, logger?: any, target?: string }} deps
 */
export function createPermissionLedger({ file, rpc, logger, target = 'default' }) {
  let tail = Promise.resolve()
  const serial = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run }

  const load = () => {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'))
      return d && typeof d === 'object' && d.targets && typeof d.targets === 'object' ? d : { version: 1, targets: {} }
    } catch { return null }
  }
  const save = (d) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) { logger?.warn?.(`[dsh-jiuwen] permission ledger not saved (${file}): ${e?.message || e}`) }
  }
  const owned = (d) => (d.targets[target] ||= { tools: {} }).tools

  async function currentLevels() {
    const r = await rpc('permissions.tools.get', {}, { timeoutMs: 10_000 })
    const tools = r?.tools && typeof r.tools === 'object' ? r.tools : {}
    const out = {}
    for (const [k, v] of Object.entries(tools)) out[k] = levelOf(v)
    return out
  }
  async function write(tool, level) {
    if (level === null) {
      try { await rpc('permissions.tools.delete', { tool }, { timeoutMs: 10_000 }) } catch (e) { if (!/not.?found/i.test(String(e?.message || e))) throw e }
    } else {
      await rpc('permissions.tools.update', { tool, level }, { timeoutMs: 10_000 })
    }
  }

  /**
   * Make the adapter's entries for `owner` exactly `desired` ({ tool: level }): apply missing ones
   * (recording the prior level), release owned entries no longer desired. `adopt`: { tool: level }
   * pre-ledger values to take ownership of when found unowned and equal (only on the first run).
   */
  function reconcile(desired, { owner = 'route', adopt = {} } = {}) {
    return serial(async () => {
      const existing = load()
      const firstRun = existing === null
      const d = existing || { version: 1, targets: {} }
      const mine = owned(d)
      let cur
      try { cur = await currentLevels() } catch (e) {
        logger?.warn?.(`[dsh-jiuwen] permissions.tools.get failed; Jiuwen permissions not reconciled: ${e?.message || e}`)
        return { ok: false, error: String(e?.message || e).slice(0, 200), applied: [], released: [], dropped: [], adopted: [] }
      }
      const out = { ok: true, applied: [], released: [], dropped: [], adopted: [], kept: [], errors: [] }
      for (const [tool, level] of Object.entries(desired)) {
        const now = cur[tool] ?? null
        const rec = mine[tool]
        if (rec && rec.level !== now) {
          // Changed by someone else since we wrote it: theirs wins.
          delete mine[tool]; out.dropped.push(tool)
          logger?.info?.(`[dsh-jiuwen] Jiuwen permission ${tool}=${now ?? '(unset)'} was changed outside the adapter; leaving it (no longer adapter-owned)`)
          continue
        }
        if (now === level) {
          if (rec) { rec.owner = owner; out.kept.push(tool) }
          else if (firstRun && adopt[tool] === level) { mine[tool] = { level, prior: null, owner, adopted: true }; out.adopted.push(tool) }
          continue
        }
        try {
          await write(tool, level)
          mine[tool] = { level, prior: rec ? rec.prior : now, owner, at: new Date().toISOString() }
          out.applied.push(tool)
        } catch (e) { out.ok = false; out.errors.push({ tool, error: String(e?.message || e).slice(0, 120) }) }
      }
      for (const [tool, rec] of Object.entries({ ...mine })) {
        if (rec.owner !== owner || Object.hasOwn(desired, tool)) continue
        const r = await releaseOne(mine, tool, rec, cur)
        out[r].push(tool)
      }
      if (!firstRun || Object.keys(mine).length || out.released.length || out.dropped.length) save(d)
      return out
    })
  }

  async function releaseOne(mine, tool, rec, cur) {
    const now = cur[tool] ?? null
    if (now !== rec.level) { delete mine[tool]; return 'dropped' }
    try {
      await write(tool, rec.prior ?? null)
      delete mine[tool]
      return 'released'
    } catch (e) {
      logger?.warn?.(`[dsh-jiuwen] restoring Jiuwen permission ${tool} failed: ${e?.message || e}`)
      return 'errors'
    }
  }

  /** Record a write the caller already made (e.g. preset mirror), keeping the original prior. */
  function record(tool, level, { owner = 'preset', prior } = {}) {
    return serial(async () => {
      const d = load() || { version: 1, targets: {} }
      const mine = owned(d)
      const rec = mine[tool]
      mine[tool] = { level, prior: rec ? rec.prior : (prior ?? null), owner: rec?.owner === 'route' ? 'route' : owner, at: new Date().toISOString() }
      save(d)
    })
  }

  /** Restore every entry this adapter owns (optionally one owner). */
  function release({ owner } = {}) {
    return serial(async () => {
      const d = load()
      if (!d) return { ok: true, released: [], dropped: [], errors: [] }
      const mine = owned(d)
      let cur
      try { cur = await currentLevels() } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200), released: [], dropped: [], errors: [] } }
      const out = { ok: true, released: [], dropped: [], errors: [] }
      for (const [tool, rec] of Object.entries({ ...mine })) {
        if (owner && rec.owner !== owner) continue
        out[await releaseOne(mine, tool, rec, cur)].push(tool)
      }
      if (out.errors.length) out.ok = false
      save(d)
      return out
    })
  }

  /** Owned entries for this target: { tool: { level, prior, owner } }. */
  function entries() { return { ...(load()?.targets?.[target]?.tools || {}) } }

  return { reconcile, record, release, entries, file, target }
}
