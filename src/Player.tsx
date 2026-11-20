import { useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { formatTime, playbackPosition, type Room } from './model'
import { Button } from './ui/button'

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

export async function fullscreen(frame: HTMLElement | null, video: FullscreenVideo | null) {
  if (document.fullscreenElement) await document.exitFullscreen()
  else if (frame?.requestFullscreen) {
    try { await frame.requestFullscreen() }
    catch (error) {
      if (!video?.webkitEnterFullscreen) throw error
      video.webkitEnterFullscreen()
    }
  } else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen()
  else throw new Error('Полноэкранный режим недоступен в этом браузере.')
}

export function Player({ room, offset, disabled, command, report }:
  { room: Room; offset: RefObject<number>; disabled: boolean
    command: (name: string, args: Record<string, unknown>) => Promise<void>; report: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const latest = useRef(room)
  latest.current = room
  const [playBlocked, setPlayBlocked] = useState(false)
  const [mediaError, setMediaError] = useState('')
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [drag, setDrag] = useState<number>()
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    const element = video.current!
    const source = room.source!
    let active = true
    let cleanup: (() => void) | undefined
    const failure = () => { if (active) setMediaError('Видео не загрузилось. Проверь ссылку, формат и доступ к источнику.') }
    if (/\.m3u8(?:[?#]|$)/i.test(source) && !element.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (!active) return
        if (!Hls.isSupported()) return failure()
        const hls = new Hls()
        cleanup = () => hls.destroy()
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) failure() })
        hls.loadSource(source)
        hls.attachMedia(element)
      }).catch(failure)
    } else element.src = source
    return () => {
      active = false
      cleanup?.()
      element.removeAttribute('src')
      element.load()
    }
  }, [room.source])

  useEffect(() => {
    const element = video.current!
    let cancelled = false
    let playing = false
    function sync(force: boolean) {
      const state = latest.current
      if (element.readyState < 1) return
      let target = playbackPosition(state, Date.now() + offset.current)
      if (Number.isFinite(element.duration)) target = Math.min(element.duration, target)
      else if (element.seekable.length) {
        const start = element.seekable.start(0)
        const end = element.seekable.end(element.seekable.length - 1)
        target = Math.min(end, Math.max(start, target))
      }
      const drift = target - element.currentTime
      if (Math.abs(drift) > (force || state.paused ? 0.22 : 1.3)) element.currentTime = target
      element.playbackRate = state.paused || Math.abs(drift) < 0.24 || Math.abs(drift) > 1.3 ? 1 : drift > 0 ? 1.06 : 0.94
      if (state.paused) {
        element.pause()
        setPlayBlocked(false)
      } else if (element.paused && !element.ended && !playing) {
        playing = true
        void element.play().then(() => { if (!cancelled) setPlayBlocked(false) })
          .catch((error) => { if (!cancelled && error.name === 'NotAllowedError') setPlayBlocked(true) })
          .finally(() => { playing = false })
      }
    }
    const immediate = () => sync(true)
    element.addEventListener('loadedmetadata', immediate)
    immediate()
    const interval = setInterval(() => sync(false), 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
      element.removeEventListener('loadedmetadata', immediate)
    }
  }, [room.version, offset])

  function changeVolume(value: number) {
    const element = video.current!
    element.volume = value
    element.muted = value === 0
    setVolume(value)
  }

  async function seek(value: number) {
    setDrag(undefined)
    await command('seek', { version: room.version, position: value })
  }

  return <div className="player" ref={frame}>
    <div className="screen">
      <video ref={video} playsInline preload="metadata"
        onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onError={() => setMediaError('Не удалось открыть видео. Проверь адрес, формат и доступность источника.')}
        onEnded={() => { if (!latest.current.paused) void command('pause', { version: latest.current.version }) }} />
      {mediaError && <p className="media-message" role="alert">{mediaError}</p>}
      {playBlocked && !mediaError && <Button className="play-overlay" onClick={() => {
        void video.current?.play().then(() => setPlayBlocked(false)).catch(() => report('Браузер не смог запустить это видео.'))
      }}><Play size={17} /> Включить просмотр</Button>}
    </div>
    <div className="controls">
      <input className="progress" type="range" aria-label="Позиция видео" min={0} max={duration || 1} step={0.1}
        value={drag ?? Math.min(current, duration)} disabled={disabled || !duration}
        onChange={(e) => setDrag(Number(e.currentTarget.value))}
        onPointerUp={(e) => void seek(Number(e.currentTarget.value))}
        onPointerCancel={() => setDrag(undefined)}
        onBlur={() => { if (drag !== undefined) void seek(drag) }}
        onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void seek(Number(e.currentTarget.value)) }} />
      <div className="control-row">
        <Button variant="ghost" disabled={disabled || !!mediaError} aria-label={room.paused ? 'Воспроизвести' : 'Пауза'}
          onClick={() => void command(room.paused ? 'play' : 'pause', {
            version: room.version, restart: room.paused && !!duration && current >= duration - 0.3,
          })}>{room.paused ? <Play size={21} /> : <Pause size={21} />}</Button>
        <span className="time">{formatTime(drag ?? current)}{duration > 0 && ' / ' + formatTime(duration)}</span>
        <div className="spacer" />
        <Button variant="ghost" aria-label={volume ? 'Выключить звук' : 'Включить звук'} onClick={() => changeVolume(volume ? 0 : 1)}>
          {volume ? <Volume2 size={19} /> : <VolumeX size={19} />}
        </Button>
        <input className="volume" type="range" aria-label="Громкость" min={0} max={1} step={0.05} value={volume}
          onChange={(e) => changeVolume(Number(e.currentTarget.value))} />
        <Button variant="ghost" aria-label="Полноэкранный режим" onClick={() => void fullscreen(frame.current, video.current)
          .catch((error: Error) => report(error.message))}><Maximize size={19} /></Button>
      </div>
    </div>
  </div>
}
