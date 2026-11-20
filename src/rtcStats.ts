type Value = number | string | boolean | undefined
export type Stat = { id: string; type: string; timestamp: number; [key: string]: Value }
export type Stats = ReadonlyMap<string, Stat>
export type Metric = [label: string, value: string | undefined]

const number = (stat: Stat | undefined, field: string) => {
  const value = stat?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
const label = (stat: Stat | undefined, field: string) => {
  const value = stat?.[field]
  return typeof value === 'string' ? value : undefined
}
const reference = (stats: Stats, stat: Stat | undefined, field: string) => stats.get(label(stat, field) ?? '')
const scale = (value: number | undefined, by: number) => value === undefined ? undefined : value * by
const format = (value: number | undefined, unit = '', digits = 0) =>
  value === undefined ? undefined : value.toFixed(digits) + unit
const resolution = (width?: number, height?: number) => width && height ? `${width} × ${height}` : undefined
const statResolution = (stat?: Stat) => resolution(number(stat, 'frameWidth'), number(stat, 'frameHeight'))

export function delta(current: Stat | undefined, previous: Stats, field: string) {
  const before = current && previous.get(current.id)
  const now = number(current, field)
  const old = number(before, field)
  if (current && before && current.timestamp > before.timestamp && now !== undefined && old !== undefined && now >= old) {
    return now - old
  }
}

function rate(stat: Stat | undefined, previous: Stats, field: string) {
  const value = delta(stat, previous, field)
  const before = stat && previous.get(stat.id)
  if (value !== undefined && before && stat) return value * 1000 / (stat.timestamp - before.timestamp)
}

function intervalMean(stat: Stat | undefined, previous: Stats, total: string, count: string) {
  const sum = delta(stat, previous, total)
  const n = delta(stat, previous, count)
  if (sum !== undefined && n) return sum / n
}

function media(stats: Stats, type: string, kind: string, counter: string) {
  return [...stats.values()].filter((stat) => stat.type === type && stat.kind === kind)
    .sort((a, b) => (number(b, counter) ?? 0) - (number(a, counter) ?? 0))[0]
}

export function measurements(stats: Stats, prior: Stats, host: boolean, capture?: MediaTrackSettings, playout?: number) {
  const type = host ? 'outbound-rtp' : 'inbound-rtp'
  const bytes = host ? 'bytesSent' : 'bytesReceived'
  const video = media(stats, type, 'video', bytes)
  const audio = media(stats, type, 'audio', bytes)
  const source = host ? reference(stats, video, 'mediaSourceId') : undefined
  const transport = reference(stats, video ?? audio, 'transportId')
    ?? [...stats.values()].find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId)
  const pair = reference(stats, transport, 'selectedCandidatePairId')
  const local = reference(stats, pair, 'localCandidateId')
  const remote = reference(stats, pair, 'remoteCandidateId')
  const peerVideo = reference(stats, video, 'remoteId')
    ?? [...stats.values()].find((stat) => stat.type === 'remote-inbound-rtp' && video && stat.localId === video.id)
  const loss = delta(host ? peerVideo : video, prior, 'packetsLost')
  const received = delta(host ? peerVideo : video, prior, 'packetsReceived')
  const lossPercent = loss !== undefined && received !== undefined && loss + received > 0
    ? 100 * loss / (loss + received) : undefined
  const rtt = number(pair, 'currentRoundTripTime') ?? (host ? number(peerVideo, 'roundTripTime') : undefined)
  const implementation = label(video, host ? 'encoderImplementation' : 'decoderImplementation')
  const powerEfficient = video?.[host ? 'powerEfficientEncoder' : 'powerEfficientDecoder']
  const localType = label(local, 'candidateType')
  const remoteType = label(remote, 'candidateType')
  const direct = localType && remoteType ? (localType === 'relay' || remoteType === 'relay' ? 'TURN' : 'Прямое P2P') : undefined
  const transportProtocol = [label(local, 'protocol'), label(local, 'relayProtocol')].filter(Boolean).join(' / ')
  const count = (stat: Stat | undefined, field: string) => format(delta(stat, prior, field))
  const fps = (field: string) => format(rate(video, prior, field), ' кадр/с', 1)
  const ms = (seconds?: number) => format(scale(seconds, 1000), ' мс', 1)
  const common: Metric[] = [
    ['Видеокодек', label(reference(stats, video, 'codecId'), 'mimeType')],
    ['Аудиокодек', label(reference(stats, audio, 'codecId'), 'mimeType')],
    [host ? 'Разрешение отправки' : 'Разрешение приёма', statResolution(video)],
    [host ? 'Исходящий видеобитрейт' : 'Входящий видеобитрейт', format(scale(rate(video, prior, bytes), 0.000008), ' Мбит/с', 2)],
    ['Потерянные пакеты за интервал', format(loss)],
    ['Потери за интервал', format(lossPercent, ' %', 2)],
    ['RTT', ms(rtt)],
    ['Путь медиапотока', direct],
    ['Кандидаты ICE (локальный / удалённый)', localType || remoteType ? `${localType ?? 'Недоступно'} / ${remoteType ?? 'Недоступно'}` : undefined],
    ['Сетевой протокол', transportProtocol || undefined],
    [host ? 'Кодировщик' : 'Декодировщик', implementation],
    ['Энергоэффективная реализация', typeof powerEfficient === 'boolean' ? (powerEfficient ? 'Да' : 'Нет') : undefined],
  ]
  const detail: Metric[] = host ? [
    ['Разрешение захвата', resolution(capture?.width, capture?.height)],
    ['Частота захвата по настройкам', format(capture?.frameRate, ' кадр/с', 1)],
    ['Кадры от источника за секунду', format(number(source, 'framesPerSecond'), ' кадр/с', 1)],
    ['Частота кодирования', fps('framesEncoded')],
    ['Кадры отправлены за интервал', count(video, 'framesSent')],
    // The current outbound RTP standard does not expose an encoder drop counter.
    ['Кадры отброшены кодировщиком', undefined],
    ['Среднее кодирование кадра', ms(intervalMean(video, prior, 'totalEncodeTime', 'framesEncoded'))],
    ['Повторные передачи пакетов за интервал', count(video, 'retransmittedPacketsSent')],
    ['Оценка доступной исходящей полосы', format(scale(number(pair, 'availableOutgoingBitrate'), 0.000001), ' Мбит/с', 2)],
    ['Ограничение качества', label(video, 'qualityLimitationReason')],
  ] : [
    ['Частота приёма', fps('framesReceived')],
    ['Частота декодирования', fps('framesDecoded')],
    ['Кадры отброшены за интервал', count(video, 'framesDropped')],
    ['Замирания за интервал', count(video, 'freezeCount')],
    ['Jitter', ms(number(video, 'jitter'))],
    ['Средняя задержка в jitter buffer', ms(intervalMean(video, prior, 'jitterBufferDelay', 'jitterBufferEmittedCount'))],
    ['Среднее декодирование кадра', ms(intervalMean(video, prior, 'totalDecodeTime', 'framesDecoded'))],
    ['От захвата до показа (оценка браузера)', format(playout, ' мс', 1)],
  ]
  return [...common, ...detail]
}

export function videoCapabilities(side: typeof RTCRtpSender | typeof RTCRtpReceiver) {
  return side?.getCapabilities?.('video')?.codecs ?? []
}
