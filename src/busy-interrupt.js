/**
 * Interrupt-and-resend on a busy session (onBusyMessage: 'interrupt', default).
 *
 * Jiuwen has no mid-turn injection, so a user message that reaches a host session while its
 * Jiuwen turn is still running would otherwise wait in the host inbox until the turn ends.
 * With 'interrupt' the adapter:
 *   1. sends chat.interrupt {intent:'cancel'} for the running Jiuwen request and waits for it to
 *      settle (chat.interrupt_result / completion, bounded by interruptSettleMs);
 *   2. moves every message still queued for later turns (host inbox `next-turn`) to the step
 *      boundary (`next-step`, same as the host's own "steer a queued message" action), so all
 *      messages that arrived meanwhile coalesce into ONE follow-up step;
 *   3. ends the host stream with `stop`; the host loop then runs one new step whose trailing user
 *      messages are the new message(s), and the adapter prefixes that query with a short note that
 *      the previous turn was interrupted and its side effects were not rolled back.
 *
 * Generic: keyed by host session id only; no plugin/profile specific logic.
 * Approval pending: the interrupt is deferred until the approval card resolves (the transport is
 * awaiting the host answer; the request is queued behind it), then fires. A pending Jiuwen
 * *question* card is left to the existing "user message supersedes the question" path.
 * Host stop/cancel always wins: an aborted turn finishes `aborted`, nothing is promoted or noted.
 */

/**
 * Inbox sources that are host automation, not a person typing (never interrupt): question-card replies,
 * schedules, goal rounds, sub-agent results / inter-agent messages. Plus any message with
 * `source.form === 'notice'` (injected notices). Everything else that wakes the session — dsh web/RPC
 * prompts (`user`), and messages a plugin relays on behalf of a person (e.g. an IM bridge) — interrupts.
 * Override with config `busyIgnoreSources`.
 */
export const DEFAULT_BUSY_IGNORE_SOURCES = Object.freeze(['user-question-reply', 'schedule', 'goal', 'subagent', 'subagent-settled', 'agent-message', 'runtime-context', 'system'])

/** Note prepended to the resend query (consumed once). */
export function interruptNote(count = 1) {
  return `[Note from the host adapter: your previous turn was interrupted because the user sent ${count > 1 ? `${count} new messages` : 'a new message'} before it finished. `
    + 'Tool calls and side effects that already ran in that turn (file edits, commands, commits, messages, tickets) were NOT rolled back — check the current state before redoing or undoing work. '
    + 'The message(s) below are the latest instructions and supersede the interrupted request where they conflict.]'
}

/**
 * Text of messages whose turn was interrupted before its chat.send went out (Jiuwen never saw them).
 * Prepended to the resend so they are not lost.
 */
export function carryBlock(text) {
  return `[Earlier message(s) from the user, sent while the previous turn was being interrupted (not seen by you yet):]\n${text}\n\n[Newest message(s):]`
}

/** True when an inbox message should trigger an interrupt (person-originated input, not automation). */
export function isUserMessage(message, ignore = DEFAULT_BUSY_IGNORE_SOURCES) {
  if (!message || typeof message !== 'object') return false
  if (message.role && message.role !== 'user') return false
  const src = message.source
  if (src?.form === 'notice') return false
  const kind = src?.kind
  if (kind === undefined) return true
  return !ignore.includes(String(kind))
}

/**
 * @param {{ config: () => any, subscribe?: (fn: (id: string, message: any) => string) => unknown, agentFor?: (id: string) => any, trace?: (rec: object) => void, logger?: any }} deps
 */
export function createBusyRegistry(deps) {
  /** dshSessionId -> live turn state */
  const turns = new Map()
  /** dshSessionId -> { count } pending note for the next turn */
  const notes = new Map()
  let subscribed = false
  const trace = (rec) => { try { deps.trace?.(rec) } catch { /* ignore */ } }

  const api = {
    /** Register a running (non-aux) Jiuwen turn; returns the handle passed to the transport. */
    begin(dshSessionId) {
      if (!subscribed) { subscribed = true; try { deps.subscribe?.((id, m) => api.noteMessage(id, m)) } catch { /* host without inbox events */ } }
      const st = {
        fire: null, requested: false, count: 0, awaiting: null, done: false, at: 0,
        /** set by the adapter: this turn's user text (incl. any carried text) and how many messages it holds */
        userText: '', userCount: 0,
        /** transport: subscribe; fires immediately when a request already arrived. */
        attach(fn) { st.fire = fn; if (st.requested && !st.done) fn() },
        /** transport: the interrupt settled and the stream is about to finish `stop`. */
        settled(info = {}) {
          if (st.done) return
          st.done = true
          let promoted = 0
          try {
            const agent = deps.agentFor?.(dshSessionId)
            const inbox = agent?.inbox
            const queued = inbox?.nextTurn?.length || 0
            if (queued && typeof inbox.splice === 'function') {
              const moved = inbox.splice('next-turn', 0, queued, [])
              inbox.splice('next-step', inbox.nextStep?.length ?? 0, 0, moved)
              promoted = moved.length
            }
          } catch (error) { deps.logger?.warn?.(`[dsh-jiuwen] interrupt: inbox coalesce failed: ${error?.message || error}`) }
          // Interrupted before chat.send went out: Jiuwen never saw this turn's text, so carry it into the resend.
          const carry = info.unsent && st.userText ? st.userText : undefined
          notes.set(dshSessionId, { count: Math.max(1, st.count) + (carry ? Math.max(1, st.userCount) : 0), ...(carry ? { carry } : {}) })
          trace({ at: 'turn-interrupt', phase: 'settled', dshSessionId, messages: st.count, promoted, waitedMs: Date.now() - st.at, settledBy: info.by, partialChars: info.chars, ...(carry ? { carried: carry.length } : {}) })
        },
        end() { st.done = true; if (turns.get(dshSessionId) === st) turns.delete(dshSessionId) },
      }
      turns.set(dshSessionId, st)
      return st
    },

    /** Track a host interaction (approval/question card) the running turn is waiting on. */
    setAwaiting(dshSessionId, kind) {
      const st = turns.get(dshSessionId)
      if (st) st.awaiting = kind || null
    },

    /**
     * A message reached a host session inbox. Returns what happened:
     * 'queue' (mode off) | 'idle' | 'ignored' | 'interrupt' | 'deferred' | 'coalesced' | 'question'.
     */
    noteMessage(dshSessionId, message) {
      const cfg = deps.config()
      if (cfg.onBusyMessage !== 'interrupt') return 'queue'
      const st = turns.get(dshSessionId)
      if (!st || st.done) return 'idle'
      if (!isUserMessage(message, cfg.busyIgnoreSources || DEFAULT_BUSY_IGNORE_SOURCES)) return 'ignored'
      if (st.awaiting === 'question') return 'question' // interaction.js closes the question; the turn ends itself
      st.count++
      if (st.requested) { trace({ at: 'turn-interrupt', phase: 'coalesced', dshSessionId, messages: st.count }); return 'coalesced' }
      st.requested = true
      st.at = Date.now()
      const deferred = st.awaiting === 'approval'
      trace({ at: 'turn-interrupt', phase: deferred ? 'deferred' : 'requested', dshSessionId, awaiting: st.awaiting || undefined })
      try { st.fire?.() } catch { /* ignore */ }
      return deferred ? 'deferred' : 'interrupt'
    },

    /** Consume the pending interrupt note: `{ note, carry?, count }` (carry = text Jiuwen never received). */
    takeResend(dshSessionId) {
      const n = notes.get(dshSessionId)
      if (!n) return undefined
      notes.delete(dshSessionId)
      return { note: interruptNote(n.count), count: n.count, ...(n.carry ? { carry: n.carry } : {}) }
    },
    /** Consume the pending interrupt note as one prefix string (note + carried text). */
    takeNote(dshSessionId) {
      const r = api.takeResend(dshSessionId)
      return r && (r.carry ? `${r.note}\n\n${carryBlock(r.carry)}` : r.note)
    },
    /** Drop a pending note (host stop/cancel after the interrupt). */
    clearNote(dshSessionId) { notes.delete(dshSessionId) },
    isBusy: (dshSessionId) => Boolean(turns.get(dshSessionId) && !turns.get(dshSessionId).done),
  }
  return api
}
