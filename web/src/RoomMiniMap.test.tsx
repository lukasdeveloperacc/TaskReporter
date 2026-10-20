// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import roles from './roles.json' with { type: 'json' }
import { roomGeometry, type Point } from './visitor.ts'
import { RoomMiniMap } from './RoomMiniMap.tsx'

const geometry = roomGeometry(roles.departments)
const point: Point = { x: 168, y: 1440 }

describe('RoomMiniMap', () => {
  it('draws every room and door from shared geometry and places the player at the global point', () => {
    const { container } = render(<RoomMiniMap geometry={geometry} point={point} activeRoomKey={null} />)
    screen.getByRole('img', { name: '사무실 미니맵 · 현재 위치 복도' })
    expect(container.querySelectorAll('[data-room-key]')).toHaveLength(10)
    expect(container.querySelectorAll('.room-minimap__door')).toHaveLength(10)
    expect(container.querySelector('.room-minimap__player')?.getAttribute('cx')).toBe('168')
    expect(container.querySelector('.room-minimap__player')?.getAttribute('cy')).toBe('1440')
    expect(container.querySelector('.room-minimap__player')?.getAttribute('r')).toBe('40')
    expect(screen.getByText('현재 위치 · 복도')).toBeTruthy()
  })

  it('marks current room and destination visually and names both accessibly', () => {
    const active = geometry.rooms.find(({ key }) => key === '백엔드팀')!
    const target = geometry.rooms.find(({ key }) => key === '감사팀')!
    const { container } = render(<RoomMiniMap geometry={geometry} point={point} activeRoomKey={active.key} targetRoomKey={target.key} />)
    expect(screen.getByText('현재 위치 · 백엔드팀')).toBeTruthy()
    expect(screen.getByText('목적지 · 감사팀')).toBeTruthy()
    expect(screen.getByRole('img', { name: '사무실 미니맵 · 현재 위치 백엔드팀 · 목적지 감사팀' })).toBeTruthy()
    expect(container.querySelector(`[data-room-key="${active.key}"]`)?.getAttribute('data-active')).toBe('true')
    expect(container.querySelector(`[data-room-key="${target.key}"]`)?.getAttribute('data-target')).toBe('true')
    expect(container.querySelector('.room-minimap__destination-marker')).toBeTruthy()
  })

  it('keeps a point on a room boundary classified as corridor when no room is active', () => {
    const room = geometry.rooms[0]
    const boundaryPoint = { x: (room.door.from.x + room.door.to.x) / 2, y: room.door.from.y }
    const { container } = render(<RoomMiniMap geometry={geometry} point={boundaryPoint} activeRoomKey={null} />)
    expect(screen.getByText('현재 위치 · 복도')).toBeTruthy()
    expect(container.querySelector('.room-minimap__player')?.getAttribute('cx')).toBe(String(boundaryPoint.x))
    expect(container.querySelector('.room-minimap__player')?.getAttribute('cy')).toBe(String(boundaryPoint.y))
    expect(container.querySelector('.room-minimap__room--active')).toBeNull()
  })
})
