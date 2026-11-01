import test from 'node:test'
import assert from 'node:assert/strict'
import { applySkillBodyInjection, redactSecrets, skillDescription, SKILL_INDEX_OPEN, SKILL_BODY_OPEN } from '../src/host-sync.js'
import { applySystemInjection, splitSections, systemDelta, sectionHashes, filterHostSystemSections, SYSTEM_PARTIAL, SYSTEM_UPDATED, SYSTEM_OPEN } from '../src/system-inject.js'
import { matchSessionOverride } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'

const sk = [{ name: 'alpha', content: '---\ndescription: Do alpha things\n---\n# Alpha\nAPI_KEY=supersecretvalue123\nsteps' }, { name: 'beta', content: '# Beta\nBeta helps with charts.\nmore' }]

test('skill index: names + descriptions once, no bodies, no secrets', () => {
  const m = { jiuwenSessionId: 's1', skillBodies: sk }
  const q = applySkillBodyInjection('hi', m, { mode: 'index', loaderTool: 'mcp_x_skill', onInjected: (h) => { m.skillInjectHash = h } })
  assert.ok(q.startsWith(SKILL_INDEX_OPEN))
  assert.match(q, /- alpha: Do alpha things/)
  assert.match(q, /- beta: Beta helps with charts\./)
  assert.match(q, /mcp_x_skill/)
  assert.doesNotMatch(q, /supersecret|steps/)
  assert.equal(applySkillBodyInjection('hi', m, { mode: 'index', loaderTool: 'mcp_x_skill' }), 'hi')
})

test('skill index stays index-only without a loader tool (no silent body dump); off sends nothing', () => {
  const m = { skillBodies: sk }
  let warned = 0
  const q = applySkillBodyInjection('hi', m, { mode: 'index', onMissingLoader: () => { warned++ } })
  assert.ok(q.startsWith(SKILL_INDEX_OPEN))
  assert.match(q, /- alpha: Do alpha things/)
  assert.match(q, /Bodies are not available on demand/)
  assert.doesNotMatch(q, /supersecret|SKILL_BODY|API_KEY=/)
  assert.equal(warned, 1)
  assert.equal(applySkillBodyInjection('hi', { skillBodies: sk }, { mode: 'off' }), 'hi')
  const body = applySkillBodyInjection('hi', { skillBodies: sk }, { mode: 'body' })
  assert.ok(body.startsWith(SKILL_BODY_OPEN))
  assert.match(body, /API_KEY=\[REDACTED\]/)
})

test('skill injection persists across restarts by hash and re-sends on change', () => {
  const m = { skillBodies: sk }
  applySkillBodyInjection('q', m, { mode: 'index', loaderTool: 'L', onInjected: (h) => { m.skillInjectHash = h } })
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

test('config defaults and sessionOverrides matching', () => {
  const c = resolveConfig({}, { env: {} })
  assert.equal(c.injectSystemUpdate, 'diff', 'diff is the default')
  assert.equal(c.hostSkillInject, 'index')
  assert.equal(c.skillLoaderTool, 'skill')
  assert.deepEqual(c.hostSystemSectionsAllow, [])
  assert.deepEqual(c.hostSystemSectionsDeny, [])
  assert.equal(c.coreTools, undefined, 'prompt-based core-tool hint removed')
  assert.deepEqual(c.sessionOverrides, [])
  assert.equal(resolveConfig({}, { env: { JIUWEN_HOST_SKILL_INJECT: 'body' } }).hostSkillInject, 'body')
  assert.equal(resolveConfig({ injectSystemUpdate: 'full' }, { env: {} }).injectSystemUpdate, 'full')
  assert.deepEqual(resolveConfig({ hostSystemSectionsAllow: ['^# Identity$'] }, { env: {} }).hostSystemSectionsAllow, ['^# Identity$'])
  const list = resolveConfig({ sessionOverrides: [{ match: 'worker-*', modelName: 'fast' }, { match: '*', chatMode: 'agent' }] }, { env: {} }).sessionOverrides
  assert.equal(matchSessionOverride(list, 'worker-1').modelName, 'fast')
  assert.equal(matchSessionOverride(list, 'orchestrator-1').chatMode, 'agent')
  assert.equal(matchSessionOverride([], 'x'), undefined)
})


test('skill injection state is the hash alone (no skillBodiesInjected flag)', async () => {
  const { applySkillBodyInjection } = await import('../src/host-sync.js')
  const m = { skillBodies: [{ name: 'a', content: 'A body' }] }
  let h
  const q1 = applySkillBodyInjection('q', m, { mode: 'body', onInjected: (x) => { h = x } })
  assert.notEqual(q1, 'q'); assert.ok(h); assert.equal(m.skillInjectHash, undefined, 'pure: caller commits'); assert.equal(m.skillBodiesInjected, undefined)
  m.skillInjectHash = h
  assert.equal(applySkillBodyInjection('q', m, { mode: 'body' }), 'q', 'same hash → skip')
  m.skillBodiesInjected = true // legacy flag alone no longer suppresses a changed set
  m.skillBodies = [{ name: 'a', content: 'A body v2' }]
  assert.notEqual(applySkillBodyInjection('q', m, { mode: 'body' }), 'q')
})

test('splitSections ignores # lines inside fenced code blocks', () => {
  const t = '# A\nintro\n```bash\n# not a heading\necho hi\n```\n~~~\n## also not\n~~~\n# B\nend'
  assert.deepEqual(splitSections(t).map(s => s.head), ['# A', '# B'])
  const unclosed = '# A\n```\n# inside\n'
  assert.deepEqual(splitSections(unclosed).map(s => s.head), ['# A'])
})

test('truncateSkillBody: marker + configurable limit', async () => {
  const { truncateSkillBody } = await import('../src/host-sync.js')
  assert.equal(truncateSkillBody('short', 100), 'short')
  const t = truncateSkillBody('x'.repeat(500), 200)
  assert.equal(t.length, 200)
  assert.match(t, /truncated by dsh-jiuwen adapter: capped at 200 of 500 chars\]$/)
  assert.equal(resolveConfig({ skillBodyMaxChars: 9000, skillSyncMax: 5 }, { env: {} }).skillBodyMaxChars, 9000)
})


test('filterHostSystemSections: allow-only, deny-only, both; fenced headings ignored', () => {
  const t = '# Keep\nA\n```\n# fenced\n```\n# Drop\nB\n# Other\nC'
  assert.equal(filterHostSystemSections(t, {}), t)
  const allow = filterHostSystemSections(t, { allow: ['^# Keep$', '^# Other$'] })
  assert.match(allow, /# Keep\nA/)
  assert.match(allow, /# Other\nC/)
  assert.doesNotMatch(allow, /# Drop/)
  // fenced `# fenced` is content inside Keep, not its own section — allow/deny of that heading is a no-op
  assert.equal(filterHostSystemSections(t, { allow: ['^# fenced$'] }), '')
  assert.match(filterHostSystemSections(t, { deny: ['^# fenced$'] }), /# Drop/)
  const deny = filterHostSystemSections(t, { deny: ['^# Drop$'] })
  assert.match(deny, /# Keep/)
  assert.match(deny, /# Other/)
  assert.doesNotMatch(deny, /# Drop\nB/)
  const both = filterHostSystemSections(t, { allow: ['^# Keep$', '^# Drop$', '^# Other$'], deny: ['^# Drop$'] })
  assert.match(both, /# Keep/)
  assert.match(both, /# Other/)
  assert.doesNotMatch(both, /# Drop/)
  const withPreamble = 'intro\n# Keep\nok'
  assert.match(filterHostSystemSections(withPreamble, { allow: ['^$'] }), /^intro/)
  assert.doesNotMatch(filterHostSystemSections(withPreamble, { allow: ['^# Keep$'] }), /^intro/)
  const inj = applySystemInjection('q', { system: t }, { jiuwenSessionId: 'j' }, 'full', undefined, undefined, 'full', undefined, { deny: ['^# Drop$'] })
  assert.match(inj.query, /# Keep/)
  assert.doesNotMatch(inj.query, /# Drop\nB/)
})

test('restricted toolAllowlist still includes skillLoaderTool under hostSkillInject:index', () => {
  const c = resolveConfig({ toolAllowlist: ['bash', 'read'], hostSkillInject: 'index' }, { env: {} })
  assert.ok(c.toolAllowlist.includes('skill'))
  const custom = resolveConfig({ toolAllowlist: ['bash'], hostSkillInject: 'index', skillLoaderTool: 'load_skill' }, { env: {} })
  assert.ok(custom.toolAllowlist.includes('load_skill'))
  const body = resolveConfig({ toolAllowlist: ['bash'], hostSkillInject: 'body' }, { env: {} })
  assert.ok(!body.toolAllowlist.includes('skill'), 'body mode does not force-add loader')
})
