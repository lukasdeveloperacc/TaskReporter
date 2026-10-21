import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { AskView, RunView } from '../../shared/contract.ts'
import { buildOffice, characterFrame, diffScenes, fitOfficeScale, OFFICE_HEIGHT, OFFICE_WIDTH, seatPosition, type Scene } from './office.ts'
import { ELEVATOR_RECT, moveVisitor, nearestInteraction, roomGeometry, visitorSpriteBounds, VISITOR_SPAWN, type Direction, type Point } from './visitor.ts'
import { findVisitorPath, moveWithinArea, nearestDoor, roomKeyAt } from './roomNavigation.ts'
import { RoomMiniMap } from './RoomMiniMap.tsx'
import { EmployeeReport } from './EmployeeReport.tsx'
import roles from './roles.json' with { type: 'json' }
import './office.css'

export type OfficeFloor = { projectPath: string; name: string; floorNumber: number; status: string; disabled: boolean; current: boolean }
type VisitorPanel = { kind: 'elevator' } | { kind: 'employee'; owner: string; tab: 'current' | 'history' }
type WalkingDestination = { kind: 'employee'; owner: string } | { kind: 'elevator' } | { kind: 'room'; roomKey: string }
export type OfficeProps = { run: RunView; projectRuns?: RunView[]; asks: AskView[]; now: number; onOpenAsk: (id: string) => void; visitorEnabled?: boolean; floors?: OfficeFloor[]; onVisitProject?: (path: string) => boolean | void; interactionBlocked?: boolean; overviewOpen?: boolean; onOverviewOpenChange?: (open: boolean) => void }
const departmentByKey = new Map(roles.departments.map((department) => [department.key, department]))
const TILE = 48
const MAX_SCENES = 40
const BUBBLE_WIDTH = 148
const CEO_START: Point = { x: 122, y: 240 }
const isEditableKeyTarget = (target: EventTarget | null) => target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null

function Sprite({ frame, className = '' }: { frame: [number, number]; className?: string }) {
  const [col, row] = frame
  return <span aria-hidden="true" className={`sprite ${className}`} style={{ backgroundPosition: `${-col * 51}px ${-row * 51}px` }} />
}

export function Office({ run, projectRuns = [run], asks, now, onOpenAsk, visitorEnabled = true, floors = [], onVisitProject, interactionBlocked = false, overviewOpen: controlledOverviewOpen, onOverviewOpenChange }: OfficeProps) {
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
  const [localOverviewOpen, setLocalOverviewOpen] = useState(false)
  const overviewOpen = controlledOverviewOpen ?? localOverviewOpen
  const changeOverviewOpen = (open: boolean) => {
    onOverviewOpenChange?.(open)
    if (controlledOverviewOpen === undefined) setLocalOverviewOpen(open)
  }
  const [visitorPoint, setVisitorPoint] = useState<Point>(visitorEnabled ? VISITOR_SPAWN : CEO_START)
  const visitorPointRef = useRef(visitorPoint)
  visitorPointRef.current = visitorPoint
  const [walkingDestination, setWalkingDestination] = useState<WalkingDestination | null>(null)
  const walkingOwner = walkingDestination?.kind === 'employee' ? walkingDestination.owner : null
  const [visitorPaused, setVisitorPaused] = useState(false)
  const geometry = useMemo(() => roomGeometry(roles.departments), [])
  const [visitorPanel, setVisitorPanel] = useState<VisitorPanel | null>(null)
  const [visitorMessage, setVisitorMessage] = useState('')
  const [visitorMapHeight, setVisitorMapHeight] = useState<number | null>(null)
  const visitorFocusRef = useRef<HTMLButtonElement>(null)
  const visitorInspectorCloseRef = useRef<HTMLButtonElement>(null)
  const interactionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const restorePickerTriggerFocusRef = useRef(false)
  const focusFrameRef = useRef<number | undefined>(undefined)
  const [fitScale, setFitScale] = useState(1)
  const focusAllowedRef = useRef(false)
  focusAllowedRef.current = visitorEnabled && !interactionBlocked && visitorPanel === null
  const focusMap = () => {
    if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = undefined
      if (focusAllowedRef.current) floorRef.current?.focus({ preventScroll: true })
    })
  }
  useEffect(() => () => { if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current) }, [])
  useLayoutEffect(() => {
    if (!visitorEnabled || overviewOpen) { setVisitorMapHeight(null); return }
    const measure = () => {
      const floor = floorRef.current
      if (!floor) return
      const available = window.innerHeight - floor.getBoundingClientRect().top - 8
      setVisitorMapHeight(available > 0 ? available : Math.min(240, Math.max(0, window.innerHeight - 8)))
    }
    const measureOnPageScroll = (event: Event) => {
      const floor = floorRef.current
      const target = event.target
      if (floor && target instanceof Node && (target === floor || floor.contains(target))) return
      measure()
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measureOnPageScroll, true)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (floorRef.current) observer?.observe(floorRef.current)
    const panel = floorRef.current?.parentElement
    if (panel) observer?.observe(panel)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measureOnPageScroll, true)
      observer?.disconnect()
    }
  }, [visitorEnabled, overviewOpen, run.id])
  const targetRoomKey = walkingDestination?.kind === 'room' ? walkingDestination.roomKey : null
  const requestRoom = (roomKey: string) => {
    if (interactionBlocked || visitorPanel !== null || !geometry.rooms.some(({ key }) => key === roomKey)) return
    setVisitorMessage('')
    setVisitorPaused(false)
    setWalkingDestination({ kind: 'room', roomKey })
    if (visitorEnabled) focusMap()
  }
  const openAsk = (id: string) => {
    setWalkingDestination(null)
    restoreTriggerFocus.current = false
    if (visitorEnabled) setVisitorPaused(true)
    setVisitorPanel(null)
    changeOverviewOpen(false)
    onOpenAsk(id)
  }
  const toggleOverview = () => {
    setWalkingDestination(null)
    if (overviewOpen) {
      restoreTriggerFocus.current = !interactionBlocked
      setVisitorPanel(null)
      changeOverviewOpen(false)
    } else {
      setVisitorPanel(null)
      floorRef.current?.scrollTo({ left: 0, top: 0, behavior: 'instant' })
      changeOverviewOpen(true)
    }
    if (visitorEnabled && !visitorPaused && !interactionBlocked) focusMap()
  }

  useEffect(() => {
    if (!overviewOpen) {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const measure = () => {
      const floor = floorRef.current
      const width = floor?.clientWidth ?? 0
      const height = floor?.clientHeight ?? 0
      setFitScale(width && height ? Math.min(1, width / OFFICE_WIDTH, height / OFFICE_HEIGHT) : fitOfficeScale(window.innerWidth, window.innerHeight, toolbarRef.current?.getBoundingClientRect().height ?? 52))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (floorRef.current) observer?.observe(floorRef.current)
    const viewport = floorRef.current?.parentElement
    if (viewport) observer?.observe(viewport)
    const controls = floorRef.current?.closest('.office-panel')?.querySelector('.visitor-controls')
    if (controls) observer?.observe(controls)
    if (toolbarRef.current) observer?.observe(toolbarRef.current)
    if (visitorEnabled && !visitorPaused && !interactionBlocked) focusMap()
    else overviewTriggerRef.current?.focus()
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
      document.body.style.overflow = previousOverflow
    }
  }, [overviewOpen, visitorEnabled])
  useEffect(() => {
    if (overviewOpen) {
      if (visitorEnabled && !visitorPaused && !interactionBlocked) focusMap()
      return
    }
    if (visitorEnabled && !visitorPaused && !interactionBlocked) {
      restoreTriggerFocus.current = false
      focusMap()
    } else if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false
      overviewTriggerRef.current?.focus()
    }
  }, [overviewOpen, visitorEnabled, visitorPaused, interactionBlocked])

  const activeVisitors = visitorEnabled && !visitorPaused && !interactionBlocked && visitorPanel === null
  const walkingToElevator = walkingDestination?.kind === 'elevator'
  const cameraFollowVisitor = (activeVisitors || walkingDestination !== null) && !overviewOpen
  const elevatorOpen = visitorPanel?.kind === 'elevator'
  const firstAvailableFloor = floors.find((floor) => !floor.disabled && !floor.current)
  const inspectedOwner = visitorPanel?.kind === 'employee' ? visitorPanel.owner : null
  const employeeAnchors = office.employees.filter((employee) => employee.state !== 'gone').map((employee) => {
    const seat = seatPosition(departmentByKey.get(employee.department)!, employee.deskIndex)
    return { employee, point: { x: seat.x * TILE, y: seat.y * TILE } }
  })
  const inspectedEmployeeAvailable = inspectedOwner !== null && employeeAnchors.some(({ employee }) => employee.name === inspectedOwner)
  const inspectedTab = visitorPanel?.kind === 'employee' ? visitorPanel.tab : null
  const walkingEmployee = employeeAnchors.find(({ employee }) => employee.name === walkingOwner)
  const walkingEmployeeRoom = geometry.rooms.find(({ key }) => key === walkingEmployee?.employee.department)
  const walkingRoom = walkingDestination?.kind === 'room' ? geometry.rooms.find(({ key }) => key === walkingDestination.roomKey) : undefined
  const walkingTargetX = walkingToElevator ? ELEVATOR_RECT.x + ELEVATOR_RECT.width / 2
    : walkingDestination?.kind === 'room' && walkingRoom ? walkingRoom.x + walkingRoom.width / 2
      : walkingEmployee ? walkingEmployee.point.x + (visitorEnabled ? 0 : 24) : undefined
  const walkingTargetY = walkingToElevator ? ELEVATOR_RECT.y + ELEVATOR_RECT.height
    : walkingDestination?.kind === 'room' && walkingRoom ? walkingRoom.y + 72
      : walkingEmployee && walkingEmployeeRoom ? Math.min(walkingEmployee.point.y + (visitorEnabled ? 48 : 72), walkingEmployeeRoom.y + walkingEmployeeRoom.height - 24) : undefined
  useEffect(() => {
    if (walkingDestination === null) return
    if (interactionBlocked || visitorPanel !== null || walkingTargetX === undefined || walkingTargetY === undefined) {
      setWalkingDestination(null)
      return
    }
    const path = findVisitorPath(visitorPointRef.current, { x: walkingTargetX, y: walkingTargetY }, geometry)
    if (!path) {
      setWalkingDestination(null)
      const destinationName = walkingToElevator ? '엘리베이터' : walkingRoom?.name
      setVisitorMessage(destinationName ? `${destinationName}까지 가는 길을 찾을 수 없습니다.` : '직원에게 가는 길을 찾을 수 없습니다.')
      return
    }
    const arrive = () => {
      setVisitorPoint(path[path.length - 1])
      setWalkingDestination(null)
      if (walkingDestination.kind === 'elevator') setVisitorPanel({ kind: 'elevator' })
      else if (walkingDestination.kind === 'employee') setVisitorPanel({ kind: 'employee', owner: walkingDestination.owner, tab: 'current' })
    }
    if (path.length === 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      arrive()
      return
    }
    const duration = Math.min(900, Math.max(500, path.length * 12))
    let started: number | undefined
    let frame: number
    let lastIndex = 0
    const step = (time: number) => {
      started ??= time
      const progress = Math.min(1, (time - started) / duration)
      if (progress >= 1) { arrive(); return }
      const index = Math.floor(progress * (path.length - 1))
      if (index !== lastIndex) { setVisitorPoint(path[index]); lastIndex = index }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [walkingDestination, walkingToElevator, walkingOwner, walkingRoom, walkingTargetX, walkingTargetY, geometry, interactionBlocked, visitorPanel, run.id, visitorEnabled])
  const activeRoomKey = visitorEnabled ? roomKeyAt(visitorPoint, geometry) : null
  const doorInteraction = visitorEnabled && !overviewOpen ? nearestDoor(visitorPoint, geometry) : null
  const scopedEmployeeAnchors = overviewOpen
    ? employeeAnchors
    : employeeAnchors.filter(({ employee }) => employee.department === activeRoomKey)
  const nearestEmployee = visitorEnabled ? nearestInteraction(visitorPoint, scopedEmployeeAnchors.map(({ employee, point }) => ({ name: employee.name, point, employee }))) : null
  const elevatorTarget = { name: '엘리베이터', point: { x: ELEVATOR_RECT.x + ELEVATOR_RECT.width / 2, y: ELEVATOR_RECT.y + ELEVATOR_RECT.height } }
  const nearElevator = visitorEnabled && (overviewOpen || activeRoomKey === null) && nearestInteraction(visitorPoint, [elevatorTarget]) !== null
  const currentEmployee = nearestEmployee?.employee
  const currentInteraction = doorInteraction ? `${doorInteraction.kind === 'enter' ? 'door-enter' : 'door-exit'}:${doorInteraction.roomKey}` : nearElevator ? 'elevator' : currentEmployee?.name ?? null
  const visitorCanInteract = activeVisitors && currentInteraction !== null
  const move = (direction: Direction) => {
    if (!activeVisitors) return
    setWalkingDestination(null)
    setVisitorPoint((point) => overviewOpen ? moveVisitor(point, direction, geometry) : moveWithinArea(point, direction, geometry))
    setVisitorMessage('')
  }
  const interact = (tab: 'current' | 'history' = 'current') => {
    if (!visitorCanInteract) return
    interactionTriggerRef.current = null
    setWalkingDestination(null)
    if (doorInteraction && tab === 'current') {
      setVisitorPoint(doorInteraction.destination)
      setVisitorMessage(doorInteraction.kind === 'enter' ? `${geometry.rooms.find(({ key }) => key === doorInteraction.roomKey)?.name ?? '팀'} 입장` : '복도로 나왔습니다')
      return
    }
    if (nearElevator && tab === 'current') { setVisitorPanel({ kind: 'elevator' }); return }
    if (currentEmployee) { setVisitorPanel({ kind: 'employee', owner: currentEmployee.name, tab }); return }
  }
  const closeVisitorPanel = (restore = true, preferTrigger = false) => {
    if (restore && preferTrigger) restorePickerTriggerFocusRef.current = true
    setVisitorPanel(null)
    if (restore && !interactionBlocked) {
      if (preferTrigger) return
      if (visitorEnabled) focusMap()
      else if (interactionTriggerRef.current?.isConnected && !interactionTriggerRef.current.disabled) interactionTriggerRef.current.focus({ preventScroll: true })
      else floorRef.current?.focus({ preventScroll: true })
    }
  }
  const onMapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || interactionBlocked) return
    if (event.key === 'Escape' && walkingDestination !== null && !isEditableKeyTarget(event.target)) { event.preventDefault(); event.stopPropagation(); setWalkingDestination(null); return }
    if (event.target !== event.currentTarget || !visitorEnabled) return
    const keyDirections: Record<string, Direction> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' }
    const direction = keyDirections[event.code] ?? (event.code ? undefined : ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as Record<string, Direction>)[event.key])
    if (direction) { if (!visitorPaused && !visitorPanel) { event.preventDefault(); move(direction) }; return }
    if (event.code === 'Space' || event.key === ' ') {
      if (!visitorPanel && !event.repeat) { event.preventDefault(); setWalkingDestination(null); const resume = visitorPaused; setVisitorPaused(!visitorPaused); if (resume) focusMap() }
      return
    }
    if (event.code === 'KeyF' || event.key.toLowerCase() === 'f') { if (!visitorPanel && !event.repeat) { event.preventDefault(); toggleOverview() }; return }
    if ((event.code === 'KeyJ' || event.key.toLowerCase() === 'j') && !event.repeat && visitorCanInteract && currentEmployee) { event.preventDefault(); interact('history'); return }
    if (event.key === 'Escape' && visitorPanel) { event.preventDefault(); event.stopPropagation(); closeVisitorPanel(false); return }
    if (event.key === 'Escape' && !visitorPaused && !overviewOpen) { event.preventDefault(); setVisitorPaused(true); return }
    if ((event.key === 'Enter' || event.key.toLowerCase() === 'e') && visitorCanInteract && !event.repeat) { event.preventDefault(); interact() }
  }

  const handleOfficeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !visitorEnabled || overviewOpen || interactionBlocked || visitorPanel !== null || walkingDestination === null || isEditableKeyTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    setWalkingDestination(null)
  }

  useEffect(() => {
    setWalkingDestination(null)
    setVisitorPoint(visitorEnabled ? VISITOR_SPAWN : CEO_START)
    if (!visitorEnabled) { setVisitorPaused(false); setVisitorPanel(null); return }
    setVisitorPaused(false)
    setVisitorPanel(null)
    focusMap()
  }, [run.id, visitorEnabled])
  useEffect(() => {
    if (elevatorOpen) {
      visitorFocusRef.current?.focus({ preventScroll: true })
      return
    }
    if (!restorePickerTriggerFocusRef.current) return
    restorePickerTriggerFocusRef.current = false
    const trigger = interactionTriggerRef.current
    if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true })
    else if (visitorEnabled) focusMap()
    else floorRef.current?.focus({ preventScroll: true })
  }, [elevatorOpen, firstAvailableFloor?.projectPath])
  useEffect(() => {
    if (!cameraFollowVisitor) return
    const frame = requestAnimationFrame(() => {
      const floor = floorRef.current
      if (!floor) return
      const bounds = visitorSpriteBounds(visitorPoint)
      floor.scrollTo({ left: Math.max(0, Math.min(bounds.left + bounds.width / 2 - floor.clientWidth / 2, floor.scrollWidth - floor.clientWidth)), top: Math.max(0, Math.min(bounds.top + bounds.height / 2 - floor.clientHeight / 2, floor.scrollHeight - floor.clientHeight)), behavior: 'instant' })
    })
    return () => cancelAnimationFrame(frame)
  }, [cameraFollowVisitor, visitorPoint, visitorMapHeight, run.id])
  useEffect(() => {
    if (!interactionBlocked) return
    setWalkingDestination(null)
    setVisitorPanel(null)
    setVisitorPaused(true)
    restoreTriggerFocus.current = false
    if (overviewOpen) changeOverviewOpen(false)
  }, [interactionBlocked, visitorPanel, overviewOpen])
  useEffect(() => {
    if (!cameraFollowVisitor) return
    const recenter = () => {
      const floor = floorRef.current
      if (!floor) return
      const bounds = visitorSpriteBounds(visitorPoint)
      floor.scrollTo({ left: Math.max(0, Math.min(bounds.left + bounds.width / 2 - floor.clientWidth / 2, floor.scrollWidth - floor.clientWidth)), top: Math.max(0, Math.min(bounds.top + bounds.height / 2 - floor.clientHeight / 2, floor.scrollHeight - floor.clientHeight)), behavior: 'instant' })
    }
    window.addEventListener('resize', recenter)
    return () => window.removeEventListener('resize', recenter)
  }, [cameraFollowVisitor, visitorPoint, visitorMapHeight])
  useEffect(() => {
    if (interactionBlocked || inspectedOwner === null) return
    if (!inspectedEmployeeAvailable) {
      visitorInspectorCloseRef.current?.focus({ preventScroll: true })
      return
    }
    document.getElementById(`employee-report-tab-${inspectedTab ?? 'current'}`)?.focus({ preventScroll: true })
  }, [visitorEnabled, interactionBlocked, inspectedOwner, inspectedEmployeeAvailable, inspectedTab])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (walkingDestination !== null) { event.preventDefault(); event.stopPropagation(); setWalkingDestination(null); return }
      if (visitorPanel !== null) { event.preventDefault(); event.stopPropagation(); closeVisitorPanel(); return }
      event.preventDefault()
      restoreTriggerFocus.current = !interactionBlocked
      changeOverviewOpen(false)
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

  const handlePickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      const first = buttons[0]
      const last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      event.stopPropagation()
      return
    }

    // The picker owns its keyboard input so it cannot reach overview or map shortcuts.
    event.stopPropagation()
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeVisitorPanel(true, true)
      return
    }

    const navigation = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[event.key]
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    if (navigation !== undefined && buttons.length) {
      event.preventDefault()
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const nextIndex = currentIndex < 0
        ? (navigation > 0 ? 0 : buttons.length - 1)
        : (currentIndex + navigation + buttons.length) % buttons.length
      buttons[nextIndex]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus()
    }
  }

  const stageStyle = overviewOpen
    ? { width: OFFICE_WIDTH * fitScale, height: OFFICE_HEIGHT * fitScale }
    : { width: OFFICE_WIDTH, height: OFFICE_HEIGHT }
  const mapStyle = overviewOpen ? { transform: `scale(${fitScale})` } : undefined

  return <section className={`office-panel${overviewOpen ? ' office-panel--expanded' : ''}`} aria-label={`${run.title} 사무실`} role={overviewOpen ? 'dialog' : undefined} aria-modal={overviewOpen || undefined} onKeyDown={overviewOpen ? handleDialogKeyDown : handleOfficeKeyDown}>
    <nav ref={toolbarRef} className="office-department-nav" aria-label="사무실 구역 바로가기">
      <button ref={overviewTriggerRef} type="button" className="office-overview-toggle" onClick={toggleOverview} disabled={interactionBlocked || visitorPanel !== null}>{overviewOpen ? '전체 보기 닫기' : '전체 보기'}</button>
      {roles.departments.map((department, index) => <button key={department.key} type="button" aria-controls={`office-room-${index}`} onClick={() => requestRoom(department.key)} disabled={interactionBlocked || visitorPanel !== null}>{department.name}</button>)}
    </nav>
    {visitorEnabled && <div className={`visitor-controls${overviewOpen ? ' visitor-controls--overview' : ''}`} aria-label="둘러보기 조작 · 방향키/WASD 이동 · E/Enter 실행 · Space 일시정지">
      <div className="visitor-directions"><button type="button" aria-label="위로 이동" onClick={() => move('up')} disabled={!activeVisitors}>↑</button><button type="button" aria-label="왼쪽으로 이동" onClick={() => move('left')} disabled={!activeVisitors}>←</button><button type="button" aria-label="아래로 이동" onClick={() => move('down')} disabled={!activeVisitors}>↓</button><button type="button" aria-label="오른쪽으로 이동" onClick={() => move('right')} disabled={!activeVisitors}>→</button></div>
      <button type="button" onKeyDown={(event) => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault() }} onClick={() => interact()} disabled={!visitorCanInteract}>{overviewOpen ? '살펴보기' : doorInteraction ? `${doorInteraction.kind === 'enter' ? '입장' : '퇴장'} · ${geometry.rooms.find(({ key }) => key === doorInteraction.roomKey)?.name ?? '팀'}` : `살펴보기 · ${currentInteraction === 'elevator' ? '엘리베이터' : currentInteraction ?? '주변'}`}</button>
      <button type="button" onClick={() => { setWalkingDestination(null); const resume = visitorPaused; setVisitorPaused(!visitorPaused); if (resume) focusMap() }} disabled={visitorPanel !== null || interactionBlocked}>{visitorPaused ? '둘러보기 재개' : '잠시 멈춤'}</button>
      {visitorMessage && <span role="status">{visitorMessage}</span>}
    </div>}
    {walkingDestination !== null && <span className="office-walk-status" role="status">{walkingToElevator ? '엘리베이터로 이동 중…' : walkingRoom ? `${walkingRoom.name} 방으로 이동 중…` : `${walkingOwner}에게 이동 중…`}</span>}
    {!visitorEnabled && visitorMessage && <span role="status">{visitorMessage}</span>}
    <div className={`office-viewport${overviewOpen ? ' office-viewport--overview' : ''}`}>
    <div id="office-floor-scroll" ref={floorRef} className={`office-scroll${overviewOpen ? ' office-scroll--overview' : ''}${visitorEnabled ? ' office-scroll--visitor' : ''}`} style={visitorEnabled && !overviewOpen && visitorMapHeight !== null ? { maxHeight: visitorMapHeight } : undefined} role="region" aria-label={`${run.title} 사무실 바닥`} tabIndex={0} onKeyDown={onMapKeyDown}>
    <div className="office-map-stage" style={stageStyle} data-fit-scale={overviewOpen ? fitScale : 1}>
    <div className={`office-scene${run.ended_at ? ' office-scene--off' : ''}${visitorEnabled && !overviewOpen ? activeRoomKey ? ' office-scene--room' : ' office-scene--corridor' : ''}`} data-run-id={run.id} data-active-room={activeRoomKey ?? undefined} style={mapStyle} onClick={(event) => { if (!visitorEnabled || visitorPaused || interactionBlocked || visitorPanel !== null) return; const target = event.target; if (target instanceof Element && target.closest('button, input, select, textarea, [contenteditable="true"]')) return; focusMap() }}>
      {(overviewOpen || activeRoomKey === null) && <button type="button" className="office-elevator" aria-haspopup="dialog" disabled={interactionBlocked || visitorPanel !== null} onClick={(event) => {
        interactionTriggerRef.current = event.currentTarget
        if (visitorPanel !== null) return
        if (walkingDestination?.kind === 'elevator') return
        setVisitorMessage('')
        setVisitorPaused(false)
        setWalkingDestination({ kind: 'elevator' })
        if (visitorEnabled) focusMap()
      }} style={{ left: ELEVATOR_RECT.x, top: ELEVATOR_RECT.y, width: ELEVATOR_RECT.width, height: ELEVATOR_RECT.height }}><span>엘리베이터</span><small>층간 이동</small></button>}
      {roles.departments.map((department, index) => { const room = geometry.rooms[index]; const visibleInterior = overviewOpen || !visitorEnabled || activeRoomKey === department.key; return <section key={department.key} id={`office-room-${index}`} className={`office-room${activeRoomKey === department.key ? ' office-room--active' : ''}`} aria-label={department.name} style={{ left: room.x, top: room.y, width: room.width, height: room.height, '--room-color': department.color, '--door-left': `${room.door.from.x - room.x}px`, '--door-width': `${room.door.to.x - room.door.from.x}px` } as CSSProperties}>
        <h3><button type="button" aria-label={`${department.name} 지도 구역`} onClick={() => requestRoom(department.key)} disabled={!visitorEnabled || interactionBlocked || visitorPanel !== null}>{department.name}</button></h3>
        {visibleInterior && department.key === '대표실' && asks.filter((ask) => ask.run_id === run.id && ask.status === 'pending').map((ask) => <button className="office-ask" key={ask.id} onClick={() => openAsk(ask.id)}><span>결재 서류</span><strong>{ask.question}</strong></button>)}
        {visibleInterior && department.key === '대표실' && <span className="office-plant" aria-hidden="true" />}
        {visitorEnabled && <button type="button" className="office-door-sign" aria-label={`${department.name} 방으로 이동`} title={`${department.name} 방으로 이동`} disabled={interactionBlocked || visitorPanel !== null} onClick={() => requestRoom(department.key)}>↓ {department.name} 방으로 이동</button>}
      </section>})}
      <div className={`office-representative${walkingDestination !== null ? ' office-representative--walking' : ''}`} data-office-role="representative" role="img" aria-label="대표 · 나, 대표 캐릭터" style={visitorSpriteBounds(visitorPoint)}>
        <Sprite frame={characterFrame('대표 · 나')} className="office-person" />
        <span className="office-name">대표 · 나</span>
      </div>
      {office.employees.filter((employee) => overviewOpen || !visitorEnabled || employee.department === activeRoomKey).map((employee) => {
        const todos = run.state.tasks?.find((task) => task.id === employee.task?.id)?.todos
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
        const at = visitorEnabled ? { x: position.x - 26, y: position.y - 48 }
          : walkingOwner === employee.name || inspectedOwner === employee.name ? position
          : walkers.has(employee.name)
          ? { x: 13 * TILE + (office.employees.findIndex(({ name }) => name === employee.name) % 6) * 56, y: 13 * TILE + Math.floor(office.employees.findIndex(({ name }) => name === employee.name) / 6) * 56 }
          : travelsThisScene && sceneTraveling ? travelTarget : isWorking || employee.state === 'away' || travelsThisScene ? position : parked
        return <button type="button" key={employee.name} className={`office-employee office-employee--${employee.state}${visitorEnabled ? ' office-employee--visitor' : ''}${walkingOwner === employee.name ? ' office-employee--destination' : ''}`} data-employee={employee.name} data-state={employee.state} aria-label={`${employee.name === 'leader' ? '부장 · leader' : employee.name} 현재 업무 보기`} aria-haspopup="dialog" disabled={employee.state === 'gone' || interactionBlocked || visitorPanel !== null} onClick={(event) => {
          if (visitorPanel !== null) return
          if (walkingDestination?.kind === 'employee' && walkingDestination.owner === employee.name) return
          interactionTriggerRef.current = event.currentTarget
          setVisitorMessage('')
          setVisitorPaused(false)
          setWalkingDestination({ kind: 'employee', owner: employee.name })
          if (visitorEnabled) focusMap()
        }} style={{ left: at.x, top: at.y, '--employee-color': desk.color, '--walk-key': motionKey } as CSSProperties}>
          <Sprite frame={employee.frame} className="office-person" />
          <span className="office-bubble office-bubble--staff" title={`${employee.name}${employee.task ? ` · ${employee.task.title}` : ''} · 모델 ${employee.model ?? '미보고'} · 노력 ${employee.effort ?? '미보고'}`} style={{ '--bubble-width': `${BUBBLE_WIDTH}px`, maxHeight: 120 } as CSSProperties}>
            <span className="office-name">{employee.name === 'leader' ? '부장 · leader' : `${employee.name}${employee.rank ? ` · ${employee.rank}` : ''}`}</span>
            {employee.task && <strong className="office-task-title" title={employee.task.title}>{employee.task.title}</strong>}
            {todos?.length ? <small className="office-todo-progress">TODO {todos.filter((todo) => todo.done).length}/{todos.length}</small> : null}
            <strong className="office-model-line">모델 · {employee.model ?? '미보고'}</strong>
            <strong className="office-effort-line">노력 · {employee.effort ?? '미보고'}</strong>
            {employee.task && <small>{employee.state === 'away' ? '자리 비움 · ' : ''}{employee.task.elapsedMin}분{employee.rank ? ` · ${employee.rank}` : ''}</small>}
            {!employee.task && employee.state === 'away' && <small>자리 비움</small>}
            {!employee.task && employee.state !== 'away' && employee.rank && <small>{employee.rank}</small>}
          </span>
          <span className="office-desk" aria-hidden="true" style={{ left: x - at.x, top: y - at.y }} />
          <span className="office-chair" aria-hidden="true" style={{ left: x - at.x, top: y - at.y + 37 }} />
        </button>
      })}
      {(overviewOpen || !visitorEnabled || activeRoomKey !== null) && scene && (scene.type === 'deliver' || scene.type === 'return') && (() => {
        const audit = { x: (departmentByKey.get('감사팀')!.x + 4) * TILE, y: (departmentByKey.get('감사팀')!.y + 2) * TILE }
        const origin = scene.type === 'deliver' ? deskPositions.get(scene.who) ?? audit : deskPositions.get(scene.from) ?? audit
        const destination = scene.type === 'deliver' ? audit : deskPositions.get(scene.to[0]) ?? audit
        const paperAt = sceneTraveling ? destination : origin
        if (visitorEnabled && !overviewOpen && activeRoomKey !== roomKeyAt({ x: paperAt.x + 24, y: paperAt.y + 24 }, geometry)) return null
        return <div key={`${scene.type}-${motionKey}`} className={`office-paper office-paper--${scene.type}`} aria-label="이동 중인 서류" style={{ left: paperAt.x + 12, top: paperAt.y - 20 } as CSSProperties} />
      })()}
      {[...latestReviews.values()].filter(({ review }) => overviewOpen || !visitorEnabled || office.employees.find(({ name }) => name === review.reviewer)?.department === activeRoomKey).map(({ review, count }) => {
        const desk = deskPositions.get(review.reviewer) ?? { x: (departmentByKey.get('감사팀')!.x + 2) * TILE, y: (departmentByKey.get('감사팀')!.y + 2) * TILE }
        const verdict = review.verdict === 'PASS' ? 'approve' : review.verdict === 'CHANGES_REQUIRED' ? 'reject' : 'pending'
        const label = verdict === 'approve' ? '승인' : verdict === 'reject' ? '반려' : '검토중'
        return <div key={`${review.round}-${review.reviewer}`} className={`office-stamp office-stamp--${verdict}`} style={{ left: desk.x + 8, top: desk.y - 35 }} data-reviewer={review.reviewer}>{label} <small>R{review.round}{count > 1 ? ` · ${count}회` : ''}</small></div>
      })}
      {scene?.type === 'stamp' && <span className="office-scene-live" role="status">{scene.reviewer} R{scene.round} {scene.verdict === 'CHANGES_REQUIRED' ? '반려 도장' : '승인 도장'}</span>}
      {visitorEnabled && <span className="office-scene-live" role="status">{visitorPaused ? '둘러보기 일시정지' : nearElevator ? '엘리베이터 근처' : currentEmployee ? `${currentEmployee.name} 근처` : ''}</span>}
    </div>
    </div>
    </div>
    {visitorEnabled && <RoomMiniMap geometry={geometry} point={visitorPoint} activeRoomKey={activeRoomKey} targetRoomKey={overviewOpen ? null : targetRoomKey} />}
    </div>
    {elevatorOpen && <div className="visitor-picker" role="dialog" aria-modal="true" aria-label="다른 프로젝트 층 선택" onKeyDown={handlePickerKeyDown}>
      <h2>어느 층으로 갈까요?</h2><p className="visitor-picker__help">↑/↓ 층 이동 · Home/End 처음/끝 · Enter 선택 · Esc 닫기</p><button type="button" onClick={() => closeVisitorPanel(true, true)}>닫기</button>
      {visitorMessage && <p role="alert">{visitorMessage}</p>}
      {floors.map((floor) => <button key={floor.projectPath} ref={floor === firstAvailableFloor ? visitorFocusRef : undefined} type="button" disabled={floor.disabled || floor.current} onClick={() => { const moved = onVisitProject?.(floor.projectPath); if (moved === false) setVisitorMessage('해당 프로젝트 층을 사용할 수 없습니다. 최신 보고 상태를 확인해 주세요.'); else closeVisitorPanel(true, true) }}>{floor.floorNumber}층 · {floor.name} · {floor.status}{floor.current ? ' · 현재 층' : ''}</button>)}
      <button ref={firstAvailableFloor ? undefined : visitorFocusRef} type="button" onClick={() => { setVisitorPanel(null); window.location.hash = '#/' }}>빌딩 로비로 돌아가기</button>
    </div>}
    {inspectedOwner !== null && <div className="visitor-inspector-backdrop"><aside className="visitor-inspector" role="dialog" aria-modal="true" aria-label="직원 업무 살펴보기" onKeyDown={(event) => {
      if (event.key === 'Tab') {
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), summary, [tabindex="0"]')]
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeVisitorPanel(); return }
      if (event.key !== 'Enter' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
      const target = event.target
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return
      const reportTab = target.closest('[role="tab"]')
      const reportContent = target.closest('[role="tabpanel"]')
      if (!reportTab && !reportContent || target.closest('button:not([role="tab"]), a, input, textarea, select, summary')) return
      event.preventDefault()
      event.stopPropagation()
      if (visitorPanel?.kind === 'employee' && visitorPanel.tab === 'current') {
        setVisitorPanel({ ...visitorPanel, tab: 'history' })
      } else closeVisitorPanel()
    }}>
      {(() => { const selected = employeeAnchors.find(({ employee }) => employee.name === inspectedOwner)?.employee; return selected ? <><h2>{selected.name} 업무</h2><p>부서 · {selected.department}</p><p>상태 · {selected.state === 'away' ? '자리 비움' : selected.state === 'gone' ? '업무 종료' : '근무 중'}</p><p className="visitor-inspector__help">Enter 기록 → Enter 닫고 계속 · Esc 닫기</p><EmployeeReport owner={inspectedOwner} runs={projectRuns} currentRunId={run.id} tab={visitorPanel?.kind === 'employee' ? visitorPanel.tab : 'current'} onTabChange={(tab) => setVisitorPanel((panel) => panel?.kind === 'employee' ? { ...panel, tab } : panel)} now={now} /></> : <><h2>직원을 찾을 수 없습니다</h2><p>최신 보고에서 해당 직원이 사라졌습니다.</p></> })()}
      <button ref={visitorInspectorCloseRef} type="button" onClick={() => closeVisitorPanel()}>닫기</button>
    </aside></div>}
  </section>
}
