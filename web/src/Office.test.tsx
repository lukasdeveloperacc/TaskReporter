// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskView, RunView, Task } from '../../shared/contract.ts'
import { Office } from './Office.tsx'

const stamp = '2026-10-19T12:00:00.000Z'
const askList: AskView[] = []
const makeRun = (tasks: Task[] = [], patch: Partial<RunView> = {}): RunView => ({
  id: 'run-ui', project_path: '/workspace/project', title: '관제실 확인', doc_path: null,
  doc_accessible: false, state: { stage: '구현', tasks }, last_report_at: stamp, ended_at: null, ...patch,
})
const task = (id: string, owner: string, lane: Task['lane'] = 'build', status: Task['status'] = '완료'): Task => ({ id, owner, lane, status, title: `${owner} 작업` })

afterEach(() => vi.useRealTimers())

describe('Office scene controls and coordinates', () => {
  it('parks idle employees in distinct department stations, including the temporary desk', () => {
    render(<Office run={makeRun([], { state: { tasks: [task('B-1', 'backend-1'), task('F-1', 'frontend-1'), task('D-1', 'designer-1')], reviews: [{ round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS' }] } })} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const names = ['backend-1', 'frontend-1', 'designer-1', 'Karpathy Agent']
    const positions = names.map((name) => {
      const employee = document.querySelector(`[data-employee="${name}"]`)
      expect(employee?.getAttribute('data-state'), name).toBe('idle')
      return `${(employee as HTMLElement).style.left},${(employee as HTMLElement).style.top}`
    })
    expect(new Set(positions).size).toBe(positions.length)
  })

  it('supports keyboard focus and jumps to named departments within the bounded floor region', () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    expect(floor.getAttribute('tabindex')).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: '감사팀' }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(document.getElementById('office-room-7')).not.toBeNull()
  })

  it('clears the final scene after a run refresh without cancelling its active timer', () => {
    vi.useFakeTimers()
    const previous = makeRun([task('B-1', 'backend-1', 'build', '진행중')])
    const { rerender } = render(<Office run={previous} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const completed = makeRun([task('B-1', 'backend-1', 'build', '완료')], { last_report_at: '2026-10-19T12:00:01.000Z' })
    rerender(<Office run={completed} asks={askList} now={Date.parse(stamp) + 1000} onOpenAsk={() => {}} />)
    expect(screen.getByLabelText('이동 중인 서류')).toBeTruthy()
    const carrier = document.querySelector('[data-employee="backend-1"]') as HTMLElement
    const start = carrier.style.left
    act(() => { vi.advanceTimersByTime(32) })
    expect(carrier.style.left).not.toBe(start)
    const refreshed = { ...completed, state: { ...completed.state, summary: '새 report' }, last_report_at: '2026-10-19T12:00:02.000Z' }
    rerender(<Office run={refreshed} asks={askList} now={Date.parse(stamp) + 2000} onOpenAsk={() => {}} />)
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.queryByLabelText('이동 중인 서류')).toBeNull()
  })

  it('fits the single office map to both viewport dimensions and closes with Escape', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const toggle = screen.getByRole('button', { name: '전체 보기' })
    fireEvent.click(toggle)
    const dialog = screen.getByRole('dialog', { name: '관제실 확인 사무실' })
    expect(document.querySelectorAll('#office-floor-scroll')).toHaveLength(1)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(toggle)
    const stage = document.querySelector('.office-map-stage') as HTMLElement
    const toolbarHeight = document.querySelector('.office-department-nav')!.getBoundingClientRect().height
    const scale = Number(stage.dataset.fitScale)
    expect(scale).toBeLessThan(900 / 1600)
    expect(Number.parseFloat(stage.style.width)).toBeCloseTo(1536 * scale)
    expect(Number.parseFloat(stage.style.height)).toBeCloseTo(1600 * scale)
    expect(Number.parseFloat(stage.style.height)).toBeLessThanOrEqual(900 - toolbarHeight)
    fireEvent.keyDown(toggle, { key: 'Tab', shiftKey: true })
    const lastStaffCard = document.querySelectorAll('.office-bubble').item(document.querySelectorAll('.office-bubble').length - 1)
    expect(document.activeElement).toBe(lastStaffCard)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(toggle)

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1200 })
    fireEvent(window, new Event('resize'))
    expect(Number(stage.dataset.fitScale)).toBeGreaterThan(scale)
    const departmentButton = screen.getByRole('button', { name: 'QA팀' })
    departmentButton.focus()
    fireEvent.keyDown(departmentButton, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(toggle)
  })

  it('keeps the CEO character distinct from the internal leader employee', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    expect(screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' })).toBeTruthy()
    expect(document.querySelector('[data-office-role="representative"] .office-name')?.textContent).toBe('대표 · 나')
    const leader = document.querySelector('[data-employee="leader"]')
    expect(leader?.querySelector('.office-name')?.textContent).toBe('부장 · leader')
    expect(leader?.getAttribute('data-employee')).toBe('leader')
  })

  it('shows reported model IDs for idle staff and marks missing active-task models honestly', () => {
    const run = makeRun([
      { id: 'C', owner: 'backend-1', lane: 'build', status: '완료', title: '완료한 Claude 작업', model: 'claude-3-7-sonnet-20250219', effort: 'high' },
      { id: 'X', owner: 'backend-2', lane: 'build', status: '완료', title: '완료한 Codex 작업', effort: 'low' },
      { id: 'Y', owner: 'frontend-1', lane: 'build', status: '완료', title: '완료한 익숙하지 않은 모델 작업', model: 'gpt-5.3-codex' },
      { id: 'M', owner: 'docs-1', lane: 'docs', status: '완료', title: 'metadata missing' },
      { id: 'N', owner: 'designer-1', lane: 'build', status: '진행중', title: '현재 진행 작업' },
    ])
    render(<Office run={run} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const claudeCard = document.querySelector('[data-employee="backend-1"] .office-bubble')!
    const effortOnlyCard = document.querySelector('[data-employee="backend-2"] .office-bubble')!
    const modelOnlyCard = document.querySelector('[data-employee="frontend-1"] .office-bubble')!
    const missingCard = document.querySelector('[data-employee="docs-1"] .office-bubble')!
    const activeCard = document.querySelector('[data-employee="designer-1"] .office-bubble')!
    expect(claudeCard.textContent).toContain('모델 · claude-3-7-sonnet-20250219')
    expect(claudeCard.textContent).toContain('노력 · high')
    expect(effortOnlyCard.textContent).toContain('모델 · 미보고')
    expect(effortOnlyCard.textContent).toContain('노력 · low')
    expect(modelOnlyCard.textContent).toContain('모델 · gpt-5.3-codex')
    expect(modelOnlyCard.textContent).toContain('노력 · 미보고')
    expect(missingCard.textContent).toContain('모델 · 미보고')
    expect(missingCard.textContent).toContain('노력 · 미보고')
    expect(activeCard.textContent).toContain('모델 · 미보고')
    expect(activeCard.textContent).toContain('노력 · 미보고')
  })

  it('shows model and effort on a stale active task marked away', () => {
    const stale = makeRun([{ id: 'STALE', owner: 'backend-1', lane: 'build', status: '진행중', title: '중단된 작업', model: 'gpt-5.3-codex', effort: 'high' }], { last_report_at: '2026-10-19T11:00:00.000Z' })
    render(<Office run={stale} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const employee = document.querySelector('[data-employee="backend-1"]')!
    expect(employee.getAttribute('data-state')).toBe('away')
    expect(employee.querySelector('.office-bubble')?.textContent).toContain('모델 · gpt-5.3-codex')
    expect(employee.querySelector('.office-bubble')?.textContent).toContain('노력 · high')
    expect(employee.querySelector('.office-bubble')?.textContent).toContain('자리 비움')
  })

  it('closes overview before opening a representative approval ask', () => {
    const onOpenAsk = vi.fn()
    const ask: AskView = { id: 'ask-1', run_id: 'run-ui', question: '운영 반영 승인', options: ['승인', '보류'], recommended: '승인', status: 'pending', answer: null }
    render(<Office run={makeRun()} asks={[ask]} now={Date.parse(stamp)} onOpenAsk={onOpenAsk} />)
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    fireEvent.click(screen.getByRole('button', { name: /운영 반영 승인/ }))
    expect(onOpenAsk).toHaveBeenCalledWith('ask-1')
    expect(screen.queryByRole('dialog', { name: '관제실 확인 사무실' })).toBeNull()
  })

  it('restores focus to the overview control when closed by its button', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    const toggle = screen.getByRole('button', { name: '전체 보기' })
    fireEvent.click(toggle)
    screen.getByRole('button', { name: 'QA팀' }).focus()
    fireEvent.click(screen.getByRole('button', { name: '전체 보기 닫기' }))
    expect(document.activeElement).toBe(toggle)
  })

  it('wraps overview keyboard focus using visible candidates after a run ends', () => {
    render(<Office run={makeRun([], { ended_at: stamp })} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const toggle = screen.getByRole('button', { name: '전체 보기 닫기' })
    const floor = document.getElementById('office-floor-scroll')
    expect(document.querySelector('[data-employee="leader"] .office-bubble')?.getAttribute('tabindex')).toBeNull()

    fireEvent.keyDown(toggle, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(floor)
    fireEvent.keyDown(floor!, { key: 'Tab' })
    expect(document.activeElement).toBe(toggle)
  })
})

describe('simultaneous worker layout', () => {
  it('keeps long task and rank bubbles readable for adjacent same-team employees', () => {
    const title1 = '동시에 실행되는 백엔드 작업의 긴 제목이 말풍선 안에서 여러 줄로 읽히는지 확인합니다 '.repeat(2)
    const title2 = '데이터 저장소 검사와 재시도 동작을 확인하는 두 번째 긴 작업 제목입니다 '.repeat(2)
    const run = makeRun([
      { id: 'B-1', owner: 'backend-1', lane: 'build', status: '진행중', title: title1, model: 'claude-3-7-sonnet-20250219-provider-custom-xlarge', effort: 'high' },
      { id: 'B-2', owner: 'backend-2', lane: 'build', status: '진행중', title: title2, model: 'gpt-5.3-codex-with-a-deliberately-long-routing-suffix', effort: 'medium' },
    ])
    render(<Office run={run} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)

    const first = document.querySelector('[data-employee="backend-1"]') as HTMLElement
    const second = document.querySelector('[data-employee="backend-2"]') as HTMLElement
    const firstBubble = document.querySelector('[data-employee="backend-1"] .office-bubble') as HTMLElement
    const secondBubble = document.querySelector('[data-employee="backend-2"] .office-bubble') as HTMLElement
    const names = [...document.querySelectorAll('.office-name')] as HTMLElement[]
    expect(Number.parseFloat(second.style.left) - Number.parseFloat(first.style.left)).toBe(192)
    const bubbleWidth = Number.parseFloat(firstBubble.style.getPropertyValue('--bubble-width'))
    const bubbleOffset = Number.parseFloat(getComputedStyle(firstBubble).left) || 39
    const firstBubbleLeft = Number.parseFloat(first.style.left) + bubbleOffset
    const secondBubbleLeft = Number.parseFloat(second.style.left) + bubbleOffset
    expect(bubbleWidth).toBe(148)
    expect(secondBubbleLeft - firstBubbleLeft).toBeGreaterThan(bubbleWidth)
    const backendRoom = document.getElementById('office-room-3') as HTMLElement
    expect(secondBubbleLeft + bubbleWidth).toBeLessThanOrEqual(Number.parseFloat(backendRoom.style.left) + Number.parseFloat(backendRoom.style.width))
    expect(firstBubble.getAttribute('tabindex')).toBe('0')
    expect(firstBubble.getAttribute('title')).toBe(`backend-1 · ${title1} · 모델 claude-3-7-sonnet-20250219-provider-custom-xlarge · 노력 high`)
    expect(getComputedStyle(firstBubble).maxHeight).toBe('120px')
    expect(firstBubble.querySelector('.office-name')?.textContent).toBe('backend-1 · 대리')
    expect(firstBubble.textContent).toContain(title1)
    expect(firstBubble.textContent).toContain('대리')
    expect(firstBubble.textContent).toContain('노력 · high')
    expect(firstBubble.textContent).toContain('모델 · claude-3-7-sonnet-20250219-provider-custom-xlarge')
    expect(secondBubble.textContent).toContain(title2)
    expect(secondBubble.textContent).toContain('모델 · gpt-5.3-codex-with-a-deliberately-long-routing-suffix')
    expect(names.filter((name) => ['backend-1 · 대리', 'backend-2'].some((label) => name.textContent === label))).toHaveLength(2)
  })
})
