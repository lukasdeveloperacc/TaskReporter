import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import express from 'express'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import * as z from 'zod/v4'
import { ASK_WAIT_MS, CLOSED, SSE_EVENTS, type AskArgs, type AskResult, type ProgressData, type ReportArgs } from '../shared/contract.ts'
import { apply, INIT } from './progress.ts'
import { docDiff, inWorkspace, readDoc, resolveDoc, watchDoc } from './docs.ts'
import { openStore, type AskRow, type RunRow } from './store.ts'

type Store = ReturnType<typeof openStore>
type WaitResult = { result?: AskResult; error?: Error }
type Waiter = (result: WaitResult) => void
type Watcher = { path: string; stop: () => void }

export type CreateAppOptions = {
  db: Store
  workspaceRoot: string
  now?: () => number
  askWaitMs?: number
  staticDir?: string
}

const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function originAllowed(origin: string, req: Request, devOrigin?: string): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || parsed.protocol !== 'http:' || !ALLOWED_HOSTS.includes(parsed.hostname)) return false
    if (origin === devOrigin && devOrigin) return true
    return Number(parsed.port || 80) === (req.socket.localPort ?? 80)
  } catch {
    return false
  }
}

function isEnded(run: RunRow): boolean {
  return CLOSED.includes((run.state.stage ?? '').split(' ')[0] as (typeof CLOSED)[number])
}

function toolError(message: string): never {
  throw new Error(message)
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function activeDoc(run: RunRow, workspaceRoot: string): string | null {
  return resolveDoc(run.project_path, run.doc_path, workspaceRoot)
}

export function createApp({ db, workspaceRoot, now = Date.now, askWaitMs = ASK_WAIT_MS, staticDir }: CreateAppOptions) {
  if (!Number.isFinite(askWaitMs) || askWaitMs <= 0 || askWaitMs > 300_000) {
    throw new RangeError('ASK_WAIT_MS must be a finite number greater than 0 and no more than 300000')
  }
  const root = resolve(workspaceRoot)
  const app = createMcpExpressApp({ allowedHosts: ALLOWED_HOSTS })
  const watchers = new Map<string, Watcher>()
  const waiters = new Map<string, Set<Waiter>>()
  const eventClients = new Set<Response>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const devOrigin = process.env.OFFICE_DEV_ORIGIN

  app.use((req, res, next) => {
    if ((req.path === '/mcp' || req.path === '/api' || req.path.startsWith('/api/')) && req.get('origin') !== undefined && !originAllowed(req.get('origin')!, req, devOrigin)) {
      res.status(403).json({ error: 'forbidden origin' })
      return
    }
    next()
  })

  const broadcast = (event: string, data: unknown = {}) => {
    const encoded = JSON.stringify(data)
    for (const response of eventClients) {
      if (response.destroyed || response.writableEnded) {
        eventClients.delete(response)
        continue
      }
      response.write(`event: ${event}\ndata: ${encoded}\n\n`)
    }
  }

  const stopWatcher = (runId: string) => {
    const current = watchers.get(runId)
    if (current) {
      current.stop()
      watchers.delete(runId)
    }
  }

  const startWatcher = (run: RunRow) => {
    stopWatcher(run.id)
    if (run.ended_at) return
    const abs = activeDoc(run, root)
    if (!abs) return
    const stop = watchDoc(abs, () => broadcast(SSE_EVENTS.docChanged, { run_id: run.id, path: run.doc_path }))
    watchers.set(run.id, { path: abs, stop })
  }

  const settleWaiters = (askId: string, value: WaitResult) => {
    const active = waiters.get(askId)
    if (!active) return
    waiters.delete(askId)
    for (const settle of active) settle(value)
  }

  function waitForAsk(askId: string, signal: AbortSignal | undefined, response: Response): Promise<AskResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      let finished = false
      let timeout: ReturnType<typeof setTimeout>
      const settle: Waiter = (value) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        response.removeListener('close', onResponseClose)
        const registered = waiters.get(askId)
        registered?.delete(settle)
        if (registered?.size === 0) waiters.delete(askId)
        if (value.error) rejectPromise(value.error)
        else resolvePromise(value.result!)
      }
      const onAbort = () => settle({ error: new Error('request cancelled') })
      const onResponseClose = () => {
        if (!response.writableEnded) settle({ error: new Error('request closed') })
      }
      if (!waiters.has(askId)) waiters.set(askId, new Set())
      waiters.get(askId)!.add(settle)
      signal?.addEventListener('abort', onAbort, { once: true })
      response.on('close', onResponseClose)
      timeout = setTimeout(() => settle({ result: { status: 'pending', ask_id: askId } }), askWaitMs)
      if (signal?.aborted || response.destroyed) onAbort()
    })
  }

  const report = (args: ReportArgs) => {
    if (!isAbsolute(args.project_path)) toolError('project_path must be absolute')
    const projectPath = resolve(args.project_path)
    const stamp = now()
    const existing = args.run_id ? db.getRun(args.run_id) : undefined
    if (args.run_id && !existing) toolError(`unknown run_id: ${args.run_id}`)
    if (existing && existing.project_path !== projectPath) toolError('run_id belongs to a different project')
    const state = apply(existing?.state ?? INIT(args.title ?? basename(projectPath)), args.patch, stamp)
    const run: RunRow = existing ?? {
      id: '', project_path: projectPath, state, doc_path: null, doc_baseline: null,
      last_report_at: new Date(stamp).toISOString(), ended_at: null,
    }
    run.state = state
    const previousResolved = activeDoc(run, root)
    const docPathProvided = typeof args.doc_path === 'string' && args.doc_path.length > 0
    const nextDocPath = docPathProvided ? args.doc_path! : run.doc_path
    const pathChanged = docPathProvided && nextDocPath !== run.doc_path
    if (pathChanged) run.doc_baseline = null
    run.doc_path = nextDocPath ?? null
    const newResolved = activeDoc(run, root)
    if (previousResolved !== newResolved) run.doc_baseline = null
    const changes: { path: string; diff: string }[] = []
    if (newResolved) {
      const text = readDoc(newResolved)
      if (text !== null) {
        if (run.doc_baseline === null) run.doc_baseline = text
        else if (run.doc_baseline !== text) {
          changes.push({ path: run.doc_path!, diff: docDiff(run.doc_path!, run.doc_baseline, text) })
          run.doc_baseline = text
        }
      }
    }
    const ended = isEnded(run)
    run.ended_at = ended ? (run.ended_at ?? new Date(stamp).toISOString()) : null
    run.last_report_at = new Date(stamp).toISOString()
    let closedIds: string[] = []
    db.transaction(() => {
      db.upsertProject(projectPath, inWorkspace(projectPath, root), stamp)
      if (!existing) {
        const created = db.createRun(projectPath, state, stamp)
        run.id = created.id
        run.last_report_at = created.last_report_at
      }
      db.saveRun(run)
      closedIds = args.close_ask_ids ? db.closeAsks(run.id, args.close_ask_ids) : []
      if (ended) closedIds = [...new Set([...closedIds, ...db.closeAsks(run.id)])]
    })

    if (run.ended_at) stopWatcher(run.id)
    else if (previousResolved !== newResolved || !watchers.has(run.id)) startWatcher(run)
    for (const id of closedIds) settleWaiters(id, { error: new Error('ask closed') })
    broadcast(SSE_EVENTS.changed)
    return { run_id: run.id, doc_changes: changes }
  }

  const askTool = async (args: AskArgs, extra: { signal?: AbortSignal }, response: Response): Promise<AskResult> => {
    let askId = args.ask_id
    let ask: AskRow | undefined
    if (askId) {
      ask = db.getAsk(askId)
      if (!ask || ask.run_id !== args.run_id) toolError('unknown ask_id for run')
      if (ask.status === 'answered') return { status: 'answered', answer: ask.answer!, ask_id: ask.id }
      if (ask.status === 'closed') toolError('ask closed')
    }
    const run = db.getRun(args.run_id)
    if (!run) toolError(`unknown run_id: ${args.run_id}`)
    if (isEnded(run)) toolError('run has ended')
    if (!askId) {
      askId = db.transaction(() => db.createAsk(run.id, args.question, args.options, args.recommended, now()))
      broadcast(SSE_EVENTS.changed)
    }
    return waitForAsk(askId, extra.signal, response)
  }

  const schema = {
    project_path: z.string(),
    run_id: z.string().optional(),
    doc_path: z.string().optional(),
    title: z.string().optional(),
    patch: z.record(z.string(), z.unknown()),
    close_ask_ids: z.array(z.string()).optional(),
  }
  const askSchema = {
    run_id: z.string(), question: z.string(), options: z.array(z.string()).min(1).max(6),
    recommended: z.string().optional(), ask_id: z.string().optional(),
  }

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'office-team-reporter', version: '1.0.0' })
    server.registerTool('report', { description: 'Report basic-team progress and document changes', inputSchema: schema }, async (args) => jsonResult(report(args as ReportArgs)))
    server.registerTool('ask', { description: 'Ask the user for a decision and wait for an answer', inputSchema: askSchema }, async (args, extra) => jsonResult(await askTool(args as AskArgs, extra, res)))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' })
    }
  })
  app.get('/mcp', (_req, res) => res.sendStatus(405))
  app.delete('/mcp', (_req, res) => res.sendStatus(405))

  app.get('/api/state', (_req, res) => {
    res.json(db.snapshot((run) => activeDoc(run, root) !== null))
  })

  app.get('/api/events', (_req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    res.write(': connected\n\n')
    eventClients.add(res)
    const ping = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n')
    }, 25_000)
    ping.unref?.()
    timers.add(ping)
    const cleanup = () => {
      clearInterval(ping)
      timers.delete(ping)
      eventClients.delete(res)
    }
    res.on('close', cleanup)
  })

  app.post('/api/asks/:id/answer', (req, res) => {
    if (!req.body || typeof req.body.answer !== 'string') return res.status(400).json({ error: 'answer must be a string' })
    const result = db.answerAsk(req.params.id!, req.body.answer)
    if (result === 'invalid-option') return res.status(400).json({ error: 'answer must be one of the ask options' })
    if (result === 'not-found') return res.status(404).json({ error: 'ask not found' })
    if (result === 'not-pending') return res.status(409).json({ error: 'ask is not pending' })
    const ask = db.getAsk(req.params.id!)!
    settleWaiters(ask.id, { result: { status: 'answered', answer: ask.answer!, ask_id: ask.id } })
    broadcast(SSE_EVENTS.changed)
    return res.json({ ok: true })
  })

  app.get('/api/runs/:id/doc', (req, res) => {
    const run = db.getRun(req.params.id!)
    if (!run) return res.status(404).json({ error: 'run not found' })
    if (!run.doc_path) return res.status(404).json({ error: 'run has no document' })
    const lexical = resolve(run.project_path, run.doc_path)
    if (extname(lexical) !== '.md' || !inWorkspace(run.project_path, root) || !inWorkspace(lexical, run.project_path) || !inWorkspace(lexical, root)) {
      return res.status(403).json({ error: 'document is not accessible' })
    }
    if (!existsSync(lexical)) return res.status(404).json({ error: 'document not found' })
    const abs = resolveDoc(run.project_path, run.doc_path, root)
    if (!abs) return res.status(403).json({ error: 'document is not accessible' })
    const text = readDoc(abs)
    if (text === null) return res.status(404).json({ error: 'document not found' })
    return res.json({ path: run.doc_path, text })
  })

  app.use('/api', (_req, res) => res.sendStatus(404))

  if (staticDir) {
    const absoluteStaticDir = resolve(staticDir)
    app.use(express.static(absoluteStaticDir))
    app.use((_req, res) => res.sendFile(resolve(absoluteStaticDir, 'index.html')))
  }

  for (const run of db.listActiveRuns()) startWatcher(run)

  return {
    app,
    close() {
      for (const runId of watchers.keys()) stopWatcher(runId)
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      for (const response of eventClients) response.end()
      eventClients.clear()
      for (const askId of waiters.keys()) settleWaiters(askId, { error: new Error('app closed') })
    },
  }
}
