// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskView, RunView } from '../../shared/contract.ts'
import { AskDialog, DocumentPanel, Journal } from './Panels.tsx'
import { answerAsk, getDoc } from './api.ts'

vi.mock('./api.ts', () => ({ answerAsk: vi.fn(), getDoc: vi.fn() }))

const ask: AskView = { id: 'ask-1', run_id: 'run-1', question: '이번 변경을 반영할까요?', options: ['반영하기', '그대로 진행'], recommended: '반영하기', status: 'pending', answer: null }

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: 'run-1', project_path: '/outside/project', title: '사무실 리포터', doc_path: null, doc_accessible: false,
    state: { stage: '완료', summary: '기본 관제실을 완성했습니다.', tasks: [{ id: 'ui', title: '화면 만들기', status: '완료' }], reviews: [{ round: 1, reviewer: 'Ponytail Agent', verdict: 'PASS' }], decisions: [{ title: 'React DOM', body: '접근성 있는 씬' }] },
    last_report_at: '2026-10-19T07:00:00.000Z', ended_at: '2026-10-19T07:05:00.000Z', ...overrides,
  }
}

describe('Panels', () => {
  beforeEach(() => vi.clearAllMocks())

  it('posts the selected approval option and marks the recommendation', async () => {
    vi.mocked(answerAsk).mockResolvedValue({ ok: true })
    const onClose = vi.fn()
    render(<AskDialog ask={ask} onClose={onClose} />)
    expect(screen.getByText('추천')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /그대로 진행/ }))
    await waitFor(() => expect(answerAsk).toHaveBeenCalledWith('ask-1', '그대로 진행'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a retryable answer error and lets a pending ask be closed', async () => {
    vi.mocked(answerAsk).mockRejectedValue(new Error('다시 시도해 주세요.'))
    const onClose = vi.fn()
    render(<AskDialog ask={ask} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /반영하기/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '결재 창 닫기' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('lists ended work and opens its final snapshot', () => {
    const onOpenSnapshot = vi.fn()
    const endedRun = run()
    render(<Journal runs={[endedRun]} onOpenSnapshot={onOpenSnapshot} />)
    fireEvent.click(screen.getByRole('button', { name: /사무실 리포터/ }))
    expect(onOpenSnapshot).toHaveBeenCalledWith(endedRun)
    expect(screen.getByText(/기본 관제실을 완성했습니다/)).toBeTruthy()
    expect(screen.getByText(/화면 만들기 · 완료/)).toBeTruthy()
    expect(screen.getByText(/Ponytail Agent · PASS/)).toBeTruthy()
    expect(screen.getByText(/React DOM — 접근성 있는 씬/)).toBeTruthy()
  })

  it('shows TODO counts in the final work snapshot', () => {
    const endedRun = run({ state: { tasks: [{ id: 'FE', title: '화면', status: '완료', todos: [{ id: 'a', done: true }, { id: 'b' }] }] } })
    render(<Journal runs={[endedRun]} onOpenSnapshot={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /사무실 리포터/ }))
    expect(screen.getByText('화면 · 완료 · TODO 1/2')).toBeTruthy()
  })

  it('explains when the plan document is outside the readable workspace', () => {
    render(<DocumentPanel run={run()} />)
    expect(screen.getByText('기획서 열람·변경 감지 불가')).toBeTruthy()
    expect(getDoc).not.toHaveBeenCalled()
  })

  it('loads the connected plan as read-only text', async () => {
    vi.mocked(getDoc).mockResolvedValue({ path: 'docs/plan.md', text: '# 계획\n읽기 전용' })
    render(<DocumentPanel run={run({ doc_path: 'docs/plan.md', doc_accessible: true })} />)
    expect(await screen.findByText(/# 계획/)).toBeTruthy()
    expect(screen.getByText('읽기 전용')).toBeTruthy()
  })

  it('reloads updated text when the same document is invalidated', async () => {
    vi.mocked(getDoc)
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '이전 문서 내용' })
      .mockResolvedValueOnce({ path: 'docs/plan.md', text: '바뀐 문서 내용' })
    const connectedRun = run({ doc_path: 'docs/plan.md', doc_accessible: true })
    const { rerender } = render(<DocumentPanel run={connectedRun} revision={0} />)
    expect(await screen.findByText('이전 문서 내용')).toBeTruthy()
    rerender(<DocumentPanel run={connectedRun} revision={1} />)
    expect(await screen.findByText('바뀐 문서 내용')).toBeTruthy()
    expect(getDoc).toHaveBeenCalledTimes(2)
  })
})
