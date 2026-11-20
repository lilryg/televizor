import { useEffect, useRef, useState } from 'react'
import { act, errorText, supabase } from './api'
import type { Member, Room } from './model'

export function useRoom(id: string, user: string, onClosed: (message: string) => void) {
  const [room, setRoom] = useState<Room>()
  const [members, setMembers] = useState<Member[]>([])
  const [connected, setConnected] = useState(false)
  const [problem, setProblem] = useState('')
  const offset = useRef(0)
  const close = useRef(onClosed)
  close.current = onClosed
  const accept = (value: Room) => setRoom((previous) =>
    !previous || previous.touched_at <= value.touched_at ? value : previous)

  useEffect(() => {
    const client = supabase!
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let pulseRunning = false
    let rosterRequest = 0

    async function roster() {
      const version = ++rosterRequest
      const { data, error } = await client.from('tv_members').select('user_id,nickname,status,seen_at')
        .eq('room_id', id).eq('status', 'active').order('joined_at')
      if (alive && version === rosterRequest && !error) setMembers(data)
    }

    function refreshRoster() {
      clearTimeout(timer)
      timer = setTimeout(() => void roster(), 100)
    }

    async function pulse() {
      if (!alive || pulseRunning) return
      pulseRunning = true
      const start = Date.now()
      try {
        const result = await act<{ now: string }>(id, 'heartbeat')
        if (!alive) return
        offset.current = Date.parse(result.now) - (start + Date.now()) / 2
        const { data, error } = await client.from('tv_rooms').select().eq('id', id).maybeSingle()
        if (!alive) return
        if (error) throw error
        if (!data) return close.current('Комната больше недоступна.')
        accept(data)
        setProblem('')
        refreshRoster()
      } catch (error) {
        if (!alive) return
        const message = errorText(error)
        if (/Доступ к комнате закрыт/.test(message)) close.current(message)
        else setProblem(message)
      } finally { pulseRunning = false }
    }

    const channel = client.channel('room:' + id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tv_rooms', filter: 'id=eq.' + id }, (event) => {
        if (alive) accept(event.new as Room)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tv_members', filter: 'room_id=eq.' + id }, (event) => {
        if (!alive) return
        if ('user_id' in event.new && event.new.user_id === user && event.new.status === 'kicked') {
          close.current('Хост удалил тебя из комнаты.')
        } else refreshRoster()
      })
      .subscribe((status) => {
        if (!alive) return
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') void pulse()
      })

    const offline = () => setConnected(false)
    const interval = setInterval(pulse, 30_000)
    window.addEventListener('online', pulse)
    window.addEventListener('offline', offline)
    void pulse()
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(interval)
      window.removeEventListener('online', pulse)
      window.removeEventListener('offline', offline)
      void client.removeChannel(channel)
    }
  }, [id, user])

  return { room, members, connected, problem, offset, accept }
}
