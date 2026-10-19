import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ASK_WAIT_MS } from '../shared/contract.ts'

const endpoint = process.env.OFFICE_URL ?? 'http://127.0.0.1:4780/mcp'
const timeout = Number(process.env.ASK_WAIT_MS ?? ASK_WAIT_MS) + 30_000

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'office-replay', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  try { return await run(client) } finally { await client.close() }
}

function parseText(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return result
  const text = result.content.find((block: { type?: string }) => block.type === 'text')?.text
  return text ? JSON.parse(text) as unknown : result
}

async function replay(projectPath: string, delayMs: number, docPath?: string) {
  const fixture = readFileSync(new URL('../server/fixtures/progress-example.md', import.meta.url), 'utf8')
  const patches = [...fixture.matchAll(/```json\n(.*?)\n```/gs)].map((match) => JSON.parse(match[1]) as Record<string, unknown>)
  const title = '외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일'
  return withClient(async (client) => {
    let runId: string | undefined
    for (const [index, patch] of patches.entries()) {
      const result = await client.callTool({ name: 'report', arguments: {
        project_path: projectPath,
        ...(runId ? { run_id: runId } : { title }),
        ...(docPath ? { doc_path: docPath } : {}),
        patch,
      } }, undefined, { timeout })
      const parsed = parseText(result)
      console.log(JSON.stringify(parsed, null, 2))
      if (!runId && parsed && typeof parsed === 'object' && 'run_id' in parsed) runId = String(parsed.run_id)
      if (index < patches.length - 1 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return runId
  })
}

async function ask(runId: string, question: string, options: string[], askId?: string) {
  return withClient(async (client) => {
    const result = await client.callTool({ name: 'ask', arguments: {
      run_id: runId, question, options, ...(askId ? { ask_id: askId } : {}),
    } }, undefined, { timeout })
    const parsed = parseText(result)
    console.log(JSON.stringify(parsed, null, 2))
    return parsed
  })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'replay') {
    const projectPath = args[0]
    if (!projectPath) throw new Error('usage: node scripts/replay.ts replay <project_path> [delayMs=3000] [doc_path]')
    const delayMs = args[1] === undefined ? 3000 : Number(args[1])
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be a non-negative number')
    await replay(projectPath, delayMs, args[2])
    return
  }
  if (command === 'ask') {
    const [runId, question, ...rest] = args
    if (!runId || !question) throw new Error('usage: node scripts/replay.ts ask <run_id> "<question>" "<opt1>" ["<opt2>"...] [--ask-id <id>]')
    const askIdIndex = rest.indexOf('--ask-id')
    const askId = askIdIndex >= 0 ? rest[askIdIndex + 1] : undefined
    if (askIdIndex >= 0 && !askId) throw new Error('--ask-id needs an id')
    const options = askIdIndex >= 0 ? rest.filter((_, index) => index !== askIdIndex && index !== askIdIndex + 1) : rest
    if (!options.length) throw new Error('ask needs at least one option')
    await ask(runId, question, options, askId)
    return
  }
  throw new Error('command must be replay or ask')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
