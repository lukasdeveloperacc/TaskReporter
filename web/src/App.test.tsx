// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskView, ProjectView, RunView, StateSnapshot } from '../../shared/contract.ts'
import App from './App.tsx'
import { getDoc, getState, subscribe } from './api.ts'

vi.mock('./api.ts', () => ({ getState: vi.fn(), getDoc: vi.fn(), subscribe: vi.fn(() => vi.fn()), answerAsk: vi.fn() }))
vi.mock('./Office.tsx', () => ({ Office: (props: { run: { id: string }; visitorEnabled?: boolean; onVisitorEnabledChange?: (enabled: boolean) => void }) => <div data-testid="office" data-visitor-enabled={String(props.visitorEnabled)}><span data-testid="office-run">{props.run.id}</span>{props.onVisitorEnabledChange && <button type="button" onClick={() => props.onVisitorEnabledChange?.(!props.visitorEnabled)}>{props.visitorEnabled ? '둘러보기 끝내기' : '직접 둘러보기'}</button>}</div> }))

const ask: AskView = { id: 'ask-doc', run_id: 'newer', question: '문서를 다시 볼까요?', options: ['다시 계획', '계속'], recommended: '다시 계획', status: 'pending', answer: null }

function run(id: string, date: string, ended: string | null = null): RunView {
  return { id, project_path: '/workspace/alpha', title: `제목 ${id}`, doc_path: null, doc_accessible: false, state: { stage: ended ? '완료' : '구현', summary: '작업 중' }, last_report_at: date, ended_at: ended }
}

const newer = { ...run('newer', '2026-10-19T07:30:00.000Z'), state: { stage: '구현', summary: '작업 중', todo: '접근성 확인', blockers: '리뷰 응답 대기' } }
const older = { ...run('older', '2026-10-19T07:00:00.000Z'), state: { stage: '구현', summary: '작업 중', todo: '', blockers: '' } }
const ended = run('ended', '2026-10-19T06:00:00.000Z', '2026-10-19T06:30:00.000Z')
const project: ProjectView = { path: '/workspace/alpha', name: 'alpha', in_workspace: true, runs: [older, newer, ended] }
let docChanged: ((event: { run_id: string; path: string }) => void) | undefined
let stateChanged: (() => void) | undefined
let reconnected: (() => void) | undefined

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return { projects: [project], asks: [], ...overrides }
}

async function renderApp(state: StateSnapshot, hash = '#/') {
  vi.mocked(getState).mockResolvedValue(state)
  window.location.hash = hash
  render(<App />)
  await waitFor(() => expect(getState).toHaveBeenCalled())
}

describe('App route integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.location.hash = '#/'
    vi.mocked(subscribe).mockImplementation((onChanged, onDocChanged, onReconnect) => {
      stateChanged = onChanged
      docChanged = onDocChanged
      reconnected = onReconnect
      return vi.fn()
    })
  })

  it('opens the newest active run from the building floor', async () => {
    await renderApp(snapshot())
    fireEvent.click(await screen.findByRole('button', { name: /alpha 층/ }))
    await waitFor(() => expect(screen.getByTestId('office-run').textContent).toBe('newer'))
    expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('true')
  })

  it('opens the most recently ended run when the project has no active run', async () => {
    const allEnded = { ...project, runs: [ended, { ...older, ended_at: '2026-10-19T06:20:00.000Z' }] }
    await renderApp(snapshot({ projects: [allEnded] }))
    fireEvent.click(await screen.findByRole('button', { name: /alpha 층/ }))
    await waitFor(() => expect(screen.getByTestId('office-run').textContent).toBe('ended'))
  })

  it('lets the user choose among active runs and switches the office run', async () => {
    await renderApp(snapshot(), '#/run/newer')
    const picker = await screen.findByRole('combobox', { name: '진행 중 run' })
    fireEvent.change(picker, { target: { value: 'older' } })
    await waitFor(() => expect(screen.getByTestId('office-run').textContent).toBe('older'))
  })

  it('shows and dismisses document-change notices for the open run', async () => {
    await renderApp(snapshot(), '#/run/newer')
    await waitFor(() => expect(docChanged).toBeTypeOf('function'))
    act(() => docChanged?.({ run_id: 'newer', path: 'docs/plan.md' }))
    expect(await screen.findByText('기획 변경 공지')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '기획 변경 공지 닫기' }))
    await waitFor(() => expect(screen.queryByText('기획 변경 공지')).toBeNull())
  })

  it('shows user todo and blockers, with clear empty values when absent', async () => {
    await renderApp(snapshot(), '#/run/newer')
    expect(screen.getByText('접근성 확인')).toBeTruthy()
    expect(screen.getByText('리뷰 응답 대기')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '진행 중 run' }), { target: { value: 'older' } })
    await waitFor(() => expect(screen.getByTestId('office-run').textContent).toBe('older'))
    expect(screen.getByText('사용자 할 일').parentElement?.textContent).toContain('없음')
    expect(screen.getByText('막힌 사항').parentElement?.textContent).toContain('없음')
  })

  it('refetches a same-path document after its change event', async () => {
    vi.mocked(getDoc)
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '처음 내용' })
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '수정된 내용' })
    const docRun = { ...newer, doc_path: 'docs/plan.md', doc_accessible: true }
    const docProject = { ...project, runs: project.runs.map((run) => run.id === 'newer' ? docRun : run) }
    await renderApp(snapshot({ projects: [docProject] }), '#/run/newer')
    expect(await screen.findByText('처음 내용')).toBeTruthy()
    await waitFor(() => expect(docChanged).toBeTypeOf('function'))
    act(() => docChanged?.({ run_id: 'newer', path: 'docs/plan.md' }))
    expect(await screen.findByText('수정된 내용')).toBeTruthy()
    expect(screen.getByText('기획 변경 공지')).toBeTruthy()
    expect(getDoc).toHaveBeenCalledTimes(2)
  })

  it('refreshes the current document after a report or EventSource reconnect', async () => {
    vi.mocked(getDoc)
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '처음 내용' })
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '보고 후 내용' })
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '재연결 후 내용' })
    const docRun = { ...newer, doc_path: 'docs/plan.md', doc_accessible: true }
    const docProject = { ...project, runs: project.runs.map((run) => run.id === 'newer' ? docRun : run) }
    await renderApp(snapshot({ projects: [docProject] }), '#/run/newer')
    expect(await screen.findByText('처음 내용')).toBeTruthy()

    vi.mocked(getState).mockResolvedValue(snapshot({ projects: [docProject] }))
    act(() => stateChanged?.())
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2))
    expect(getDoc).toHaveBeenCalledTimes(1)

    const reportedRun = { ...docRun, last_report_at: '2026-10-19T07:35:00.000Z' }
    vi.mocked(getState).mockResolvedValue(snapshot({ projects: [{ ...docProject, runs: docProject.runs.map((run) => run.id === 'newer' ? reportedRun : run) }] }))
    act(() => stateChanged?.())
    expect(await screen.findByText('보고 후 내용')).toBeTruthy()

    act(() => reconnected?.())
    expect(await screen.findByText('재연결 후 내용')).toBeTruthy()
    expect(getDoc).toHaveBeenCalledTimes(3)
  })

  it('opens a run directly from its hash link', async () => {
    await renderApp(snapshot(), '#/run/older')
    expect((await screen.findByTestId('office-run')).textContent).toBe('older')
    expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('true')
  })

  it('keeps direct floor entry enabled while its initial snapshot is loading', async () => {
    let resolveState!: (state: StateSnapshot) => void
    vi.mocked(getState).mockReturnValue(new Promise((resolve) => { resolveState = resolve }))
    window.location.hash = '#/run/newer'
    render(<App />)
    expect(screen.getByRole('status').textContent).toContain('사무실 층을 확인하고 있습니다')
    await act(async () => { resolveState(snapshot()); await Promise.resolve() })
    await waitFor(() => expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('true'))
  })

  it('preserves floor intent after an initial load error and enables it after retry succeeds', async () => {
    vi.mocked(getState).mockRejectedValueOnce(new Error('temporary offline'))
    window.location.hash = '#/run/newer'
    render(<App />)
    const retry = await screen.findByRole('button', { name: '다시 불러오기' })
    expect(screen.getByRole('alert').textContent).toContain('temporary offline')
    vi.mocked(getState).mockResolvedValueOnce(snapshot())
    fireEvent.click(retry)
    expect((await screen.findByTestId('office-run')).textContent).toBe('newer')
    expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('true')
  })

  it('preserves an explicit end through same-run snapshot refreshes and reenables on a new floor', async () => {
    await renderApp(snapshot(), '#/run/newer')
    fireEvent.click(await screen.findByRole('button', { name: '둘러보기 끝내기' }))
    expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('false')

    vi.mocked(getState).mockResolvedValue(snapshot({ projects: [{ ...project, runs: [older, { ...newer, last_report_at: '2026-10-19T07:45:00.000Z' }, ended] }] }))
    act(() => stateChanged?.())
    await waitFor(() => expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('false'))

    window.location.hash = '#/'
    await waitFor(() => expect(screen.getByRole('button', { name: /alpha 층/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /alpha 층/ }))
    await waitFor(() => expect(screen.getByTestId('office').getAttribute('data-visitor-enabled')).toBe('true'))
  })

  it('returns to the lobby for a malformed run link', async () => {
    await renderApp(snapshot(), '#/run/%')
    expect(await screen.findByRole('button', { name: /alpha 층/ })).toBeTruthy()
  })

  it('offers a pending approval from the floor and tracks doc notices', async () => {
    await renderApp(snapshot({ asks: [ask] }), '#/run/newer')
    fireEvent.click(await screen.findByRole('button', { name: /대표실 결재 대기/ }))
    expect(await screen.findByRole('dialog', { name: '대표님의 결정이 필요합니다' })).toBeTruthy()
  })
})
