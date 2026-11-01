/** Spawn bin/mock-gateway.mjs on an OS-assigned port (port 0) and resolve once it is listening. */
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export function spawnMockGateway(env = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], {
    env: { ...process.env, ...env, JIUWEN_GATEWAY_MOCK_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    let buf = ''
    const onExit = c => reject(new Error(`mock-gateway exited ${c} before listening`))
    child.on('exit', onExit)
    child.stdout.on('data', d => {
      buf += String(d)
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(buf)
      if (!m) return
      child.off('exit', onExit)
      child.stdout.resume()
      const port = Number(m[1])
      resolve({
        child, port, url: `ws://127.0.0.1:${port}/ws`,
        stop: () => new Promise(r => { if (child.exitCode !== null || child.signalCode) return r(); child.once('exit', () => r()); child.kill() }),
      })
    })
  })
}
