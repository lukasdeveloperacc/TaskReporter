import { describe, expect, it } from 'vitest'
import { floorStatus, STALE_MS, type AskView, type ProjectView, type RunView } from './contract.ts'

const now = Date.parse('2026-10-19T00:00:00.000Z')

function run(id: string, ageMs: number, endedAt: string | null = null): RunView {
  return {
    id,
    project_path: '/workspace/project',
    title: id,
    doc_path: null,
    doc_accessible: false,
    state: {},
    last_report_at: new Date(now - ageMs).toISOString(),
    ended_at: endedAt,
  }
}

function project(runs: RunView[]): ProjectView {
  return { path: '/workspace/project', name: 'project', in_workspace: true, runs }
}

function ask(runId: string): AskView {
  return { id: 'ask-1', run_id: runId, question: 'Approve?', options: ['Yes', 'No'], recommended: null, status: 'pending', answer: null }
}

describe('floorStatus', () => {
  it('blinks for a pending ask on an active run', () => {
    expect(floorStatus(project([run('run-1', 0)]), [ask('run-1')], now)).toBe('ask')
  })

  it('shows away after 30 minutes without a report', () => {
    expect(floorStatus(project([run('run-1', STALE_MS + 60_000)]), [], now)).toBe('away')
  })

  it('shows on for a recent active run', () => {
    expect(floorStatus(project([run('run-1', STALE_MS - 60_000)]), [], now)).toBe('on')
  })

  it('shows off when every run has ended', () => {
    expect(floorStatus(project([run('run-1', 0, new Date(now).toISOString())]), [ask('run-1')], now)).toBe('off')
  })

  it('ignores pending asks on ended runs', () => {
    expect(floorStatus(project([run('run-1', 0, new Date(now).toISOString())]), [ask('run-1')], now)).toBe('off')
  })
})
