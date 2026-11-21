import { useEffect, useState } from 'react'
import { DoorOpen, History, LockKeyhole, LockKeyholeOpen, Users } from 'lucide-react'
import { recentRooms, roomDirectory } from './api'
import type { ListedRoom, RecentRoom } from './model'
import { Button } from './ui/button'

export function RoomList({ recent = false, disabled, onJoin }:
  { recent?: boolean; disabled: boolean; onJoin: (room: ListedRoom, recent: boolean) => void }) {
  const [rooms, setRooms] = useState<(ListedRoom | RecentRoom)[]>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let running = false
    async function refresh() {
      if (running || document.hidden) return
      running = true
      try {
        const list = await (recent ? recentRooms() : roomDirectory())
        if (active) { setRooms(list); setFailed(false) }
      } catch {
        if (active) setFailed(true)
      } finally { running = false }
    }
    void refresh()
    const timer = setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [recent])

  return <section className="panel recent-rooms">
    <h2>{recent ? <><History size={20} /> Недавние комнаты</> : <><Users size={20} /> Список комнат</>}</h2>
    {rooms?.length ? <ul>
      {rooms.map((room) => <li key={room.id}>
        <span className="room-list-info"><strong>{room.title}</strong>
          <small>
            {room.is_locked ? <LockKeyhole size={13} /> : <LockKeyholeOpen size={13} />}
            {room.is_locked ? 'Закрытая' : 'Открытая'}
            {'was_host' in room && (room.was_host ? ' · Хост' : ' · Гость')}
            {' · '}{room.participants ? `${room.participants}/10` : 'Пустая'}
          </small>
        </span>
        <Button type="button" variant="secondary" disabled={disabled || room.participants >= 10}
          onClick={() => onJoin(room, recent)} aria-label={'Войти в комнату «' + room.title + '»'}>
          <DoorOpen size={16} /> Войти
        </Button>
      </li>)}
    </ul> : <p className="muted">{failed ? 'Не удалось обновить список.' :
      rooms ? (recent ? 'Недавних комнат пока нет.' : 'Комнат пока нет.') : 'Загружаем комнаты…'}</p>}
  </section>
}
