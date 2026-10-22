import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { openStore } from './store.ts'
import { ASK_WAIT_MS, type ProgressData } from '../shared/contract.ts'

const fixture = readFileSync(new URL('./fixtures/progress-example.md', import.meta.url), 'utf8')
const golden = JSON.parse(readFileSync(new URL('./fixtures/progress-example.expected.json', import.meta.url), 'utf8')) as ProgressData
const patches = [...fixture.matchAll(/```json\n(.*?)\n```/gs)].map((match) => JSON.parse(match[1]) as Record<string, unknown>)
const fixtureTitle = '외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일'

type TestServer = { base: string; server: ReturnType<typeof createServer>; close: () => Promise<void> }

describe('office app', () => {
  let dir: string
  let workspace: string
  let db: ReturnType<typeof openStore>
  let closeApp: (() => void) | undefined
  let server: TestServer | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'office-app-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    db = openStore(':memory:')
  })

  afterEach(async () => {
    closeApp?.()
    closeApp = undefined
    if (server) await server.close()
    server = undefined
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(options: { askWaitMs?: number; staticDir?: string; now?: () => number } = {}) {
    const created = createApp({ db, workspaceRoot: workspace, now: () => 1_800_000_000_000, askWaitMs: 200, ...options })
    closeApp = created.close
    const http = createServer(created.app)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP address')
    const base = `http://127.0.0.1:${address.port}`
    server = { base, server: http, close: () => new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())) }
    return { base, client: await connect(base) }
  }

  async function connect(base: string) {
    const client = new Client({ name: 'app-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    return client
  }

  function parseTool(result: Awaited<ReturnType<Client['callTool']>>) {
    const content = 'content' in result && Array.isArray(result.content) ? result.content as { type: string; text?: string }[] : []
    const text = content.find((item) => item.type === 'text')?.text
    return text ? JSON.parse(text) as Record<string, unknown> : undefined
  }

  async function report(client: Client, base: string, args: Record<string, unknown>) {
    return client.callTool({ name: 'report', arguments: { project_path: join(workspace, 'project'), patch: {}, ...args } }, undefined, { timeout: 2_000 })
  }

  async function ask(client: Client, args: Record<string, unknown>, timeout = 2_000) {
    return client.callTool({ name: 'ask', arguments: args }, undefined, { timeout })
  }

  it('creates projects and runs, groups a second project, and replays the full progress.py golden', async () => {
    const { base, client } = await start({ askWaitMs: 2_000 })
    const first = parseTool(await report(client, base, { title: fixtureTitle, patch: patches[0] }))!
    const runId = String(first.run_id)
    expect(runId).toBeTruthy()
    for (const patch of patches.slice(1)) await report(client, base, { run_id: runId, patch })
    const snapshot = await (await fetch(`${base}/api/state`)).json() as { projects: { runs: { id: string; state: ProgressData; ended_at: string | null }[] }[] }
    const run = snapshot.projects[0]!.runs[0]!
    const normalized = structuredClone(run.state)
    for (const task of normalized.tasks ?? []) { delete task.started; delete task.finished }
    delete normalized.updated
    expect(normalized).toEqual(golden)
    expect(run.ended_at).toBeTruthy()

    await report(client, base, { project_path: join(workspace, 'second'), patch: { summary: 'second' } })
    const twoProjects = await (await fetch(`${base}/api/state`)).json() as { projects: unknown[] }
    expect(twoProjects.projects).toHaveLength(2)

    await report(client, base, { run_id: runId, patch: { stage: '수정' } })
    const reopened = await (await fetch(`${base}/api/state`)).json() as { projects: { runs: { id: string; ended_at: string | null }[] }[] }
    expect(reopened.projects.flatMap((project) => project.runs).find((item) => item.id === runId)?.ended_at).toBeNull()
    await client.close()
  })

  it('rejects an invalid first report atomically with strict schema errors', async () => {
    const { base, client } = await start()
    const result = await report(client, base, { project_path: join(workspace, 'new-project'), patch: { extra: true } })
    expect(result.isError).toBe(true)
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Unrecognized key: \"extra\"') }))
    const snapshot = await (await fetch(`${base}/api/state`)).json() as { projects: unknown[] }
    expect(snapshot.projects).toEqual([])
    const runId = String(parseTool(await report(client, base, { project_path: join(workspace, 'existing'), patch: { summary: 'saved' } }))!.run_id)
    const before = await (await fetch(`${base}/api/state`)).json()
    const invalidExisting = await report(client, base, { project_path: join(workspace, 'existing'), run_id: runId, patch: { extra: true } })
    expect(invalidExisting.isError).toBe(true)
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual(before)
    await client.close()
  })

  it('publishes typed strict tool schemas and instructions', async () => {
    const { client } = await start()
    const { tools } = await client.listTools()
    const reportTool = tools.find((tool) => tool.name === 'report')!
    const patch = reportTool.inputSchema.properties!.patch as {
      additionalProperties: boolean
      properties: { tasks: { items: { additionalProperties: boolean; properties: Record<string, { enum?: string[]; description: string }> } } }
    }
    expect(reportTool.inputSchema.additionalProperties).toBe(false)
    expect(patch.additionalProperties).toBe(false)
    expect(patch.properties.tasks.items.additionalProperties).toBe(false)
    expect(patch.properties.tasks.items.properties.lane!.enum).toEqual(['plan', 'build', 'review', 'fix', 'finish'])
    expect(patch.properties.tasks.items.properties.status!.enum).toEqual(['대기중', '진행중', '완료', '중단'])
    expect(patch.properties.tasks.items.properties.model!.description).toContain('전체 model ID')
    expect(patch.properties.tasks.items.properties.effort!.description).toContain('모르면 생략')
    const todos = patch.properties.tasks.items.properties.todos as unknown as {
      items: { additionalProperties: boolean; properties: Record<string, { type: string; minLength?: number; description: string }> }
    }
    expect(todos.items.additionalProperties).toBe(false)
    expect(todos.items.properties.id).toMatchObject({ type: 'string', minLength: 1 })
    expect(todos.items.properties.done!.type).toBe('boolean')
    expect(Object.keys(todos.items.properties)).toEqual(['id', 'text', 'phase', 'done', 'detail'])
    expect(Object.values(todos.items.properties).every((field) => field.description.length > 0)).toBe(true)
    expect(reportTool.description).toContain('todos:[{id:"FE-2",done:true}]')
    expect(reportTool.description).toContain('report.asks')
    expect(reportTool.description).toContain('pending.retry_after_sec')
    expect(client.getInstructions()).toBe(reportTool.description)
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true)
    expect(tools.find((tool) => tool.name === 'get_run')!.annotations?.readOnlyHint).toBe(true)
    await client.close()
  })

  it('creates durable missing-metadata checks, accepts replies idempotently, and exposes read-only history', async () => {
    let clock = 10_000
    const { base, client } = await start({ now: () => clock })
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checks = first.checks as { id: string; question: string; status: string }[]
    expect(checks).toHaveLength(1)
    expect(checks[0]!.question).toContain('누락: model, effort')
    expect(checks[0]!.question).toContain('실제 값을 확인')
    const checkId = checks[0]!.id
    const before = db.checks(runId)
    expect(parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!.checks).toEqual(before)
    clock += 1
    const repeated = parseTool(await report(client, base, { run_id: runId, patch: { summary: 'still working' } }))!
    expect((repeated.checks as { id: string }[])[0]!.id).toBe(checkId)
    const reply = { check_id: checkId, answer: 'The host does not expose this metadata yet.' }
    const answered = parseTool(await report(client, base, { run_id: runId, check_replies: [reply], patch: {} }))!
    expect(answered.checks).toEqual([])
    expect(parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!.checks).toMatchObject([
      { id: checkId, status: 'answered', answer: reply.answer, responded_at: new Date(clock).toISOString() },
    ])
    clock += 1
    await report(client, base, { run_id: runId, check_replies: [reply], patch: { tasks: [{ id: 'T', note: 'still active' }] } })
    expect(db.checks(runId)).toHaveLength(1)
    clock += 1_799_998
    expect(parseTool(await report(client, base, { run_id: runId, patch: {} }))!.checks).toEqual([])
    clock += 1
    const next = parseTool(await report(client, base, { run_id: runId, patch: {} }))!
    expect(next.checks).toHaveLength(1)
    expect((next.checks as { id: string }[])[0]!.id).not.toBe(checkId)
    await client.close()
  })

  it('requests each absent or blank model/effort value only for active tasks', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { patch: { tasks: [
      { id: 'model-only', status: '진행중', model: 'actual' },
      { id: 'effort-only', status: '진행중', effort: 'high' },
      { id: 'blank', status: '진행중', model: ' ', effort: '' },
      { id: 'complete', status: '진행중', model: 'actual', effort: 'high' },
      { id: 'waiting' },
    ] } }))!
    const checks = first.checks as { task_id: string; question: string }[]
    expect(checks.map((check) => check.task_id).sort()).toEqual(['blank', 'effort-only', 'model-only'])
    expect(checks.find((check) => check.task_id === 'model-only')!.question).toContain('누락: effort')
    expect(checks.find((check) => check.task_id === 'effort-only')!.question).toContain('누락: model')
    expect(checks.find((check) => check.task_id === 'blank')!.question).toContain('누락: model, effort')
    const repeated = parseTool(await report(client, base, { run_id: String(first.run_id), patch: {} }))!
    expect((repeated.checks as { id: string }[]).map((check) => check.id).sort()).toEqual((first.checks as { id: string }[]).map((check) => check.id).sort())
    await client.close()
  })

  it('uses short Korean check prompts with conditional guidance and presents checks/asks before state', async () => {
    let stamp = 1_800_000_000_000
    const { base, client } = await start({ now: () => stamp })
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중', model: 'actual', effort: 'high' }] } }))!
    const runId = String(first.run_id)
    expect(first.checks).toEqual([])
    stamp += 1_800_000
    const response = await report(client, base, { run_id: runId, patch: {} })
    const stale = parseTool(response)!
    const question = (stale.checks as { question: string }[])[0]!.question
    expect(question).toBe('30분째 변화 없음: 현재 상태·막힌 점을 check_replies로 알려 주세요.')
    expect(question).not.toContain('누락:')
    expect(question).not.toContain('미완료 TODO:')
    for (const value of [stale, response.structuredContent!]) {
      const keys = Object.keys(value)
      expect(keys.indexOf('checks')).toBeLessThan(keys.indexOf('state'))
      expect(keys.indexOf('asks')).toBeLessThan(keys.indexOf('state'))
    }
    const missing = parseTool(await report(client, base, { patch: { tasks: [{ id: 'M', status: '진행중' }] } }))!
    const missingQuestion = (missing.checks as { question: string }[])[0]!.question
    expect(missingQuestion).not.toContain('30분째')
    expect(missingQuestion).toContain('누락: model, effort')
    expect(missingQuestion).toContain('확인 불가하면 이유')
    expect(missingQuestion).not.toContain('미완료 TODO:')
    expect(missingQuestion.split('\n')).toHaveLength(2)
    await client.close()
  })

  it('includes current unfinished TODOs in check questions and keeps later pending guidance current', async () => {
    let clock = 200_000
    const { base, client } = await start({ now: () => clock })
    const first = parseTool(await report(client, base, { patch: { tasks: [{
      id: 'T', status: '진행중', model: 'actual-model', effort: 'high',
      todos: [{ id: 'DONE', text: 'Finished item', done: true }, { id: 'OPEN', text: 'Pending work', done: false }],
    }] } }))!
    const runId = String(first.run_id)
    expect(first.checks).toEqual([])
    clock += 1_800_000
    const stale = parseTool(await report(client, base, { run_id: runId, patch: {} }))!
    const check = (stale.checks as { id: string; question: string }[])[0]!
    expect(check.question).toContain('OPEN (Pending work)')
    expect(check.question).not.toContain('DONE (Finished item)')
    expect(check.question).toContain('get_run으로 최신 TODO를 확인')
    const updated = parseTool(await report(client, base, { run_id: runId, patch: { tasks: [{
      id: 'T', todos: [{ id: 'LATER', text: 'Added while pending' }],
    }] } }))!
    expect(updated.checks).toMatchObject([{ id: check.id, question: check.question }])
    const latest = parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!.tasks as { todos: { id: string; text?: string }[] }[]
    expect(latest[0]!.todos).toContainEqual(expect.objectContaining({ id: 'LATER', text: 'Added while pending' }))
    await client.close()
  })

  it('rejects conflicting or foreign replies without changing report, project, checks, asks, or baselines', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { doc_path: 'plan.md', patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    const before = db.getRun(runId)
    expect((await report(client, base, { run_id: runId, doc_path: 'other.md', check_replies: [
      { check_id: checkId, answer: 'valid' }, { check_id: 'foreign', answer: 'invalid' },
    ], patch: { summary: 'must roll back' }, close_ask_ids: ['unknown'] })).isError).toBe(true)
    expect(db.getRun(runId)).toEqual(before)
    expect(db.checks(runId)).toEqual(first.checks)
    expect(db.snapshot(() => false).projects).toHaveLength(1)
    expect(db.snapshot(() => false).asks).toEqual([])
    await client.close()
  })

  it('rolls back a valid check reply and ask closure when task completion leaves TODOs open', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { doc_path: 'plan.md', patch: { tasks: [{
      id: 'T', status: '진행중', todos: [{ id: 'TODO-1', done: false }],
    }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    const askId = db.createAsk(runId, 'Continue?', ['Yes'], undefined, 1_800_000_000_000)
    const before = db.getRun(runId)
    const rejected = await report(client, base, {
      run_id: runId, check_replies: [{ check_id: checkId, answer: 'The actual work is still incomplete.' }],
      close_ask_ids: [askId], patch: { tasks: [{ id: 'T', status: '완료' }] },
    })
    expect(rejected.isError).toBe(true)
    expect(db.getRun(runId)).toEqual(before)
    expect(db.check(checkId)).toMatchObject({ status: 'pending', answer: null })
    expect(db.getAsk(askId)).toMatchObject({ status: 'pending', answer: null })
    await client.close()
  })

  it('validates reply identity, nonblank values, and duplicate answers strictly', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    const otherRunId = String(parseTool(await report(client, base, { project_path: join(workspace, 'other'), patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!.run_id)
    for (const args of [
      { check_replies: [{ check_id: checkId, answer: 'answer' }] },
      { run_id: runId, check_replies: [{ check_id: '', answer: 'answer' }] },
      { run_id: runId, check_replies: [{ check_id: checkId, answer: ' ' }] },
      { run_id: runId, check_replies: [{ check_id: 'unknown', answer: 'answer' }] },
      { run_id: otherRunId, check_replies: [{ check_id: checkId, answer: 'answer' }] },
      { run_id: runId, check_replies: [{ check_id: checkId, answer: 'one' }, { check_id: checkId, answer: 'two' }] },
    ]) expect((await report(client, base, args)).isError).toBe(true)
    expect(db.check(checkId)).toMatchObject({ status: 'pending', answer: null })
    expect(db.getRun(runId)!.state.tasks).toMatchObject([{ id: 'T', status: '진행중' }])
    await client.close()
  })

  it('closes pending checks on owner transfer and task/run closure', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', owner: 'old', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const oldId = (first.checks as { id: string }[])[0]!.id
    const reassigned = parseTool(await report(client, base, { run_id: runId,
      check_replies: [{ check_id: oldId, answer: 'Old owner reports their status.' }],
      patch: { tasks: [{ id: 'T', owner: 'new' }] },
    }))!
    expect(reassigned.checks).toHaveLength(1)
    expect(reassigned.checks).toMatchObject([{ owner: 'new' }])
    const newId = (reassigned.checks as { id: string }[])[0]!.id
    expect(newId).not.toBe(oldId)
    expect(db.check(oldId)).toMatchObject({ status: 'answered', answer: 'Old owner reports their status.' })
    await report(client, base, { run_id: runId, patch: { tasks: [{ id: 'T', status: '완료' }] } })
    expect(db.checks(runId).map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: oldId, status: 'answered' }, { id: newId, status: 'closed' },
    ].sort((a, b) => a.id.localeCompare(b.id)))
    expect((await report(client, base, { run_id: runId, check_replies: [{ check_id: oldId, answer: 'late' }], patch: {} })).isError).toBe(true)
    await client.close()
  })

  it('applies a same-report reply before interruption and accepts its replay after completion', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    const reply = { check_id: checkId, answer: 'Work is ongoing; metadata unavailable.' }
    const stopped = parseTool(await report(client, base, { run_id: runId, check_replies: [reply], patch: { stage: '중단' } }))!
    expect(stopped.checks).toMatchObject([{ task_id: '__retro__', status: 'pending' }])
    expect(db.check(checkId)).toMatchObject({ status: 'answered', answer: reply.answer, responded_at: expect.any(String) })
    const replay = await report(client, base, { run_id: runId, check_replies: [reply], patch: {} })
    expect(replay.isError).toBeFalsy()
    expect(db.check(checkId)).toMatchObject({ status: 'answered', answer: reply.answer })
    await client.close()
  })

  it('uses the task clock and only meaningful task fields to trigger stale checks', async () => {
    let clock = 50_000
    const { base, client } = await start({ now: () => clock })
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중', model: 'actual-model', effort: 'high', title: 'A' }] } }))!
    const runId = String(first.run_id)
    expect(first.checks).toEqual([])
    clock += 1_700_000
    const metadataOnly = parseTool(await report(client, base, { run_id: runId, patch: { tasks: [{ id: 'T', title: 'B', model: 'new-model', effort: 'medium', lane: 'review' }] } }))!
    expect(metadataOnly.checks).toEqual([])
    clock += 99_999
    expect(parseTool(await report(client, base, { run_id: runId, patch: {} }))!.checks).toEqual([])
    clock += 1
    expect(parseTool(await report(client, base, { run_id: runId, patch: {} }))!.checks).toHaveLength(1)
    const second = parseTool(await report(client, base, { title: 'Second', patch: { tasks: [
      { id: 'N', status: '진행중', model: 'actual', effort: 'high', todos: [{ id: 'todo', done: false }] },
    ] } }))!
    const secondRun = String(second.run_id)
    clock += 1_700_000
    expect(parseTool(await report(client, base, { run_id: secondRun, patch: { tasks: [{ id: 'N', note: 'meaningful', todos: [{ id: 'todo', done: true }] }] } }))!.checks).toEqual([])
    clock += 1_799_999
    expect(parseTool(await report(client, base, { run_id: secondRun, patch: {} }))!.checks).toEqual([])
    clock += 1
    expect(parseTool(await report(client, base, { run_id: secondRun, patch: {} }))!.checks).toHaveLength(1)
    await client.close()
  })

  it('keeps accepted-reply cooldown across same-owner reopen and never recreates checks while interrupted', async () => {
    let clock = 70_000
    const { base, client } = await start({ now: () => clock })
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    await report(client, base, { run_id: runId, check_replies: [{ check_id: checkId, answer: 'No host metadata available.' }], patch: {} })
    clock += 1
    await report(client, base, { run_id: runId, patch: { stage: '중단' } })
    expect(db.checks(runId)).toMatchObject([{ task_id: 'T', status: 'answered' }, { task_id: '__retro__', status: 'pending' }])
    await report(client, base, { run_id: runId, patch: { stage: '수정' } })
    expect(db.checks(runId)).toMatchObject([{ task_id: 'T', status: 'answered' }, { task_id: '__retro__', status: 'closed' }])
    clock += 1_800_000
    const stale = parseTool(await report(client, base, { run_id: runId, patch: {} }))!
    expect(stale.checks).toHaveLength(1)
    await client.close()
  })

  it('preserves metadata reply cooldown when the same owner reactivates a closed task', async () => {
    let clock = 90_000
    const { base, client } = await start({ now: () => clock })
    const first = parseTool(await report(client, base, { patch: { tasks: [{ id: 'T', owner: 'same', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    const checkId = (first.checks as { id: string }[])[0]!.id
    await report(client, base, { run_id: runId, check_replies: [{ check_id: checkId, answer: 'Unavailable.' }], patch: {} })
    clock += 1
    await report(client, base, { run_id: runId, patch: { tasks: [{ id: 'T', status: '완료' }] } })
    await report(client, base, { run_id: runId, patch: { tasks: [{ id: 'T', status: '진행중' }] } })
    expect(db.checks(runId)).toHaveLength(1)
    clock += 1_799_998
    expect(parseTool(await report(client, base, { run_id: runId, patch: {} }))!.checks).toEqual([])
    clock += 1
    expect(parseTool(await report(client, base, { run_id: runId, patch: {} }))!.checks).toHaveLength(1)
    await client.close()
  })

  it('rejects misspelled and mistyped tool arguments before storing anything', async () => {
    const { base, client } = await start()
    for (const args of [
      { close_asks: [] },
      { patch: { tasks: [{ id: 'x', assigned_to: 'reviewer-lead' }] } },
      { patch: { tasks: [{ id: 'x', lane: 'backend' }] } },
      { patch: { tasks: [{ id: 'x', status: 'running' }] } },
      { patch: { decisions: [{ title: 'x', extra: true }] } },
      { patch: { reviews: [{ round: 1, reviewer: 'Karpathy Agent', extra: true }] } },
      { patch: { reviews: [{ round: 1, reviewer: 'reviewer-lead' }] } },
      { patch: { summary: 42 } },
      { patch: { tasks: [{ id: 'FE', todos: null }] } },
      { patch: { tasks: [{ id: 'FE', todos: [{ id: '' }] }] } },
      { patch: { tasks: [{ id: 'FE', todos: [{ id: 'FE-1', checked: true }] }] } },
      { patch: { tasks: [{ id: 'FE', todos: [{ id: 'FE-1', done: 'true' }] }] } },
    ]) {
      const result = await report(client, base, args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Input validation error') }))
    }
    expect(db.snapshot(() => false).projects).toEqual([])
    const runId = String(parseTool(await report(client, base, {}))!.run_id)
    for (const args of [{ recommended: 'Maybe' }, { close_asks: [] }]) {
      const result = await ask(client, { run_id: runId, question: '?', options: ['Yes'], ...args })
      expect(result.isError).toBe(true)
      if ('recommended' in args) expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('recommended must be one of the options') }))
    }
    expect(db.snapshot(() => false).asks).toEqual([])
    expect((await client.callTool({ name: 'get_run', arguments: { run_id: runId, extra: true } })).isError).toBe(true)
    await client.close()
  })

  it('omits only report state on opt-in and returns the full state through get_run', async () => {
    const { base, client } = await start()
    const tools = (await client.listTools()).tools
    const reportTool = tools.find((tool) => tool.name === 'report')!
    expect(reportTool.inputSchema.properties!.include_state).toMatchObject({ type: 'boolean' })
    expect(reportTool.outputSchema!.required).not.toContain('state')
    expect(tools.find((tool) => tool.name === 'get_run')!.outputSchema!.required).toContain('state')
    const first = parseTool(await report(client, base, { include_state: false, patch: { stage: '구현', summary: 'Full summary', todo: 'Next', blockers: 'None', tasks: [{ id: 'T', status: '진행중' }] } }))!
    const runId = String(first.run_id)
    expect(first).not.toHaveProperty('state')
    expect(Object.keys(first).sort()).toEqual(['run_id', 'ended_at', 'doc_changes', 'checks', 'asks'].sort())
    const askId = db.createAsk(runId, 'Continue?', ['Yes'], undefined, 0)
    db.answerAsk(askId, 'Yes')
    const compactResponse = await report(client, base, { run_id: runId, include_state: false, patch: {} })
    const compact = parseTool(compactResponse)!
    expect(compact).not.toHaveProperty('state')
    expect(compactResponse.structuredContent).not.toHaveProperty('state')
    expect(compact.asks).toEqual([{ ask_id: askId, status: 'answered', answer: 'Yes' }])
    expect(compact.checks).toEqual(first.checks)
    const full = parseTool(await report(client, base, { run_id: runId, include_state: true, patch: {} }))!
    const defaultResult = parseTool(await report(client, base, { run_id: runId, patch: {} }))!
    expect(defaultResult).toEqual(full)
    const read = parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!
    expect(read.state).toEqual(full.state)
    expect(read.state).toMatchObject({ summary: 'Full summary', todo: 'Next', blockers: 'None' })
    expect((await report(client, base, { run_id: runId, include_state: 'false', patch: {} })).isError).toBe(true)
    await client.close()
  })

  it('returns merged report state and reads one run with only its pending asks without writes', async () => {
    const { base, client } = await start()
    const first = parseTool(await report(client, base, { patch: {
      tasks: [{ id: 'task', owner: 'reviewer-lead', model: 'gpt-6-astra', effort: 'high', todos: [{ id: 'T-1', phase: '계획', detail: '초안' }] }],
      decisions: [{ title: 'Choice', body: 'First' }],
      reviews: [{ round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS' }],
    } }))!
    const runId = String(first.run_id)
    expect(first.ended_at).toBeNull()
    expect(first.state).toMatchObject({ tasks: [{ id: 'task', status: '대기중', todos: [{ id: 'T-1', text: 'T-1', phase: '계획', detail: '초안' }] }] })
    const pending = parseTool(await ask(client, { run_id: runId, question: 'Continue?', options: ['Yes'], recommended: 'Yes' }))!
    const closed = parseTool(await ask(client, { run_id: runId, question: 'Old?', options: ['Yes'] }))!
    await report(client, base, { run_id: runId, close_ask_ids: [closed.ask_id], patch: {
      decisions: [{ title: 'Choice', body: 'Updated' }], tasks: [{ id: 'task', todos: [{ id: 'T-1', done: true }] }],
    } })
    const otherRun = String(parseTool(await report(client, base, {}))!.run_id)
    await ask(client, { run_id: otherRun, question: 'Other?', options: ['Yes'] })
    const before = db.snapshot(() => false)
    const result = parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!
    expect(result).toMatchObject({
      run_id: runId, project_path: join(workspace, 'project'), stage: '계획', ended_at: null,
      tasks: [{ id: 'task', owner: 'reviewer-lead', todos: [{ id: 'T-1', text: 'T-1', phase: '계획', detail: '초안', done: true }] }],
      decisions: [{ title: 'Choice', body: 'Updated' }],
      reviews: [{ round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS' }],
      asks: [{ id: pending.ask_id, status: 'pending', recommended: 'Yes' }],
    })
    expect(result.asks).toHaveLength(1)
    expect(db.snapshot(() => false)).toEqual(before)
    const ended = parseTool(await report(client, base, { run_id: runId, patch: { stage: '완료', tasks: [{ id: 'task', status: '완료' }] } }))!
    expect(ended.ended_at).toBe('2027-01-15T08:00:00.000Z')
    expect(ended.state).toMatchObject({ stage: '완료', tasks: [{ id: 'task', status: '완료' }] })
    const finished = parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!
    expect(finished).toMatchObject({ stage: '완료', ended_at: ended.ended_at, asks: [] })
    const missing = await client.callTool({ name: 'get_run', arguments: { run_id: 'missing' } })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContainEqual(expect.objectContaining({ text: 'unknown run_id: missing' }))
    await client.close()
  })

  it('validates visibility changes, emits changed, and restores active projects on reports while preserving history and pending asks', async () => {
    const { base, client } = await start({ askWaitMs: 2_000 })
    const projectPath = join(workspace, 'hidden-project')
    const runId = String(parseTool(await report(client, base, { project_path: projectPath, patch: {} }))!.run_id)
    const askPromise = ask(client, { run_id: runId, question: 'Still needed?', options: ['Yes'] })
    let snapshot: { projects: { path: string; hidden?: boolean; runs: { id: string }[] }[]; asks: { id: string }[] } | undefined
    for (let attempt = 0; attempt < 50 && !snapshot?.asks.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      snapshot = await (await fetch(`${base}/api/state`)).json() as typeof snapshot
    }
    const askId = snapshot!.asks[0]!.id
    const patchVisibility = (body: unknown) => fetch(`${base}/api/projects/visibility`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await patchVisibility({ project_path: projectPath })).status).toBe(400)
    expect((await patchVisibility(null)).status).toBe(400)
    expect((await patchVisibility({ project_path: 3, hidden: true })).status).toBe(400)
    expect((await patchVisibility({ project_path: '', hidden: true })).status).toBe(400)
    expect((await patchVisibility({ project_path: projectPath, hidden: 'true' })).status).toBe(400)
    expect((await patchVisibility({ project_path: join(workspace, 'unknown'), hidden: true })).status).toBe(404)
    expect(((await (await fetch(`${base}/api/state`)).json()) as typeof snapshot)!.projects.map((project) => project.path)).not.toContain(join(workspace, 'unknown'))

    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    await reader.read()
    const hidden = await patchVisibility({ project_path: projectPath, hidden: true })
    expect(hidden.status).toBe(200)
    expect(await hidden.json()).toEqual({ ok: true })
    expect(new TextDecoder().decode((await reader.read()).value).includes('event: changed')).toBe(true)
    await report(client, base, { project_path: projectPath, run_id: runId, patch: { summary: 'existing run updated' } })
    expect(((await (await fetch(`${base}/api/state`)).json()) as typeof snapshot)!.projects.find((project) => project.path === projectPath)?.hidden).toBe(false)
    await patchVisibility({ project_path: projectPath, hidden: true })
    await report(client, base, { project_path: projectPath, patch: { summary: 'new run' } })
    snapshot = await (await fetch(`${base}/api/state`)).json() as typeof snapshot
    const hiddenProject = snapshot!.projects.find((project) => project.path === projectPath)!
    expect(hiddenProject.hidden).toBe(false)
    expect(hiddenProject.runs.map((run) => run.id)).toContain(runId)
    expect(hiddenProject.runs).toHaveLength(2)
    expect(snapshot!.asks).toContainEqual(expect.objectContaining({ id: askId, status: 'pending' }))
    const answer = await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Yes' }) })
    expect(answer.status).toBe(200)
    expect(parseTool(await askPromise)).toMatchObject({ status: 'answered', answer: 'Yes', ask_id: askId })
    const restored = await patchVisibility({ project_path: projectPath, hidden: false })
    expect(restored.status).toBe(200)
    expect(((await (await fetch(`${base}/api/state`)).json()) as typeof snapshot)!.projects.find((project) => project.path === projectPath)?.hidden).toBe(false)
    await reader.cancel()
    await client.close()
  })

  it('keeps terminal reports hidden and restores a resumed run only after a successful report', async () => {
    const { base, client } = await start()
    const projectPath = join(workspace, 'resumed-project')
    const runId = String(parseTool(await report(client, base, { project_path: projectPath, patch: { stage: '완료' } }))!.run_id)
    await fetch(`${base}/api/projects/visibility`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_path: projectPath, hidden: true }) })
    const isHidden = async () => ((await (await fetch(`${base}/api/state`)).json()) as { projects: { path: string; hidden: boolean }[] }).projects.find((project) => project.path === projectPath)!.hidden
    await report(client, base, { project_path: projectPath, run_id: runId, patch: { summary: 'archived note' } })
    expect(await isHidden()).toBe(true)
    const invalid = await report(client, base, { project_path: projectPath, run_id: runId, patch: { stage: '구현', tasks: [{ id: 'unfinished', status: '완료', todos: [{ id: 'todo', done: false }] }] } })
    expect(invalid.isError).toBe(true)
    expect(await isHidden()).toBe(true)
    await report(client, base, { project_path: projectPath, run_id: runId, patch: { stage: '구현' } })
    expect(await isHidden()).toBe(false)
    await client.close()
  })

  it('answers an ask over HTTP, enforces answer status codes, and lets a closed ask wake immediately', async () => {
    const { base, client } = await start()
    const created = parseTool(await report(client, base, { patch: { summary: 'active' } }))!
    const runId = String(created.run_id)
    const pendingPromise = ask(client, { run_id: runId, question: 'Approve?', options: ['Yes', 'No'] })
    let snapshot: { asks: { id: string }[] } | undefined
    for (let attempt = 0; attempt < 50 && !snapshot?.asks.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      snapshot = await (await fetch(`${base}/api/state`)).json() as { asks: { id: string }[] }
    }
    const askId = snapshot!.asks[0]!.id
    expect((await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Maybe' }) })).status).toBe(400)
    expect((await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ answer: 'Yes' }) })).status).toBe(403)
    const answer = await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Yes' }) })
    expect(answer.status).toBe(200)
    expect(parseTool(await pendingPromise)).toMatchObject({ status: 'answered', answer: 'Yes', ask_id: askId })
    expect((await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Yes' }) })).status).toBe(409)

    const closedWait = ask(client, { run_id: runId, question: 'Close me?', options: ['Yes'] })
    let closedAskId = ''
    for (let attempt = 0; attempt < 50 && !closedAskId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      closedAskId = ((await (await fetch(`${base}/api/state`)).json()) as { asks: { id: string; question: string }[] }).asks.find((item) => item.question === 'Close me?')?.id ?? ''
    }
    await report(client, base, { run_id: runId, close_ask_ids: [closedAskId], patch: {} })
    const closedResult = await closedWait
    expect(closedResult.isError).toBe(true)
    expect(closedResult.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('ask closed') }))
    await client.close()
  })

  it('uses a 100-second default wait without waiting in real time', async () => {
    expect(ASK_WAIT_MS).toBe(100_000)
    const { base, client } = await start({ askWaitMs: undefined })
    const runId = String(parseTool(await report(client, base, { patch: {} }))!.run_id)
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const waiting = ask(client, { run_id: runId, question: 'Default wait?', options: ['Yes'] }).catch(() => undefined)
    try {
      for (let attempt = 0; attempt < 50 && !db.asks(runId).length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(timer.mock.calls.some((call) => call[1] === 100_000)).toBe(true)
    } finally {
      timer.mockRestore()
      await client.close()
      await waiting
    }
  })

  it('replays answered asks after disconnect and database restart, with discoverable output schemas', async () => {
    db.close()
    const file = join(dir, 'answers.db')
    db = openStore(file)
    const { base, client } = await start()
    const tools = (await client.listTools()).tools
    for (const name of ['report', 'get_run']) {
      const properties = tools.find((tool) => tool.name === name)!.outputSchema!.properties as Record<string, unknown>
      expect(properties.asks).toBeDefined()
    }
    const askProperties = tools.find((tool) => tool.name === 'ask')!.outputSchema!.properties as Record<string, unknown>
    expect(askProperties.retry_after_sec).toBeDefined()
    const runId = String(parseTool(await report(client, base, { patch: {} }))!.run_id)
    const pending = parseTool(await ask(client, { run_id: runId, question: 'Persist?', options: ['Yes'] }))!
    const askId = String(pending.ask_id)
    await client.close()
    expect((await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Yes' }) })).status).toBe(200)
    closeApp!()
    await server!.close()
    db.close()
    db = openStore(file)
    const restarted = await start()
    const expected = [{ ask_id: askId, status: 'answered', answer: 'Yes' }]
    const otherRun = String(parseTool(await report(restarted.client, restarted.base, { patch: {} }))!.run_id)
    expect(parseTool(await report(restarted.client, restarted.base, { run_id: otherRun, patch: {} }))!.asks).toEqual([])
    const before = db.asks(runId)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(parseTool(await report(restarted.client, restarted.base, { run_id: runId, patch: {} }))!.asks).toEqual(expected)
      const result = parseTool(await restarted.client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!
      expect(result.asks).toMatchObject([{ ...expected[0], id: askId, question: 'Persist?', options: ['Yes'] }])
    }
    expect(db.asks(runId)).toEqual(before)
    expect(parseTool(await ask(restarted.client, { run_id: runId, ask_id: askId, question: 'ignored', options: ['Yes'] }))).toEqual(expected[0])
    await restarted.client.close()
  })

  it('returns pending after timeout, reuses ask_id, and permits an answered recall after the run ends', async () => {
    const { base, client } = await start()
    const runId = String(parseTool(await report(client, base, { patch: { summary: 'active' } }))!.run_id)
    const first = parseTool(await ask(client, { run_id: runId, question: 'Continue?', options: ['Yes', 'No'] }))!
    expect(first).toMatchObject({ status: 'pending', retry_after_sec: 0, message: expect.stringContaining('같은 ask_id') })
    const askId = String(first.ask_id)
    const otherRunId = String(parseTool(await report(client, base, { project_path: join(workspace, 'other'), patch: {} }))!.run_id)
    expect((await ask(client, { run_id: otherRunId, ask_id: askId, question: '?', options: ['Yes'] })).isError).toBe(true)
    const repeated = ask(client, { run_id: runId, question: 'Continue?', options: ['Yes', 'No'], ask_id: askId })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'Yes' }) })
    expect(parseTool(await repeated)).toMatchObject({ status: 'answered', answer: 'Yes', ask_id: askId })
    await report(client, base, { run_id: runId, patch: { stage: '완료' } })
    expect(parseTool(await ask(client, { run_id: runId, ask_id: askId, question: 'ignored', options: ['Yes'] }))).toMatchObject({ status: 'answered', answer: 'Yes' })
    expect((await ask(client, { run_id: 'unknown', question: '?', options: ['Yes'] })).isError).toBe(true)
    expect((await ask(client, { run_id: runId, question: '?', options: ['Yes'] })).isError).toBe(true)
    await client.close()
  })

  it('keeps a disconnected ask pending and allows a fresh caller to resume it', async () => {
    const { base, client } = await start()
    const runId = String(parseTool(await report(client, base, { patch: {} }))!.run_id)
    const originalCall = ask(client, { run_id: runId, question: 'Resume me?', options: ['Yes', 'No'] }).catch(() => undefined)
    let askId = ''
    for (let attempt = 0; attempt < 50 && !askId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      askId = ((await (await fetch(`${base}/api/state`)).json()) as { asks: { id: string }[] }).asks[0]?.id ?? ''
    }
    expect(askId).toBeTruthy()
    await client.close()
    await Promise.race([originalCall, new Promise((resolve) => setTimeout(resolve, 1_000))])
    expect(((await (await fetch(`${base}/api/state`)).json()) as { asks: { id: string; status?: string }[] }).asks).toContainEqual(expect.objectContaining({ id: askId }))

    const resumedClient = await connect(base)
    const resumed = ask(resumedClient, { run_id: runId, ask_id: askId, question: 'Resume me?', options: ['Yes', 'No'] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fetch(`${base}/api/asks/${askId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'No' }) })
    expect(parseTool(await resumed)).toMatchObject({ status: 'answered', answer: 'No', ask_id: askId })
    await resumedClient.close()
  })

  it('settles in-flight waiters on app close while leaving their durable ask pending', async () => {
    const { base, client } = await start()
    const runId = String(parseTool(await report(client, base, { patch: {} }))!.run_id)
    const pending = ask(client, { run_id: runId, question: 'Shutdown?', options: ['Yes'] })
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await (await fetch(`${base}/api/state`)).json() as { asks: { id: string }[] }
      if (snapshot.asks.length) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    closeApp?.()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(((await (await fetch(`${base}/api/state`)).json()) as { asks: { status?: string }[] }).asks).toHaveLength(1)
    await client.close()
  })

  it('accepts retro only on ended runs, including finish auto-close, and replaces it without reopening', async () => {
    let clock = 1_800_000_000_000
    const { base, client } = await start({ now: () => clock })
    const runId = String(parseTool(await report(client, base, { patch: { summary: 'start' } }))!.run_id)
    const item = { skill: 'basic-team', skill_version: '0.1.0+bb590a2', category: 'tool_friction', evidence: 'ask timed out at 리뷰', suggestion: 'raise timeout' }
    const early = await report(client, base, { run_id: runId, patch: { summary: 'changed' }, retro: [item] })
    expect(early.isError).toBe(true)
    expect(early.content).toContainEqual(expect.objectContaining({ text: 'retro requires ended run' }))
    expect(db.getRun(runId)!.state.summary).toBe('start')
    const ended = parseTool(await report(client, base, { run_id: runId, retro: [item],
      patch: { tasks: [{ id: 'F', lane: 'finish', status: '완료' }] } }))!
    expect(ended.state).toMatchObject({ stage: '완료' })
    expect(ended.checks).toEqual([])
    expect(db.runRetro(runId).items).toEqual([item])
    const submitted = db.runRetro(runId).submitted_at
    clock += 5_000
    await report(client, base, { run_id: runId, patch: {}, retro: [item] })
    expect(db.runRetro(runId)).toEqual({ submitted_at: submitted, items: [item] })
    expect(db.retros({}, 10)).toHaveLength(1)
    const replaced = parseTool(await report(client, base, { run_id: runId, patch: {}, retro: [] }))!
    expect(replaced).toMatchObject({ ended_at: ended.ended_at, state: { stage: '완료' }, checks: [] })
    const run = parseTool(await client.callTool({ name: 'get_run', arguments: { run_id: runId } }))!
    expect(run.retro).toEqual({ submitted_at: expect.any(String), items: [] })
    await client.close()
  })

  it('asks once for a missing retro, keeps the request open after the end, and settles it by retro or reply', async () => {
    const { base, client } = await start()
    const runId = String(parseTool(await report(client, base, { patch: { stage: '중단' } }))!.run_id)
    const first = parseTool(await report(client, base, { run_id: runId, patch: {} }))!
    expect(first.checks).toMatchObject([{ task_id: '__retro__', owner: null, status: 'pending', question: expect.stringContaining('retro:[]') }])
    const retroCheck = (first.checks as { id: string }[])[0]!.id
    const endedAt = first.ended_at
    const answered = parseTool(await report(client, base, { run_id: runId, patch: {}, retro: [] }))!
    expect(answered).toMatchObject({ checks: [], ended_at: endedAt })
    expect(db.check(retroCheck)).toMatchObject({ status: 'answered', answer: 'retro 0건', responded_at: expect.any(String) })
    expect(db.runRetro(runId)).toEqual({ submitted_at: expect.any(String), items: [] })
    await report(client, base, { run_id: runId, patch: { stage: '수정' } })
    await report(client, base, { run_id: runId, patch: { stage: '완료' } })
    expect(db.checks(runId)).toHaveLength(1)

    const other = String(parseTool(await report(client, base, { patch: { stage: '완료' } }))!.run_id)
    const otherCheck = db.checks(other)[0]!.id
    await report(client, base, { run_id: other, patch: { stage: '수정' } })
    expect(db.check(otherCheck)).toMatchObject({ status: 'closed' })
    await report(client, base, { run_id: other, patch: { stage: '완료' } })
    expect(db.checks(other)).toHaveLength(1)

    const third = String(parseTool(await report(client, base, { patch: { stage: '중단' } }))!.run_id)
    const thirdCheck = db.checks(third)[0]!.id
    const replied = parseTool(await report(client, base, { run_id: third, patch: {}, check_replies: [{ check_id: thirdCheck, answer: '회고 없음: 짧은 run' }] }))!
    expect(replied.checks).toEqual([])
    expect(db.check(thirdCheck)).toMatchObject({ status: 'answered', answer: '회고 없음: 짧은 run' })
    expect(db.runRetro(third).submitted_at).toBeNull()
    await client.close()
  })

  it('validates retro items strictly and advertises retro and get_retros', async () => {
    const { base, client } = await start()
    const ok = { skill: 'basic-team', skill_version: '0.1.0', category: 'other', evidence: 'x' }
    for (const retro of [
      [ok, ok, ok, ok],
      [{ ...ok, category: 'bug' }],
      [{ ...ok, evidence: '  ' }],
      [{ ...ok, extra: true }],
      [{ ...ok, evidence: 'x'.repeat(501) }],
      [{ ...ok, skill_version: undefined }],
    ]) expect((await report(client, base, { patch: { stage: '완료' }, retro })).isError).toBe(true)
    expect(db.snapshot(() => true).projects).toEqual([])
    const { tools } = await client.listTools()
    const retroSchema = tools.find((tool) => tool.name === 'report')!.inputSchema.properties!.retro as { maxItems: number; items: { additionalProperties: boolean } }
    expect(retroSchema).toMatchObject({ maxItems: 3, items: { additionalProperties: false } })
    const getRetros = tools.find((tool) => tool.name === 'get_retros')!
    expect(getRetros.annotations?.readOnlyHint).toBe(true)
    expect(getRetros.outputSchema?.properties).toHaveProperty('groups')
    expect(client.getInstructions()).toContain('get_retros')
    expect((await client.callTool({ name: 'get_retros', arguments: { since: 'Oct 1 2026' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'get_retros', arguments: { project_path: 'relative' } })).isError).toBe(true)
    const reserved = await report(client, base, { patch: { tasks: [{ id: '__retro__' }] } })
    expect(reserved.content).toContainEqual(expect.objectContaining({ text: 'task id __retro__ is reserved' }))
    await client.close()
  })

  it('groups retros by skill and category with candidates, signals and filters without writes', async () => {
    let clock = 1_800_000_000_000
    const { base, client } = await start({ now: () => clock })
    const entry = (category: string, evidence: string, version = '0.1.0+aaa') => ({ skill: 'basic-team', skill_version: version, category, evidence })
    const first = String(parseTool(await report(client, base, { patch: {
      tasks: [{ id: 'T', status: '진행중', model: 'm', effort: 'high' }],
      reviews: [{ round: 1, reviewer: 'Karpathy Agent' }, { round: 2, reviewer: 'Karpathy Agent' }],
    } }))!.run_id)
    clock += 1_800_000
    const stale = parseTool(await report(client, base, { run_id: first, patch: {} }))!
    clock += 60_000
    await report(client, base, { run_id: first, check_replies: [{ check_id: (stale.checks as { id: string }[])[0]!.id, answer: 'still working' }], patch: {} })
    await report(client, base, { run_id: first, patch: { stage: '완료', tasks: [{ id: 'T', status: '완료' }] }, retro: [entry('tool_friction', 'ask timeout'), entry('other', 'misc')] })
    clock += 1_000
    const since = new Date(clock).toISOString()
    const second = String(parseTool(await report(client, base, { patch: { stage: '중단' }, retro: [entry('tool_friction', 'ask timeout again', '0.1.0+bbb')] }))!.run_id)
    const before = db.snapshot(() => false)
    const all = parseTool(await client.callTool({ name: 'get_retros', arguments: {} }))!
    expect(all.truncated).toBe(false)
    expect(all.groups).toMatchObject([
      { skill: 'basic-team', category: 'tool_friction', run_count: 2, candidate: true, skill_versions: ['0.1.0+bbb', '0.1.0+aaa'],
        items: [{ run_id: second, evidence: 'ask timeout again' }, { run_id: first, evidence: 'ask timeout' }] },
      { category: 'other', run_count: 1, candidate: false },
    ])
    expect(all.signals).toEqual(expect.arrayContaining([
      { run_id: first, project_path: join(workspace, 'project'), stage: '완료', ended_at: expect.any(String), review_rounds: 2,
        checks_answered: 1, checks_closed_unanswered: 0, avg_check_reply_ms: 60_000 },
      expect.objectContaining({ run_id: second, stage: '중단', review_rounds: 0, checks_answered: 0 }),
    ]))
    const recent = parseTool(await client.callTool({ name: 'get_retros', arguments: { since, category: 'tool_friction' } }))!
    expect(recent.groups).toMatchObject([{ run_count: 1, candidate: false, items: [{ run_id: second }] }])
    const elsewhere = parseTool(await client.callTool({ name: 'get_retros', arguments: { project_path: join(workspace, 'none') } }))!
    expect(elsewhere).toEqual({ groups: [], signals: [], truncated: false,
      submission: { ended_runs: 0, submitted: 0, empty: 0, missing: 0, recent_missing: [] } })
    expect(db.snapshot(() => false)).toEqual(before)
    clock += 1_000
    const skipped = String(parseTool(await report(client, base, { patch: { stage: '완료' } }))!.run_id)
    clock += 1_000
    await report(client, base, { patch: { stage: '중단' }, retro: [] })
    await report(client, base, { patch: { summary: 'still open' } })
    const rate = parseTool(await client.callTool({ name: 'get_retros', arguments: { skill: 'nobody' } }))!
    expect(rate.groups).toEqual([])
    expect(rate.submission).toEqual({ ended_runs: 4, submitted: 3, empty: 1, missing: 1,
      recent_missing: [{ run_id: skipped, project_path: join(workspace, 'project'), ended_at: expect.any(String) }] })
    const later = parseTool(await client.callTool({ name: 'get_retros', arguments: { since: new Date(clock).toISOString() } }))!
    expect(later.submission).toMatchObject({ ended_runs: 1, submitted: 1, empty: 1, missing: 0 })
    await client.close()
  })

  it('tracks readable docs, emits doc-changed, establishes fresh baselines on path switches and rejects inaccessible docs', async () => {
    const project = join(workspace, 'project')
    mkdirSync(project)
    const firstDoc = join(project, 'plan.md')
    const secondDoc = join(project, 'next.md')
    writeFileSync(firstDoc, 'first\n')
    writeFileSync(secondDoc, 'second\n')
    const { base, client } = await start()
    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    await reader.read()
    const runId = String(parseTool(await report(client, base, { doc_path: 'plan.md', patch: {} }))!.run_id)
    const changed = new Promise<string>((resolve) => {
      const read = async () => {
        while (true) {
          const part = await reader.read()
          if (part.done) return
          const text = new TextDecoder().decode(part.value)
          if (text.includes('doc-changed')) { resolve(text); return }
        }
      }
      void read()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(firstDoc, 'updated\n')
    expect(await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no doc event')), 3_000))])).toContain(runId)
    const diff = parseTool(await report(client, base, { run_id: runId, patch: {} }))!.doc_changes as { path: string; diff: string }[]
    expect(diff).toHaveLength(1)
    expect(diff[0]!.diff).toContain('+updated')
    const switched = parseTool(await report(client, base, { run_id: runId, doc_path: 'next.md', patch: {} }))!.doc_changes
    expect(switched).toEqual([])
    expect((await fetch(`${base}/api/runs/${runId}/doc`)).status).toBe(200)
    expect((await fetch(`${base}/api/runs/${runId}/doc`)).status).toBe(200)
    const reopenedEvent = (async () => {
      while (true) {
        const part = await reader.read()
        if (part.done) return ''
        const text = new TextDecoder().decode(part.value)
        if (text.includes('doc-changed')) return text
      }
    })()
    await report(client, base, { run_id: runId, patch: { stage: '완료' } })
    await report(client, base, { run_id: runId, patch: { stage: '수정' } })
    writeFileSync(secondDoc, 'reopened\n')
    expect(await Promise.race([reopenedEvent, new Promise((_, reject) => setTimeout(() => reject(new Error('watcher did not restart')), 3_000))])).toContain(runId)
    await report(client, base, { run_id: runId, doc_path: 'notes.txt', patch: {} })
    expect((await fetch(`${base}/api/runs/${runId}/doc`)).status).toBe(403)
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'secret')
    const outsideRun = String(parseTool(await report(client, base, { project_path: outside, doc_path: 'secret.md', patch: {} }))!.run_id)
    symlinkSync(join(outside, 'secret.md'), join(project, 'escape.md'))
    const symlinkRun = String(parseTool(await report(client, base, { project_path: project, doc_path: 'escape.md', patch: {} }))!.run_id)
    const state = await (await fetch(`${base}/api/state`)).json() as { projects: { path: string; runs: { id: string; doc_accessible: boolean }[] }[] }
    expect(state.projects.find((item) => item.path === outside)?.runs[0]?.doc_accessible).toBe(false)
    expect((await fetch(`${base}/api/runs/${outsideRun}/doc`)).status).toBe(403)
    expect((await fetch(`${base}/api/runs/${symlinkRun}/doc`)).status).toBe(403)
    await reader.cancel()
    await client.close()
  })

  it('denies foreign and null origins, rejects hostile Host headers, and keeps unknown API paths at 404 before SPA fallback', async () => {
    const staticDir = join(dir, 'static')
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<html>app</html>')
    const { base, client } = await start({ staticDir })
    const allowed = await fetch(`${base}/api/state`, { headers: { origin: base } })
    expect(allowed.status).toBe(200)
    expect((await fetch(`${base}/api/state`, { headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/api/state`, { headers: { origin: 'null' } })).status).toBe(403)
    expect((await fetch(`${base}/api/state`, { headers: { origin: `${base}/?unexpected=1` } })).status).toBe(403)
    expect((await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    })).status).toBe(403)
    const port = new URL(base).port
    const hostile = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      request.on('error', reject)
      request.end()
    })
    expect(hostile).toBe(403)
    expect((await fetch(`${base}/api/missing`)).status).toBe(404)
    expect((await fetch(`${base}/`)).status).toBe(200)
    await client.close()
  })

  it('refuses requests when the ask wait exceeds the protocol cap', () => {
    expect(() => createApp({ db, workspaceRoot: workspace, askWaitMs: 300_001 })).toThrow('ASK_WAIT_MS')
  })
})
