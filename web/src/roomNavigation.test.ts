import { describe, expect, it } from 'vitest'
import roles from './roles.json' with { type: 'json' }
import { moveVisitor, roomGeometry, VISITOR_SPAWN, type Direction, type Point, type RoomGeometry } from './visitor.ts'
import { findVisitorPath, moveWithinArea, nearestDoor, roomKeyAt } from './roomNavigation.ts'

const geometry = roomGeometry(roles.departments)
const directions: Direction[] = ['up', 'down', 'left', 'right']

function reachableInArea(start: Point, geometry: RoomGeometry): Set<string> {
  const area = roomKeyAt(start, geometry)
  const queue = [start]
  const visited = new Set([`${start.x},${start.y}`])
  while (queue.length) {
    const point = queue.shift()!
    for (const direction of directions) {
      const next = moveWithinArea(point, direction, geometry)
      const key = `${next.x},${next.y}`
      if (roomKeyAt(next, geometry) === area && !visited.has(key)) {
        visited.add(key)
        queue.push(next)
      }
    }
  }
  return visited
}

describe('room navigation', () => {
  it('finds wall-safe routes to every room from spawn, an off-grid CEO seat, and another room', () => {
    const starts = [VISITOR_SPAWN, { x: 122, y: 192 }, { x: 1104, y: 528 }]
    for (const start of starts) {
      for (const room of geometry.rooms) {
        const target = { x: room.x + 48, y: room.y + 144 }
        const path = findVisitorPath(start, target, geometry)
        expect(path, `${JSON.stringify(start)} to ${room.name}`).not.toBeNull()
        expect(path![0]).toEqual(start)
        const end = path!.at(-1)!
        expect(roomKeyAt(end, geometry)).toBe(room.key)
        expect(Math.hypot(end.x - target.x, end.y - target.y)).toBeLessThanOrEqual(24)
        for (let index = 1; index < path!.length; index++) {
          expect(directions.some((direction) => {
            const next = moveVisitor(path![index - 1], direction, geometry)
            return next.x === path![index].x && next.y === path![index].y
          })).toBe(true)
        }
      }
    }
  })

  it('returns the current point when already at the destination', () => {
    expect(findVisitorPath(VISITOR_SPAWN, VISITOR_SPAWN, geometry)).toEqual([VISITOR_SPAWN])
  })

  it('returns null for unreachable or out-of-bounds destinations', () => {
    const room = geometry.rooms[0]
    const sealed = { ...geometry, walls: [...geometry.walls, room.door] }
    expect(findVisitorPath(VISITOR_SPAWN, { x: room.x + 48, y: room.y + 144 }, sealed)).toBeNull()
    expect(findVisitorPath(VISITOR_SPAWN, { x: -1, y: 100 }, geometry)).toBeNull()
  })

  it('treats only strict room interiors as rooms', () => {
    const room = geometry.rooms[0]
    expect(roomKeyAt({ x: room.x + 1, y: room.y + 1 }, geometry)).toBe(room.key)
    expect(roomKeyAt({ x: room.x, y: room.y + 1 }, geometry)).toBeNull()
    expect(roomKeyAt({ x: room.x + room.width, y: room.y + 1 }, geometry)).toBeNull()
    expect(roomKeyAt({ x: room.x + 1, y: room.y + room.height }, geometry)).toBeNull()
  })

  it('keeps normal movement in the current area while raw movement retains door walking', () => {
    const room = geometry.rooms[3]
    const outside = { x: (room.door.from.x + room.door.to.x) / 2, y: room.door.from.y + 24 }
    const inside = { x: outside.x, y: room.door.from.y - 24 }
    expect(moveVisitor(moveVisitor(outside, 'up', geometry), 'up', geometry)).toEqual(inside)
    const corridorBoundary = moveWithinArea(outside, 'up', geometry)
    expect(roomKeyAt(corridorBoundary, geometry)).toBeNull()
    expect(moveWithinArea(corridorBoundary, 'up', geometry)).toEqual(corridorBoundary)
    expect(moveWithinArea(inside, 'down', geometry)).toEqual(inside)
    expect(moveWithinArea(inside, 'left', geometry)).toEqual(moveVisitor(inside, 'left', geometry))
  })

  it('offers enter and exit transitions for all ten doors and keeps both destinations in bounds', () => {
    expect(geometry.rooms).toHaveLength(10)
    for (const room of geometry.rooms) {
      const x = (room.door.from.x + room.door.to.x) / 2
      const outside = { x, y: room.door.from.y + 24 }
      const inside = { x, y: room.door.from.y - 24 }
      expect(nearestDoor(outside, geometry)).toEqual({ roomKey: room.key, kind: 'enter', destination: inside })
      expect(nearestDoor(inside, geometry)).toEqual({ roomKey: room.key, kind: 'exit', destination: outside })
    }
  })

  it('limits activation by doorway clearance, side, and midpoint distance', () => {
    const room = geometry.rooms[3]
    const midpointX = (room.door.from.x + room.door.to.x) / 2
    const doorY = room.door.from.y
    expect(nearestDoor({ x: midpointX + 32, y: doorY + 24 }, geometry)).toBeNull()
    expect(nearestDoor({ x: midpointX, y: doorY + 49 }, geometry)).toBeNull()
    expect(nearestDoor({ x: midpointX, y: doorY }, geometry)).toEqual({
      roomKey: room.key,
      kind: 'enter',
      destination: { x: midpointX, y: doorY - 24 },
    })
  })

  it('enters from the reachable corridor threshold and exits back outside', () => {
    const room = geometry.rooms[3]
    const outside = { x: (room.door.from.x + room.door.to.x) / 2, y: room.door.from.y + 24 }
    const threshold = moveWithinArea(outside, 'up', geometry)
    expect(threshold).toEqual({ x: outside.x, y: room.door.from.y })
    const entered = nearestDoor(threshold, geometry)
    expect(entered).toEqual({
      roomKey: room.key,
      kind: 'enter',
      destination: { x: outside.x, y: room.door.from.y - 24 },
    })
    expect(nearestDoor(entered!.destination, geometry)).toEqual({ roomKey: room.key, kind: 'exit', destination: outside })
  })

  it('does not create an out-of-bounds transition fallback', () => {
    const room = geometry.rooms.at(-1)!
    const point = { x: (room.door.from.x + room.door.to.x) / 2, y: room.door.from.y + 24 }
    const tooShort = { ...geometry, height: room.door.from.y + 40 }
    expect(nearestDoor(point, tooShort)).toBeNull()
    expect(nearestDoor({ x: point.x, y: geometry.height + 1 }, geometry)).toBeNull()
  })

  it('reaches every outside door point in the corridor and can return from every doorway', () => {
    const corridor = reachableInArea(VISITOR_SPAWN, geometry)
    for (const room of geometry.rooms) {
      const x = (room.door.from.x + room.door.to.x) / 2
      const outside = { x, y: room.door.from.y + 24 }
      const inside = { x, y: room.door.from.y - 24 }
      expect(corridor.has(`${outside.x},${outside.y}`), `${room.name} outside door should be reachable`).toBe(true)
      expect(nearestDoor(outside, geometry)?.destination).toEqual(inside)
      expect(nearestDoor(inside, geometry)?.destination).toEqual(outside)
    }
  })
})
