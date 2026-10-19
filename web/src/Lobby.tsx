import { floorStatus } from '../../shared/contract.ts'
import type { AskView, ProjectView } from '../../shared/contract.ts'

type LobbyProps = {
  projects: ProjectView[]
  asks: AskView[]
  now: number
  onOpen: (path: string) => void
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

export default function Lobby({ projects, asks, now, onOpen }: LobbyProps) {
  const ordered = [...projects].sort((a, b) => {
    return a.path.localeCompare(b.path, 'ko') || a.name.localeCompare(b.name, 'ko')
  })

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
                <div><h2>아직 등록된 층이 없습니다</h2><p>첫 진행 보고가 도착하면 프로젝트 사무실이 열립니다.</p><span className="empty-caption">팀의 다음 보고를 기다리는 중</span></div>
              </div>
            ) : ordered.map((project, index) => {
              const status = floorStatus(project, asks, now)
              const run = latestRun(project)
              const floor = String(ordered.length - index).padStart(2, '0')
              return (
                <button
                  className={`floor floor--${status}`}
                  data-status={status}
                  data-floor={floor}
                  type="button"
                  key={project.path}
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
              )
            })}
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
    </main>
  )
}
