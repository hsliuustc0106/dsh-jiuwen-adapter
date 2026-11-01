#!/usr/bin/env node
// Test runner for CI and local guard runs: `npm test` with reports, coverage thresholds and the test-count baseline.
//   node scripts/run-tests.mjs [--coverage] [--update-baseline] [--allow-drop]
// Writes reports/junit.xml (+ reports/lcov.info and reports/coverage-summary.json with --coverage).
// Fails when a test fails, coverage drops below test/baseline.json `coverage`, or the test count drops below the baseline.
// --update-baseline raises the baseline to the current counts (and coverage floors to current − margin);
// add --allow-drop to lower it on purpose (e.g. tests were consolidated).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE = join(ROOT, 'test/baseline.json')
const REPORTS = join(ROOT, 'reports')
const args = new Set(process.argv.slice(2))
const coverage = args.has('--coverage') || args.has('--update-baseline')
const update = args.has('--update-baseline')
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const files = readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => `test/${f}`)
mkdirSync(REPORTS, { recursive: true })

const flags = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${join(REPORTS, 'junit.xml')}`]
if (coverage) {
  const c = baseline.coverage
  flags.push('--experimental-test-coverage', '--test-coverage-include=src/**', '--test-coverage-include=index.js', '--test-reporter=lcov', `--test-reporter-destination=${join(REPORTS, 'lcov.info')}`)
  if (!update) flags.push(`--test-coverage-lines=${c.lines}`, `--test-coverage-branches=${c.branches}`, `--test-coverage-functions=${c.functions}`)
}
const r = spawnSync(process.execPath, [...flags, ...files], { cwd: ROOT, stdio: 'inherit' })

const junit = existsSync(join(REPORTS, 'junit.xml')) ? readFileSync(join(REPORTS, 'junit.xml'), 'utf8') : ''
const num = k => Number((junit.match(new RegExp(`<!-- ${k} (\\d+) -->`)) || [])[1] ?? NaN)
const now = { files: files.length, tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') }
let cov
if (coverage && existsSync(join(REPORTS, 'lcov.info'))) {
  const t = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 }
  for (const line of readFileSync(join(REPORTS, 'lcov.info'), 'utf8').split('\n')) { const m = line.match(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)/); if (m) t[m[1]] += Number(m[2]) }
  const pct = (h, f) => f ? Math.round((h / f) * 10000) / 100 : 100
  cov = { lines: pct(t.LH, t.LF), branches: pct(t.BRH, t.BRF), functions: pct(t.FNH, t.FNF) }
  writeFileSync(join(REPORTS, 'coverage-summary.json'), JSON.stringify(cov, null, 2) + '\n')
}
writeFileSync(join(REPORTS, 'summary.json'), JSON.stringify({ ...now, coverage: cov, node: process.version }, null, 2) + '\n')

const problems = []
if (r.status !== 0) problems.push(`node --test exited ${r.status}${coverage ? ' (failing test or coverage below threshold)' : ''}`)
if (!Number.isFinite(now.tests)) problems.push('could not read the test counts from reports/junit.xml')
console.log(`\ntests: ${now.tests} (pass ${now.pass}, fail ${now.fail}, skipped ${now.skipped}) in ${now.files} files; baseline ${baseline.tests} tests / ${baseline.pass} pass / ${baseline.files} files`)
if (cov) console.log(`coverage: lines ${cov.lines}% · branches ${cov.branches}% · functions ${cov.functions}% (floors ${baseline.coverage.lines}/${baseline.coverage.branches}/${baseline.coverage.functions})`)

if (update) {
  if (r.status !== 0 && !args.has('--allow-drop')) { console.error('refusing to update the baseline: the run failed'); process.exit(1) }
  const drop = now.tests < baseline.tests || now.pass < baseline.pass || now.files < baseline.files
  if (drop && !args.has('--allow-drop')) { console.error('refusing to lower the baseline without --allow-drop'); process.exit(1) }
  const margin = baseline.coverageMargin ?? 1.5
  const floor = v => Math.max(0, Math.floor(v - margin))
  const next = { ...baseline, files: now.files, tests: now.tests, pass: now.pass, coverage: cov ? { lines: floor(cov.lines), branches: floor(cov.branches), functions: floor(cov.functions) } : baseline.coverage }
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
  console.log(`baseline updated: ${JSON.stringify(next)}`)
  process.exit(0)
}
if (now.files < baseline.files) problems.push(`test files dropped: ${now.files} < baseline ${baseline.files}`)
if (now.tests < baseline.tests) problems.push(`test count dropped: ${now.tests} < baseline ${baseline.tests}`)
if (now.pass < baseline.pass) problems.push(`passing tests dropped: ${now.pass} < baseline ${baseline.pass}`)
if (problems.length) {
  console.error(`\nTEST GUARD FAILED\n  - ${problems.join('\n  - ')}\nIf tests were removed on purpose: npm run test:baseline:update -- --allow-drop (and say why in the PR).`)
  process.exit(1)
}
if (now.tests > baseline.tests || now.pass > baseline.pass || now.files > baseline.files) console.log('More tests than the baseline: bump it with `npm run test:baseline:update` and commit test/baseline.json.')
console.log('test guard: OK')
