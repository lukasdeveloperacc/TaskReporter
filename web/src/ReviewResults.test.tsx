// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReviewResults } from './ReviewResults.tsx'

describe('review results', () => {
  it('shows each reviewer latest verdict and full note, preserving older rounds', () => {
    const note = '필수 수정: 키보드 포커스 복구\n근거: 실제 모바일 화면에서 확인했습니다.'
    render(<ReviewResults reviews={[
      { round: 1, reviewer: 'Karpathy Agent', verdict: 'PASS', note: '이전 판정 근거' },
      { round: 2, reviewer: 'Karpathy Agent', verdict: 'CHANGES_REQUIRED', note },
      { round: 1, reviewer: 'E2E Agent', verdict: 'PASS', note: '실제 연결 검증 완료' },
    ]} />)
    const region = screen.getByRole('region', { name: '리뷰 결과' })
    expect(within(region).getByText('CHANGES_REQUIRED')).toBeTruthy()
    expect(within(region).getByText(/필수 수정:/).textContent).toBe(note)
    expect(within(region).getByText('실제 연결 검증 완료')).toBeTruthy()
    const previous = region.querySelector('details')!
    expect(previous.open).toBe(false)
    fireEvent.click(within(region).getByText('이전 라운드 리뷰 1개'))
    expect(previous.open).toBe(true)
    expect(within(previous).getByText('이전 판정 근거')).toBeTruthy()
  })

  it('keeps missing verdicts and review contents explicit without guessing PASS', () => {
    const { rerender } = render(<ReviewResults reviews={[]} />)
    expect(screen.getByText('아직 보고된 리뷰 결과가 없습니다.')).toBeTruthy()
    rerender(<ReviewResults reviews={[{ round: 1, reviewer: 'Ponytail Agent' }]} />)
    expect(screen.getByText('판정 미보고')).toBeTruthy()
    expect(screen.getByText('리뷰 내용이 아직 보고되지 않았습니다.')).toBeTruthy()
    expect(screen.queryByText('PASS')).toBeNull()
  })
})
