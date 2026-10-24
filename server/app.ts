import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import express from 'express'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import * as z from 'zod/v4'
import { ASK_WAIT_MS, CLOSED, LANES, RETRO_CATEGORIES, RETRO_TASK_ID, REVIEWERS, STATUSES, SSE_EVENTS, type ActiveRunSummary, type AskArgs, type AskResult, type OpenTodos, type ProgressData, type ReportArgs, type Task, type TaskPlacement } from '../shared/contract.ts'
import { actorAssignments, resolveDepartment, roles } from '../shared/office-roles.ts'
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
const RETRO_LIMIT = 200
const RECENT_MISSING_LIMIT = 20

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

// Remaining TODOs of the tasks a report touched, so callers see what is left even without state.
function openTodos(state: ProgressData, taskIds: string[]): OpenTodos[] {
  return (state.tasks ?? []).filter((task) => taskIds.includes(task.id)).flatMap((task) => {
    const open = (task.todos ?? []).filter((todo) => todo.done !== true)
    return open.length ? [{ task_id: task.id, open: open.length, next: { id: open[0]!.id, text: open[0]!.text || open[0]!.id } }] : []
  })
}

function toolError(message: string): never {
  throw new Error(message)
}

function jsonResult(value: Record<string, unknown>) {
  return { structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function taskPlacements(tasks: Task[]): TaskPlacement[] {
  const assignments = actorAssignments(tasks)
  return tasks.map((task) => {
    const owner = task.owner || null
    const assignment = owner ? assignments.get(owner) : undefined
    const resolved = resolveDepartment(owner ?? undefined, assignment?.lane)
    return { task_id: task.id, owner, department: resolved.department, matched_by: resolved.matched_by }
  })
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
    if (args.patch.tasks?.some((task) => task.id === RETRO_TASK_ID)) toolError(`task id ${RETRO_TASK_ID} is reserved`)
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
    if (args.retro && !ended) toolError('retro requires ended run')
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
      db.recordTodoTicks(run.id, previousState, run.state, stamp)
      if (args.retro) db.replaceRetro(run.id, args.retro, stamp)
      db.syncRetroCheck(run.id, ended, stamp, !wasEnded)
      closedIds = args.close_ask_ids ? db.closeAsks(run.id, args.close_ask_ids) : []
      if (ended) closedIds = [...new Set([...closedIds, ...db.closeAsks(run.id)])]
    })

    if (run.ended_at) stopWatcher(run.id)
    else if (previousResolved !== newResolved || !watchers.has(run.id)) startWatcher(run)
    for (const id of closedIds) settleWaiters(id, { error: new Error('ask closed') })
    broadcast(SSE_EVENTS.changed)
    const touchedIds = new Set(args.patch.tasks?.map((task) => task.id) ?? [])
    return {
      checks: db.checks(run.id, true),
      asks: db.asks(run.id).filter((ask) => ask.status === 'answered')
        .map((ask) => ({ ask_id: ask.id, status: 'answered' as const, answer: ask.answer! })),
      open_todos: openTodos(run.state, args.patch.tasks?.map((task) => task.id) ?? []),
      run_id: run.id, doc_changes: changes, ended_at: run.ended_at,
      placements: taskPlacements(run.state.tasks ?? []).filter((placement) => touchedIds.has(placement.task_id)),
      ...(!existing ? { active_runs: activeRuns(projectPath) } : {}),
      ...(args.include_state === false ? {} : { state: run.state }),
    }
  }

  const activeRuns = (projectPath: string): ActiveRunSummary[] => db.listActiveRunsForProject(projectPath).map((run) => ({
    run_id: run.id, title: run.state.title ?? basename(projectPath), stage: run.state.stage ?? null, last_report_at: run.last_report_at,
  }))

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
    'task의 owner와 shared office rules가 배우 배정을 정합니다. report/get_run placements는 데이터에서 계산한 배정이며 브라우저 렌더링이나 실제 좌석 표시 증거가 아닙니다. fallback/unassigned를 확인하려면 get_office_rules를 조회하세요.',
    'get_office_rules는 부서와 owner 매칭 규칙을, get_active_runs는 지정한 절대 project_path의 종료되지 않은 run만 조회합니다. hidden 프로젝트도 포함하며 다른 프로젝트를 검색하지 않습니다.',
    '신규 실행 전 get_active_runs로 같은 프로젝트의 실행을 확인하세요. 새 run의 첫 report에만 active_runs(자신 포함 진행 중 실행)를 반환합니다. 자동 재개·형제 실행 종료는 하지 않습니다. get_run.last_report_at은 저장된 마지막 보고 시각이며 실제 agent 생존 증거가 아닙니다.',
    'report 응답의 checks는 작업 상태 설명을 요청합니다. 확인한 뒤 check_replies:[{check_id,answer}]로 답하세요. 답변은 설명일 뿐 성공 판정이 아닙니다. model/effort가 없으면 host/runtime에서 실제 값을 확인해 같은 task id patch로 보고하고, 확인할 수 없으면 이유를 설명하고 값을 비워 두세요.',
    'retro는 run을 끝내는(완료·중단, finish 자동 종료 포함) report 또는 종료된 run의 report 최상위에 최대 3개 보냅니다. 스킬 지시·도구·프로세스 문제만 적고 코드 결함은 리뷰에 남기세요. 없으면 retro:[]. 다시 보내면 run 단위로 교체됩니다. 빠뜨리면 checks의 task_id __retro__ 요청이 한 번 오며 patch:{}와 retro로 답하세요. 집계는 읽기 전용 get_retros로 조회합니다.',
    'report 응답 open_todos는 이번 patch.tasks의 남은 TODO와 첫 미완료 next입니다. TODO는 실제 진행 순서로 정의하고, 끝날 때마다 바로 done:true로 보고하세요(완료 직전 몰아서 체크 금지). 진행중 task의 상태·note만 바뀌고 15분째 TODO 체크가 없으면 체크인이 옵니다.',
    '체크인이 남은 TODO를 보여주면 실제 작업을 해결한 뒤 해당 id를 done:true로 보고하세요. 미완료 TODO가 남은 task는 완료할 수 없고, run stage 완료에도 모든 task의 TODO 완료가 필요합니다. 중단은 미완료 TODO를 보존하는 비성공 종료입니다.',
  ].join('\n')
  const retroItemSchema = z.object({
    skill: z.string().trim().min(1).max(64).describe('사용자가 호출한 진입 스킬 이름 (예: basic-team)'),
    skill_version: z.string().trim().min(1).max(64).describe('플러그인 버전+커밋 (예: 0.1.0+bb590a2); 불투명 문자열'),
    category: z.enum(RETRO_CATEGORIES).describe('문제 유형'),
    evidence: z.string().trim().min(1).max(500).describe('무슨 일이 있었는지 한 줄; 단계·파일·도구 포함'),
    suggestion: z.string().trim().min(1).max(500).optional().describe('개선 제안'),
  }).strict()
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
    retro: z.array(retroItemSchema).max(3).optional().describe('run 종료 회고 최대 3개; patch 밖 최상위 필드, 종료 상태에서만 허용, []는 회고 없음, 재전송 시 교체'),
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
  const activeRunsSchema = z.array(z.object({ run_id: z.string(), title: z.string(), stage: z.string().nullable(), last_report_at: z.string() }))
  const reportOutputSchema = z.object({
    run_id: z.string(), doc_changes: z.array(z.object({ path: z.string(), diff: z.string() })),
    state: z.record(z.string(), z.unknown()).optional(), ended_at: z.string().nullable(), checks: z.array(z.unknown()),
    placements: z.array(z.object({ task_id: z.string(), owner: z.string().nullable(), department: z.string().nullable(), matched_by: z.enum(['lane', 'owner', 'fallback', 'unassigned']) })),
    active_runs: activeRunsSchema.optional().describe('새 run 생성 응답에만 포함. 같은 프로젝트의 진행 중 run이며 자신도 포함; 기존 run을 자동 재개하거나 종료하지 않음'),
    asks: z.array(answeredAskSchema).describe('답변된 결재를 반복 전달; ask_id로 중복 처리, 조회는 수신 확인이 아님'),
    open_todos: z.array(z.object({ task_id: z.string(), open: z.number(), next: z.object({ id: z.string(), text: z.string() }) }))
      .describe('이번 patch.tasks에 포함된 task 중 미완료 TODO가 남은 것; next는 목록 순서상 첫 미완료(웹에서 진행 중 표시)'),
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
    last_report_at: z.string().describe('저장된 마지막 보고 시각; 조회는 이 값을 갱신하지 않음'),
    tasks: z.array(z.unknown()), decisions: z.array(z.unknown()), reviews: z.array(z.unknown()),
    asks: z.array(runAskSchema).describe('pending과 answered 결재; answered는 ask_id로 중복 처리'), checks: z.array(z.unknown()),
    retro: z.object({ submitted_at: z.string().nullable(), items: z.array(z.unknown()) }).describe('제출된 회고; submitted_at null이면 미제출'),
    placements: z.array(z.object({ task_id: z.string(), owner: z.string().nullable(), department: z.string().nullable(), matched_by: z.enum(['lane', 'owner', 'fallback', 'unassigned']) })),
  })

  const getRetrosSchema = z.object({
    skill: z.string().trim().min(1).optional().describe('스킬 이름 필터'),
    category: z.enum(RETRO_CATEGORIES).optional().describe('문제 유형 필터'),
    since: z.iso.datetime({ offset: true }).optional().describe('이 시각(ISO) 이후 회고만; 스킬 수정 전후 구분'),
    project_path: z.string().refine(isAbsolute, 'project_path must be absolute').optional().describe('프로젝트 절대 경로 필터'),
  }).strict()
  const getRetrosOutputSchema = z.object({
    groups: z.array(z.object({
      skill: z.string(), category: z.string(), run_count: z.number(), skill_versions: z.array(z.string()),
      last_at: z.string(), candidate: z.boolean(), items: z.array(z.unknown()),
    })).describe('skill+category 묶음; candidate 우선, run_count·last_at 내림차순'),
    signals: z.array(z.unknown()).describe('회고가 있는 run별 서버 계산 신호'),
    truncated: z.boolean().describe(`최근 ${RETRO_LIMIT}개 회고 행으로 잘렸는지`),
    submission: z.object({
      ended_runs: z.number(), submitted: z.number(), empty: z.number(), missing: z.number(),
      recent_missing: z.array(z.object({ run_id: z.string(), project_path: z.string(), ended_at: z.string() })),
    }).describe(`종료된 run의 회고 제출 현황; since(ended_at 기준)·project_path만 적용, skill·category는 무시. empty는 retro:[] 제출, recent_missing은 최근 미제출 ${RECENT_MISSING_LIMIT}개`),
  })

  const getRetros = (args: z.infer<typeof getRetrosSchema>) => {
    const filter = {
      ...args,
      since: args.since && new Date(args.since).toISOString(),
      project_path: args.project_path && resolve(args.project_path),
    }
    const rows = db.retros(filter, RETRO_LIMIT + 1)
    const truncated = rows.length > RETRO_LIMIT
    const kept = rows.slice(0, RETRO_LIMIT)
    const grouped = new Map<string, typeof kept>()
    for (const row of kept) {
      const key = `${row.skill}\u0000${row.category}`
      grouped.set(key, [...(grouped.get(key) ?? []), row])
    }
    const groups = [...grouped.values()].map((items) => {
      const runCount = new Set(items.map((item) => item.run_id)).size
      return {
        skill: items[0]!.skill, category: items[0]!.category, run_count: runCount,
        skill_versions: [...new Set(items.map((item) => item.skill_version))],
        last_at: items[0]!.created_at, candidate: runCount >= 2,
        items: items.map(({ skill: _s, category: _c, ...item }) => item),
      }
    }).sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.run_count - a.run_count || b.last_at.localeCompare(a.last_at))
    const signals = [...new Set(kept.map((row) => row.run_id))].map((runId) => {
      const run = db.getRun(runId)!
      const stats = db.checkStats(runId)
      const ticks = db.todoTickStats(runId)
      return {
        run_id: runId, project_path: run.project_path, stage: run.state.stage ?? null, ended_at: run.ended_at,
        review_rounds: Math.max(0, ...(run.state.reviews ?? []).map((review) => review.round)),
        checks_answered: stats.answered, checks_closed_unanswered: stats.closed_unanswered, avg_check_reply_ms: stats.avg_reply_ms,
        todos_ticked: ticks.ticked, todos_ticked_at_close: ticks.at_close,
      }
    })
    return { groups, signals, truncated, submission: db.retroSubmission(filter, RECENT_MISSING_LIMIT) }
  }

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'office-team-reporter', version: '1.0.0' }, { instructions: usage })
    server.registerTool('report', { description: usage, inputSchema: schema, outputSchema: reportOutputSchema }, async (args) => jsonResult(report(args)))
    server.registerTool('get_office_rules', {
      description: 'Read office departments and owner mappings. lane=plan takes precedence over exact and prefix owner matching. Placement data is not proof of browser rendering or physical seat position.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        departments: z.array(z.unknown()), owners: z.array(z.unknown()), plan_lane_precedence: z.string(),
      }),
      annotations: { readOnlyHint: true },
    }, async () => jsonResult({
      departments: roles.departments, owners: roles.owners,
      plan_lane_precedence: 'lane=plan resolves to 회의실 before owner exact or prefix matching.',
    }))
    server.registerTool('get_active_runs', {
      description: 'Read nonended runs for one absolute project path only; hidden projects are included. This does not read documents, mutate state, or enumerate other projects.',
      inputSchema: z.object({ project_path: z.string().describe('조회할 프로젝트의 절대 경로') }).strict(),
      outputSchema: z.object({ runs: activeRunsSchema }),
      annotations: { readOnlyHint: true },
    }, async ({ project_path }) => {
      if (!isAbsolute(project_path)) toolError('project_path must be absolute')
      const path = resolve(project_path)
      return jsonResult({ runs: activeRuns(path) })
    })
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
        checks: db.checks(run.id),
        asks: db.asks(run.id).map(({ created_at: _, ...ask }) => ({ ...ask, ask_id: ask.id })),
        run_id: run.id, project_path: run.project_path, state: run.state, stage: run.state.stage, ended_at: run.ended_at,
        last_report_at: run.last_report_at,
        tasks: run.state.tasks ?? [], decisions: run.state.decisions ?? [], reviews: run.state.reviews ?? [],
        retro: db.runRetro(run.id),
        placements: taskPlacements(run.state.tasks ?? []),
      })
    })
    server.registerTool('get_retros', {
      description: 'Read run retros grouped by skill+category with per-run signals and the retro submission rate of ended runs, without changing state; candidate=true when 2+ distinct runs repeat it. Use since to separate before/after a skill fix.',
      inputSchema: getRetrosSchema,
      outputSchema: getRetrosOutputSchema,
      annotations: { readOnlyHint: true },
    }, async (args) => jsonResult(getRetros(args)))
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
