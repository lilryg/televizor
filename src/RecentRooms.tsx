import { useEffect, useState } from 'react'
import { DoorOpen, History } from 'lucide-react'
import { recentRooms } from './api'
import type { RecentRoom } from './model'
import { Button } from './ui/button'

export function RecentRooms({ disabled, onJoin }: { disabled: boolean; onJoin: (id: string) => void }) {
  const [rooms, setRooms] = useState<RecentRoom[]>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let running = false
    async function refresh() {
      if (running || document.hidden) return
      running = true
      try {
        const list = await recentRooms()
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
  }, [])

  return <section className="panel recent-rooms">
    <h2><History size={20} /> Недавние комнаты</h2>
    {rooms?.length ? <ul>
      {rooms.map((room) => <li key={room.id}>
        <span><strong>Кинозал {room.id.slice(0, 6).toUpperCase()}</strong>
          <small>{room.was_host ? 'Хост' : 'Гость'} · {room.participants ? `В комнате: ${room.participants}` : 'Пустая'}</small>
        </span>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => onJoin(room.id)}>
          <DoorOpen size={16} /> Войти
        </Button>
      </li>)}
    </ul> : <p className="muted">{failed ? 'Не удалось обновить список.' : rooms ? 'Недавних комнат пока нет.' : 'Загружаем комнаты…'}</p>}
  </section>
}
