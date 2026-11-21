import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Check, CircleAlert, Crown, DoorOpen, Film, Link2, LoaderCircle, MonitorPlay, Pencil,
  Plus, Radio, ScreenShare, Square, Tv, UserRoundMinus, Users,
} from 'lucide-react'
import { act, enter, errorText, leaveOnPageHide, signIn, supabase } from './api'
import { inviteCode, isOnline, validNickname, videoUrl, type ListedRoom, type Room, type RoomVisit } from './model'
import { Player } from './Player'
import { TabPlayer } from './TabPlayer'
import { RoomList } from './RecentRooms'
import { RoomDialog } from './RoomDialog'
import { SlotPanel } from './SlotPanel'
import { captureOptions, qualityProfiles, type QualityProfile } from './rtcQuality'
import { Button } from './ui/button'
import { useRoom } from './useRoom'
import './style.css'

const nicknameKey = 'televizor.nickname'
const readInvite = () => inviteCode(location.hash.slice(1).replace(/^room=/, ''))
const clearInvite = () => history.replaceState(null, '', location.pathname + location.search)
function setInvite(code: string) {
  history.replaceState(null, '', '#room=' + code)
}

function Logo() {
  return <div className="brand"><span className="logo"><Tv size={23} /></span><span>Телевизор</span></div>
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="notice" role="status"><CircleAlert size={17} /> <span>{children}</span></p>
}

function App() {
  const [nickname, setNickname] = useState(() => localStorage.getItem(nicknameKey) || '')
  const [draft, setDraft] = useState(nickname)
  const [user, setUser] = useState('')
  const [currentRoom, setCurrentRoom] = useState<RoomVisit>()
  const roomId = currentRoom?.id
  const [code, setCode] = useState('')
  const [invite, setIncomingInvite] = useState(readInvite)
  const [editing, setEditing] = useState(false)
  const [roomDialog, setRoomDialog] = useState<{ kind: 'create' } | { kind: 'password'; room: ListedRoom; recent: boolean }>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function run(task: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try { await task() } catch (error) { setMessage(errorText(error)) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (supabase && validNickname(nickname)) void run(async () => setUser(await signIn()))
    const update = () => setIncomingInvite(readInvite())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
    // Load the stored session once.
  }, [])

  useEffect(() => {
    if (user && invite && !roomId) void run(async () => setCurrentRoom(await enter(nickname, { invitation: invite })))
  }, [user, invite])

  function submitName(event: FormEvent) {
    event.preventDefault()
    const name = draft.trim()
    if (!validNickname(name)) return setMessage('Введи никнейм длиной от 2 до 20 символов.')
    void run(async () => {
      if (currentRoom) await act(currentRoom.id, 'nick', { nickname: name, visit: currentRoom.visit })
      const session = user || await signIn()
      localStorage.setItem(nicknameKey, name)
      setNickname(name)
      setEditing(false)
      setUser(session)
    })
  }

  function exit(reason = '') {
    clearInvite()
    setIncomingInvite('')
    setCurrentRoom(undefined)
    setMessage(reason)
  }

  function join(event: FormEvent) {
    event.preventDefault()
    const invitation = inviteCode(code)
    if (!invitation) return setMessage('Вставь ссылку-приглашение или полный код комнаты.')
    void run(async () => setCurrentRoom(await enter(nickname, { invitation })))
  }

  function joinList(room: ListedRoom, recent: boolean) {
    if (room.is_locked) {
      setMessage('')
      setRoomDialog({ kind: 'password', room, recent })
      return
    }
    void run(async () => setCurrentRoom(await enter(nickname, recent ? { recentRoom: room.id } : { listedRoom: room.id })))
  }

  const nickForm = <form onSubmit={submitName} className="stack">
    <label htmlFor="nickname">Твой никнейм</label>
    <input id="nickname" value={draft} autoComplete="nickname" placeholder="Например, Киноман"
      onChange={(event) => setDraft(event.target.value)} required autoFocus />
    <Button type="submit" disabled={busy || !supabase}>{busy && <LoaderCircle className="spin" size={17} />}
      {user ? 'Сохранить' : 'Продолжить'}</Button>
  </form>

  if (!user) return <main className="login">
    <section className="login-card">
      <Logo />
      <h1>Кино вместе</h1>
      <p className="muted">Приватный кинозал для тебя и друзей.</p>
      {supabase ? nickForm : <Notice>Сервис ещё не подключён к Supabase.</Notice>}
      {message && <Notice>{message}</Notice>}
    </section>
  </main>

  return <>
    <header className="top"><div className="top-inner"><Logo />
      <Button variant="ghost" onClick={() => { setDraft(nickname); setEditing(true); setMessage('') }}>
        <span className="avatar small">{Array.from(nickname)[0]?.toUpperCase()}</span><span className="nav-nick">{nickname}</span><Pencil size={14} />
      </Button>
    </div></header>
    {currentRoom ? <RoomView key={currentRoom.visit} id={currentRoom.id} visit={currentRoom.visit} user={user} exit={exit} /> :
      <main className="lobby">
        <div className="intro">
          <h1>Кино вместе</h1>
          <p>Привет, {nickname}! Создай комнату или присоединяйся к друзьям.</p>
        </div>
        <div className="lobby-grid">
          <section className="panel lobby-card">
            <span className="tile-icon"><Film size={25} /></span>
            <h2>Свой кинозал</h2>
            <p>До 10 участников в комнате.</p>
            <Button disabled={busy} onClick={() => { setMessage(''); setRoomDialog({ kind: 'create' }) }}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />} Создать комнату
            </Button>
          </section>
          <section className="panel lobby-card">
            <span className="tile-icon"><Users size={25} /></span>
            <h2>К друзьям</h2>
            <form onSubmit={join} className="stack">
              <label htmlFor="join">Ссылка-приглашение или код</label>
              <input id="join" placeholder="Вставь ссылку или код" value={code} onChange={(e) => setCode(e.target.value)} required />
              <Button variant="secondary" disabled={busy}><DoorOpen size={18} /> Войти по коду</Button>
            </form>
          </section>
        </div>
        {message && !editing && <Notice>{message}</Notice>}
        <RoomList disabled={busy} onJoin={joinList} />
        <RoomList recent disabled={busy} onJoin={joinList} />
      </main>}
    {roomDialog && <RoomDialog roomTitle={roomDialog.kind === 'password' ? roomDialog.room.title : undefined}
      onClose={() => setRoomDialog(undefined)} onSubmit={async (roomName, password) => {
        const options = roomDialog.kind === 'create' ? { roomName, password }
          : roomDialog.recent ? { recentRoom: roomDialog.room.id, password } : { listedRoom: roomDialog.room.id, password }
        setCurrentRoom(await enter(nickname, options))
        setRoomDialog(undefined)
      }} />}
    {editing && <div className="modal-backdrop" onClick={() => !busy && setEditing(false)}>
      <dialog className="panel modal" open aria-label="Изменить никнейм" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setEditing(false) }}>
        <h2>Изменить никнейм</h2>
        {nickForm}
        {message && <Notice>{message}</Notice>}
        <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Отмена</Button>
      </dialog>
    </div>}
  </>
}

function RoomView({ id, user, visit, exit }: { id: string; user: string; visit: string; exit: (reason?: string) => void }) {
  const { room, members, connected, problem, offset, accept } = useRoom(id, user, visit, exit)
  const [message, setMessage] = useState('')
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<'tab' | 'video'>('tab')
  const [quality, setQuality] = useState<QualityProfile>('balanced')
  const [capture, setCapture] = useState<{ media: MediaStream; stream: string; quality: QualityProfile }>()
  const localCapture = useRef<typeof capture>(undefined)
  const alive = useRef(true)
  const actionPending = useRef(false)
  const host = room?.host === user
  const tab = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  function stopLocal() {
    localCapture.current?.media.getTracks().forEach((track) => track.stop())
    localCapture.current = undefined
    if (alive.current) setCapture(undefined)
  }

  useEffect(() => () => { alive.current = false; stopLocal() }, [])
  useEffect(() => {
    if (room?.invite) setInvite(room.invite)
  }, [room?.invite])
  useEffect(() => {
    if (localCapture.current && (!host || room?.stream_id !== localCapture.current.stream)) stopLocal()
  }, [room?.stream_id, host])
  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(timeout)
  }, [copied])

  async function perform(task: () => Promise<void>) {
    if (actionPending.current) return
    actionPending.current = true
    setBusy(true)
    setMessage('')
    try { await task() } catch (error) { if (alive.current) setMessage(errorText(error)) }
    finally {
      actionPending.current = false
      if (alive.current) setBusy(false)
    }
  }

  function command(name: string, args: Record<string, unknown> = {}) {
    return perform(async () => {
      const next = await act<Room>(id, name, { ...args, visit })
      if (name === 'leave') exit()
      else accept(next)
    })
  }

  async function startCapture() {
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getDisplayMedia(captureOptions(quality))
    } catch (error) {
      if ((error as Error).name === 'NotAllowedError') throw new Error('Захват отменён или браузер не дал доступ к вкладке.')
      throw error
    }
    const track = media.getVideoTracks()[0]
    let stream: string | null = null
    const finish = () => {
      if (localCapture.current?.media === media) stopLocal()
      if (stream) void act<Room>(id, 'stop_tab', { stream, visit }).then((next) => {
        if (alive.current) accept(next)
      }).catch(() => {})
    }
    try {
      const surface = track?.getSettings().displaySurface
      if (!track || (surface && surface !== 'browser')) throw new Error('Выбери вкладку браузера в окне захвата.')
      if (!alive.current) return
      if ('contentHint' in track) track.contentHint = 'motion'
      track.addEventListener('ended', finish, { once: true })
      const next = await act<Room>(id, 'start_tab', { visit })
      stream = next.stream_id
      if (!stream || !alive.current || track.readyState === 'ended') return finish()
      stopLocal()
      localCapture.current = { media, stream, quality }
      setCapture(localCapture.current)
      accept(next)
      if (!media.getAudioTracks().length) setMessage('Вкладка передаётся без звука. При выборе вкладки включи «Поделиться звуком», если браузер это поддерживает.')
    } finally {
      if (localCapture.current?.media !== media) media.getTracks().forEach((item) => item.stop())
    }
  }

  if (!room) return <main className="room-shell">
    <p role="status" className="loading"><LoaderCircle className="spin" size={20} /> Открываем комнату…</p>
    {problem && <Notice>{problem}</Notice>}
    <Button variant="secondary" onClick={() => { leaveOnPageHide(id, visit); exit() }}>В главное меню</Button>
  </main>

  const now = Date.now() + offset.current
  const activeMembers = members.filter((member) => isOnline(member, now))
  const viewers = activeMembers.filter((member) => member.user_id !== user).map((member) => member.user_id)
  return <main className="room-shell">
    <div className="room-heading">
      <div><div className={'connection' + (connected ? ' online' : '')}><i /> {connected ? 'На связи' : 'Восстанавливаем связь'}</div>
        <h1>{room.title ?? 'Кинозал ' + room.id.slice(0, 6).toUpperCase()}</h1></div>
      <div className="room-actions">
        <Button variant="secondary" onClick={() => void perform(async () => {
          const link = new URL(location.href)
          link.hash = 'room=' + room.invite
          link.searchParams.delete('webrtc')
          link.searchParams.delete('rtc-codec')
          await navigator.clipboard.writeText(link.href)
          setCopied(true)
        })}>{copied ? <Check size={17} /> : <Link2 size={17} />}{copied ? 'Скопировано' : 'Ссылка-приглашение'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void command('leave')}><DoorOpen size={17} /> Выйти</Button>
      </div>
    </div>
    <div className="room-grid">
      <SlotPanel room={id} visit={visit} />
      <div className="room-main">
        {room.mode === 'video' && room.source ? <Player key={room.source} room={room} offset={offset} command={command}
          disabled={busy || !connected} report={setMessage} /> :
          room.mode === 'tab' && room.stream_id ? <TabPlayer key={room.stream_id} room={room} user={user} visit={visit}
            capture={capture?.stream === room.stream_id ? capture.media : null} quality={capture?.quality ?? 'balanced'}
            viewers={viewers} report={setMessage} /> :
            <div className="player empty-player"><span className="tile-icon"><MonitorPlay size={32} /></span>
              <h2>{host ? 'Что смотрим?' : 'Ждём хоста'}</h2>
              <p>{host ? 'Запусти трансляцию вкладки или добавь ссылку на видео.' : 'Видео появится, когда хост выберет источник.'}</p>
            </div>}
        {(message || problem) && <Notice>{message || problem}</Notice>}
        {host && <section className="panel source-panel">
          <h2>Источник видео</h2>
          <div className="source-tabs" aria-label="Выбор источника">
            <Button variant={selection === 'tab' ? 'secondary' : 'ghost'} aria-pressed={selection === 'tab'}
              onClick={() => setSelection('tab')}><ScreenShare size={17} /> Вкладка</Button>
            <Button variant={selection === 'video' ? 'secondary' : 'ghost'} aria-pressed={selection === 'video'}
              onClick={() => setSelection('video')}><Link2 size={17} /> Прямая ссылка</Button>
          </div>
          {selection === 'video' ? <form className="video-form" onSubmit={(e) => {
            e.preventDefault()
            const source = videoUrl(url)
            if (!source) return setMessage('Вставь прямую HTTPS-ссылку на MP4, WebM или M3U8.')
            void command('video', { url: source })
          }}>
            <input aria-label="Прямая HTTPS-ссылка на видео" placeholder="https://…/film.mp4" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <Button disabled={busy || !connected}>Открыть видео</Button>
          </form> : room.mode === 'tab' ? <Button variant="danger" disabled={busy}
            onClick={() => { stopLocal(); void command('stop_tab', { stream: room.stream_id }) }}>
            <Square size={16} /> Остановить трансляцию
          </Button> : <>
            <label className="quality-selector">
              Качество трансляции
              <select value={quality} disabled={busy} onChange={(event) => setQuality(event.target.value as QualityProfile)}>
                {Object.entries(qualityProfiles).map(([key, profile]) => <option key={key} value={key}>
                  {profile.label} · до {profile.height}p / {profile.fps} FPS
                </option>)}
              </select>
            </label>
            <Button disabled={busy || !connected || !tab} onClick={() => void perform(startCapture)}>
              <Radio size={17} /> Транслировать вкладку
            </Button>
            <p className="muted">{tab ? 'Выбери вкладку и включи передачу звука в окне браузера. Защищённое видео может отображаться чёрным экраном.' :
              'Для запуска трансляции открой комнату в Chrome или Edge на компьютере.'}</p>
          </>}
        </section>}
      </div>
      <aside className="panel roster">
        <h2><Users size={19} /> Участники <span className="counter">{activeMembers.length}/10</span></h2>
        <ul>
          {activeMembers.map((member) => {
            const self = member.user_id === user
            return <li key={member.user_id}>
              <span className="avatar">{Array.from(member.nickname)[0]?.toUpperCase()}</span>
              <span className="member-label"><strong>{member.nickname}{self && ' (ты)'}</strong>
                <small>{member.user_id === room.host && <><Crown size={13} /> Хост · </>}В сети</small>
              </span>
              {host && !self && <div className="member-actions">
                <Button variant="ghost" title="Передать роль хоста" aria-label={'Передать роль хоста: ' + member.nickname}
                  disabled={busy} onClick={() => void command('transfer', { target: member.user_id })}><Crown size={16} /></Button>
                <Button variant="ghost" title="Удалить участника" aria-label={'Удалить участника: ' + member.nickname} disabled={busy}
                  onClick={() => { if (confirm('Исключить участника «' + member.nickname + '»? Он сможет войти снова.')) void command('kick', { target: member.user_id }) }}>
                  <UserRoundMinus size={16} />
                </Button>
              </div>}
            </li>
          })}
        </ul>
      </aside>
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
