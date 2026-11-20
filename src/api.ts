import { createClient } from '@supabase/supabase-js'
import type { Room } from './model'

function publicKey(key?: string) {
  if (key?.startsWith('sb_publishable_')) return true
  try { return JSON.parse(atob((key ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon' }
  catch { return false }
}

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_KEY: key } = import.meta.env
export const supabase = url?.startsWith('https://') && publicKey(key)
  ? createClient(url, key, { auth: { detectSessionInUrl: false } })
  : null

function client() {
  if (!supabase) throw new Error('Сервис ещё не подключён к Supabase.')
  return supabase
}

export async function signIn() {
  const { data, error } = await client().auth.getSession()
  if (error) throw error
  if (data.session) return data.session.user.id
  const result = await client().auth.signInAnonymously()
  if (result.error) throw result.error
  if (!result.data.user) throw new Error('Supabase не создал сессию.')
  return result.data.user.id
}

export async function enter(nick: string, invitation?: string): Promise<string> {
  const { data, error } = await client().rpc('tv_enter', { nick, invitation: invitation || null })
  if (error) throw error
  return data
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
