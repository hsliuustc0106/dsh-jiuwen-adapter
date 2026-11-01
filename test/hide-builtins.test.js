// dsh tool routing: duplicate Jiuwen built-ins are hidden; their permission asks never become dsh cards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractor, askToolName, askPath } from '../src/interaction.js'
import { fsRouteHint, routedBuiltins, routedCounterpart, isJiuwenInternalPath, JIUWEN_HIDE_DENY_TOOLS } from '../src/fs-route.js'
import { resolveConfig } from '../src/config.js'
import { validateConfig } from '../src/config-validate.js'

// Shapes as the live Gateway sends them (no tool_name; header = ask title; Chinese hint text).
const liveAsk = (tool, path, extra = {}) => ({
  eventType: 'chat.ask_user_question',
  payload: {
    request_id: 'call_1', source: 'permission_interrupt',
    questions: [{
      question: `read ${path}\n\n\n> 选择「会话内记住」可在本会话内自动放行 \`\`${tool}\`\` 类工具在 \`\`${path}\`\` 下的调用；选择「永久记住」可将此规则写回磁盘，所有会话均自动放行。`,
      header: '检测到受保护的文件路径访问，需要确认后才能执行',
      options: [{ value: 'allow_once', label: '本次允许' }, { value: 'session_allow', label: '会话内记住' }, { value: 'always_allow', label: '永久记住' }, { value: 'reject', label: '拒绝' }],
      tool_payload: { file_path: path, call_goal: 'x' },
      ...extra,
    }],
  },
})

const EXPOSED = ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'subagent', 'get_goal', 'update_goal', 'create_goal']

function rig({ cfg = {}, routing = { on: true, serverName: 'dsh-tools-0123456789abcdef', exposed: EXPOSED } } = {}) {
  const asked = []
  const approval = { request: async (r) => { asked.push(r); return 'allowed-once' } }
  const interact = createInteractor({
    config: () => ({ approvalTimeoutMs: 0, toolApproval: 'host', mcpServerName: 'dsh-tools', hideJiuwenBuiltins: 'deny', ...cfg }),
    services: () => ({ approval, agents: { get: () => ({ id: 's' }) } }),
    routing: () => routing,
  })
  return { interact, asked }
}

test('askToolName / askPath read live permission asks (no tool_name field)', () => {
  const a = liveAsk('read_file', '/tmp/r.txt')
  assert.equal(askToolName(a.payload, a.payload.questions[0]), 'read_file')
  assert.equal(askPath(a.payload.questions[0]), '/tmp/r.txt')
  assert.equal(askToolName({}, { header: '权限审批: grep' }), 'grep')
  assert.equal(askToolName({}, { question: '工具 `glob` 需要授权才能执行' }), 'glob')
  assert.equal(askToolName({}, { tool_name: 'bash', header: '权限审批: grep' }), 'bash')
  assert.equal(askPath({ question: 'list x\n``list_files`` 类工具在 ``/a/b`` 下的调用' }), '/a/b')
})

test('a routed duplicate built-in ask is declined with the dsh tool to use — no dsh card', async () => {
  const r = rig()
  const out = await r.interact(liveAsk('read_file', '/tmp/r.txt'), 's')
  assert.equal(out.outcome, 'redirected')
  assert.equal(r.asked.length, 0, 'never reaches ctx.approval')
  assert.deepEqual(out.answers[0].selected_options, ['reject'])
  assert.match(out.answers[0].custom_input, /read_file is hidden.*mcp_dsh-tools-0123456789abcdef_read/)
  const g = await r.interact(liveAsk('grep', '/elsewhere'), 's')
  assert.match(g.answers[0].custom_input, /mcp_dsh-tools-0123456789abcdef_grep/)
  const sk = await r.interact({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', questions: [{ header: '权限审批: skill_tool', question: 'load skill?' }] } }, 's')
  assert.match(sk.answers[0].custom_input, /_skill /)
})

test("Jiuwen's own data dir (plan files) is allowed without a card, even when the dsh counterpart is not exposed", async () => {
  const r = rig()
  const out = await r.interact(liveAsk('read_file', '/Users/u/.jiuwenswarm/agent/workspace/.plans/p.md'), 's')
  assert.equal(out.outcome, 'auto-allowed')
  assert.deepEqual(out.answers[0].selected_options, ['allow_once'])
  assert.equal(r.asked.length, 0)
  const noRead = rig({ routing: { on: true, serverName: 'dsh-tools', exposed: ['bash'] } })
  const o2 = await noRead.interact(liveAsk('list_files', '/x/.jiuwenswarm/agent/workspace/skills'), 's')
  assert.equal(o2.outcome, 'auto-allowed')
  // A write into the data dir is not an internal *read*: declined to the dsh tool.
  const w = await r.interact(liveAsk('write_file', '/x/.jiuwenswarm/agent/workspace/.plans/p.md'), 's')
  assert.equal(w.outcome, 'redirected')
})

test('not hidden → the ask still goes to ctx.approval (routing off, hideJiuwenBuiltins off, counterpart not exposed, other tools)', async () => {
  for (const [label, opts] of [
    ['routing off', { routing: { on: false } }],
    ['hide off', { cfg: { hideJiuwenBuiltins: 'off' } }],
    ['no counterpart', { routing: { on: true, serverName: 'dsh-tools', exposed: ['bash'] } }],
  ]) {
    const r = rig(opts)
    const out = await r.interact(liveAsk('read_file', '/tmp/r.txt'), 's')
    assert.equal(out.outcome, 'allowed-once', label)
    assert.equal(r.asked.length, 1, label)
  }
  const r = rig()
  const out = await r.interact({ eventType: 'chat.ask_user_question', payload: { source: 'permission_interrupt', questions: [{ header: '权限审批: send_file_to_user', question: 'send?' }] } }, 's')
  assert.equal(r.asked.length, 1, 'a non-duplicate built-in is a real ask')
  assert.equal(out.outcome, 'allowed-once')
})

test('isJiuwenInternalPath: .jiuwenswarm segment or JIUWENSWARM_DATA_DIR; no traversal', () => {
  assert.equal(isJiuwenInternalPath('/home/u/.jiuwenswarm/agent/workspace/.plans/a.md', {}), true)
  assert.equal(isJiuwenInternalPath('~/.jiuwenswarm/x', { HOME: '/home/u' }), true)
  assert.equal(isJiuwenInternalPath('/home/u/.jiuwenswarm/../.ssh/id_rsa', {}), false)
  assert.equal(isJiuwenInternalPath('/home/u/project/a.md', {}), false)
  assert.equal(isJiuwenInternalPath('/srv/jw/agent/x', { JIUWENSWARM_DATA_DIR: '/srv/jw' }), true)
  assert.equal(isJiuwenInternalPath('/srv/jwx/agent', { JIUWENSWARM_DATA_DIR: '/srv/jw' }), false)
  assert.equal(isJiuwenInternalPath('', {}), false)
})

test('hint maps every hidden built-in to its exposed dsh tool; legacy mode keeps the old core hint', () => {
  const h = fsRouteHint('dsh-tools-abc', EXPOSED)
  assert.match(h, /bash \/ write_file \/ edit_file are denied/)
  assert.match(h, /read_file → mcp_dsh-tools-abc_read/)
  assert.match(h, /glob \/ list_files → mcp_dsh-tools-abc_glob/)
  assert.match(h, /subagent_spawn \/ task_tool → mcp_dsh-tools-abc_subagent/)
  assert.match(h, /submit_goal_report → mcp_dsh-tools-abc_update_goal/)
  assert.match(h, /Delegate with mcp_dsh-tools-abc_subagent/)
  assert.match(h, /declined automatically/)
  assert.doesNotMatch(h, /web_fetch/, 'not exposed → not mapped')
  const legacy = fsRouteHint('dsh-tools', EXPOSED, 'off')
  assert.doesNotMatch(legacy, /subagent|declined|goal/i)
  assert.match(legacy, /mcp_dsh-tools_read/)
  assert.deepEqual(routedBuiltins(['read']).map(r => r.builtin), ['read_file'])
  assert.equal(routedCounterpart('task_tool', EXPOSED), 'subagent')
  assert.equal(routedCounterpart('task_tool', ['bash']), undefined)
  assert.equal(routedCounterpart('todo_create', EXPOSED), undefined, 'Jiuwen todos are not hidden')
  assert.deepEqual([...JIUWEN_HIDE_DENY_TOOLS], ['subagent_spawn', 'task_tool'])
})

test('config: hideJiuwenBuiltins defaults to deny, accepts prompt/off, validates', () => {
  assert.equal(resolveConfig({}, { env: {} }).hideJiuwenBuiltins, 'deny')
  assert.equal(resolveConfig({ hideJiuwenBuiltins: 'prompt' }, { env: {} }).hideJiuwenBuiltins, 'prompt')
  assert.equal(resolveConfig({ hideJiuwenBuiltins: 'bogus' }, { env: {} }).hideJiuwenBuiltins, 'deny')
  assert.equal(resolveConfig({}, { env: { JIUWEN_HIDE_JIUWEN_BUILTINS: 'off' } }).hideJiuwenBuiltins, 'off')
  assert.deepEqual(validateConfig({ hideJiuwenBuiltins: 'off' }), [])
  // Constraints kept: progressive Jiuwen tools untouched, passthrough allowlist default '*'.
  assert.deepEqual(resolveConfig({}, { env: {} }).toolAllowlist, ['*'])
})
