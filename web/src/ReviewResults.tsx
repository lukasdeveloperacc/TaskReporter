import type { Review } from '../../shared/contract.ts'
import './review-results.css'

export function ReviewResults({ reviews }: { reviews: Review[] }) {
  const latest = new Map<string, Review>()
  for (const review of reviews) {
    if (!latest.has(review.reviewer) || latest.get(review.reviewer)!.round < review.round) latest.set(review.reviewer, review)
  }
  const ordered = [...latest.values()].sort((a, b) => b.round - a.round || a.reviewer.localeCompare(b.reviewer))
  const previous = reviews.filter((review) => latest.get(review.reviewer) !== review).sort((a, b) => b.round - a.round || a.reviewer.localeCompare(b.reviewer))
  const list = (items: Review[]) => <ul className="review-results__list">{items.map((review) => <li key={`${review.round}-${review.reviewer}`}>
    <p><strong>{review.reviewer}</strong> · R{review.round} · <span className="review-results__verdict" data-verdict={review.verdict}>{review.verdict || '판정 미보고'}</span></p>
    <p className="review-results__note">{review.note?.trim() ? review.note : '리뷰 내용이 아직 보고되지 않았습니다.'}</p>
  </li>)}</ul>

  return <section className="review-results" aria-label="리뷰 결과">
    <h3>리뷰 결과</h3>
    {ordered.length ? list(ordered) : <p>아직 보고된 리뷰 결과가 없습니다.</p>}
    {previous.length > 0 && <details><summary>이전 라운드 리뷰 {previous.length}개</summary>{list(previous)}</details>}
  </section>
}
