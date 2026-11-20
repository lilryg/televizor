import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize, Minimize } from 'lucide-react'
import { Button } from './ui/button'

type OrientationLock = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> }
type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

const controlsTimeout = 10_000

export function usePlayerFullscreen(video: RefObject<HTMLVideoElement | null>, report: (message: string) => void) {
  const frame = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(false)
  const changing = useRef(false)
  const locked = useRef<OrientationLock | undefined>(undefined)
  const [mode, setMode] = useState<'native' | 'viewport'>()
  const [touch, setTouch] = useState(false)
  const [rotateViewport, setRotateViewport] = useState(false)
  const [hidden, setHidden] = useState(false)

  const unlock = useCallback(() => {
    locked.current?.unlock?.()
    locked.current = undefined
  }, [])

  useEffect(() => {
    mounted.current = true
    const element = frame.current
    function fullscreenChanged() {
      if (document.fullscreenElement === element) return
      unlock()
      setMode((current) => current === 'native' ? undefined : current)
      setRotateViewport(false)
    }
    document.addEventListener('fullscreenchange', fullscreenChanged)
    return () => {
      mounted.current = false
      document.removeEventListener('fullscreenchange', fullscreenChanged)
      unlock()
    }
  }, [unlock])

  useEffect(() => {
    if (mode !== 'viewport') return
    const root = document.documentElement
    root.classList.add('video-viewport-open')
    frame.current?.focus({ preventScroll: true })
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMode(undefined)
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      root.classList.remove('video-viewport-open')
    }
  }, [mode])

  const autoHide = Boolean(mode && touch)
  const wake = useCallback((wait = true) => {
    clearTimeout(timer.current)
    setHidden(false)
    if (wait) timer.current = setTimeout(() => setHidden(true), controlsTimeout)
  }, [])

  useEffect(() => {
    setHidden(false)
    if (!autoHide) return
    const keydown = () => wake()
    wake()
    document.addEventListener('keydown', keydown)
    return () => {
      clearTimeout(timer.current)
      document.removeEventListener('keydown', keydown)
    }
  }, [autoHide, wake])

  async function toggle() {
    const element = frame.current
    if (!element || changing.current) return
    if (mode === 'viewport') {
      setMode(undefined)
      return
    }
    changing.current = true
    try {
      if (document.fullscreenElement === element) {
        await document.exitFullscreen()
        return
      }

      const mobile = matchMedia('(hover: none) and (pointer: coarse)').matches
      setTouch(mobile)
      setRotateViewport(false)
      if (element.requestFullscreen && document.fullscreenEnabled !== false) {
        try {
          await element.requestFullscreen()
          if (!mounted.current || document.fullscreenElement !== element) return
          setMode('native')
          if (!mobile) return
          const orientation = screen.orientation as OrientationLock | undefined
          if (orientation?.lock) {
            try {
              await orientation.lock('landscape')
              if (mounted.current && document.fullscreenElement === element) locked.current = orientation
              else orientation.unlock?.()
              return
            } catch { /* Use the app's landscape layout if the browser declines orientation locking. */ }
          }
          if (mounted.current && document.fullscreenElement === element) setRotateViewport(true)
          return
        } catch (error) {
          if (!mobile && !(video.current as FullscreenVideo | null)?.webkitEnterFullscreen) throw error
        }
      }

      if (!mounted.current) return
      if (mobile) setMode('viewport')
      else {
        const element = video.current as FullscreenVideo | null
        if (!element?.webkitEnterFullscreen) throw new Error('Полноэкранный режим недоступен в этом браузере.')
        element.webkitEnterFullscreen()
      }
    } catch (error) {
      report(error instanceof Error ? error.message : 'Не удалось переключить полноэкранный режим.')
    } finally {
      changing.current = false
    }
  }

  return {
    frame,
    fullscreen: Boolean(mode),
    controlsHidden: autoHide && hidden,
    toggle: () => void toggle(),
    frameProps: {
      tabIndex: -1,
      'data-player-mode': mode,
      'data-player-rotate': (mode === 'viewport' || rotateViewport) || undefined,
      onPointerDown: autoHide ? () => wake(false) : undefined,
      onPointerUp: autoHide ? () => wake() : undefined,
      onPointerCancel: autoHide ? () => wake() : undefined,
      onClick: autoHide ? () => wake() : undefined,
    },
  }
}

export function FullscreenButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  return <Button type="button" variant="ghost"
    aria-label={active ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'} onClick={toggle}>
    {active ? <Minimize size={19} /> : <Maximize size={19} />}
  </Button>
}
