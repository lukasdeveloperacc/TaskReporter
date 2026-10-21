import { useState } from 'react'
import { floorStatus } from '../../shared/contract.ts'
import type { AskView, ProjectView } from '../../shared/contract.ts'
import { orderProjectFloors } from './floors.ts'

type LobbyProps = {
  projects: ProjectView[]
  asks: AskView[]
  now: number
  onOpen: (path: string) => void
  onSetVisibility: (path: string, hidden: boolean) => Promise<void>
  onOpenAsk: (id: string) => void
}

function latestRun(project: ProjectView) {
  return [...project.runs].sort((a, b) => Date.parse(b.last_report_at) - Date.parse(a.last_report_at) || b.id.localeCompare(a.id))[0]
}

const statusCopy = {
  ask: '결재 대기',
  away: '자리 비움',
  on: '불 켜짐',
  off: '퇴근',
} as const

export default function Lobby({ projects, asks, now, onOpen, onSetVisibility, onOpenAsk }: LobbyProps) {
  const ordered = orderProjectFloors(projects)
  const hiddenProjects = projects.filter((project) => project.hidden)
  const pendingAsks = asks.flatMap((ask) => {
    if (ask.status !== 'pending') return []
    const project = projects.find((item) => item.runs.some((run) => run.id === ask.run_id))
    return project ? [{ ask, project }] : []
  })
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null)
  const [hiddenManagerOpen, setHiddenManagerOpen] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [visibilityError, setVisibilityError] = useState<{ path: string; hidden: boolean; message: string } | null>(null)

  async function setVisibility(path: string, hidden: boolean) {
    if (busyPath) return
    setBusyPath(path)
    setVisibilityError(null)
    try {
      await onSetVisibility(path, hidden)
      setOpenMenuPath(null)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '알 수 없는 오류'
      setVisibilityError({ path, hidden, message: `층을 ${hidden ? '숨기지' : '다시 표시하지'} 못했습니다. ${reason}` })
    } finally {
      setBusyPath(null)
    }
  }

  const hiddenManagerToggle = hiddenProjects.length > 0 && (
    <button
      className="hidden-manager__toggle"
      type="button"
      aria-expanded={hiddenManagerOpen}
      aria-controls="hidden-projects-manager"
      onClick={() => setHiddenManagerOpen((open) => !open)}
    >
      {hiddenManagerOpen ? '숨긴 층 닫기' : '숨긴 층 관리'}
    </button>
  )

  return (
    <main className="lobby-page">
      <header className="lobby-heading">
        <div>
          <h1>대표님, 어느 층을 볼까요?</h1>
          <p>프로젝트별 사무실과 가장 최근 보고를 모았습니다.</p>
        </div>
      </header>

      <section className="building" aria-label="프로젝트 빌딩">
        <div className="building__roof">
          <span className="roof__mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="roof__name">오피스 리포터<small>TEAM CONTROL ROOM · 4780</small></span>
          <span className="roof-flag">관제실</span>
        </div>
        <div className="building__body">
          <aside className="building__core" aria-label="빌딩 엘리베이터">
            <span className="core__label">층</span>
            <div className="core__shaft"><span className="core__car"><i /><i /></span></div>
            <span className="core__base">OFFICE<br />TOWER</span>
          </aside>
          <div className="building__floors">
            {ordered.length === 0 ? (
              <div className="building__empty" aria-live="polite">
                <div className="empty-window" aria-hidden="true"><span /><span /><span /></div>
                <div>
                  <h2>{projects.length === 0 ? '아직 등록된 층이 없습니다' : '숨긴 프로젝트만 있습니다'}</h2>
                  <p>{projects.length === 0 ? '첫 진행 보고가 도착하면 프로젝트 사무실이 열립니다.' : '숨긴 층을 다시 표시하면 빌딩에 나타납니다.'}</p>
                  {projects.length === 0 ? <span className="empty-caption">팀의 다음 보고를 기다리는 중</span> : hiddenManagerToggle}
                </div>
              </div>
            ) : ordered.map(({ project, floorNumber }) => {
              const status = floorStatus(project, asks, now)
              const run = latestRun(project)
              const floor = String(floorNumber).padStart(2, '0')
              return (
                <div className="floor-entry" key={project.path}>
                  <button
                    className={`floor floor--${status}`}
                    data-status={status}
                    data-floor={floor}
                    type="button"
                    disabled={!run}
                    onClick={() => onOpen(project.path)}
                    aria-label={`${project.name} 층 ${floor}F, ${run?.title || run?.state.title || '아직 보고 없음'}, ${statusCopy[status]}`}
                  >
                    <span className="floor__level"><span>{floor}</span><small>FLOOR</small></span>
                    <span className="floor__details">
                      <span className="floor__name" title={project.name}>{project.name}</span>
                      <span className="floor__run" title={run?.title || run?.state.title || ''}>{run ? run.title || run.state.title || '제목 없는 run' : '아직 보고 없음'}</span>
                      <span className="floor__meta">
                        <span className="floor__status"><i aria-hidden="true" />{statusCopy[status]}</span>
                        {run && <span className="floor__stage">{run.state.stage ?? '계획'}</span>}
                      </span>
                    </span>
                    <span className="floor__bay" aria-hidden="true"><i /><i /><i /></span>
                  </button>
                  <div className={`floor-actions${openMenuPath === project.path ? ' floor-actions--open' : ''}`}>
                    <button
                      className="floor-menu-toggle"
                      type="button"
                      aria-label={`층 메뉴, ${floor}F`}
                      aria-expanded={openMenuPath === project.path}
                      aria-controls={`floor-menu-${floor}`}
                      onClick={() => setOpenMenuPath((path) => path === project.path ? null : project.path)}
                    >메뉴</button>
                    <div className="floor-menu" id={`floor-menu-${floor}`} hidden={openMenuPath !== project.path}>
                      <button type="button" disabled={busyPath !== null} onClick={() => void setVisibility(project.path, true)}>이 층 숨기기</button>
                    </div>
                  </div>
                </div>
              )
            })}
            {ordered.length > 0 && hiddenManagerToggle}
            {hiddenProjects.length > 0 && (
              <section className="hidden-manager" id="hidden-projects-manager" aria-label="숨긴 프로젝트" hidden={!hiddenManagerOpen}>
                <h2>숨긴 층</h2>
                {hiddenProjects.map((project) => (
                  <div className="hidden-project" key={project.path}>
                    <div className="hidden-project__details">
                      <strong title={project.name}>{project.name}</strong>
                      <small title={project.path}>{project.path}</small>
                    </div>
                    <button
                      type="button"
                      aria-label={`${project.name} 층 다시 표시`}
                      disabled={busyPath !== null}
                      onClick={() => void setVisibility(project.path, false)}
                    >다시 표시</button>
                  </div>
                ))}
              </section>
            )}
            {busyPath && <p className="inline-state" role="status">층 표시 상태를 저장하고 있습니다…</p>}
            {visibilityError && (
              <div className="visibility-error" role="alert">
                <span>{visibilityError.message}</span>
                <button type="button" disabled={busyPath !== null} onClick={() => void setVisibility(visibilityError.path, visibilityError.hidden)}>다시 시도</button>
              </div>
            )}
          </div>
        </div>
        <div className="building__base">
          <span className="base__sign">1F · 로비</span>
          <span className="base__message">보고가 도착하면 이곳에 프로젝트 층이 열립니다</span>
          <span className="base-door" aria-hidden="true"><i /><i /></span>
        </div>
        <div className="building__foundation" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      </section>

      <footer className="lobby-key" aria-label="층 상태 안내">
        <span><i className="key-light key-light--on" />불 켜짐</span>
        <span><i className="key-light key-light--ask" />결재 대기</span>
        <span><i className="key-light key-light--away" />자리 비움</span>
        <span><i className="key-light key-light--off" />퇴근</span>
      </footer>
      {pendingAsks.length > 0 && (
        <section className="lobby-asks" aria-label="결재 대기">
          <h2>결재 대기</h2>
          {pendingAsks.map(({ ask, project }) => (
            <button className="ask-ticket" type="button" key={ask.id} onClick={() => onOpenAsk(ask.id)}>
              <span className="ask-ticket__bell" aria-hidden="true">!</span>
              <span><strong>{project.name} · 대표실 결재 대기</strong><small>{ask.question}</small></span>
              <span>열기</span>
            </button>
          ))}
        </section>
      )}
    </main>
  )
}
