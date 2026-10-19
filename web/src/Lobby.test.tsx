// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AskView, ProjectView, RunView } from '../../shared/contract.ts'
import Lobby from './Lobby.tsx'

const now = Date.parse('2026-10-19T08:00:00.000Z')

function run(id: string, last = '2026-10-19T07:59:00.000Z'): RunView {
  return { id, project_path: `/workspace/${id}`, title: `작업 ${id}`, doc_path: null, doc_accessible: false, state: { stage: '구현' }, last_report_at: last, ended_at: null }
}

function project(name: string, runs: RunView[]): ProjectView {
  return { path: `/workspace/${name}`, name, in_workspace: true, runs }
}

describe('Lobby', () => {
  it('shows one floor per project and marks the floor with a pending ask', () => {
    const projects = [project('alpha', [run('a')]), project('beta', [run('b')])]
    const asks: AskView[] = [{ id: 'ask-1', run_id: 'b', question: '배포할까요?', options: ['예', '아니오'], recommended: '예', status: 'pending', answer: null }]
    render(<Lobby projects={projects} asks={asks} now={now} onOpen={vi.fn()} />)

    expect(screen.getByRole('button', { name: /alpha .*불 켜짐/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /beta .*결재 대기/ }).getAttribute('data-status')).toBe('ask')
    expect(screen.getByRole('button', { name: /beta .*결재 대기/ }).textContent).toContain('결재 대기')
  })

  it('opens the clicked project and provides an empty state with no projects', () => {
    const onOpen = vi.fn()
    const { rerender } = render(<Lobby projects={[project('alpha', [run('a')])]} asks={[]} now={now} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha .*불 켜짐/ }))
    expect(onOpen).toHaveBeenCalledWith('/workspace/alpha')

    rerender(<Lobby projects={[]} asks={[]} now={now} onOpen={onOpen} />)
    expect(screen.getByText('아직 등록된 층이 없습니다')).toBeTruthy()
  })

  it('keeps project floors in a stable path order when report times change', () => {
    const alpha = project('alpha', [run('alpha-run', '2026-10-19T06:00:00.000Z')])
    const beta = project('beta', [run('beta-run', '2026-10-19T07:59:00.000Z')])
    const { rerender } = render(<Lobby projects={[beta, alpha]} asks={[]} now={now} onOpen={vi.fn()} />)

    const alphaFloor = () => screen.getByRole('button', { name: /alpha 층 02F/ })
    const betaFloor = () => screen.getByRole('button', { name: /beta 층 01F/ })
    expect(alphaFloor().getAttribute('data-floor')).toBe('02')
    expect(betaFloor().getAttribute('data-floor')).toBe('01')

    rerender(<Lobby projects={[project('alpha', [run('alpha-run', '2026-10-19T07:59:30.000Z')]), project('beta', [run('beta-run', '2026-10-19T06:01:00.000Z')])]} asks={[]} now={now} onOpen={vi.fn()} />)
    expect(alphaFloor().getAttribute('data-floor')).toBe('02')
    expect(betaFloor().getAttribute('data-floor')).toBe('01')
  })

  it('keeps long names accessible and renders a project with no runs as a disabled floor', () => {
    const longName = 'office-team-reporter-with-a-deliberately-long-project-name'
    const onOpen = vi.fn()
    render(<Lobby projects={[project(longName, [run('long-run')]), project('empty-project', [])]} asks={[]} now={now} onOpen={onOpen} />)

    const namedFloor = screen.getByRole('button', { name: new RegExp(longName) })
    expect(namedFloor.textContent).toContain(longName)
    const emptyFloor = screen.getByRole('button', { name: /empty-project .*아직 보고 없음/ })
    expect((emptyFloor as HTMLButtonElement).disabled).toBe(true)
    expect(emptyFloor.getAttribute('data-status')).toBe('off')
  })
})
