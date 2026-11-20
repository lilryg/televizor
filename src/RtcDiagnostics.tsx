import { useEffect, useState, type RefObject } from 'react'
import { measurements, videoCapabilities, type Metric, type Stat, type Stats } from './rtcStats'

export function rtcDebugEnabled() {
  return new URLSearchParams(location.search).get('webrtc') === '1'
}

const codecList = (side: typeof RTCRtpSender | typeof RTCRtpReceiver) =>
  [...new Set(videoCapabilities(side).map((codec) => codec.mimeType)
    .filter((mime) => /^video\/(h264|vp8|vp9|av1)$/i.test(mime)))].join(', ') || undefined

export function RtcDiagnostics({ peers, host, capture, video }: {
  peers: RefObject<Map<string, { pc: RTCPeerConnection }>>
  host: boolean
  capture: MediaStream | null
  video: RefObject<HTMLVideoElement | null>
}) {
  const [reports, setReports] = useState<Metric[][]>([])
  const [error, setError] = useState(false)
  const [capabilities] = useState<Metric[]>(() => [
    ['Локальное кодирование', codecList(globalThis.RTCRtpSender)],
    ['Локальное декодирование', codecList(globalThis.RTCRtpReceiver)],
  ])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let callback: number | undefined
    let playout: { at: number; delay: number } | undefined
    const previous = new WeakMap<RTCPeerConnection, Stats>()
    const element = video.current
    function onFrame(now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) {
      if (!active || !element) return
      if (typeof metadata.captureTime === 'number' && Number.isFinite(metadata.captureTime)) {
        const delay = metadata.expectedDisplayTime - metadata.captureTime
        if (Number.isFinite(delay) && delay >= 0) playout = { at: now, delay }
      }
      callback = element.requestVideoFrameCallback(onFrame)
    }
    if (!host && element?.requestVideoFrameCallback) callback = element.requestVideoFrameCallback(onFrame)

    async function sample() {
      const targets = [...peers.current.values()]
      const reports = await Promise.allSettled(targets.map(async ({ pc }): Promise<Metric[]> => {
        const stats = new Map<string, Stat>()
        const report = await pc.getStats()
        report.forEach((stat: Stat) => stats.set(stat.id, stat))
        const rows = measurements(stats, previous.get(pc) ?? new Map(), host,
          capture?.getVideoTracks()[0]?.getSettings(),
          playout && performance.now() - playout.at < 2500 ? playout.delay : undefined)
        previous.set(pc, stats)
        return [['Соединение', pc.connectionState], ['Состояние ICE', pc.iceConnectionState], ...rows]
      }))
      if (!active) return
      setReports(reports.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []))
      setError(reports.some((result) => result.status === 'rejected'))
      timer = setTimeout(sample, 1000)
    }
    void sample()
    return () => {
      active = false
      clearTimeout(timer)
      if (callback !== undefined) element?.cancelVideoFrameCallback(callback)
    }
  }, [capture, host, peers, video])

  return <section className="panel rtc-diagnostics" aria-label="Диагностика WebRTC">
    <h2>Диагностика WebRTC</h2>
    <MetricList rows={capabilities} />
    {!reports.length && <p className="muted">{error ? 'Статистика соединения недоступна.' : 'Ожидаем соединение…'}</p>}
    {reports.map((report, index) => <div key={index} className="rtc-report">
      {reports.length > 1 && <h3>Соединение {index + 1}</h3>}
      <MetricList rows={report} />
    </div>)}
    {error && reports.length > 0 && <p className="muted">Часть соединений не предоставила статистику.</p>}
  </section>
}

function MetricList({ rows }: { rows: Metric[] }) {
  return <dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? 'Недоступно'}</dd></div>)}</dl>
}
