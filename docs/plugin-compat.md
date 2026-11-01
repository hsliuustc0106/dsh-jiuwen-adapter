# Plugin compatibility (plain dsh)

Tested with dsh 0.2.1-rc.5, a plain web profile (`dsh-base` + `dsh-web-app`), with and without `dsh-llm-jiuwen`, and with the adapter loaded first or last. A small driver plugin (`test/live/plain-dsh/driver`, run by `npm run test:plain-dsh`; in-process: `test/plugin-compat-matrix.test.js`) runs the scenario through host services (`sessionController`, `schedule`, …).

- **Non-jiuwen:** the normalized event stream, fork events, schedules, skills and preset are the same with and without the adapter.
- **Jiuwen:** what the plugin does reaches Jiuwen (checked by reading it back), or the adapter leaves the session unchanged without errors.
- **Hygiene:** no errors and no unhandled rejections. Results are the same in either load order. The adapter adds one `process.exit` listener, lazily, and removes it on dispose.

| Plugin | Non-jiuwen identical | In jiuwen sessions | Result |
|---|---|---|---|
| session-controller (create/selectModel/prompt) | ✓ | turns reach Jiuwen | PASS |
| session-title (rename) | ✓ | title → Jiuwen | PASS |
| working-directory | ✓ | cwd → projectDir (also when the model is selected after create) | PASS |
| dsh-schedule (`every`) | ✓ | → Jiuwen heartbeat; restored on delete | PASS |
| dsh-permission-presets | ✓ | read-only → bash/write/edit deny; restored | PASS |
| fork (controller) | ✓ | Jiuwen fork; fork turn goes to the fork | PASS |
| dsh-plan-mode (preset-scoped) | ✓ | on/off → Jiuwen chat mode | PASS |
| dsh-goal | ✓ | clear → Jiuwen goal cleared | PASS |
| dsh-skill / skill-filesystem (preset-scoped) | ✓ | skill body reaches the model | PASS |
| agent-presets persona (`minimal`) | ✓ | persona forwarded; shipped `{{model}}` default skipped | PASS |
| workspace archive / agent dispose | ✓ | Jiuwen session kept while dsh still stores it | PASS |
| mcp-resources, subagent, todo, compaction, approval, web tools | ✓ | not mirrored; unchanged | PASS (graceful) |

## Extra plugins

Tested in real profiles in both load orders with the stand-in model: `PLAIN_DSH_ONLY=ext npm run test:plain-dsh`.

| Plugin | Non-jiuwen | Jiuwen sessions | Verdict |
|---|---|---|---|
| dsh-compaction / compaction-basic / command-compact | `compactNow` works | the summary is local (`compactionMode: local`); the same Jiuwen session continues and no extra Jiuwen turn is created | works |
| dsh-session-turn-outline | outline matches the turns | the outline counts the Jiuwen turns | works |
| dsh-mcp-client (stdio) | tool runs | the tool reaches Jiuwen as `mcp_dsh-tools-<sha16>_mcp__<server>__<tool>` (per-session server); calls are approval-gated, and with no UI they are denied after `approvalTimeoutMs` | works (gated) |
| dsh-time-context | injected | not forwarded (Jiuwen stamps its own time) | works |
| ralph / terminal / worktree bundles | tools registered | the tools are published to Jiuwen over dsh-tools (approval-gated) | works (gated) |
| dsh-experimental-auto-review (Auto preset) | Auto preset applies | Auto → Jiuwen `ask` (bash, write, edit). Fixed: before, Jiuwen stayed at the previous level | works after fix |

## Interrupt on busy (PR #4)

`PLAIN_DSH_ONLY=busy npm run test:plain-dsh`, both load orders: a slow turn (`SLOW12000`), then two user messages 3 s and 3.4 s in.

| Session | Result |
|---|---|
| Non-jiuwen | dsh queues the messages and answers each in turn; identical with and without the adapter; no note |
| Jiuwen | the turn is interrupted within ~3 s; both messages reach Jiuwen in one resend with one note; the next turn has no note. Fixed: the second message landed while the resend waited out `postCancelSettleMs`; the resend was sent and cancelled at once and Jiuwen dropped the first message |

## Memory-module plugins

dsh has no plugin literally named "memory". Its memory and recall layer is three plugins. Each was tested in real profiles in both load orders with the stand-in model (`npm run test:plain-dsh`).

| Plugin | Non-jiuwen | Jiuwen sessions | Verdict |
|---|---|---|---|
| dsh-agent-instructions (AGENTS.md / CLAUDE.md, in dsh-base) | unchanged | the AGENTS.md reminder is forwarded with the first prompt, and Jiuwen keeps it in history (not resent) | works |
| dsh-session-reference (`dsh-session:<id>` mentions, in dsh-web-app) | unchanged | the referenced-session snapshot is forwarded with the citing prompt; later turns are not resent | works |
| dsh-experimental-session-search (+ session-query-sqlite, tool-session-query; opt-in) | unchanged | the `session_*` tools reach Jiuwen as `mcp_dsh-tools-<sha16>_session_*` and return dsh's session index | works (after the fix below) |

- **Jiuwen's own memory:** no conflict. Jiuwen keeps its `coding_memory_*` tools and its history. dsh tools are prefixed, and dsh context is sent once per turn, never duplicated.
- **Fix:** the passthrough asked for dsh approval on every call. dsh never asks for the read-only session-query tools (or goal CRUD: `get_goal` / `update_goal` / `create_goal`), so a Jiuwen session would hang until approval timed out (300 s) — and with `permissions.approval: never` the gate returns `rejected` immediately (`dsh denied get_goal (rejected)`), leaving goals stuck paused. These tools are now in `toolApprovalExempt` (see the configuration docs).
- **Fix (general, `toolApproval: host`, now the default):** the per-call gate itself diverged from native dsh. dsh only asks when its `tools/pre-execute` policy returns `ask`; the adapter asked `ctx.approval` for *every* non-exempt call, and under approval policy `never` (the `auto` preset: `danger-full-access` + `never`) `approval.request` returns `rejected` at once — so Jiuwen's `write` / `bash` calls failed with `dsh denied write (rejected)` while the same calls ran natively. Passthrough calls now go through dsh's own tool pipeline (`tools.execute`), so pre-execute guards, the sandbox, the approval policy, post-execute hooks, content finalizers, `tools/result` observers and dsh's per-tool timeout behave exactly as for a native call (a real `ask` under `never` is still rejected — never fails open). The skill loader, goal and session-query tools no longer skip those hooks either. `toolApproval: dsh` keeps the old gate; the adapter falls back to it when the host has no tools runtime with `execute()` (or no live agent).
- **Fix:** Jiuwen plan review (`plan.approval_required` / `confirm_interrupt` for `exit_plan_mode`) and SwarmFlow human turns were sent to `ctx.approval`, so `never` rejected every Jiuwen plan and SwarmFlow review step. They are now asked through `ctx.userQuestions`, like dsh's own `exit_plan_mode`. Real tool permission asks (`permission_interrupt`) still go to `ctx.approval` and are rejected under `never`, as natively.
- **Fix:** host-sync's "make sure the proxy exists" call (`prepare([])`) cleared the session's admitted tool schemas, so later `tools/call`s could fail with `tool X is not exposed by dsh`. An empty tool list now keeps the current set.
- **Fix:** Jiuwen's MCP `timeout_s` was `toolCallTimeoutMs` alone while an approval could wait `approvalTimeoutMs` (300 s) first: Jiuwen gave up after 120 s and a late approval then ran the tool with nobody listening. The call is cancelled if the proxy connection drops.
- **Fix (native timeouts):** the adapter capped every passthrough call (`toolCallTimeoutMs` 120 s, then + `approvalTimeoutMs`) and denied approvals after 300 s; native dsh has neither (approval waits for the user or the turn's abort; dsh's per-tool timeout policy bounds the run). Both now default to none; the dsh turn's abort cancels in-flight passthrough calls. The transport deadline (`mcpCallTimeoutMs`, default 1 h) is advertised to the proxy, and Jiuwen records with an old `timeout_s` (e.g. 120) are re-registered instead of reused.
- **Fix (admission):** a tool was callable only if it was in the *latest* request's tool list, while Jiuwen was shown the union in `schemas.json`; calls to tools of an earlier turn (or after a restart) failed `not exposed by dsh`. Admission is now the session's admitted union (plus `schemas.json` names matching the current allowlist); dsh's registry decides visibility as for a native call.
- **Fix (double gate):** a Jiuwen `permission_interrupt` about a dsh passthrough tool went to `ctx.approval` (rejected under `never`) before dsh's own pipeline decided the same call; it is now delegated to dsh's pipeline.
- **Fix (presets vs FS routing):** with `mapJiuwenFsToDsh` (default with the passthrough) a dsh preset change (`full-access` → allow) re-allowed Jiuwen's denied `bash` / `write_file` / `edit_file`, letting Jiuwen bypass dsh's tools (and fs-route's cache never re-denied them). Preset sync now skips the routed builtins; dsh's preset applies natively to the dsh tools.
- **Fix (duplicate Jiuwen builtins hang on approval cards):** with dsh tool routing, Jiuwen still used its own `grep` / `glob` / `read_file` (e.g. plan mode reading `~/.jiuwenswarm/…/.plans/*.md`); their `permission_interrupt` asks became dsh approval cards that waited forever (`approvalTimeoutMs: 0`). Such asks are now decided by the adapter (`hideJiuwenBuiltins`, default `deny`): reads of Jiuwen's own data dir are allowed once, any other duplicated builtin is declined with feedback naming the `mcp_<server>_<dsh tool>` to call, and the routing hint lists every builtin → dsh mapping. No dsh card, no hang. The tool lists Jiuwen sees are unchanged (the Gateway has no per-session tool filter; progressive discovery and `toolAllowlist: ['*']` stay).
- **Fix (stale global Jiuwen permissions):** the routed `bash` / `write_file` / `edit_file = deny` (and preset mirrors) were written into JiuwenSwarm's global config and never undone, affecting every other session and client. Writes are now owned in `jiuwen-permissions.json` with their prior value, restored when routing is off or on `/jiuwen permissions release confirm`; a value the user changed afterwards is left alone. Legacy denies are adopted on upgrade. Delegation: `subagent_spawn` / `task_tool` are denied (owned) while dsh `subagent` is passed through, so sub-agents run as dsh sub-agents with dsh's tools.
- **Fix (Jiuwen goal report vs dsh goal):** a dsh goal was also armed as Jiuwen's own goal; Jiuwen's `submit_goal_report complete` finished only Jiuwen's copy and dsh kept running goal rounds until round-limit → `blocked`. With dsh `update_goal` passed through, Jiuwen's goal is no longer armed (only `clear` mirrors) and an accepted `submit_goal_report complete` / `blocked` (direct or via `tool_call`) is mirrored onto dsh `update_goal` (after `get_goal` for id/revision) before the turn finishes.
- **Fix (turn never ends after a tool call, e.g. `schedule_create`):** the adapter ended a turn on `processing_status.is_complete` or a closing `chat.final`; AgentServer's own end-of-run status is `{is_processing: false}` (is_complete only on the envelope, and the Gateway then sends none of its own). A turn without a closing final stayed open until `requestTimeoutMs` (Jiuwen idle, dsh got no assistant message / turn end). `is_processing: false` now ends the turn after `terminalFinalGraceMs` of idle (later frames keep it open; a stale status of a resumed request is ignored).
- **Limit:** Jiuwen-side memory is not mirrored into dsh's session index. `session_search` sees the dsh transcripts of Jiuwen sessions, not Jiuwen's internal memory.

**Gaps:** dsh has no session delete, so the Jiuwen session is deleted only after dsh has dropped it. ralph / terminal / worktree tools were checked as published and gated, not run end to end inside a Jiuwen turn (no approval UI in the driver). Interrupt-on-busy while an approval card is pending is covered by unit tests only.
