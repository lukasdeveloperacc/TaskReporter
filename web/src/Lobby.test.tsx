// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    render(<Lobby projects={projects} asks={asks} now={now} onOpen={vi.fn()} onSetVisibility={vi.fn()} onOpenAsk={vi.fn()} />)

    expect(screen.getByRole('button', { name: /alpha .*불 켜짐/ })).toBeTruthy()
    const betaFloor = screen.getByRole('button', { name: /beta 층 .*결재 대기/ })
    expect(betaFloor.getAttribute('data-status')).toBe('ask')
    expect(betaFloor.textContent).toContain('결재 대기')
  })

  it('opens the clicked project and provides an empty state with no projects', () => {
    const onOpen = vi.fn()
    const { rerender } = render(<Lobby projects={[project('alpha', [run('a')])]} asks={[]} now={now} onOpen={onOpen} onSetVisibility={vi.fn()} onOpenAsk={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /alpha .*불 켜짐/ }))
    expect(onOpen).toHaveBeenCalledWith('/workspace/alpha')

    rerender(<Lobby projects={[]} asks={[]} now={now} onOpen={onOpen} onSetVisibility={vi.fn()} onOpenAsk={vi.fn()} />)
    expect(screen.getByText('아직 등록된 층이 없습니다')).toBeTruthy()
  })

  it('keeps project floors in a stable path order when report times change', () => {
    const alpha = project('alpha', [run('alpha-run', '2026-10-19T06:00:00.000Z')])
    const beta = project('beta', [run('beta-run', '2026-10-19T07:59:00.000Z')])
    const props = { projects: [beta, alpha], asks: [], now, onOpen: vi.fn(), onSetVisibility: vi.fn(), onOpenAsk: vi.fn() }
    const { rerender } = render(<Lobby {...props} />)

    const alphaFloor = () => screen.getByRole('button', { name: /alpha 층 02F/ })
    const betaFloor = () => screen.getByRole('button', { name: /beta 층 01F/ })
    expect(alphaFloor().getAttribute('data-floor')).toBe('02')
    expect(betaFloor().getAttribute('data-floor')).toBe('01')

    rerender(<Lobby {...props} projects={[project('alpha', [run('alpha-run', '2026-10-19T07:59:30.000Z')]), project('beta', [run('beta-run', '2026-10-19T06:01:00.000Z')])]} />)
    expect(alphaFloor().getAttribute('data-floor')).toBe('02')
    expect(betaFloor().getAttribute('data-floor')).toBe('01')
  })

  it('keeps long names accessible and renders a project with no runs as a disabled floor', () => {
    const longName = 'office-team-reporter-with-a-deliberately-long-project-name'
    const onOpen = vi.fn()
    render(<Lobby projects={[project(longName, [run('long-run')]), project('empty-project', [])]} asks={[]} now={now} onOpen={onOpen} onSetVisibility={vi.fn()} onOpenAsk={vi.fn()} />)

    const namedFloor = screen.getByRole('button', { name: new RegExp(longName) })
    expect(namedFloor.textContent).toContain(longName)
    const emptyFloor = screen.getByRole('button', { name: /empty-project .*아직 보고 없음/ })
    expect((emptyFloor as HTMLButtonElement).disabled).toBe(true)
    expect(emptyFloor.getAttribute('data-status')).toBe('off')
  })

  it('hides and restores floors through the sibling menu and manager', async () => {
    const alpha = project('alpha', [run('a')])
    const beta = project('beta', [run('b')])
    const onSetVisibility = vi.fn().mockResolvedValue(undefined)
    const props = { projects: [alpha, beta], asks: [], now, onOpen: vi.fn(), onSetVisibility, onOpenAsk: vi.fn() }
    const { rerender } = render(<Lobby {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '층 메뉴, 02F' }))
    fireEvent.click(screen.getByRole('button', { name: '이 층 숨기기' }))
    expect(onSetVisibility).toHaveBeenCalledWith(alpha.path, true)
    await waitFor(() => expect(screen.getByRole('button', { name: '층 메뉴, 02F' }).getAttribute('aria-expanded')).toBe('false'))
    rerender(<Lobby {...props} projects={[{ ...alpha, hidden: true }, beta]} />)
    expect(screen.queryByRole('button', { name: /alpha 층/ })).toBeNull()
    expect(screen.getByRole('button', { name: /beta 층 01F/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '숨긴 층 관리' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha 층 다시 표시' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'alpha 층 다시 표시' }))
    expect(onSetVisibility).toHaveBeenLastCalledWith(alpha.path, false)
    rerender(<Lobby {...props} projects={[alpha, beta]} />)
    expect(screen.getByRole('button', { name: /alpha 층 02F/ })).toBeTruthy()
  })

  it('keeps an all-hidden building recoverable from its empty state', () => {
    const alpha = { ...project('alpha', [run('a')]), hidden: true }
    render(<Lobby projects={[alpha]} asks={[]} now={now} onOpen={vi.fn()} onSetVisibility={vi.fn()} onOpenAsk={vi.fn()} />)

    expect(screen.getByText('숨긴 프로젝트만 있습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '숨긴 층 관리' }))
    expect(screen.getByRole('button', { name: 'alpha 층 다시 표시' })).toBeTruthy()
  })

  it('disables duplicate visibility requests and keeps a failed hide available for retry', async () => {
    let rejectRequest!: (error: Error) => void
    const onSetVisibility = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectRequest = reject }))
      .mockResolvedValue(undefined)
    render(<Lobby projects={[project('alpha', [run('a')])]} asks={[]} now={now} onOpen={vi.fn()} onSetVisibility={onSetVisibility} onOpenAsk={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '층 메뉴, 01F' }))
    const hide = screen.getByRole('button', { name: '이 층 숨기기' })
    fireEvent.click(hide)
    expect(hide.hasAttribute('disabled')).toBe(true)
    fireEvent.click(hide)
    expect(onSetVisibility).toHaveBeenCalledTimes(1)

    await act(async () => { rejectRequest(new Error('offline')) })
    expect((await screen.findByRole('alert')).textContent).toContain('층을 숨기지 못했습니다. offline')
    expect(screen.getByRole('button', { name: /alpha 층 01F/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(onSetVisibility).toHaveBeenCalledTimes(2))
    expect(onSetVisibility).toHaveBeenLastCalledWith('/workspace/alpha', true)
  })

  it('keeps a failed restore in the hidden manager and offers retry', async () => {
    const alpha = { ...project('alpha', [run('a')]), hidden: true }
    const onSetVisibility = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    render(<Lobby projects={[alpha]} asks={[]} now={now} onOpen={vi.fn()} onSetVisibility={onSetVisibility} onOpenAsk={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '숨긴 층 관리' }))
    fireEvent.click(screen.getByRole('button', { name: 'alpha 층 다시 표시' }))
    expect((await screen.findByRole('alert')).textContent).toContain('층을 다시 표시하지 못했습니다. offline')
    expect(screen.getByRole('button', { name: 'alpha 층 다시 표시' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(onSetVisibility).toHaveBeenCalledTimes(2))
    expect(onSetVisibility).toHaveBeenLastCalledWith(alpha.path, false)
  })

  it('opens pending asks from hidden projects in the lobby', () => {
    const alpha = { ...project('alpha', [run('a')]), hidden: true }
    const ask: AskView = { id: 'ask-hidden', run_id: 'a', question: '배포할까요?', options: ['예', '아니오'], recommended: '예', status: 'pending', answer: null }
    const onOpenAsk = vi.fn()
    render(<Lobby projects={[alpha]} asks={[ask]} now={now} onOpen={vi.fn()} onSetVisibility={vi.fn()} onOpenAsk={onOpenAsk} />)

    fireEvent.click(screen.getByRole('button', { name: /대표실 결재 대기.*배포할까요/ }))
    expect(onOpenAsk).toHaveBeenCalledWith('ask-hidden')
  })
})
