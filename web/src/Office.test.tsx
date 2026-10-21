// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('shows TODO counts on task cards and leaves detail Enter to the native summary', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    const run = makeRun([{ ...task('FE', 'frontend-1', 'build', '진행중'), todos: [
      { id: 'FE-1', text: '계약 확인', done: true },
      { id: 'FE-2', text: '화면 구현', phase: '구현', detail: '키보드로 상세 열기' },
    ] }])
    render(<Office run={run} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    expect(document.querySelector('[data-employee="frontend-1"]')?.textContent).toContain('TODO 1/2')
    fireEvent.click(screen.getByRole('button', { name: 'frontend-1 현재 업무 보기' }))
    const dialog = await screen.findByRole('dialog', { name: '직원 업무 살펴보기' }, { timeout: 2000 })
    const summary = dialog.querySelector('summary')!
    expect(summary).not.toBeNull()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    fireEvent(summary, enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(screen.getByRole('tab', { name: '현재 업무' }).getAttribute('aria-selected')).toBe('true')
  })

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
    const lastStaffCard = document.querySelectorAll('.office-employee').item(document.querySelectorAll('.office-employee').length - 1)
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

  it('keeps the report dialog centered and inside desktop and mobile viewports from computed CSS', () => {
    const stylesheet = document.createElement('style')
    stylesheet.textContent = readFileSync('web/src/office.css', 'utf8')
    document.head.append(stylesheet)
    const backdrop = document.createElement('div')
    backdrop.className = 'visitor-inspector-backdrop'
    const dialog = document.createElement('aside')
    dialog.className = 'visitor-inspector'
    backdrop.append(dialog)
    document.body.append(backdrop)

    const computed = getComputedStyle(dialog)
    const offset = (value: string, basis: number) => value === 'auto' ? 0 : value.endsWith('%') ? basis * Number.parseFloat(value) / 100 : Number.parseFloat(value)
    const positions = [
      { viewportWidth: 1440, viewportHeight: 900, dialogHeight: 669, expected: { left: 240, top: 115.5 } },
      { viewportWidth: 390, viewportHeight: 844, dialogHeight: 628, expected: { left: 16, top: 108 } },
    ]
    expect(computed.position).toBe('relative')
    for (const { viewportWidth, viewportHeight, dialogHeight, expected } of positions) {
      const availableWidth = viewportWidth - 32
      const availableHeight = viewportHeight - 32
      const dialogWidth = Math.min(960, availableWidth)
      const left = 16 + (availableWidth - dialogWidth) / 2 + offset(computed.left, availableWidth)
      const top = 16 + (availableHeight - dialogHeight) / 2 + offset(computed.top, availableHeight)
      expect(left).toBeCloseTo(expected.left)
      expect(top).toBeCloseTo(expected.top)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left + dialogWidth).toBeLessThanOrEqual(viewportWidth)
      expect(top).toBeGreaterThanOrEqual(0)
      expect(top + dialogHeight).toBeLessThanOrEqual(viewportHeight)
    }
    backdrop.remove()
    stylesheet.remove()
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
    expect(document.querySelector('[data-employee="leader"] .office-bubble')?.getAttribute('tabindex')).toBeNull()

    fireEvent.keyDown(toggle, { key: 'Tab', shiftKey: true })
    const elevator = screen.getByRole('button', { name: '엘리베이터 층간 이동' })
    expect(document.activeElement).toBe(elevator)
    fireEvent.keyDown(elevator, { key: 'Tab' })
    expect(document.activeElement).toBe(toggle)
  })

  it.each([false, true])('opens the elevator by clicking without visitor mode (overview: %s)', (overview) => {
    const onVisitProject = vi.fn()
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} onVisitProject={onVisitProject} floors={[{ projectPath: '/workspace/other', name: 'other', floorNumber: 2, status: '근무 중', disabled: false, current: false }]} />)
    if (overview) fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const elevator = screen.getByRole('button', { name: '엘리베이터 층간 이동' })
    fireEvent.click(elevator)
    const destination = screen.getByRole('button', { name: '2층 · other · 근무 중' })
    expect(document.activeElement).toBe(destination)
    fireEvent.keyDown(destination, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    expect(document.activeElement).toBe(elevator)
    fireEvent.click(elevator)
    fireEvent.click(screen.getByRole('button', { name: '2층 · other · 근무 중' }))
    expect(onVisitProject).toHaveBeenCalledWith('/workspace/other')
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('disables elevator clicks while another interaction blocks the office', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} interactionBlocked />)
    const elevator = screen.getByRole('button', { name: '엘리베이터 층간 이동' }) as HTMLButtonElement
    expect(elevator.disabled).toBe(true)
    fireEvent.click(elevator)
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('moves only from a focused visitor map and opens the nearby elevator', () => {
    const onVisitorEnabledChange = vi.fn()
    const { rerender } = render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} onVisitorEnabledChange={onVisitorEnabledChange} floors={[{ projectPath: '/workspace/other', name: 'other', floorNumber: 1, status: '근무 중', disabled: false, current: false }]} />)
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    expect(onVisitorEnabledChange).toHaveBeenCalledWith(true)
    rerender(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled onVisitorEnabledChange={onVisitorEnabledChange} floors={[{ projectPath: '/workspace/other', name: 'other', floorNumber: 1, status: '근무 중', disabled: false, current: false }]} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    floor.focus()
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect((screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement).style.top).toBe('1368px')
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })
    expect(screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /other/ })).toBeTruthy()
  })

  it('navigates enabled elevator floors with arrows, Home and End, then activates the focused destination', () => {
    const onVisitProject = vi.fn(() => true)
    const floors = [
      { projectPath: '/workspace/disabled', name: 'disabled', floorNumber: 1, status: '보고 없음', disabled: true, current: false },
      { projectPath: '/workspace/current', name: 'current', floorNumber: 2, status: '근무 중', disabled: false, current: true },
      { projectPath: '/workspace/alpha', name: 'alpha', floorNumber: 3, status: '근무 중', disabled: false, current: false },
      { projectPath: '/workspace/beta', name: 'beta', floorNumber: 4, status: '종료', disabled: false, current: false },
    ]
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled floors={floors} onVisitProject={onVisitProject} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    floor.focus()
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })

    const picker = screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })
    const alpha = screen.getByRole('button', { name: /alpha/ })
    const beta = screen.getByRole('button', { name: /beta/ })
    const close = screen.getByRole('button', { name: '닫기' })
    const lobby = screen.getByRole('button', { name: '빌딩 로비로 돌아가기' })
    expect(screen.getByText(/↑\/↓ 층 이동 · Home\/End 처음\/끝 · Enter 선택 · Esc 닫기/)).toBeTruthy()
    expect(document.activeElement).toBe(alpha)

    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(lobby)
    fireEvent.keyDown(lobby, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'End' })
    expect(document.activeElement).toBe(lobby)
    fireEvent.keyDown(lobby, { key: 'Home' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(beta, { key: 'ArrowDown', ctrlKey: true })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'ArrowDown', isComposing: true })
    expect(document.activeElement).toBe(close)
    expect(picker).toBeTruthy()

    // Activation remains the button's native click behavior; the picker does not synthesize clicks.
    const repeatedEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true })
    fireEvent(alpha, repeatedEnter)
    expect(repeatedEnter.defaultPrevented).toBe(false)
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    fireEvent(alpha, space)
    expect(space.defaultPrevented).toBe(false)
    expect(onVisitProject).not.toHaveBeenCalled()
    fireEvent.click(beta)
    expect(onVisitProject).toHaveBeenCalledWith('/workspace/beta')
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('focuses Lobby when no other floor is available and closes the picker without dismissing overview', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled floors={[
      { projectPath: '/workspace/current', name: 'current', floorNumber: 1, status: '근무 중', disabled: false, current: true },
      { projectPath: '/workspace/missing', name: 'missing', floorNumber: 2, status: '보고 없음', disabled: true, current: false },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    floor.focus()
    fireEvent.keyDown(floor, { key: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'Enter' })

    const picker = screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })
    const lobby = screen.getByRole('button', { name: '빌딩 로비로 돌아가기' })
    const close = screen.getByRole('button', { name: '닫기' })
    expect(document.activeElement).toBe(lobby)
    fireEvent.keyDown(lobby, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(lobby)
    fireEvent.keyDown(lobby, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '관제실 확인 사무실' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '잠시 멈춤' })).toBeTruthy()
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    const before = avatar.style.top
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(before)
    expect(picker).toBeTruthy()
  })

  it('keeps movement blocked while a destination visit fails, then resumes on close', () => {
    const onVisitProject = vi.fn(() => false)
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled floors={[
      { projectPath: '/workspace/other', name: 'other', floorNumber: 1, status: '근무 중', disabled: false, current: false },
    ]} onVisitProject={onVisitProject} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    floor.focus()
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })
    const picker = screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })
    fireEvent.click(screen.getByRole('button', { name: /other/ }))
    expect(onVisitProject).toHaveBeenCalledWith('/workspace/other')
    expect(picker).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('해당 프로젝트 층을 사용할 수 없습니다')
    const blockedAt = avatar.style.top
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).toBe(blockedAt)
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(blockedAt)
  })

  it('continues walking after closing an inspection and still honors deliberate pause', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled onVisitorEnabledChange={() => {}} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    floor.focus()
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })
    expect(screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(screen.getByRole('button', { name: '잠시 멈춤' })).toBeTruthy()
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    const before = avatar.style.top
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(before)
    const walking = avatar.style.top
    fireEvent.click(screen.getByRole('button', { name: '잠시 멈춤' }))
    expect(screen.getByRole('button', { name: '둘러보기 재개' })).toBeTruthy()
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).toBe(walking)
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(walking)
  })

  it('ignores modified, composing, descendant and repeated interaction keys while keeping touch steps available', () => {
    render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled onVisitorEnabledChange={() => {}} />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    floor.focus()
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    const initial = avatar.style.top
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true })
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp', isComposing: true })
    expect(avatar.style.top).toBe(initial)
    const child = floor.querySelector('.office-map-stage')!
    fireEvent.keyDown(child, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).toBe(initial)
    fireEvent.click(screen.getByRole('button', { name: '아래로 이동' }))
    expect(avatar.style.top).toBe('1416px')
    const handled = fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter', repeat: true })
    expect(handled).toBe(true)
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
  })

  it('bounds the visitor floor to the visible viewport at desktop and mobile heights', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return new DOMRect(0, this.id === 'office-floor-scroll' ? 491 : 0, 390, 300)
    })
    const { rerender } = render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' }) as HTMLElement
    expect(Number.parseFloat(floor.style.maxHeight)).toBe(401)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    bounds.mockImplementation(function () { return new DOMRect(0, this.id === 'office-floor-scroll' ? 660 : 0, 390, 300) })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(Number.parseFloat(floor.style.maxHeight)).toBe(176)
    expect(Number.parseFloat(floor.style.maxHeight) + 660).toBeLessThanOrEqual(window.innerHeight)
    rerender(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    bounds.mockRestore()
  })

  it('recovers a usable map height after the page scrolls its floor into view', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    let floorTop = 574
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return new DOMRect(0, this.id === 'office-floor-scroll' ? floorTop : 0, 390, 300)
    })
    const { rerender } = render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' }) as HTMLElement
    expect(Number.parseFloat(floor.style.maxHeight)).toBe(240)
    floorTop = 19
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(Number.parseFloat(floor.style.maxHeight)).toBe(473)
    rerender(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} />)
    bounds.mockRestore()
  })

  it('measures the arrived floor before recentering a fresh destination run', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    let floorTop = 100
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return new DOMRect(0, this.id === 'office-floor-scroll' ? floorTop : 0, 400, 300)
    })
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    const { rerender } = render(<Office run={makeRun([], { id: 'floor-alpha' })} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' }) as HTMLElement
    Object.defineProperty(floor, 'clientWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(floor, 'clientHeight', { configurable: true, get: () => Math.min(702, Number.parseFloat(floor.style.maxHeight) || 702) })
    Object.defineProperty(floor, 'scrollWidth', { configurable: true, get: () => 1536 })
    Object.defineProperty(floor, 'scrollHeight', { configurable: true, get: () => 1600 })
    floorTop = 492
    rerender(<Office run={makeRun([], { id: 'floor-beta' })} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled />)
    expect(Number.parseFloat(floor.style.maxHeight)).toBe(400)
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 1200, behavior: 'instant' })))
    bounds.mockRestore()
  })

  it('keeps visitor map sizing immediate under reduced-motion global timing rules', () => {
    const css = readFileSync('web/src/office.css', 'utf8')
    const globalCss = readFileSync('web/src/app.css', 'utf8')
    expect(globalCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-duration:\s*\.01ms\s*!important/)
    expect(css).toMatch(/\.office-scroll--visitor\s*\{[^}]*transition:\s*none;/)
  })

  it('keeps the fitted overview walkable and guards its panels, pause controls, and approval focus', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    const { rerender } = render(<><button type="button">Approval dialog</button><Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled /></>)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' }) as HTMLElement
    Object.defineProperty(floor, 'clientWidth', { configurable: true, value: 900 })
    Object.defineProperty(floor, 'clientHeight', { configurable: true, value: 700 })
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    scrollTo.mockClear()
    fireEvent(window, new Event('resize'))
    expect(scrollTo).not.toHaveBeenCalled()
    expect(document.querySelector('.visitor-controls')).not.toBeNull()
    expect(Number((document.querySelector('.office-map-stage') as HTMLElement).dataset.fitScale)).toBeCloseTo(700 / 1600)
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    const before = avatar.style.top
    await waitFor(() => expect(document.activeElement).toBe(floor))
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(before)
    const walked = avatar.style.top
    fireEvent(window, new Event('resize'))
    expect(scrollTo).not.toHaveBeenCalled()
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })
    expect(screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '관제실 확인 사무실' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: '다른 프로젝트 층 선택' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '다른 프로젝트 층 선택' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '관제실 확인 사무실' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '잠시 멈춤' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(floor))
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(walked)
    fireEvent.keyDown(floor, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '관제실 확인 사무실' })).toBeNull()
    expect(screen.getByRole('button', { name: '전체 보기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '잠시 멈춤' })).toBeTruthy()
    const moved = avatar.style.top

    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    const approval = screen.getByRole('button', { name: 'Approval dialog' })
    approval.focus()
    rerender(<><button type="button">Approval dialog</button><Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled interactionBlocked /></>)
    expect(screen.queryByRole('dialog', { name: '관제실 확인 사무실' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Approval dialog' }))
    rerender(<><button type="button">Approval dialog</button><Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled /></>)
    expect(screen.getByRole('button', { name: '둘러보기 재개' })).toBeTruthy()
    expect(avatar.style.top).toBe(moved)
  })

  it('can activate exploration inside an open overview and use Space/F without moving the fitted camera', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    const onVisitorEnabledChange = vi.fn()
    const props = { run: makeRun(), asks: askList, now: Date.parse(stamp), onOpenAsk: () => {}, onVisitorEnabledChange }
    const { rerender } = render(<Office {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }))
    expect(screen.getByRole('dialog', { name: '관제실 확인 사무실' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '직접 둘러보기' }))
    expect(onVisitorEnabledChange).toHaveBeenCalledWith(true)
    rerender(<Office {...props} visitorEnabled />)
    scrollTo.mockClear()
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    await waitFor(() => expect(document.activeElement).toBe(floor))
    fireEvent.click(document.querySelector('.office-scene') as HTMLElement)
    await waitFor(() => expect(document.activeElement).toBe(floor))
    const avatar = screen.getByRole('img', { name: '대표 · 나, 대표 캐릭터' }) as HTMLElement
    const start = avatar.style.top
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(start)
    const walking = avatar.style.top
    fireEvent.keyDown(floor, { key: ' ', code: 'Space' })
    expect(screen.getByText('둘러보기 일시정지')).toBeTruthy()
    fireEvent.keyDown(floor, { key: ' ', code: 'Space' })
    await waitFor(() => expect(document.activeElement).toBe(floor))
    fireEvent.keyDown(floor, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(avatar.style.top).not.toBe(walking)
    const scale = (document.querySelector('.office-map-stage') as HTMLElement).dataset.fitScale
    expect(scrollTo).not.toHaveBeenCalled()
    fireEvent.keyDown(floor, { key: 'f', code: 'KeyF' })
    expect(screen.queryByRole('dialog', { name: '관제실 확인 사무실' })).toBeNull()
    fireEvent.keyDown(floor, { key: 'f', code: 'KeyF' })
    expect(screen.getByRole('dialog', { name: '관제실 확인 사무실' })).toBeTruthy()
    expect((document.querySelector('.office-map-stage') as HTMLElement).dataset.fitScale).toBe(scale)
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
  })

  it('recenters on resize only while visitor movement is active', () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
    const { rerender } = render(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled />)
    const floor = screen.getByRole('region', { name: '관제실 확인 사무실 바닥' })
    Object.defineProperty(floor, 'clientWidth', { configurable: true, value: 200 })
    Object.defineProperty(floor, 'clientHeight', { configurable: true, value: 150 })
    scrollTo.mockClear()
    fireEvent(window, new Event('resize'))
    expect(scrollTo).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '잠시 멈춤' }))
    scrollTo.mockClear()
    fireEvent(window, new Event('resize'))
    expect(scrollTo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '둘러보기 재개' }))
    fireEvent.keyDown(floor, { key: 'Enter', code: 'Enter' })
    scrollTo.mockClear()
    fireEvent(window, new Event('resize'))
    expect(scrollTo).not.toHaveBeenCalled()
    rerender(<Office run={makeRun()} asks={askList} now={Date.parse(stamp)} onOpenAsk={() => {}} visitorEnabled interactionBlocked />)
    scrollTo.mockClear()
    fireEvent(window, new Event('resize'))
    expect(scrollTo).not.toHaveBeenCalled()
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
    first.focus()
    expect(document.activeElement).toBe(first)
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
