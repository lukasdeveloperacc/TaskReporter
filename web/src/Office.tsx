import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { AskView, RunView } from '../../shared/contract.ts'
import { buildOffice, characterFrame, diffScenes, fitOfficeScale, OFFICE_HEIGHT, OFFICE_WIDTH, seatPosition, type Scene } from './office.ts'
import roles from './roles.json' with { type: 'json' }
import './office.css'

export type OfficeProps = { run: RunView; asks: AskView[]; now: number; onOpenAsk: (id: string) => void }
const departmentByKey = new Map(roles.departments.map((department) => [department.key, department]))
const TILE = 48
const MAX_SCENES = 40
const BUBBLE_WIDTH = 148

function Sprite({ frame, className = '' }: { frame: [number, number]; className?: string }) {
  const [col, row] = frame
  return <span aria-hidden="true" className={`sprite ${className}`} style={{ backgroundPosition: `${-col * 51}px ${-row * 51}px` }} />
}

export function Office({ run, asks, now, onOpenAsk }: OfficeProps) {
  const office = useMemo(() => buildOffice(run, now), [run, now])
  const previousRun = useRef<RunView | null>(null)
  const [scene, setScene] = useState<Scene | null>(null)
  const [motionKey, setMotionKey] = useState(0)
  const [walkers, setWalkers] = useState<Set<string>>(new Set())
  const [sceneTraveling, setSceneTraveling] = useState(false)
  const queue = useRef<Scene[]>([])
  const timer = useRef<number | undefined>(undefined)
  const travelFrame = useRef<number | undefined>(undefined)
  const walkFrame = useRef<number | undefined>(undefined)
  const playNext = useRef<() => void>(() => {})

  playNext.current = () => {
    timer.current = undefined
    const next = queue.current.shift()
    setScene(next ?? null)
    setSceneTraveling(false)
    if (!next) return
    if (travelFrame.current !== undefined) window.cancelAnimationFrame(travelFrame.current)
    travelFrame.current = window.requestAnimationFrame(() => {
      travelFrame.current = window.requestAnimationFrame(() => setSceneTraveling(true))
    })
    timer.current = window.setTimeout(() => playNext.current(), 1100)
  }

  useEffect(() => {
    const changes = diffScenes(previousRun.current, run)
    queue.current = [...queue.current, ...changes].slice(-MAX_SCENES)
    const arriving = new Set(changes.filter((item) => item.type === 'walk').map((item) => item.who))
    previousRun.current = run
    if (arriving.size) {
      setWalkers(arriving)
      if (walkFrame.current !== undefined) window.cancelAnimationFrame(walkFrame.current)
      walkFrame.current = window.requestAnimationFrame(() => {
        walkFrame.current = window.requestAnimationFrame(() => setWalkers(new Set()))
      })
    }
    if (queue.current.length && timer.current === undefined) playNext.current()
  }, [run])
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    if (travelFrame.current !== undefined) window.cancelAnimationFrame(travelFrame.current)
    if (walkFrame.current !== undefined) window.cancelAnimationFrame(walkFrame.current)
    queue.current = []
  }, [])
  useEffect(() => { setMotionKey((key) => key + 1) }, [scene])

  const deskPositions = new Map<string, { x: number; y: number }>()
  office.employees.forEach((employee) => {
    const department = departmentByKey.get(employee.department)!
    const seat = seatPosition(department, employee.deskIndex)
    deskPositions.set(employee.name, { x: seat.x * TILE, y: seat.y * TILE })
  })
  const latestReviews = new Map<string, { review: NonNullable<RunView['state']['reviews']>[number]; count: number }>()
  for (const review of run.state.reviews ?? []) {
    const previous = latestReviews.get(review.reviewer)
    latestReviews.set(review.reviewer, { review: !previous || review.round >= previous.review.round ? review : previous.review, count: (previous?.count ?? 0) + 1 })
  }

  const floorRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLElement>(null)
  const overviewTriggerRef = useRef<HTMLButtonElement>(null)
  const restoreTriggerFocus = useRef(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [fitScale, setFitScale] = useState(1)
  const roomRefs = useRef(new Map<string, HTMLElement>())
  const jumpToRoom = (key: string) => {
    const floor = floorRef.current
    const room = roomRefs.current.get(key)
    if (!floor || !room) return
    floor.scrollTo({
      left: Math.max(0, Math.min(room.offsetLeft + room.offsetWidth / 2 - floor.clientWidth / 2, floor.scrollWidth - floor.clientWidth)),
      top: Math.max(0, Math.min(room.offsetTop + room.offsetHeight / 2 - floor.clientHeight / 2, floor.scrollHeight - floor.clientHeight)),
    })
  }
  const openAsk = (id: string) => {
    restoreTriggerFocus.current = false
    setOverviewOpen(false)
    onOpenAsk(id)
  }
  const toggleOverview = () => {
    if (overviewOpen) {
      restoreTriggerFocus.current = true
      setOverviewOpen(false)
    } else {
      setFitScale(fitOfficeScale(window.innerWidth, window.innerHeight, toolbarRef.current?.getBoundingClientRect().height ?? 52))
      setOverviewOpen(true)
    }
  }

  useEffect(() => {
    if (!overviewOpen) {
      if (restoreTriggerFocus.current) {
        restoreTriggerFocus.current = false
        overviewTriggerRef.current?.focus()
      }
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const measure = () => setFitScale(fitOfficeScale(window.innerWidth, window.innerHeight, toolbarRef.current?.getBoundingClientRect().height ?? 52))
    measure()
    window.addEventListener('resize', measure)
    overviewTriggerRef.current?.focus()
    return () => {
      window.removeEventListener('resize', measure)
      document.body.style.overflow = previousOverflow
    }
  }, [overviewOpen])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      restoreTriggerFocus.current = true
      setOverviewOpen(false)
    } else if (event.key === 'Tab') {
      const dialog = event.currentTarget
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }

  const stageStyle = overviewOpen
    ? { width: OFFICE_WIDTH * fitScale, height: OFFICE_HEIGHT * fitScale }
    : { width: OFFICE_WIDTH, height: OFFICE_HEIGHT }
  const mapStyle = overviewOpen ? { transform: `scale(${fitScale})` } : undefined

  return <section className={`office-panel${overviewOpen ? ' office-panel--expanded' : ''}`} aria-label={`${run.title} 사무실`} role={overviewOpen ? 'dialog' : undefined} aria-modal={overviewOpen || undefined} onKeyDown={overviewOpen ? handleDialogKeyDown : undefined}>
    <nav ref={toolbarRef} className="office-department-nav" aria-label="사무실 구역 바로가기">
      <button ref={overviewTriggerRef} type="button" className="office-overview-toggle" onClick={toggleOverview}>{overviewOpen ? '전체 보기 닫기' : '전체 보기'}</button>
      {roles.departments.map((department, index) => <button key={department.key} type="button" aria-controls={`office-room-${index}`} onClick={() => jumpToRoom(department.key)}>{department.name}</button>)}
    </nav>
    <div id="office-floor-scroll" ref={floorRef} className={`office-scroll${overviewOpen ? ' office-scroll--overview' : ''}`} role="region" aria-label={`${run.title} 사무실 바닥`} tabIndex={0}>
    <div className="office-map-stage" style={stageStyle} data-fit-scale={overviewOpen ? fitScale : 1}>
    <div className={`office-scene ${run.ended_at ? 'office-scene--off' : ''}`} data-run-id={run.id} style={mapStyle}>
      <div className="office-entry"><span>출입구</span></div>
      {roles.departments.map((department, index) => <section key={department.key} id={`office-room-${index}`} ref={(element) => { if (element) roomRefs.current.set(department.key, element); else roomRefs.current.delete(department.key) }} className="office-room" aria-label={department.name} style={{ left: department.x * TILE, top: department.y * TILE, width: department.w * TILE, height: department.h * TILE, '--room-color': department.color } as CSSProperties}>
        <h3>{department.name}</h3>
        {department.key === '대표실' && asks.filter((ask) => ask.run_id === run.id && ask.status === 'pending').map((ask) => <button className="office-ask" key={ask.id} onClick={() => openAsk(ask.id)}><span>결재 서류</span><strong>{ask.question}</strong></button>)}
        {department.key === '대표실' && <span className="office-plant" aria-hidden="true" />}
      </section>)}
      <div className="office-representative" data-office-role="representative" role="img" aria-label="대표 · 나, 대표 캐릭터" style={{ left: 2 * TILE, top: 4 * TILE }}>
        <Sprite frame={characterFrame('대표 · 나')} className="office-person" />
        <span className="office-name">대표 · 나</span>
      </div>
      {office.employees.map((employee) => {
        const position = deskPositions.get(employee.name) ?? { x: 0, y: 0 }
        const desk = departmentByKey.get(employee.department)!
        const x = position.x
        const y = position.y - TILE
        const isWorking = employee.state === 'typing'
        const parked = { x: position.x - TILE / 2, y: position.y }
        const deliveryAudit = { x: (departmentByKey.get('감사팀')!.x + 4) * TILE, y: (departmentByKey.get('감사팀')!.y + 2) * TILE }
        const delivery = scene?.type === 'deliver' && scene.who === employee.name
        const returnOwner = scene?.type === 'return' ? scene.to[0] : undefined
        const returning = scene?.type === 'return' && (scene.from === employee.name || returnOwner === employee.name)
        const travelTarget = delivery ? deliveryAudit : returning && returnOwner ? deskPositions.get(returnOwner) ?? position : position
        const travelsThisScene = delivery || returning
        const at = walkers.has(employee.name)
          ? { x: 13 * TILE + (office.employees.findIndex(({ name }) => name === employee.name) % 6) * 56, y: 13 * TILE + Math.floor(office.employees.findIndex(({ name }) => name === employee.name) / 6) * 56 }
          : travelsThisScene && sceneTraveling ? travelTarget : isWorking || employee.state === 'away' || travelsThisScene ? position : parked
        return <div key={employee.name} className={`office-employee office-employee--${employee.state}`} data-employee={employee.name} data-state={employee.state} style={{ left: at.x, top: at.y, '--employee-color': desk.color, '--walk-key': motionKey } as CSSProperties}>
          <Sprite frame={employee.frame} className="office-person" />
          <span className="office-bubble office-bubble--staff" tabIndex={employee.state === 'gone' ? undefined : 0} title={`${employee.name}${employee.task ? ` · ${employee.task.title}` : ''} · 모델 ${employee.model ?? '미보고'} · 노력 ${employee.effort ?? '미보고'}`} style={{ '--bubble-width': `${BUBBLE_WIDTH}px`, maxHeight: 120 } as CSSProperties}>
            <span className="office-name">{employee.name === 'leader' ? '부장 · leader' : `${employee.name}${employee.rank ? ` · ${employee.rank}` : ''}`}</span>
            {employee.task && <strong className="office-task-title" title={employee.task.title}>{employee.task.title}</strong>}
            <strong className="office-model-line">모델 · {employee.model ?? '미보고'}</strong>
            <strong className="office-effort-line">노력 · {employee.effort ?? '미보고'}</strong>
            {employee.task && <small>{employee.state === 'away' ? '자리 비움 · ' : ''}{employee.task.elapsedMin}분{employee.rank ? ` · ${employee.rank}` : ''}</small>}
            {!employee.task && employee.state === 'away' && <small>자리 비움</small>}
            {!employee.task && employee.state !== 'away' && employee.rank && <small>{employee.rank}</small>}
          </span>
          <span className="office-desk" aria-hidden="true" style={{ left: x - at.x, top: y - at.y }} />
          <span className="office-chair" aria-hidden="true" style={{ left: x - at.x, top: y - at.y + 37 }} />
        </div>
      })}
      {scene && (scene.type === 'deliver' || scene.type === 'return') && (() => {
        const audit = { x: (departmentByKey.get('감사팀')!.x + 4) * TILE, y: (departmentByKey.get('감사팀')!.y + 2) * TILE }
        const origin = scene.type === 'deliver' ? deskPositions.get(scene.who) ?? audit : deskPositions.get(scene.from) ?? audit
        const destination = scene.type === 'deliver' ? audit : deskPositions.get(scene.to[0]) ?? audit
        const paperAt = sceneTraveling ? destination : origin
        return <div key={`${scene.type}-${motionKey}`} className={`office-paper office-paper--${scene.type}`} aria-label="이동 중인 서류" style={{ left: paperAt.x + 12, top: paperAt.y - 20 } as CSSProperties} />
      })()}
      {[...latestReviews.values()].map(({ review, count }) => {
        const desk = deskPositions.get(review.reviewer) ?? { x: (departmentByKey.get('감사팀')!.x + 2) * TILE, y: (departmentByKey.get('감사팀')!.y + 2) * TILE }
        const verdict = review.verdict === 'PASS' ? 'approve' : review.verdict === 'CHANGES_REQUIRED' ? 'reject' : 'pending'
        const label = verdict === 'approve' ? '승인' : verdict === 'reject' ? '반려' : '검토중'
        return <div key={`${review.round}-${review.reviewer}`} className={`office-stamp office-stamp--${verdict}`} style={{ left: desk.x + 8, top: desk.y - 35 }} data-reviewer={review.reviewer}>{label} <small>R{review.round}{count > 1 ? ` · ${count}회` : ''}</small></div>
      })}
      {scene?.type === 'stamp' && <span className="office-scene-live" role="status">{scene.reviewer} R{scene.round} {scene.verdict === 'CHANGES_REQUIRED' ? '반려 도장' : '승인 도장'}</span>}
    </div>
    </div>
    </div>
  </section>
}
