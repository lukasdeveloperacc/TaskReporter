import {
  moveVisitor,
  visitorSpriteBounds,
  type Direction,
  type Point,
  type RoomGeometry,
} from './visitor.ts'

export function roomKeyAt(point: Point, geometry: RoomGeometry): string | null {
  const room = geometry.rooms.find(({ x, y, width, height }) =>
    point.x > x && point.x < x + width && point.y > y && point.y < y + height,
  )
  return room?.key ?? null
}

export function moveWithinArea(point: Point, direction: Direction, geometry: RoomGeometry): Point {
  const next = moveVisitor(point, direction, geometry)
  return roomKeyAt(next, geometry) === roomKeyAt(point, geometry) ? next : point
}

export function nearestDoor(
  point: Point,
  geometry: RoomGeometry,
): { roomKey: string; kind: 'enter' | 'exit'; destination: Point } | null {
  if (!isInsideWorld(point, geometry)) return null
  const currentRoomKey = roomKeyAt(point, geometry)
  const doors = geometry.rooms.flatMap((room) => {
    const midpoint = { x: (room.door.from.x + room.door.to.x) / 2, y: room.door.from.y }
    const horizontalMin = Math.min(room.door.from.x, room.door.to.x) + 17
    const horizontalMax = Math.max(room.door.from.x, room.door.to.x) - 17
    if (point.x < horizontalMin || point.x > horizontalMax || Math.hypot(point.x - midpoint.x, point.y - midpoint.y) > 48) return []

    let kind: 'enter' | 'exit'
    let destination: Point
    if (currentRoomKey === room.key && point.y < midpoint.y) {
      kind = 'exit'
      destination = { x: midpoint.x, y: midpoint.y + 24 }
    } else if (currentRoomKey === null && point.y >= midpoint.y) {
      kind = 'enter'
      destination = { x: midpoint.x, y: midpoint.y - 24 }
    } else {
      return []
    }

    return [{ room, kind, destination }]
  })

  const nearest = doors.sort((a, b) =>
    Math.hypot(a.room.door.from.x - point.x, a.room.door.from.y - point.y)
      - Math.hypot(b.room.door.from.x - point.x, b.room.door.from.y - point.y),
  )[0]
  if (!nearest || !isInsideWorld(nearest.destination, geometry)) return null
  return { roomKey: nearest.room.key, kind: nearest.kind, destination: nearest.destination }
}

function isInsideWorld(point: Point, geometry: RoomGeometry): boolean {
  const bounds = visitorSpriteBounds(point)
  return bounds.left >= 0
    && bounds.top >= 0
    && bounds.left + bounds.width <= geometry.width
    && bounds.top + bounds.height <= geometry.height
}
