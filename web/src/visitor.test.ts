import { describe, expect, it } from 'vitest'
import { roles } from '../../shared/office-roles.ts'
import { layoutOffice, OFFICE_HEIGHT, OFFICE_WIDTH, seatPosition, type EmployeeView } from './office.ts'
import { ELEVATOR_RECT, INTERACTION_RADIUS, moveVisitor, nearestInteraction, roomGeometry, VISITOR_SPAWN, visitorSpriteBounds, type Direction, type Point } from './visitor.ts'
import { findVisitorPath, roomKeyAt } from './roomNavigation.ts'

const geometry = roomGeometry(roles.departments)
const directions: Direction[] = ['up', 'down', 'left', 'right']

describe('visitor geometry', () => {
  it('expands map bounds and keeps routes to all seats when every department grows', () => {
    const employees: EmployeeView[] = roles.departments.flatMap(({ key: department }) => Array.from({ length: 9 }, (_, deskIndex) => ({
      name: `${department}-${deskIndex}`, department, deskIndex, model: null, rank: null, effort: null, frame: [0, 5], state: 'idle', statusLabel: '업무 미보고',
    })))
    const layout = layoutOffice(employees)
    const expanded = roomGeometry(layout)
    expect(expanded.width).toBe(OFFICE_WIDTH)
    expect(expanded.height).toBe(Math.max(...layout.map(({ y, h }) => (y + h) * 48)) + 64)
    expect(expanded.height).toBeGreaterThan(OFFICE_HEIGHT)
    const spawn = { ...VISITOR_SPAWN, y: VISITOR_SPAWN.y + expanded.height - OFFICE_HEIGHT }
    for (const department of layout) {
      const seat = seatPosition(department, 8)
      const target = { x: seat.x * 48, y: (seat.y + 1) * 48 }
      const path = findVisitorPath(spawn, target, expanded)
      expect(path, `${department.name} last seat should be reachable`).not.toBeNull()
      expect(roomKeyAt(path!.at(-1)!, expanded)).toBe(department.key)
    }
  })

  it('uses the foot point and keeps sprite and elevator geometry inside the map', () => {
    expect(visitorSpriteBounds(VISITOR_SPAWN)).toEqual({ left: 142, top: 1392, width: 52, height: 65 })
    expect(geometry.rooms.every((room) => ELEVATOR_RECT.x + ELEVATOR_RECT.width <= room.x || ELEVATOR_RECT.x >= room.x + room.width || ELEVATOR_RECT.y + ELEVATOR_RECT.height <= room.y || ELEVATOR_RECT.y >= room.y + room.height)).toBe(true)
    expect(VISITOR_SPAWN.x).toBeGreaterThanOrEqual(12)
    expect(VISITOR_SPAWN.x).toBeLessThanOrEqual(OFFICE_WIDTH - 12)
    expect(VISITOR_SPAWN.y).toBeLessThanOrEqual(OFFICE_HEIGHT - 12)
    expect(moveVisitor({ x: 168, y: 48 }, 'up', geometry)).toEqual({ x: 168, y: 48 })
    expect(moveVisitor({ x: 168, y: OFFICE_HEIGHT - 17 }, 'down', geometry)).toEqual({ x: 168, y: OFFICE_HEIGHT - 17 })
  })

  it('blocks room walls and map edges while allowing both directions through every door', () => {
    const room = geometry.rooms[3]
    const inside = { x: (room.door.from.x + room.door.to.x) / 2, y: room.y + room.height - 24 }
    const outside = { x: inside.x, y: room.y + room.height + 24 }
    const enteredCorridor = moveVisitor(inside, 'down', geometry)
    expect(moveVisitor(enteredCorridor, 'down', geometry)).toEqual(outside)
    const enteredRoom = moveVisitor(outside, 'up', geometry)
    expect(moveVisitor(enteredRoom, 'up', geometry)).toEqual(inside)
    expect(moveVisitor({ x: room.x - 24, y: room.y + 72 }, 'right', geometry)).toEqual({ x: room.x - 24, y: room.y + 72 })
    expect(moveVisitor({ x: 12, y: 100 }, 'left', geometry)).toEqual({ x: 12, y: 100 })
    expect(moveVisitor({ x: room.x + 24, y: room.y + 72 }, 'left', geometry)).toEqual({ x: room.x + 24, y: room.y + 72 })
    expect(moveVisitor({ x: 100, y: room.y + room.height - 12 }, 'down', geometry)).toEqual({ x: 100, y: room.y + room.height - 12 })
    expect(moveVisitor({ x: room.x - 12, y: room.y - 24 }, 'down', geometry)).toEqual({ x: room.x - 12, y: room.y - 24 })
  })

  it('connects the elevator spawn to every department interior on the 24px grid', () => {
    const queue: Point[] = [VISITOR_SPAWN]
    const visited = new Set([`${VISITOR_SPAWN.x},${VISITOR_SPAWN.y}`])
    while (queue.length) {
      const point = queue.shift()!
      for (const direction of directions) {
        const next = moveVisitor(point, direction, geometry)
        const key = `${next.x},${next.y}`
        if (!visited.has(key)) { visited.add(key); queue.push(next) }
      }
    }
    for (const room of geometry.rooms) {
      const anchor = { x: room.x + room.width / 2, y: room.y + room.height - 24 }
      expect(visited.has(`${anchor.x},${anchor.y}`), `${room.name} should be reachable`).toBe(true)
    }
  })
})

describe('nearestInteraction', () => {
  it('uses the nearest in-range target and stable Korean name tie-break', () => {
    const targets = [
      { name: '나래', point: { x: 50, y: 0 }, owner: 'narae' },
      { name: '가람', point: { x: -50, y: 0 }, owner: 'garam' },
      { name: '너무 멀리', point: { x: INTERACTION_RADIUS + 1, y: 0 }, owner: 'far' },
    ]
    expect(nearestInteraction({ x: 0, y: 0 }, targets)?.owner).toBe('garam')
    expect(nearestInteraction({ x: 0, y: 0 }, targets)).toEqual(targets[1])
    expect(nearestInteraction({ x: 0, y: 0 }, [{ name: '먼 곳', point: { x: 121, y: 0 } }])).toBeNull()
  })
})
