import type { DepartmentLayout } from './office.ts'
import { OFFICE_HEIGHT, OFFICE_WIDTH } from './office.ts'

/** Foot point in office pixels. The visual wrapper is wider/taller than its collision footprint. */
export type Point = { x: number; y: number }
export type SpriteBounds = { left: number; top: number; width: number; height: number }
export type Direction = 'up' | 'down' | 'left' | 'right'
export const VISITOR_SPAWN: Point = { x: 168, y: 1440 }
export const VISITOR_FOOT_RADIUS = 12
export const VISITOR_WALL_MARGIN = 5
export const VISITOR_STEP = 24
export const INTERACTION_RADIUS = 120
export const ELEVATOR_RECT = { x: 96, y: 1296, width: 144, height: 96 }

/** Converts the foot anchor to the existing 52×65 representative wrapper bounds. */
export function visitorSpriteBounds(point: Point): SpriteBounds {
  return { left: point.x - 26, top: point.y - 48, width: 52, height: 65 }
}

export type Segment = { from: Point; to: Point }
export type Room = { key: string; name: string; x: number; y: number; width: number; height: number; door: Segment }
export type RoomGeometry = { rooms: Room[]; walls: Segment[]; width: number; height: number }
export type InteractionTarget = { name: string; point: Point; [key: string]: unknown }

const px = 48

/** Produces visible room outlines and collision walls from the same 48px-unit department layout. */
export function roomGeometry(departments: DepartmentLayout[]): RoomGeometry {
  const rooms = departments.map((department) => {
    const x = department.x * px
    const y = department.y * px
    const width = department.w * px
    const height = department.h * px
    const center = x + width / 2
    const gap = 96
    return { key: department.key, name: department.name, x, y, width, height,
      door: { from: { x: center - gap / 2, y: y + height }, to: { x: center + gap / 2, y: y + height } } }
  })
  const walls: Segment[] = []
  for (const room of rooms) {
    const { x, y, width, height, door } = room
    walls.push(
      { from: { x, y }, to: { x: x + width, y } },
      { from: { x, y }, to: { x, y: y + height } },
      { from: { x: x + width, y }, to: { x: x + width, y: y + height } },
      { from: { x, y: y + height }, to: { x: door.from.x, y: y + height } },
      { from: { x: door.to.x, y: y + height }, to: { x: x + width, y: y + height } },
    )
  }
  return { rooms, walls, width: OFFICE_WIDTH, height: Math.max(OFFICE_HEIGHT, ...rooms.map((room) => room.y + room.height + 64)) }
}

function crossesWall(from: Point, to: Point, wall: Segment): boolean {
  const vertical = wall.from.x === wall.to.x
  const clearance = VISITOR_FOOT_RADIUS + VISITOR_WALL_MARGIN
  const fixed = vertical ? wall.from.x : wall.from.y
  const wallMin = Math.min(vertical ? wall.from.y : wall.from.x, vertical ? wall.to.y : wall.to.x)
  const wallMax = Math.max(vertical ? wall.from.y : wall.from.x, vertical ? wall.to.y : wall.to.x)
  if (vertical ? from.y === to.y : from.x === to.x) {
    const along = vertical ? from.y : from.x
    if (along < wallMin - clearance || along > wallMax + clearance) return false
    const before = (vertical ? from.x : from.y) - fixed
    const after = (vertical ? to.x : to.y) - fixed
    return before * after <= 0 || (Math.abs(after) < clearance && Math.abs(after) < Math.abs(before))
  }

  const across = vertical ? from.x : from.y
  if (Math.abs(across - fixed) > clearance) return false
  const start = vertical ? from.y : from.x
  const end = vertical ? to.y : to.x
  const low = wallMin - clearance
  const high = wallMax + clearance
  const startInside = start >= low && start <= high
  const endInside = end >= low && end <= high
  return (!startInside && endInside) || (start < low && end > high) || (start > high && end < low)
}

export function moveVisitor(point: Point, direction: Direction, geometry: RoomGeometry): Point {
  const delta: Record<Direction, Point> = { up: { x: 0, y: -VISITOR_STEP }, down: { x: 0, y: VISITOR_STEP }, left: { x: -VISITOR_STEP, y: 0 }, right: { x: VISITOR_STEP, y: 0 } }
  const next = { x: point.x + delta[direction].x, y: point.y + delta[direction].y }
  const bounds = visitorSpriteBounds(next)
  if (bounds.left < 0 || bounds.left + bounds.width > geometry.width || bounds.top < 0 || bounds.top + bounds.height > geometry.height) return point
  return geometry.walls.some((wall) => crossesWall(point, next, wall)) ? point : next
}

export function nearestInteraction<T extends InteractionTarget>(point: Point, targets: T[]): T | null {
  return targets.filter(({ point: target }) => Math.hypot(target.x - point.x, target.y - point.y) <= INTERACTION_RADIUS)
    .sort((a, b) => Math.hypot(a.point.x - point.x, a.point.y - point.y) - Math.hypot(b.point.x - point.x, b.point.y - point.y) || a.name.localeCompare(b.name, 'ko'))[0] ?? null
}
