import { useEffect, useRef, useState, type FormEvent } from 'react'
import { errorText } from './api'
import { Button } from './ui/button'

export function RoomDialog({ roomTitle, onSubmit, onClose }: {
  roomTitle?: string
  onSubmit: (name: string, password: string) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const creating = roomTitle === undefined

  useEffect(() => { dialog.current?.showModal() }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (creating && !name.trim()) return setMessage('Введи название комнаты.')
    if (new TextEncoder().encode(password).length > 72) return setMessage('Пароль слишком длинный. Используй более короткий пароль.')
    setPending(true)
    setMessage('')
    try { await onSubmit(name.trim(), password) }
    catch (error) { setMessage(errorText(error)); setPending(false) }
  }

  return <dialog className="panel modal room-dialog" aria-labelledby="room-dialog-title" ref={dialog}
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}>
    <h2 id="room-dialog-title">{creating ? 'Создать комнату' : roomTitle}</h2>
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {creating && <>
        <label htmlFor="new-room-name">Название комнаты</label>
        <input id="new-room-name" value={name} autoFocus autoComplete="off" maxLength={48}
          onChange={(event) => setName(event.target.value)} required />
      </>}
      <label htmlFor="room-password">{creating ? 'Пароль (необязательно)' : 'Пароль комнаты'}</label>
      <input id="room-password" type="password" value={password} required={!creating} autoFocus={!creating}
        autoComplete={creating ? 'new-password' : 'off'} onChange={(event) => setPassword(event.target.value)} />
      {creating && <p className="muted">Без пароля комната открыта для входа из списка. По ссылке-приглашению можно войти без пароля.</p>}
      {message && <p className="notice" role="alert">{message}</p>}
      <div className="dialog-actions">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={pending}>{creating ? 'Создать' : 'Войти'}</Button>
      </div>
    </form>
  </dialog>
}
