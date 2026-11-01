#!/usr/bin/env node
// Jiuwen state helper for scripts/guard-live.sh (config files are handled by the shell script, byte for byte).
//   save <file>             RPC-visible state + custom MCP records (no secrets: ids, titles, levels, names)
//   restore <file>          delete sessions created since, reset heartbeat/permissions/MCP; prints the remaining diff keys
//   diff <file>             prints the keys that differ from <file> (empty = identical)
import { readFileSync, writeFileSync } from 'node:fs'
import { snapshot, restore, jiuwenState } from './lib.mjs'

const [cmd, file] = process.argv.slice(2)
if (!file || !['save', 'restore', 'diff'].includes(cmd)) { console.error('usage: guard-state.mjs save|restore|diff <file>'); process.exit(2) }
if (cmd === 'save') {
  const s = await snapshot()
  writeFileSync(file, JSON.stringify({ mcp: s.mcp, state: s.state }), { mode: 0o600 })
  console.log(`${s.state.sessions.length} sessions, ${s.state.mcp.length} MCP servers`)
} else {
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  let diff
  if (cmd === 'restore') diff = await restore({ config: new Map(), ...snap })
  else { const now = await jiuwenState(); diff = Object.keys({ ...snap.state, ...now }).filter(k => JSON.stringify(snap.state[k]) !== JSON.stringify(now[k])) }
  console.log(diff.join(','))
}
process.exit(0)
