import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectView, RunView, StateSnapshot } from '../../shared/contract.ts'
import { getState, setProjectVisibility, subscribe } from './api.ts'
import Lobby from './Lobby.tsx'
import { AskDialog, DocNotice, DocumentPanel, Journal } from './Panels.tsx'
import { Office } from './Office.tsx'
import { orderProjectFloors } from './floors.ts'

type Route = { runId: string | null }

function readRoute(): Route {
  const match = window.location.hash.match(/^#\/run\/([^/?#]+)/)
  if (!match) return { runId: null }
  try {
    return { runId: decodeURIComponent(match[1]) }
  } catch {
    return { runId: null }
  }
}

function chooseProjectRun(project: ProjectView) {
  const active = project.runs.filter((run) => !run.ended_at)
    .sort((a, b) => Date.parse(b.last_report_at) - Date.parse(a.last_report_at) || b.id.localeCompare(a.id))
  if (active.length) return active[0]
  return [...project.runs].filter((run) => run.ended_at)
    .sort((a, b) => Date.parse(b.ended_at ?? '') - Date.parse(a.ended_at ?? '') || b.id.localeCompare(a.id))[0]
}

export default function App() {
  const [snapshot, setSnapshot] = useState<StateSnapshot>({ projects: [], asks: [] })
  const [route, setRoute] = useState<Route>(() => readRoute())
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ runId: string; path: string } | null>(null)
  const [selectedAskId, setSelectedAskId] = useState<string | null>(null)
  const [documentRevision, setDocumentRevision] = useState(0)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const snapshotRef = useRef(snapshot)
  const routeRef = useRef(route)
  snapshotRef.current = snapshot
  routeRef.current = route
  const closeAsk = useCallback(() => setSelectedAskId(null), [])

  const refresh = useCallback(async () => {
    try {
      const next = await getState()
      const runId = routeRef.current.runId
      const previousRun = snapshotRef.current.projects.flatMap((project) => project.runs).find((run) => run.id === runId)
      const nextRun = next.projects.flatMap((project) => project.runs).find((run) => run.id === runId)
      if (previousRun && nextRun && previousRun.doc_path && (
        previousRun.doc_path !== nextRun.doc_path ||
        previousRun.doc_accessible !== nextRun.doc_accessible ||
        previousRun.last_report_at !== nextRun.last_report_at
      )) setDocumentRevision((revision) => revision + 1)
      snapshotRef.current = next
      setSnapshot(next)
      setLoadError('')
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : '관제실 상태를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsubscribe = subscribe(() => { void refresh() }, (event) => {
      if (event.run_id === routeRef.current.runId) {
        setNotice({ runId: event.run_id, path: event.path })
        setDocumentRevision((revision) => revision + 1)
      }
    }, () => setDocumentRevision((revision) => revision + 1))
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    const onHashChange = () => {
      const nextRoute = readRoute()
      setRoute(nextRoute)
      setSelectedAskId(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [refresh, route.runId])

  const activeProject = useMemo(() => snapshot.projects.find((project) => project.runs.some((run) => run.id === route.runId)), [snapshot.projects, route.runId])
  const selectedRun = activeProject?.runs.find((run) => run.id === route.runId)
  const activeRuns = activeProject?.runs.filter((run) => !run.ended_at)
    .sort((a, b) => Date.parse(b.last_report_at) - Date.parse(a.last_report_at) || b.id.localeCompare(a.id)) ?? []
  const selectedAsk = snapshot.asks.find((ask) => ask.id === selectedAskId && ask.status === 'pending') ?? null
  const floorAsks = activeProject?.runs.flatMap((run) => snapshot.asks.filter((ask) => ask.run_id === run.id)) ?? []
  const endedRuns = activeProject?.runs.filter((run) => run.ended_at) ?? []
  const visitorFloors = orderProjectFloors(snapshot.projects).map(({ project, floorNumber }) => ({
    projectPath: project.path,
    name: project.name,
    floorNumber,
    status: project.runs.length ? (project.runs.some((run) => !run.ended_at) ? '근무 중' : '업무 종료') : '보고 없음',
    disabled: project.runs.length === 0,
    current: project.path === activeProject?.path,
  }))

  function openProject(path: string) {
    const project = snapshot.projects.find((item) => item.path === path)
    const run = project && chooseProjectRun(project)
    if (run) window.location.hash = `#/run/${encodeURIComponent(run.id)}`
  }

  function selectRun(id: string) {
    window.location.hash = `#/run/${encodeURIComponent(id)}`
  }

  async function changeVisibility(path: string, hidden: boolean) {
    await setProjectVisibility(path, hidden)
    const next = { ...snapshotRef.current, projects: snapshotRef.current.projects.map((project) => project.path === path ? { ...project, hidden } : project) }
    snapshotRef.current = next
    setSnapshot(next)
  }

  if (!selectedRun || !activeProject) {
    return (
      <div className="app-shell">
        <TopBar onHome={() => { window.location.hash = '#/' }} />
        {loadError && <div className="load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => { setLoading(true); void refresh() }}>다시 불러오기</button></div>}
        {loading && snapshot.projects.length === 0 ? <LoadingLobby /> : <Lobby projects={snapshot.projects} asks={snapshot.asks} now={now} onOpen={openProject} onSetVisibility={changeVisibility} onOpenAsk={setSelectedAskId} />}
        <AskDialog ask={selectedAsk} onClose={closeAsk} />
      </div>
    )
  }

  return (
    <div className="app-shell app-shell--floor">
      <TopBar onHome={() => { window.location.hash = '#/' }} projectName={activeProject.name} />
      {loadError && <div className="load-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => { setLoading(true); void refresh() }}>다시 불러오기</button></div>}
      <main className="floor-page">
        <header className="floor-heading">
          <div><button className="back-link" type="button" onClick={() => { window.location.hash = '#/' }}>← 빌딩 로비</button><h1>{activeProject.name}</h1><p>{activeProject.path}</p></div>
          {!selectedRun.ended_at && activeRuns.length > 1 && <label className="run-picker">진행 중 실행 {activeRuns.length}개<select aria-label="진행 중 run" value={selectedRun.id} onChange={(event) => selectRun(event.target.value)}>{activeRuns.map((run) => <option value={run.id} key={run.id}>{run.title || run.state.title || '제목 미보고'} · {run.id}</option>)}</select></label>}
        </header>
        <section className="run-summary" aria-label="run 진행 요약">
          <div><span className="status-light" data-status={selectedRun.ended_at ? 'off' : 'on'} /><strong>{selectedRun.state.stage || '계획'}</strong><small>{selectedRun.ended_at ? '업무 종료' : '팀 근무 중'}</small></div>
          <div className="run-notes">
            <p><strong>선택한 실행</strong><span>{selectedRun.title || selectedRun.state.title || '제목 미보고'} · {selectedRun.id}</span></p>
            <p className="run-notes__summary">{selectedRun.state.summary || '아직 요약이 없습니다. 팀의 다음 보고를 기다리는 중입니다.'}</p>
            <p><strong>사용자 할 일</strong><span>{selectedRun.state.todo?.trim() || '없음'}</span></p>
            <p><strong>막힌 사항</strong><span>{selectedRun.state.blockers?.trim() || '없음'}</span></p>
          </div>
          <span className="report-time">마지막 보고 {new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(selectedRun.last_report_at))}</span>
        </section>
        {notice?.runId === selectedRun.id && <DocNotice path={notice.path} onDismiss={() => setNotice(null)} />}
        <div className="office-layout">
          <section className="office-column" aria-label="사무실 현황">
            <Office key={selectedRun.id} run={selectedRun} projectRuns={activeProject.runs} asks={floorAsks} now={now} onOpenAsk={setSelectedAskId} overviewOpen={overviewOpen} onOverviewOpenChange={setOverviewOpen} floors={visitorFloors} onVisitProject={(path) => {
              const latestProject = snapshotRef.current.projects.find((project) => project.path === path)
              const destination = latestProject && !latestProject.hidden && chooseProjectRun(latestProject)
              if (destination) window.location.hash = `#/run/${encodeURIComponent(destination.id)}`
              else setSelectedAskId(null)
              return Boolean(destination)
            }} interactionBlocked={selectedAsk !== null} />
            {floorAsks.filter((ask) => ask.status === 'pending').map((ask) => <button className="ask-ticket" type="button" key={ask.id} onClick={() => setSelectedAskId(ask.id)}><span className="ask-ticket__bell" aria-hidden="true">!</span><span><strong>대표실 결재 대기</strong><small>{ask.question}</small></span><span>열기</span></button>)}
          </section>
          <aside className="run-panels" aria-label="프로젝트 기록과 문서">
            <DocumentPanel run={selectedRun} revision={documentRevision} />
            <Journal key={activeProject.path} runs={endedRuns} onOpenSnapshot={() => undefined} />
          </aside>
        </div>
      </main>
      <AskDialog ask={selectedAsk} onClose={closeAsk} />
    </div>
  )
}

function TopBar({ onHome, projectName }: { onHome: () => void; projectName?: string }) {
  return <header className="topbar"><button type="button" className="brand" onClick={onHome} aria-label="빌딩 로비로 이동"><span className="brand__glyph" aria-hidden="true"><i /><i /><i /><i /></span><span>오피스 리포터<small>TEAM CONTROL ROOM</small></span></button><div className="topbar__right"><span className="server-indicator"><i />로컬 관제실</span>{projectName && <span className="topbar__project">{projectName}</span>}</div></header>
}

function LoadingLobby() {
  return <main className="lobby-loading" role="status"><span className="loading-lamp" /><p>사무실 층을 확인하고 있습니다…</p></main>
}
