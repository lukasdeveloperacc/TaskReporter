import { createServer } from 'node:http'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASK_WAIT_MS, PORT } from '../shared/contract.ts'
import { createApp } from './app.ts'
import { openStore } from './store.ts'

export function start(env: NodeJS.ProcessEnv = process.env) {
  const workspaceRoot = env.WORKSPACE_ROOT
  if (!workspaceRoot) throw new Error('WORKSPACE_ROOT is required; set it to the workspace directory mounted into the container')
  const host = env.HOST ?? '127.0.0.1'
  const portText = env.PORT ?? String(PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535')
  const dbPath = env.DB_PATH ?? './data/office.db'
  const askWaitMs = env.ASK_WAIT_MS === undefined ? ASK_WAIT_MS : Number(env.ASK_WAIT_MS)
  if (!Number.isFinite(askWaitMs) || askWaitMs <= 0 || askWaitMs > 300_000) {
    throw new Error('ASK_WAIT_MS must be a finite number greater than 0 and no more than 300000')
  }
  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = openStore(dbPath)
  const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/web')
  const { app, close } = createApp({ db, workspaceRoot, askWaitMs, ...(existsSync(staticDir) ? { staticDir } : {}) })
  const server = createServer(app)
  server.listen(port, host)
  const shutdown = () => {
    close()
    db.close()
    server.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    start()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
