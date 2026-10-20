import type { RoomGeometry, Point } from './visitor.ts'

export type RoomMiniMapProps = {
  geometry: RoomGeometry
  point: Point
  activeRoomKey: string | null
  targetRoomKey?: string | null
}

export function RoomMiniMap({ geometry, point, activeRoomKey, targetRoomKey = null }: RoomMiniMapProps) {
  const activeRoom = geometry.rooms.find(({ key }) => key === activeRoomKey)
  const targetRoom = geometry.rooms.find(({ key }) => key === targetRoomKey)

  return <div className="room-minimap">
    <p className="room-minimap__location">현재 위치 · {activeRoom?.name ?? '복도'}</p>
    {targetRoom ? <p className="room-minimap__destination">목적지 · {targetRoom.name}</p> : null}
    <svg className="room-minimap__map" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`사무실 미니맵 · 현재 위치 ${activeRoom?.name ?? '복도'}${targetRoom ? ` · 목적지 ${targetRoom.name}` : ''}`}>
      <rect className="room-minimap__corridor" x="0" y="0" width={geometry.width} height={geometry.height} />
      {geometry.rooms.map((room) => {
        const isActive = room.key === activeRoomKey
        const isTarget = room.key === targetRoomKey
        return <g key={room.key} data-room-key={room.key} data-active={isActive || undefined} data-target={isTarget || undefined}>
          <rect className={`room-minimap__room${isActive ? ' room-minimap__room--active' : ''}${isTarget ? ' room-minimap__room--target' : ''}`} x={room.x} y={room.y} width={room.width} height={room.height} />
          <line className="room-minimap__door" x1={room.door.from.x} y1={room.door.from.y} x2={room.door.to.x} y2={room.door.to.y} />
        </g>
      })}
      {targetRoom ? <circle className="room-minimap__destination-marker" cx={targetRoom.x + targetRoom.width / 2} cy={targetRoom.y + targetRoom.height / 2} r="24" /> : null}
      <circle className="room-minimap__player" cx={point.x} cy={point.y} r="40" fill="#f3ead6" stroke="#314b3c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>
}
