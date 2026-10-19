import { useEffect, useRef, useState } from 'react'
import type { AskView, RunView } from '../../shared/contract.ts'
import { answerAsk, getDoc } from './api.ts'

type AskDialogProps = { ask: AskView | null; onClose: () => void }

export function AskDialog({ ask, onClose }: AskDialogProps) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const firstOption = useRef<HTMLButtonElement>(null)
  const sendingRef = useRef(sending)
  sendingRef.current = sending

  useEffect(() => {
    if (!ask) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstOption.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sendingRef.current) onClose()
      if (event.key === 'Tab') {
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.ask-dialog button:not(:disabled)'))
        if (!controls.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [ask?.id, onClose])

  if (!ask) return null
  const currentAsk = ask

  async function choose(answer: string) {
    setSending(true)
    setError('')
    try {
      await answerAsk(currentAsk.id, answer)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '결재를 전달하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose() }}>
      <section className="ask-dialog" role="dialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-question">
        <div className="ask-dialog__top"><span className="stamp stamp--pending">결재 서류</span><button type="button" className="icon-button" aria-label="결재 창 닫기" onClick={onClose} disabled={sending}>닫기</button></div>
        <h2 id="ask-title">대표님의 결정이 필요합니다</h2>
        <p id="ask-question" className="ask-question">{ask.question}</p>
        <div className="ask-options">
          {ask.options.map((option, index) => (
            <button type="button" key={option} ref={index === 0 ? firstOption : undefined} disabled={sending} onClick={() => void choose(option)}>
              <span>{option}</span>{option === ask.recommended && <small>추천</small>}
            </button>
          ))}
        </div>
        {sending && <p className="inline-state" role="status">결재를 전달하고 있습니다…</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </section>
    </div>
  )
}

export function DocNotice({ path, onDismiss }: { path: string; onDismiss: () => void }) {
  return (
    <aside className="doc-notice" role="status">
      <span className="doc-notice__mark" aria-hidden="true">!</span>
      <div><strong>기획 변경 공지</strong><p>{path} 문서가 바뀌었습니다. 리더가 다음 보고에서 변경 내용을 확인합니다.</p></div>
      <button type="button" aria-label="기획 변경 공지 닫기" onClick={onDismiss}>확인</button>
    </aside>
  )
}

export function Journal({ runs, onOpenSnapshot }: { runs: RunView[]; onOpenSnapshot: (run: RunView) => void }) {
  const [snapshot, setSnapshot] = useState<RunView | null>(null)
  if (runs.length === 0) return null
  const ordered = [...runs].sort((a, b) => Date.parse(b.ended_at ?? '') - Date.parse(a.ended_at ?? '') || b.id.localeCompare(a.id))

  function open(run: RunView) {
    setSnapshot(run)
    onOpenSnapshot(run)
  }

  return (
    <section className="journal panel-section" aria-labelledby="journal-title">
      <div className="panel-heading"><div><h2 id="journal-title">업무 일지</h2><p>마친 run의 마지막 기록</p></div><span>{ordered.length}건</span></div>
      <ul className="journal-list">
        {ordered.map((run) => (
          <li key={run.id}>
            <button type="button" onClick={() => open(run)}>
              <span className={`stamp ${run.state.stage?.startsWith('중단') ? 'stamp--stop' : 'stamp--done'}`}>{run.state.stage?.startsWith('중단') ? '중단' : '완료'}</span>
              <span className="journal-entry"><strong>{run.title || run.state.title || '제목 없는 run'}</strong><small>{formatDate(run.ended_at)}</small></span>
              <span className="journal-arrow" aria-hidden="true">열기</span>
            </button>
          </li>
        ))}
      </ul>
      {snapshot && (
        <div className="snapshot" role="dialog" aria-modal="false" aria-labelledby="snapshot-title">
          <div className="snapshot__heading"><h3 id="snapshot-title">{snapshot.title || '마지막 상태'}</h3><button type="button" aria-label="스냅샷 닫기" onClick={() => setSnapshot(null)}>닫기</button></div>
          <p>{snapshot.state.summary || '요약이 기록되지 않았습니다.'}</p>
          <SnapshotList title="작업" items={(snapshot.state.tasks ?? []).map((task) => `${task.title || task.id} · ${task.status || '상태 미정'}`)} empty="기록된 작업이 없습니다." />
          <SnapshotList title="리뷰" items={(snapshot.state.reviews ?? []).map((review) => `R${review.round} ${review.reviewer} · ${review.verdict || '결과 미정'}${review.note ? ` — ${review.note}` : ''}`)} empty="기록된 리뷰가 없습니다." />
          <SnapshotList title="결정" items={(snapshot.state.decisions ?? []).map((decision) => `${decision.title}${decision.body ? ` — ${decision.body}` : ''}`)} empty="기록된 결정이 없습니다." />
        </div>
      )}
    </section>
  )
}

function SnapshotList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <div className="snapshot-list"><h4>{title}</h4>{items.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>{empty}</p>}</div>
}

export function DocumentPanel({ run, revision = 0 }: { run: RunView; revision?: number }) {
  const [document, setDocument] = useState<{ path: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setDocument(null)
    setError('')
    setLoading(false)
    if (!run.doc_path || !run.doc_accessible) return () => { current = false }
    setLoading(true)
    getDoc(run.id).then((result) => {
      if (current) setDocument(result)
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : '기획서를 불러오지 못했습니다.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [run.id, run.doc_path, run.doc_accessible, revision])

  return (
    <section className="document-panel panel-section" aria-labelledby="document-title">
      <div className="panel-heading"><div><h2 id="document-title">기획서</h2><p>{run.doc_path || '연결된 문서가 없습니다'}</p></div><span aria-hidden="true">읽기 전용</span></div>
      {!run.doc_accessible && <p className="document-unavailable">기획서 열람·변경 감지 불가</p>}
      {run.doc_accessible && !run.doc_path && <p className="document-unavailable">이 run에는 연결된 기획서가 없습니다.</p>}
      {loading && <p className="inline-state" role="status">기획서를 불러오는 중…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {document && <pre className="document-text">{document.text}</pre>}
    </section>
  )
}

function formatDate(value: string | null) {
  if (!value) return '종료 시간 미기록'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
