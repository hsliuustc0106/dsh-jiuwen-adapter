#!/usr/bin/env node
// Lint stand-in (the adapter has no dependencies, so no eslint): `node --check` every .js/.mjs/.cjs file
// under index.js, src/, bin/, scripts/ and test/. Run with `npm run lint`.
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP = new Set(['node_modules', '.git', 'examples', 'reports'])
const out = []
const walk = d => { for (const f of readdirSync(d)) { if (SKIP.has(f)) continue; const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (/\.(c|m)?js$/.test(f)) out.push(p) } }
out.push(join(ROOT, 'index.js'))
for (const d of ['src', 'bin', 'scripts', 'test']) walk(join(ROOT, d))
const bad = []
for (const f of out) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) bad.push(`${relative(ROOT, f)}\n${r.stderr.trim()}`) }
if (bad.length) { console.error(`syntax errors in ${bad.length} file(s):\n${bad.join('\n\n')}`); process.exit(1) }
console.log(`syntax OK: ${out.length} files`)
