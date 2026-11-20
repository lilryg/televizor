import { useEffect, useRef, useState } from 'react'
import { MonitorPlay, Radio, RotateCw, Volume2, VolumeX } from 'lucide-react'
import { act, errorText, supabase } from './api'
import { FullscreenButton, usePlayerFullscreen } from './usePlayerFullscreen'
import { RtcDiagnostics, rtcDebugEnabled } from './RtcDiagnostics'
import { preferVideoCodec, tuneVideoSender, type QualityProfile } from './rtcQuality'
import type { Room, Signal } from './model'
import { Button } from './ui/button'

function iceServers(): RTCIceServer[] {
  try {
    const configured = JSON.parse(import.meta.env.VITE_ICE_SERVERS || 'null')
    if (Array.isArray(configured) && configured.length) return configured
  } catch { /* Use public STUN when no valid configuration was provided. */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }]
}

type Peer = {
  pc: RTCPeerConnection
  attempt: string
  candidateQueue: RTCIceCandidateInit[]
  startedAt: number
  disconnectedAt?: number
}

export function TabPlayer({ room, user, visit, capture, quality, viewers, report }: {
  room: Room; user: string; visit?: string; capture: MediaStream | null; quality: QualityProfile
  viewers: string[]; report: (message: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const view = usePlayerFullscreen(video, report)
  const peers = useRef(new Map<string, Peer>())
  const [retry, setRetry] = useState(0)
  const [muted, setMuted] = useState(true)
  const [status, setStatus] = useState('Подключение к трансляции…')
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const host = room.host === user
  const streamId = room.stream_id!

  useEffect(() => {
    const element = video.current!
    const source = host ? capture : stream
    let active = true
    element.srcObject = source
    setPlaybackBlocked(false)
    if (source) void element.play().catch((error) => {
      if (active && error.name === 'NotAllowedError') setPlaybackBlocked(true)
    })
    return () => {
      active = false
      element.srcObject = null
    }
  }, [capture, stream, host])

  useEffect(() => {
    if (!host) return
    for (const [id, peer] of peers.current) {
      if (!viewers.includes(id)) {
        peer.pc.close()
        peers.current.delete(id)
      }
    }
  }, [host, viewers])

  useEffect(() => {
    if (host && !capture) return
    const client = supabase!
    const activePeers = peers.current
    let active = true
    let subscribed = false
    let recovering = false
    let attempts = 0
    let chain = Promise.resolve()
    const processed = new Set<number>()
    const pending = new Map<string, RTCIceCandidateInit[]>()
    const lastReady = new Map<string, number>()
    const send = (target: string, attempt: string, kind: Signal['kind'], data: Signal['data']) =>
      act(room.id, 'signal', { target, attempt, kind, data, stream: streamId, visit })

    function makePeer(target: string, attempt: string) {
      const old = activePeers.get(target)
      old?.pc.close()
      const pc = new RTCPeerConnection({ iceServers: iceServers() })
      const peer: Peer = { pc, attempt, candidateQueue: pending.get(attempt) || [], startedAt: performance.now() }
      pending.delete(attempt)
      activePeers.set(target, peer)
      pc.onicecandidate = (event) => {
        if (active && event.candidate && activePeers.get(target) === peer) {
          void send(target, attempt, 'ice', event.candidate.toJSON()).catch(() => {})
        }
      }
      if (capture) {
        for (const track of capture.getTracks()) {
          const sender = pc.addTrack(track, capture)
          const transceiver = pc.getTransceivers().find((entry) => entry.sender === sender)
          if (track.kind === 'video' && transceiver) preferVideoCodec(transceiver, true)
        }
      }
      if (!host) {
        const fallbackStream = new MediaStream()
        pc.ontrack = (event) => {
          if (!active || activePeers.get(target) !== peer) return
          if (!event.streams.length) fallbackStream.addTrack(event.track)
          setStream((previous) => {
            // Preserve one MediaStream for all audio/video tracks of this connection.
            const received = event.streams[0] ?? fallbackStream
            return previous === received ? previous : received
          })
        }
        pc.onconnectionstatechange = () => {
          if (!active || activePeers.get(target) !== peer) return
          if (pc.connectionState === 'connected') {
            attempts = 0
            peer.disconnectedAt = undefined
            setStatus('')
          } else if (pc.connectionState === 'disconnected') {
            peer.disconnectedAt ??= performance.now()
            setStatus('Связь прервалась. Ожидаем восстановления…')
          } else if (pc.connectionState === 'failed') {
            setStatus('Связь прервалась. Переподключаемся…')
            void connect()
          }
        }
      }
      return peer
    }

    async function receive(signal: Signal) {
      if (!active || processed.has(signal.id) || signal.stream_id !== streamId) return
      processed.add(signal.id)
      const { sender, attempt, kind, data } = signal
      if (host && kind === 'ready') {
        if (signal.id <= (lastReady.get(sender) ?? 0) || activePeers.get(sender)?.attempt === attempt) return
        lastReady.set(sender, signal.id)
        const { pc } = makePeer(sender, attempt)
        await pc.setLocalDescription(await pc.createOffer())
        const videoSender = pc.getSenders().find((sender) => sender.track?.kind === 'video')
        if (videoSender) await tuneVideoSender(videoSender, quality)
        if (active && pc.localDescription) await send(sender, attempt, 'offer', pc.localDescription.toJSON())
        return
      }
      const peer = activePeers.get(sender)
      if (!peer || peer.attempt !== attempt) {
        if (host && kind === 'ice' && pending.size < 100) {
          const candidates = pending.get(attempt) || []
          if (candidates.length < 40) candidates.push(data as RTCIceCandidateInit)
          pending.set(attempt, candidates)
        }
        return
      }
      const { pc, candidateQueue } = peer
      if (kind === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(data as RTCIceCandidateInit)
        else if (candidateQueue.length < 60) candidateQueue.push(data as RTCIceCandidateInit)
        return
      }
      if (kind !== (host ? 'answer' : 'offer') || pc.remoteDescription) return
      await pc.setRemoteDescription(data as RTCSessionDescriptionInit)
      for (const candidate of candidateQueue.splice(0)) await pc.addIceCandidate(candidate).catch(() => {})
      if (!host) {
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.receiver.track.kind === 'video') preferVideoCodec(transceiver, false)
        }
        await pc.setLocalDescription(await pc.createAnswer())
        if (active && pc.localDescription) await send(sender, attempt, 'answer', pc.localDescription.toJSON())
      }
    }

    function enqueue(signal: Signal) {
      chain = chain.then(() => receive(signal)).catch((error) => {
        if (!host && active) setStatus(errorText(error))
      })
    }

    async function connect() {
      if (!active || !subscribed || host || recovering || !navigator.onLine) return
      const peer = activePeers.get(room.host)
      if (peer) {
        const elapsed = performance.now()
        const state = peer.pc.connectionState
        if (state === 'connected') return
        if ((state === 'new' || state === 'connecting') && elapsed - peer.startedAt < 15_000) return
        if (state === 'disconnected' && elapsed - (peer.disconnectedAt ?? elapsed) < 8_000) return
      }
      if (attempts >= 3) {
        setStatus('Не удалось соединиться с хостом. В некоторых сетях для трансляции нужен TURN.')
        return
      }
      recovering = true
      attempts += 1
      try {
        const attempt = crypto.randomUUID()
        makePeer(room.host, attempt)
        setStatus('Подключение к трансляции…')
        await send(room.host, attempt, 'ready', {})
      } catch (error) {
        if (active) setStatus(errorText(error))
      } finally { recovering = false }
    }

    const channel = client.channel('signals:' + streamId + ':' + user + ':' + retry)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tv_signals', filter: 'recipient=eq.' + user },
        (event) => enqueue(event.new as Signal))
      .subscribe((state) => {
        if (!active) return
        subscribed = state === 'SUBSCRIBED'
        if (!subscribed) {
          if (!host && activePeers.get(room.host)?.pc.connectionState !== 'connected') {
            setStatus('Восстанавливаем связь с комнатой…')
          }
          return
        }
        if (host) {
          void client.from('tv_signals').select().eq('recipient', user).eq('stream_id', streamId).order('id')
            .then(({ data }) => { if (active) data?.forEach((signal) => enqueue(signal)) })
        } else {
          if (activePeers.get(room.host)?.pc.connectionState === 'connected') setStatus('')
          void connect()
        }
      })
    const online = () => { attempts = 0; void connect() }
    const timer = !host ? setInterval(connect, 2000) : undefined
    window.addEventListener('online', online)
    return () => {
      active = false
      window.removeEventListener('online', online)
      clearInterval(timer)
      activePeers.forEach((peer) => peer.pc.close())
      activePeers.clear()
      void client.removeChannel(channel)
    }
  }, [room.id, room.host, streamId, user, visit, host, capture, quality, retry])

  const showVideo = host ? capture : stream
  return <><div className="player" ref={view.frame} {...view.frameProps}><div className="player-stage">
    <div className="screen">
      <video ref={video} playsInline autoPlay muted={host || muted} />
      {!showVideo && <div className="media-message">
        <MonitorPlay size={28} />
        <p>{host ? 'Захват вкладки завершён или открыт в другом окне.' : status || 'Ожидаем видео…'}</p>
        {!host && <Button variant="secondary" onClick={() => { setStream(null); setRetry((value) => value + 1) }}>
          <RotateCw size={16} /> Переподключиться
        </Button>}
      </div>}
      {!host && showVideo && playbackBlocked && <Button className="play-overlay" onClick={() => {
        void video.current?.play().then(() => setPlaybackBlocked(false))
          .catch(() => report('Браузер заблокировал воспроизведение.'))
      }}>Включить просмотр</Button>}
    </div>
    <div className="player-controls" data-hidden={view.controlsHidden || undefined} inert={view.controlsHidden}>
    <div className="controls control-row">
      <span className="live"><Radio size={17} /> Прямой эфир</span>
      <div className="spacer" />
      {!host && <Button variant="ghost" onClick={() => {
        if (video.current) video.current.muted = !muted
        setMuted(!muted)
        void video.current?.play().then(() => setPlaybackBlocked(false))
          .catch(() => report('Браузер заблокировал воспроизведение.'))
      }}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}{muted ? 'Включить звук' : 'Выключить звук'}</Button>}
      <FullscreenButton active={view.fullscreen} toggle={view.toggle} />
    </div>
    {!host && showVideo && status && <div className="controls control-row">
      <span className="muted" role="status">{status}</span><div className="spacer" />
      <Button variant="ghost" onClick={() => { setStream(null); setRetry((value) => value + 1) }}>
        <RotateCw size={16} /> Переподключиться
      </Button>
    </div>}
    </div>
  </div></div>{rtcDebugEnabled() && <RtcDiagnostics peers={peers} video={video} host={host} capture={capture} />}</>
}
