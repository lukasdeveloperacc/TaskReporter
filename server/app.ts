import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import express from 'express'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import * as z from 'zod/v4'
import { ASK_WAIT_MS, CLOSED, LANES, REVIEWERS, STATUSES, SSE_EVENTS, type AskArgs, type AskResult, type ProgressData, type ReportArgs } from '../shared/contract.ts'
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

function jsonResult(value: Record<string, unknown>) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
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
      timeout = setTimeout(() => settle({ result: { status: 'pending', ask_id: askId, retry_after_sec: 0, message: '같은 ask_id로 ask를 다시 호출하세요. 새 질문을 만들지 마세요.' } }), askWaitMs)
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
    if (args.check_replies?.length && !args.run_id) toolError('check_replies require run_id')
    const duplicateReplies = new Map<string, string>()
    for (const reply of args.check_replies ?? []) {
      const prior = duplicateReplies.get(reply.check_id)
      if (prior !== undefined && prior !== reply.answer) toolError(`conflicting check_replies for check_id: ${reply.check_id}`)
      duplicateReplies.set(reply.check_id, reply.answer)
    }
    for (const [id, answer] of duplicateReplies) {
      const check = db.check(id)
      if (!check || check.run_id !== args.run_id || db.getRun(check.run_id)?.project_path !== projectPath) toolError('unknown check_id for run')
      if (check.status === 'closed') toolError('check is closed')
      if (check.status === 'answered' && check.answer !== answer) toolError(`conflicting answer for check_id: ${id}`)
    }
    const previousState = existing?.state
    const wasEnded = existing?.ended_at !== null && existing?.ended_at !== undefined
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
      for (const [id, answer] of duplicateReplies) db.replyCheck(id, answer, stamp)
      db.upsertProject(projectPath, inWorkspace(projectPath, root), stamp)
      if (!ended) db.setProjectHidden(projectPath, false)
      if (!existing) {
        const created = db.createRun(projectPath, state, stamp)
        run.id = created.id
        run.last_report_at = created.last_report_at
      }
      db.saveRun(run)
      db.reconcileChecks(run.id, previousState, run.state, stamp, wasEnded)
      closedIds = args.close_ask_ids ? db.closeAsks(run.id, args.close_ask_ids) : []
      if (ended) closedIds = [...new Set([...closedIds, ...db.closeAsks(run.id)])]
    })

    if (run.ended_at) stopWatcher(run.id)
    else if (previousResolved !== newResolved || !watchers.has(run.id)) startWatcher(run)
    for (const id of closedIds) settleWaiters(id, { error: new Error('ask closed') })
    broadcast(SSE_EVENTS.changed)
    return {
      run_id: run.id, doc_changes: changes, ...(args.include_state === false ? {} : { state: run.state }), ended_at: run.ended_at, checks: db.checks(run.id, true),
      asks: db.asks(run.id).filter((ask) => ask.status === 'answered')
        .map((ask) => ({ ask_id: ask.id, status: 'answered' as const, answer: ask.answer! })),
    }
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

  const usage = [
    'report.include_state:false는 응답의 state만 생략합니다. 생략 또는 true면 기존 전체 응답입니다. 전체 state는 get_run.state로 조회하세요.',
    'report.asks는 답변된 결재를 {ask_id,status:answered,answer}로 매번 재전달합니다. ask_id로 중복 처리하세요. get_run.asks는 pending과 answered를 조회하며 수신 확인 상태를 변경하지 않습니다.',
    'ask 기본 대기는 100초입니다. pending.retry_after_sec 뒤 같은 ask_id로 다시 호출하세요. report가 호출되지 않는 동안에도 ask 재호출을 계속해야 답을 받습니다.',
    '첫 report 응답의 run_id를 받아 이후 report와 ask, get_run에서 재사용하세요.',
    'close_ask_ids는 patch 안이 아닌 report 최상위에 넣으세요.',
    'stage는 계획·구현·리뷰·수정·마무리·완료·중단 중 하나로 시작하고 상세는 공백 뒤에 쓰세요.',
    'tasks는 id, decisions는 title, reviews는 round+reviewer로 merge됩니다. task.todos도 같은 작업 안에서 id로 보낸 필드만 merge하고 미전송 항목과 최초 순서를 유지합니다. 새 todo의 text 생략 시 id를 쓰며, 체크 예: tasks:[{id:"FE",todos:[{id:"FE-2",done:true}]}].',
    'task의 owner가 사무실 좌석을 정합니다. 상태 조회에는 읽기 전용 get_run을 사용하세요.',
    'report 응답의 checks는 작업 상태 설명을 요청합니다. 확인한 뒤 check_replies:[{check_id,answer}]로 답하세요. 답변은 설명일 뿐 성공 판정이 아닙니다. model/effort가 없으면 host/runtime에서 실제 값을 확인해 같은 task id patch로 보고하고, 확인할 수 없으면 이유를 설명하고 값을 비워 두세요.',
    '체크인이 남은 TODO를 보여주면 실제 작업을 해결한 뒤 해당 id를 done:true로 보고하세요. 미완료 TODO가 남은 task는 완료할 수 없고, run stage 완료에도 모든 task의 TODO 완료가 필요합니다. 중단은 미완료 TODO를 보존하는 비성공 종료입니다.',
  ].join('\n')
  const schema = z.object({
    project_path: z.string().describe('프로젝트의 절대 경로'),
    include_state: z.boolean().optional().describe('false면 응답 state만 생략; 미지정/true는 포함. 전체 상태는 get_run.state로 조회'),
    run_id: z.string().optional().describe('최초 report 응답에서 받은 run_id; 같은 실행에서는 재사용'),
    doc_path: z.string().optional().describe('프로젝트 기획서 Markdown 경로'),
    title: z.string().optional().describe('실행 제목'),
    patch: z.object({
      title: z.string().optional().describe('실행 제목 변경'),
      stage: z.string().optional().describe('계획·구현·리뷰·수정·마무리·완료·중단 접두어; 상세는 공백 뒤'),
      summary: z.string().optional().describe('현재 진행 요약'),
      blockers: z.string().optional().describe('진행을 막는 문제'),
      todo: z.string().optional().describe('다음 할 일'),
      tasks: z.array(z.object({
        id: z.string().min(1).describe('작업 merge 키; 같은 작업은 같은 id 사용'),
        title: z.string().optional().describe('작업 제목'),
        owner: z.string().optional().describe('담당 에이전트 이름; 사무실 좌석을 결정'),
        model: z.string().optional().describe('host가 확인한 전체 model ID; 별칭이나 추측값 대신 실제 ID 사용, 모르면 생략'),
        effort: z.string().optional().describe('host가 확인한 reasoning effort 값(low|medium|high 등); 모르면 생략'),
        lane: z.enum(LANES).optional().describe('작업 단계'),
        status: z.enum(STATUSES).optional().describe('작업 상태'),
        after: z.array(z.string()).optional().describe('선행 작업 id 목록'),
        note: z.string().optional().describe('작업 상세 또는 결과'),
        todos: z.array(z.object({
          id: z.string().min(1).describe('같은 작업 안 TODO merge 키; 비어있지 않은 문자열'),
          text: z.string().optional().describe('TODO 제목; 새 항목에서 생략하면 id 사용'),
          phase: z.string().optional().describe('TODO를 묶어 표시할 Phase 이름'),
          done: z.boolean().optional().describe('체크 완료 여부; true로 완료, false로 해제'),
          detail: z.string().optional().describe('접어서 표시할 TODO 상세 설명'),
        }).strict()).optional().describe('작업 안에서 id로 필드별 merge할 TODO 목록; 미전송 항목과 최초 순서 유지, 빈 배열도 삭제하지 않음'),
      }).strict()).optional().describe('id로 merge할 작업 목록'),
      decisions: z.array(z.object({
        title: z.string().describe('결정 제목; merge 키'),
        body: z.string().optional().describe('결정 내용과 근거'),
      }).strict()).optional().describe('title로 merge할 결정 목록'),
      reviews: z.array(z.object({
        round: z.number().int().describe('리뷰 라운드; reviewer와 함께 merge 키'),
        reviewer: z.enum(REVIEWERS).describe('정확한 리뷰어 이름; round와 함께 merge 키'),
        verdict: z.string().optional().describe('리뷰 판정'),
        note: z.string().optional().describe('리뷰 의견'),
      }).strict()).optional().describe('round+reviewer로 merge할 리뷰 목록'),
    }).strict().describe('기존 상태에 병합할 진행 변경; 알 수 없는 키는 거부'),
    close_ask_ids: z.array(z.string()).optional().describe('종료할 질문 id 목록; patch 밖 최상위 필드'),
    check_replies: z.array(z.object({
      check_id: z.string().trim().min(1), answer: z.string().trim().min(1),
    }).strict()).optional().describe('report 응답 checks에 대한 설명; 기존 run_id 필수'),
  }).strict()
  const askSchema = z.object({
    run_id: z.string().describe('report 응답의 실행 id'),
    question: z.string().describe('사용자에게 물을 질문'),
    options: z.array(z.string()).min(1).max(6).describe('선택지 1~6개'),
    recommended: z.string().optional().describe('options에 포함된 추천 선택지'),
    ask_id: z.string().optional().describe('pending.retry_after_sec 뒤 같은 ask_id로 재호출; answered는 저장된 답을 즉시 반환'),
  }).strict().refine((args) => args.recommended === undefined || args.options.includes(args.recommended), {
    path: ['recommended'], message: 'recommended must be one of the options',
  })

  const answeredAskSchema = z.object({ ask_id: z.string(), status: z.literal('answered'), answer: z.string() })
  const reportOutputSchema = z.object({
    run_id: z.string(), doc_changes: z.array(z.object({ path: z.string(), diff: z.string() })),
    state: z.record(z.string(), z.unknown()).optional(), ended_at: z.string().nullable(), checks: z.array(z.unknown()),
    asks: z.array(answeredAskSchema).describe('답변된 결재를 반복 전달; ask_id로 중복 처리, 조회는 수신 확인이 아님'),
  })
  const askOutputSchema = z.object({
    status: z.enum(['pending', 'answered']), ask_id: z.string(), answer: z.string().optional(),
    retry_after_sec: z.number().nonnegative().optional().describe('pending 후 동일 ask_id 재호출까지 대기할 초; 0이면 즉시 재호출'),
    message: z.string().optional().describe('pending 재호출 안내'),
  })
  const runAskSchema = z.object({
    id: z.string(), ask_id: z.string(), run_id: z.string(), question: z.string(), options: z.array(z.string()),
    recommended: z.string().nullable(), status: z.enum(['pending', 'answered']), answer: z.string().nullable(),
  })
  const getRunOutputSchema = z.object({
    state: z.record(z.string(), z.unknown()).describe('실행의 전체 진행 상태'),
    run_id: z.string(), project_path: z.string(), stage: z.string().optional(), ended_at: z.string().nullable(),
    tasks: z.array(z.unknown()), decisions: z.array(z.unknown()), reviews: z.array(z.unknown()),
    asks: z.array(runAskSchema).describe('pending과 answered 결재; answered는 ask_id로 중복 처리'), checks: z.array(z.unknown()),
  })

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'office-team-reporter', version: '1.0.0' }, { instructions: usage })
    server.registerTool('report', { description: usage, inputSchema: schema, outputSchema: reportOutputSchema }, async (args) => jsonResult(report(args)))
    server.registerTool('ask', { description: 'Ask the user for a decision; default wait 100 seconds. On pending, wait retry_after_sec then call with the same ask_id. Answered replies remain available through ask, report.asks and get_run.asks; deduplicate by ask_id.', inputSchema: askSchema, outputSchema: askOutputSchema }, async (args, extra) => jsonResult(await askTool(args, extra, res)))
    server.registerTool('get_run', {
      description: 'Read a run with full state, pending and answered asks, and check history without changing state; deduplicate answered asks by ask_id',
      inputSchema: z.object({ run_id: z.string().describe('조회할 실행 id; report 응답에서 받은 run_id') }).strict(),
      outputSchema: getRunOutputSchema,
      annotations: { readOnlyHint: true },
    }, async ({ run_id }) => {
      const run = db.getRun(run_id)
      if (!run) toolError(`unknown run_id: ${run_id}`)
      return jsonResult({
        run_id: run.id, project_path: run.project_path, state: run.state, stage: run.state.stage, ended_at: run.ended_at,
        tasks: run.state.tasks ?? [], decisions: run.state.decisions ?? [], reviews: run.state.reviews ?? [],
        asks: db.asks(run.id).map(({ created_at: _, ...ask }) => ({ ...ask, ask_id: ask.id })),
        checks: db.checks(run.id),
      })
    })
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

  app.patch('/api/projects/visibility', (req, res) => {
    const { project_path, hidden } = req.body ?? {}
    if (typeof project_path !== 'string' || project_path.length === 0 || typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'project_path and hidden are required' })
    }
    if (!db.setProjectHidden(project_path, hidden)) return res.status(404).json({ error: 'project not found' })
    broadcast(SSE_EVENTS.changed)
    return res.json({ ok: true })
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
