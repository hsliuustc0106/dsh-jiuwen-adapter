/**
 * Host-answered Jiuwen interactions.
 *
 *  - chat.ask_user_question (source ask_user_interrupt / plain)  → ctx.userQuestions.ask()  (dsh-user-questions)
 *  - permission_interrupt / tool confirm_interrupt              → ctx.approval.request() (dsh-user-approval)
 *  - plan.approval_required / plan confirm_interrupt             → ctx.userQuestions plan review (like dsh's own
 *    exit_plan_mode), ctx.approval only when the host has no user-questions channel
 *  - swarmflow_human (a person's turn in a SwarmFlow run)         → ctx.userQuestions, ctx.approval as fallback
 *
 * Why plan review / SwarmFlow human go to user-questions: dsh asks *questions* through
 * user-questions regardless of the approval policy; only tool permission asks go through
 * ctx.approval, which resolves `rejected` immediately under policy `never`. Routing a plan review
 * through ctx.approval made every Jiuwen plan / SwarmFlow review fail under the `auto` preset while
 * the native plan review still asks.
 *
 * Returns `{ kind, outcome, answers, note }` in Jiuwen's answer shape
 * (`[{ selected_options: [...], custom_input, card_id? }]`), or null to keep the legacy
 * "print the question and end the turn" behaviour. Approvals never fail open: no UI,
 * no live agent, timeout or error → reject.
 */

import { routedCounterpart, isJiuwenInternalPath, JIUWEN_INTERNAL_READ_TOOLS, mcpToolName } from './fs-route.js'

const APPROVAL_SOURCES = new Set(['permission_interrupt', 'confirm_interrupt'])

/**
 * Is `toolName` (as Jiuwen names it: `mcp_<server>_<tool>`) one of this adapter's dsh passthrough
 * tools (`<mcpServerName>` or a per-session `<mcpServerName>-<sha16>`)? Those calls are decided by
 * dsh's own tool pipeline when they run, so a Jiuwen-side permission ask for them is a second gate.
 */
export function isDshPassthroughTool(toolName, serverName = 'dsh-tools') {
  const esc = String(serverName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^mcp_${esc}(-[a-f0-9]{16})?_.+`).test(String(toolName || ''))
}
/**
 * The tool a Jiuwen permission ask is about. Live Gateway payloads carry no `tool_name`: the header
 * is `权限审批: <tool>` (or a category title) and the question names it as ``<tool>`` 类工具.
 */
export function askToolName(payload, q = {}) {
  const direct = q.tool_name || payload?.tool_name
  if (direct) return String(direct)
  const header = String(q.header || '')
  const h = /^(?:权限审批|Permission(?: approval)?)\s*[:：]\s*([A-Za-z0-9_.:-]+)/i.exec(header)
  if (h) return h[1]
  const text = String(q.question || q.message || payload?.message || '')
  const m = /``([A-Za-z0-9_.:-]+)`` 类工具/.exec(text) || /`([A-Za-z0-9_.:-]+)` 需要授权/.exec(text)
  return m ? m[1] : undefined
}

/** The path a Jiuwen permission ask is about (tool_payload, else the question text), or ''. */
export function askPath(q = {}) {
  const tp = q.tool_payload && typeof q.tool_payload === 'object' ? q.tool_payload : {}
  for (const k of ['file_path', 'path', 'target_file', 'file', 'directory', 'dir']) if (typeof tp[k] === 'string' && tp[k].trim()) return tp[k].trim()
  const m = /在 ``([^`]+)`` 下/.exec(String(q.question || ''))
  return m ? m[1] : ''
}

const APPROVE_LABEL = 'Approve'
const KEEP_PLANNING_LABEL = 'Keep planning'
const REJECT_LABEL = 'Reject'

/**
 * One host question card (dsh-user-questions), bounded by `ms` and the turn signal.
 * @returns {Promise<{ outcome: 'answered', selected: string[], custom: string } | { outcome: string }>}
 *   outcome 'answered' | 'timeout' | 'cancelled' | 'unavailable'; never throws.
 */
async function askCard(userQuestions, agent, item, ms, signal) {
  const own = linkedAbort(signal)
  try {
    const ask = Promise.resolve(userQuestions.ask({ questions: [item], ...(agent ? { agent } : {}), signal: own.signal }))
    ask.catch(() => {})
    const res = await withTimeout(ask, ms, null, signal)
    if (!res) own.abort() // timed out: withdraw the card instead of leaving it open with nobody waiting
    if (signal?.aborted) return { outcome: 'cancelled' }
    if (!res || !Array.isArray(res.answers)) return { outcome: 'timeout' }
    const a = res.answers.find(x => x?.id === item.id) || res.answers[0] || {}
    const custom = typeof a.custom === 'string' ? a.custom : (typeof a.text === 'string' ? a.text : '')
    return { outcome: 'answered', selected: (a.selected || []).map(String), custom }
  } catch (error) {
    return { outcome: error?.code === 'ASK_CANCELLED' ? 'cancelled' : 'unavailable' }
  } finally { own.dispose() }
}

async function askApproval(approval, agent, toolName, reason, ms, signal) {
  if (approval?.request && agent) {
    // Own signal per ask: when approvalTimeoutMs gives up, abort the host request too, so dsh records
    // approval/decided (cancelled) and withdraws the card. Before, the turn moved on with the
    // approval/asked left open (no decided event, card still shown, answerer still pending).
    const own = linkedAbort(signal)
    try {
      const outcome = await withTimeout(Promise.resolve(approval.request({ agent, toolName, reason, signal: own.signal })).catch(() => 'unavailable'), ms, 'timeout', signal)
      if (outcome === 'timeout') own.abort()
      return outcome
    } finally { own.dispose() }
  }
  return approval?.request ? 'unavailable' : 'no-ui'
}

/** An AbortController that also aborts when `parent` does; dispose() detaches it. */
function linkedAbort(parent) {
  const ac = new AbortController()
  const onParent = () => ac.abort(parent?.reason)
  if (parent?.aborted) ac.abort(parent.reason)
  else parent?.addEventListener?.('abort', onParent, { once: true })
  return { signal: ac.signal, abort: () => ac.abort(Object.assign(new Error('approval timed out'), { code: 'TIMEOUT' })), dispose: () => parent?.removeEventListener?.('abort', onParent) }
}
const ALLOW_RE = /^(allow_once|allow|approve|approved|yes|execute|implement|accept)$/i
const REJECT_RE = /^(reject|deny|denied|no|cancel|skip)$/i

/**
 * @param {{ services: () => { userQuestions?: any, approval?: any, agents?: any }, config: () => any, logger?: any,
 *   routing?: (dshSessionId: string) => ({ on: boolean, serverName?: string, exposed?: string[] } | undefined) }} deps
 *   routing: whether dsh tool routing is on for the session, its passthrough server name and exposed dsh tools.
 */
export function createInteractor(deps) {
  // dshSessionId -> { agent, ac } for host question cards currently awaiting the user.
  const pendingAsks = new Map()
  /** A normal chat message reached `agent`'s inbox: close its pending Jiuwen question so the turn ends. */
  const noteUserMessage = (agent, message) => {
    try {
      if (message?.source?.kind === 'user-question-reply') return false
      let hit = false
      for (const [sid, p] of pendingAsks) {
        if (p.agent && p.agent === agent) { hit = true; pendingAsks.delete(sid); p.ac.abort() }
      }
      return hit
    } catch { return false }
  }
  let subscribed = false
  const subscribe = () => {
    if (subscribed) return
    subscribed = true
    try {
      deps.onUserMessage?.(({ agent, message } = {}) => {
        if (noteUserMessage(agent, message)) deps.logger?.info?.('[dsh-jiuwen] user message superseded a pending question card')
      })
    } catch { /* host without inbox events: legacy behaviour */ }
  }
  const interact = async function interact({ eventType, payload, signal, told }, dshSessionId) {
    const cfg = deps.config()
    const { userQuestions, approval, agents } = deps.services() || {}
    const questions = Array.isArray(payload?.questions) ? payload.questions.filter(q => q && typeof q === 'object') : []
    let agent
    try { agent = agents?.get?.(dshSessionId) } catch { agent = undefined }

    if (payload?.source === 'swarmflow_human' && payload?.swarmflow_meta?.correlation_id) {
      // SwarmFlow human turn: a question for the person (dsh-user-questions), replied with
      // chat.swarmflow_reply by the transport. ctx.approval (allowed-once = "approved") only when the
      // host has no user-questions channel. Never fails open: no UI / no agent / timeout → rejected.
      const q = questions[0] || {}
      const meta = payload.swarmflow_meta
      const who = meta.agent_name || meta.agent_id || 'human'
      const reason = String(q.question || 'SwarmFlow is waiting for your input').slice(0, 2000)
      let outcome = 'unavailable'
      let answerText
      if (userQuestions?.ask) {
        const own = cardOptions(q.options).map(o => typeof o === 'string' ? { label: o } : { label: String(o.label || o.value || '?'), ...(o.description ? { description: String(o.description) } : {}) })
        const item = { id: 'swarmflow-human', header: String(q.header || `SwarmFlow · ${who}`).slice(0, 60), question: reason,
          options: own.length ? own : [{ label: APPROVE_LABEL, description: 'Approve and let the run continue' }, { label: REJECT_LABEL, description: 'Reject; type feedback instead to send it as the reply' }] }
        const r = await askCard(userQuestions, agent, item, cfg.approvalTimeoutMs, signal)
        outcome = r.outcome
        if (r.outcome === 'answered') {
          if (r.custom) answerText = r.custom
          else if (!own.length && r.selected.length === 1 && r.selected[0] === APPROVE_LABEL) { answerText = 'approved'; outcome = 'allowed-once' }
          else if (!own.length) { answerText = 'rejected (user)'; outcome = 'rejected' }
          else answerText = r.selected.join(', ') || 'rejected (no answer)'
        }
        if (r.outcome === 'unavailable') outcome = await askApproval(approval, agent, `swarmflow:${who}`, reason, cfg.approvalTimeoutMs, signal)
      } else {
        outcome = await askApproval(approval, agent, `swarmflow:${who}`, reason, cfg.approvalTimeoutMs, signal)
      }
      if (answerText === undefined) answerText = outcome === 'allowed-once' ? 'approved' : `rejected (${outcome})`
      return {
        kind: 'swarmflow', outcome, answerText,
        answers: [{ selected_options: [], custom_input: answerText }],
        note: `• swarmflow ${who}: ${answerText}`,
      }
    }

    if (eventType === 'plan.approval_required' || APPROVAL_SOURCES.has(payload?.source)) {
      const q = questions[0] || payload || {}
      const toolName = String(askToolName(payload, q) || (eventType === 'plan.approval_required' || payload?.source === 'confirm_interrupt' ? 'exit_plan_mode' : 'jiuwen-tool'))
      const reason = String(q.question || q.message || payload?.message || payload?.content || `Jiuwen requests permission: ${toolName}`).slice(0, 2000)
      const isPlan = eventType === 'plan.approval_required' || (payload?.source === 'confirm_interrupt' && toolName === 'exit_plan_mode')
      let outcome = 'unavailable'
      let feedback = ''
      let viaQuestions = false
      if (payload?.source === 'permission_interrupt' && (cfg.toolApproval || 'host') !== 'none' && isDshPassthroughTool(toolName, cfg.mcpServerName)) {
        // A Jiuwen permission ask about a dsh passthrough tool: dsh's own pipeline (pre-execute policy,
        // sandbox, ctx.approval under the session policy) decides when the call reaches dsh. Asking
        // here as well double-gated it and, under approval policy `never`, rejected calls native dsh
        // runs. Not fail-open: the dsh side still denies whatever dsh would deny.
        return {
          kind: 'approval', outcome: 'delegated',
          answers: approvalAnswers(questions.length ? questions : [payload || {}], true, payload?.plan_actions, ''),
          note: `• approval ${toolName}: delegated to dsh's tool pipeline`,
        }
      }
      const routing = payload?.source === 'permission_interrupt' && (cfg.hideJiuwenBuiltins || 'deny') !== 'off' ? deps.routing?.(dshSessionId) : undefined
      const dshTool = routing?.on ? routedCounterpart(toolName, routing.exposed) : undefined
      const internalRead = routing?.on && JIUWEN_INTERNAL_READ_TOOLS.includes(toolName) && isJiuwenInternalPath(askPath(q))
      if (dshTool || internalRead) {
        // A Jiuwen built-in that duplicates a dsh tool passed through this session: hidden here, so
        // the adapter decides instead of opening a dsh card (with approvalTimeoutMs 0 an unattended
        // run would wait on it forever). Jiuwen's own data dir (plan files, skills) → allow, the
        // rest → declined with the dsh tool to use instead (that call then runs dsh's own pipeline).
        const qs = questions.length ? questions : [payload || {}]
        if (internalRead) {
          return { kind: 'approval', outcome: 'auto-allowed', answers: approvalAnswers(qs, true, payload?.plan_actions, ''),
            note: `• approval ${toolName}: allowed (Jiuwen's own data dir)` }
        }
        const use = mcpToolName(routing.serverName || cfg.mcpServerName, dshTool)
        const feedback = `Jiuwen built-in ${toolName} is hidden in this dsh session. Call ${use} instead (it runs through dsh's sandbox and approval policy).`
        return { kind: 'approval', outcome: 'redirected', answers: approvalAnswers(qs, false, payload?.plan_actions, feedback),
          note: `• approval ${toolName}: declined → use ${use}` }
      }
      if (isPlan && userQuestions?.ask) {
        // Plan review, as dsh's own exit_plan_mode does it: a question card (not a permission ask).
        const plan = String(payload?.plan || q.plan || q.detail || payload?.content || '').slice(0, 20_000)
        const item = { id: 'plan-review', header: 'Plan review', question: reason || 'Approve this plan and leave plan mode?',
          ...(plan && plan !== reason ? { detail: plan } : {}),
          options: [{ label: APPROVE_LABEL, description: 'Carry out the plan' }, { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; typed feedback goes back to Jiuwen' }] }
        const r = await askCard(userQuestions, agent, item, cfg.approvalTimeoutMs, signal)
        if (r.outcome === 'answered') {
          viaQuestions = true
          const approved = r.selected.length === 1 && r.selected[0] === APPROVE_LABEL && !r.custom
          outcome = approved ? 'allowed-once' : 'rejected'
          feedback = approved ? '' : r.custom
        } else if (r.outcome !== 'unavailable') { viaQuestions = true; outcome = r.outcome }
      }
      if (!viaQuestions) outcome = await askApproval(approval, agent, toolName, reason, cfg.approvalTimeoutMs, signal)
      const allow = outcome === 'allowed-once'
      return {
        kind: 'approval', outcome,
        answers: approvalAnswers(questions.length ? questions : [payload || {}], allow, payload?.plan_actions, feedback),
        note: `• ${isPlan ? 'plan review' : 'approval'} ${toolName}: ${allow ? (isPlan ? 'approved' : 'allowed once') : 'denied'} (${outcome})`,
      }
    }

    if (!told || !questions.length) return null
    const items = questions.map((q, i) => ({
      id: String(q.id || q.question_id || `q${i + 1}`),
      question: String(q.question || q.text || q.header || 'Input needed'),
      ...(q.header ? { header: String(q.header).slice(0, 60) } : {}),
      ...(cardOptions(q.options).length ? {
        options: cardOptions(q.options).map(o => typeof o === 'string' ? { label: o } : { label: String(o.label || o.value || '?'), ...(o.description ? { description: String(o.description) } : {}) }),
      } : {}),
      ...((q.multi_select ?? q.multiSelect) ? { multiSelect: true } : {}),
    }))
    if (userQuestions?.ask) {
      // A pending question must not block chat: a typed message supersedes the card (see noteUserMessage);
      // the turn then ends and that message is delivered to Jiuwen as the answer on the next turn.
      const ac = new AbortController()
      const onParent = () => ac.abort()
      signal?.addEventListener?.('abort', onParent, { once: true })
      if (agent) subscribe()
      if (agent) pendingAsks.set(String(dshSessionId), { agent, ac })
      try {
        const ask = Promise.resolve(userQuestions.ask({ questions: items, ...(agent ? { agent } : {}), signal: ac.signal }))
        ask.catch(() => {})
        const res = await withTimeout(ask, cfg.questionTimeoutMs, null, ac.signal)
        if (ac.signal.aborted && !signal?.aborted) {
          return { kind: 'question', outcome: 'superseded', defer: true, note: '• question left open; your next message answers it' }
        }
        if (res && Array.isArray(res.answers)) {
          return { kind: 'question', outcome: 'answered', answers: questionAnswers(questions, items, res.answers), note: '• answered via dsh user-questions' }
        }
      } catch (error) {
        if (ac.signal.aborted && !signal?.aborted) return { kind: 'question', outcome: 'superseded', defer: true, note: '• question left open; your next message answers it' }
        deps.logger?.debug?.(`[dsh-jiuwen] user-questions unavailable: ${error?.code || error?.message}`)
      } finally {
        signal?.removeEventListener?.('abort', onParent)
        if (pendingAsks.get(String(dshSessionId))?.ac === ac) pendingAsks.delete(String(dshSessionId))
      }
    }
    {
      // We told Jiuwen we can answer; never leave it paused. Fall back to a neutral reply.
      return {
        kind: 'question', outcome: 'no-ui',
        answers: questions.map(q => ({ selected_options: [], custom_input: cfg.noUiAnswer, ...(q.card_id ? { card_id: q.card_id } : {}) })),
        note: '• no interactive user available; told Jiuwen to proceed',
      }
    }
    return null
  }
  interact.noteUserMessage = noteUserMessage
  interact.pendingCount = () => pendingAsks.size
  return interact
}

export function approvalAnswers(questions, allow, planActions, feedback) {
  return questions.map((q) => {
    const opts = [...(Array.isArray(q.options) ? q.options : []), ...(Array.isArray(planActions) ? planActions : [])]
      .map(o => typeof o === 'string' ? { value: o, label: o } : o).filter(Boolean)
    const re = allow ? ALLOW_RE : REJECT_RE
    const hit = opts.find(o => re.test(String(o.value ?? ''))) || opts.find(o => re.test(String(o.label ?? '')))
    const selected = String(hit?.value ?? hit?.label ?? (allow ? 'allow_once' : 'reject'))
    return { selected_options: [selected], custom_input: allow ? '' : (feedback || 'Denied by dsh host'), ...(q.card_id ? { card_id: q.card_id } : {}) }
  })
}

/**
 * Options for the dsh card. Jiuwen appends a synthetic `{label:'Other', description:'Custom input'}`
 * to every option list; the dsh card has its own free-text row, so drop that one (typed text is
 * sent as custom_input either way).
 */
export function cardOptions(options) {
  const opts = Array.isArray(options) ? options : []
  const last = opts.at(-1)
  if (opts.length > 1 && last && typeof last === 'object' && last.label === 'Other' && last.description === 'Custom input') return opts.slice(0, -1)
  return opts
}

export function questionAnswers(questions, items, answers) {
  return questions.map((q, i) => {
    const a = answers.find(x => x?.id === items[i].id) || answers[i] || { selected: [] }
    const opts = Array.isArray(q.options) ? q.options : []
    const selected = (a.selected || []).map(label => {
      const o = opts.find(x => (typeof x === 'string' ? x : x.label) === label)
      return String(o && typeof o === 'object' ? (o.value ?? o.label) : label)
    })
    // Jiuwen joins selected_options + custom_input into one answer: only send typed text as custom_input
    // (echoing the selected labels gave "Blue, Blue"); free-text questions keep the selection as text.
    const custom = typeof a.custom === 'string' && a.custom ? a.custom : (typeof a.text === 'string' && a.text && !selected.length ? a.text : '')
    return { selected_options: selected, custom_input: custom || (opts.length ? '' : selected.join(', ')), ...(q.card_id ? { card_id: q.card_id } : {}) }
  })
}

function withTimeout(promise, ms, fallback, signal) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms)
    const onAbort = () => { clearTimeout(t); resolve(fallback) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
