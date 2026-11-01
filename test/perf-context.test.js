import test from 'node:test'
import assert from 'node:assert/strict'
import { applySkillBodyInjection, redactSecrets, skillDescription, SKILL_INDEX_OPEN, SKILL_BODY_OPEN } from '../src/host-sync.js'
import { applySystemInjection, splitSections, systemDelta, sectionHashes, applyCoreToolsInjection, SYSTEM_PARTIAL, SYSTEM_UPDATED, SYSTEM_OPEN } from '../src/system-inject.js'
import { coreToolsHint, selectCoreTools, toolsNamedInText } from '../src/fs-route.js'
import { matchSessionOverride } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'

const sk = [{ name: 'alpha', content: '---\ndescription: Do alpha things\n---\n# Alpha\nAPI_KEY=supersecretvalue123\nsteps' }, { name: 'beta', content: '# Beta\nBeta helps with charts.\nmore' }]

test('skill index: names + descriptions once, no bodies, no secrets', () => {
  const m = { jiuwenSessionId: 's1', skillBodies: sk }
  const q = applySkillBodyInjection('hi', m, { mode: 'index', loaderTool: 'mcp_x_skill' })
  assert.ok(q.startsWith(SKILL_INDEX_OPEN))
  assert.match(q, /- alpha: Do alpha things/)
  assert.match(q, /- beta: Beta helps with charts\./)
  assert.match(q, /mcp_x_skill/)
  assert.doesNotMatch(q, /supersecret|steps/)
  assert.equal(applySkillBodyInjection('hi', m, { mode: 'index', loaderTool: 'mcp_x_skill' }), 'hi')
})

test('skill index falls back to redacted bodies without a loader tool; off sends nothing', () => {
  const m = { skillBodies: sk }
  const q = applySkillBodyInjection('hi', m, { mode: 'index' })
  assert.ok(q.startsWith(SKILL_BODY_OPEN))
  assert.match(q, /API_KEY=\[REDACTED\]/)
  assert.doesNotMatch(q, /supersecretvalue123/)
  assert.equal(applySkillBodyInjection('hi', { skillBodies: sk }, { mode: 'off' }), 'hi')
})

test('skill injection persists across restarts by hash and re-sends on change', () => {
  const m = { skillBodies: sk }
  applySkillBodyInjection('q', m, { mode: 'index', loaderTool: 'L' })
  const restored = { skillBodies: sk, skillInjectHash: m.skillInjectHash }
  assert.equal(applySkillBodyInjection('q', restored, { mode: 'index', loaderTool: 'L' }), 'q')
  const changed = { ...restored, skillBodies: [...sk, { name: 'gamma', content: 'Gamma.' }] }
  assert.match(applySkillBodyInjection('q', changed, { mode: 'index', loaderTool: 'L' }), /gamma/)
})

test('redactSecrets masks common credential shapes but keeps env references', () => {
  const t = redactSecrets('a sk-abcdefghijklmnopqrstuv b ghp_abcdefghijklmnopqrstuvwxyz12 TOKEN: "abcdefgh12345" X_API_KEY=${X_API_KEY} PASSWORD=<your-password>')
  assert.doesNotMatch(t, /sk-abc|ghp_abc|abcdefgh12345/)
  assert.match(t, /\$\{X_API_KEY\}/)
  assert.match(t, /<your-password>/)
})

test('skillDescription: registry > frontmatter > first prose line', () => {
  assert.equal(skillDescription({ description: 'Reg' }, 'x'), 'Reg')
  assert.equal(skillDescription(undefined, sk[0].content), 'Do alpha things')
  assert.equal(skillDescription(undefined, sk[1].content), 'Beta helps with charts.')
})

const big = (n) => Array.from({ length: n }, (_, i) => `# S${i}\n${'rule '.repeat(80)}${i}`).join('\n')

test('system inject: full once, nothing when unchanged, delta when one section changes', () => {
  const sys1 = `Preamble\n${big(10)}`
  const m = { jiuwenSessionId: 'j' }
  const a = applySystemInjection('q', { system: sys1 }, m, 'full', undefined, undefined, 'diff')
  assert.ok(a.query.startsWith(SYSTEM_OPEN))
  m.systemHash = a.hash; m.systemSections = a.sections
  assert.equal(applySystemInjection('q', { system: sys1 }, m, 'full', undefined, undefined, 'diff').query, 'q')
  const sys2 = sys1.replace('rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule rule 3', 'changed 3')
  const b = applySystemInjection('q', { system: sys2 }, m, 'full', undefined, undefined, 'diff')
  assert.ok(b.query.startsWith(SYSTEM_PARTIAL))
  assert.ok(b.delta && b.bytes < b.fullBytes / 5)
  assert.match(b.query, /# S3\nchanged 3/)
  assert.doesNotMatch(b.query, /# S4/)
  const c = applySystemInjection('q', { system: sys2 }, m, 'full', undefined, undefined, 'full')
  assert.ok(c.query.startsWith(SYSTEM_UPDATED))
})

test('systemDelta refuses unsafe deltas (preamble change, reorder, no baseline, too large)', () => {
  const sys = `Pre\n${big(4)}`
  const h = sectionHashes(sys)
  assert.equal(systemDelta(undefined, sys), undefined)
  assert.equal(systemDelta(h, sys.replace('Pre', 'Other')), undefined)
  const secs = splitSections(sys)
  const reordered = [secs[0], secs[2], secs[1], secs[3], secs[4]].map(s => s.text).join('\n')
  assert.equal(systemDelta(h, reordered), undefined)
  assert.equal(systemDelta(h, big(4).replace(/rule/g, 'x')), undefined)
  const removed = systemDelta(h, secs.filter(s => s.head !== '# S2').map(s => s.text).join('\n'))
  assert.match(removed.body, /Removed host sections.*# S2/)
})

test('core tools hint: exact names, once per session, only exposed tools', () => {
  assert.equal(coreToolsHint('srv', ['web_search'], ['bash']), '')
  const h = coreToolsHint('srv', ['bash', 'read', 'skill'], ['bash', 'read', 'grep'])
  assert.match(h, /mcp_srv_bash, mcp_srv_read\./)
  assert.doesNotMatch(h, /mcp_srv_grep/)
  const m = { jiuwenSessionId: 'j' }
  const a = applyCoreToolsInjection('q', m, 'srv', ['bash'], ['bash'])
  assert.ok(a.hash && a.query.endsWith('q') && a.query.includes('[Host core tools]'))
  m.coreToolsHash = a.hash
  assert.equal(applyCoreToolsInjection('q', m, 'srv', ['bash'], ['bash']).query, 'q')
})

test('config defaults and sessionOverrides matching', () => {
  const c = resolveConfig({}, { env: {} })
  assert.equal(c.injectSystemUpdate, 'diff')
  assert.equal(c.hostSkillInject, 'index')
  assert.equal(c.skillLoaderTool, 'skill')
  assert.deepEqual(c.coreTools, ['bash', 'read', 'edit', 'write', 'glob', 'grep'])
  assert.deepEqual(c.sessionOverrides, [])
  assert.deepEqual(resolveConfig({ coreTools: [] }, { env: {} }).coreTools, [])
  assert.equal(resolveConfig({}, { env: { JIUWEN_HOST_SKILL_INJECT: 'body' } }).hostSkillInject, 'body')
  const list = resolveConfig({ sessionOverrides: [{ match: 'worker-*', modelName: 'fast' }, { match: '*', chatMode: 'agent' }] }, { env: {} }).sessionOverrides
  assert.equal(matchSessionOverride(list, 'worker-1').modelName, 'fast')
  assert.equal(matchSessionOverride(list, 'orchestrator-1').chatMode, 'agent')
  assert.equal(matchSessionOverride([], 'x'), undefined)
})

test('core tool selection: globs and tools named in the host prompt', () => {
  const ex = ['bash', 'orchestrator_ack', 'orchestrator_report', 'web_search', 'read']
  assert.deepEqual(selectCoreTools(ex, ['read', 'orchestrator_*', 'bash']), ['read', 'orchestrator_ack', 'orchestrator_report', 'bash'])
  assert.deepEqual(toolsNamedInText(ex, 'Call orchestrator_report when done; use `web_search` rarely. Not orchestrator_acknowledge.'), ['orchestrator_report', 'web_search'])
  assert.deepEqual(toolsNamedInText(ex, ''), [])
  assert.equal(resolveConfig({}, { env: {} }).coreToolsFromSystem, 12)
})
