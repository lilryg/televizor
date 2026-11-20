import { videoCapabilities } from './rtcStats'

export const qualityProfiles = {
  stable: { label: 'Стабильный', width: 1280, height: 720, fps: 30 },
  balanced: { label: 'Сбалансированный', width: 1920, height: 1080, fps: 30 },
  high: { label: 'Высокое качество', width: 1920, height: 1080, fps: 60, maxBitrate: 10_000_000 },
} as const

export type QualityProfile = keyof typeof qualityProfiles

export function captureOptions(quality: QualityProfile): DisplayMediaStreamOptions {
  const { width, height, fps } = qualityProfiles[quality]
  return {
    video: {
      displaySurface: 'browser',
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
      frameRate: { ideal: fps, max: fps },
    },
    audio: true,
    preferCurrentTab: false,
  } as DisplayMediaStreamOptions
}

export async function tuneVideoSender(sender: RTCRtpSender, quality: QualityProfile) {
  const parameters = sender.getParameters()
  if (!parameters.encodings.length) return
  const profile = qualityProfiles[quality]
  parameters.degradationPreference = 'maintain-framerate'
  for (const encoding of parameters.encodings) {
    encoding.maxFramerate = profile.fps
    if ('maxBitrate' in profile) encoding.maxBitrate = profile.maxBitrate
  }
  try { await sender.setParameters(parameters) }
  catch { /* Unsupported parameters leave the browser's default adaptation in place. */ }
}

// Opt-in comparison only. Preserve the browser's codec list, including RTX and fallback codecs.
export function preferVideoCodec(transceiver: RTCRtpTransceiver, host: boolean) {
  const query = new URLSearchParams(location.search)
  if (query.get('webrtc') !== '1' || !transceiver.setCodecPreferences) return
  const choice = query.get('rtc-codec')?.toLowerCase()
  if (!choice || !['h264', 'vp8', 'vp9', 'av1'].includes(choice)) return
  const mimeType = 'video/' + choice
  const matches = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() === mimeType
  if (host && !videoCapabilities(globalThis.RTCRtpSender).some(matches)) return
  const supported = videoCapabilities(globalThis.RTCRtpReceiver)
  const preferred = supported.filter(matches)
  if (!preferred.length) return
  try { transceiver.setCodecPreferences([...preferred, ...supported.filter((codec) => !matches(codec))]) }
  catch { /* Another browser may reject a particular codec preference. */ }
}
