import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { openStore } from './store.ts'
import type { ProgressData } from '../shared/contract.ts'

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

  async function start(options: { askWaitMs?: number; staticDir?: string } = {}) {
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
    const { base, client } = await start()
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

  it('rejects an invalid first report atomically and preserves progress.py unknown-field errors', async () => {
    const { base, client } = await start()
    const result = await report(client, base, { project_path: join(workspace, 'new-project'), patch: { extra: true } })
    expect(result.isError).toBe(true)
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('unknown fields: extra') }))
    const snapshot = await (await fetch(`${base}/api/state`)).json() as { projects: unknown[] }
    expect(snapshot.projects).toEqual([])
    const runId = String(parseTool(await report(client, base, { project_path: join(workspace, 'existing'), patch: { summary: 'saved' } }))!.run_id)
    const before = await (await fetch(`${base}/api/state`)).json()
    const invalidExisting = await report(client, base, { project_path: join(workspace, 'existing'), run_id: runId, patch: { extra: true } })
    expect(invalidExisting.isError).toBe(true)
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual(before)
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

  it('returns pending after timeout, reuses ask_id, and permits an answered recall after the run ends', async () => {
    const { base, client } = await start()
    const runId = String(parseTool(await report(client, base, { patch: { summary: 'active' } }))!.run_id)
    const first = parseTool(await ask(client, { run_id: runId, question: 'Continue?', options: ['Yes', 'No'] }))!
    expect(first.status).toBe('pending')
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
