export type Room = {
  id: string
  host: string
  invite: string
  mode: 'empty' | 'video' | 'tab'
  source: string | null
  stream_id: string | null
  position: number
  version: number
  paused: boolean
  changed_at: string
  touched_at: string
}

export type Member = { user_id: string; nickname: string; status: string; seen_at: string }
export type RoomVisit = { id: string; visit: string }
export type RecentRoom = { id: string; last_visited_at: string; was_host: boolean; participants: number }
export type Signal = {
  id: number
  stream_id: string
  sender: string
  attempt: string
  kind: 'ready' | 'offer' | 'answer' | 'ice'
  data: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, never>
}

export const isOnline = (member: Member, now: number) => now - Date.parse(member.seen_at) < 95_000
export const validNickname = (value: string) => {
  const nick = value.trim()
  return Array.from(nick).length >= 2 && Array.from(nick).length <= 20 && !/\p{Cc}/u.test(nick)
}

export function inviteCode(input: string) {
  let value = input.trim()
  try { value = new URL(value).hash.slice(1).replace(/^room=/, '') } catch { /* A code can be pasted directly. */ }
  return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value.toLowerCase() : ''
}

export function videoUrl(input: string) {
  try {
    const url = new URL(input.trim())
    if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 4096) return url.href
  } catch { /* Invalid URL. */ }
  return ''
}

export function playbackPosition(state: Pick<Room, 'position' | 'paused' | 'changed_at'>, now: number) {
  return state.position + (state.paused ? 0 : Math.max(0, (now - Date.parse(state.changed_at)) / 1000))
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const elapsed = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(elapsed / 3600)
  const minutes = Math.floor(elapsed / 60) % 60
  return (hours ? hours + ':' + String(minutes).padStart(2, '0') : minutes) + ':' + String(elapsed % 60).padStart(2, '0')
}

export function seekPreview(pointer: number, width: number, duration: number) {
  const offset = Math.max(0, Math.min(width, pointer))
  // Thumb centers are inset from both edges of the native range input.
  const inset = 8
  const usable = Math.max(1, width - inset * 2)
  const fraction = Math.max(0, Math.min(1, (offset - inset) / usable))
  return { offset, time: Math.min(duration, Math.round(duration * fraction * 10) / 10) }
}
