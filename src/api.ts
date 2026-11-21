import { createClient } from '@supabase/supabase-js'
import type { ListedRoom, RecentRoom, Room, RoomVisit } from './model'

function publicKey(key?: string) {
  if (key?.startsWith('sb_publishable_')) return true
  try { return JSON.parse(atob((key ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon' }
  catch { return false }
}

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_KEY: key } = import.meta.env
export const supabase = url?.startsWith('https://') && publicKey(key)
  ? createClient(url, key, { auth: { detectSessionInUrl: false } })
  : null
let accessToken: string | undefined
supabase?.auth.onAuthStateChange((_event, session) => { accessToken = session?.access_token })

function client() {
  if (!supabase) throw new Error('Сервис ещё не подключён к Supabase.')
  return supabase
}

export async function signIn() {
  const { data, error } = await client().auth.getSession()
  if (error) throw error
  if (data.session) {
    accessToken = data.session.access_token
    return data.session.user.id
  }
  const result = await client().auth.signInAnonymously()
  if (result.error) throw result.error
  if (!result.data.user) throw new Error('Supabase не создал сессию.')
  accessToken = result.data.session?.access_token
  return result.data.user.id
}

export async function enter(nick: string, options: {
  invitation?: string; recentRoom?: string; listedRoom?: string; roomName?: string; password?: string
} = {}): Promise<RoomVisit> {
  const visit = crypto.randomUUID()
  const { data, error } = await client().rpc('tv_join_room', {
    nick, visit, invitation: options.invitation ?? null, recent_room: options.recentRoom ?? null,
    listed_room: options.listedRoom ?? null, room_name: options.roomName ?? null, password: options.password ?? null,
  })
  if (error) throw error
  if (!data?.id) throw new Error(data?.error ?? 'Комната недоступна.')
  return { id: data.id, visit }
}

export async function recentRooms(): Promise<RecentRoom[]> {
  const { data, error } = await client().rpc('tv_recent_rooms')
  if (error) throw error
  return data ?? []
}

export async function roomDirectory(): Promise<ListedRoom[]> {
  const { data, error } = await client().rpc('tv_directory')
  if (error) throw error
  return data ?? []
}

export function slots(room: string, visit: string): Promise<{ balance: number }>
export function slots(room: string, visit: string, stake: number, requestId: string):
  Promise<{ balance: number; reels: number[]; payout: number }>
export async function slots(room: string, visit: string, stake = 0, requestId?: string) {
  const { data, error } = await client().rpc('tv_slots', {
    room, visit, stake, request_id: requestId ?? null,
  })
  if (error) throw error
  return data
}

export function leaveOnPageHide(id: string, visit: string) {
  if (!supabase || !accessToken) return
  void fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/tv_action', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ room: id, action: 'leave', args: { visit } }),
  }).catch(() => {})
}

export async function act<T = Room>(room: string, action: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client().rpc('tv_action', { room, action, args })
  if (error) throw error
  return data
}

export function errorText(error: unknown) {
  const message = (error as { message?: string } | null)?.message
  if (!navigator.onLine || /fetch|network/i.test(message ?? '')) return 'Нет связи с сервером. Проверь подключение и попробуй снова.'
  if (/anonymous|signup/i.test(message ?? '')) return 'Анонимный вход недоступен. Проверь настройки входа в Supabase.'
  return message || 'Не удалось выполнить действие.'
}
