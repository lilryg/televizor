import assert from 'node:assert/strict'
import test from 'node:test'
import { delta, measurements } from '../src/rtcStats.ts'

const report = (...entries) => new Map(entries.map((entry) => [entry.id, entry]))
const stat = (id, type, fields, timestamp = 2000) => ({ id, type, timestamp, ...fields })

test('uses interval counters, rejects resets, and distinguishes missing data from zero', () => {
  const before = report(stat('video', 'inbound-rtp', { framesDecoded: 8, framesDropped: 1 }, 1000))
  const after = stat('video', 'inbound-rtp', { framesDecoded: 38, framesDropped: 1 })
  assert.equal(delta(after, before, 'framesDecoded'), 30)
  assert.equal(delta(after, before, 'framesDropped'), 0)
  assert.equal(delta(after, before, 'framesReceived'), undefined)
  assert.equal(delta({ ...after, framesDecoded: 1 }, before, 'framesDecoded'), undefined)
  assert.equal(delta({ ...after, timestamp: 1000 }, before, 'framesDecoded'), undefined)
  assert.equal(delta({ ...after, id: 'new-ssrc' }, before, 'framesDecoded'), undefined)
})

test('reports the active codecs, receiver loss and actual nominated network path', () => {
  const previous = report(stat('video', 'inbound-rtp', {
    bytesReceived: 100, framesReceived: 14, framesDecoded: 10, framesDropped: 5, packetsLost: 4, packetsReceived: 300,
    jitterBufferDelay: 0, jitterBufferEmittedCount: 10, totalDecodeTime: 0,
  }, 1000))
  const current = report(
    stat('video', 'inbound-rtp', {
      kind: 'video', codecId: 'vp8', transportId: 't', frameWidth: 1920, frameHeight: 1080,
      bytesReceived: 500100, framesReceived: 43, framesDecoded: 38, framesDropped: 6, packetsLost: 5, packetsReceived: 399,
      jitter: 0.003, jitterBufferDelay: 1.45, jitterBufferEmittedCount: 39, totalDecodeTime: 0.14,
    }),
    stat('audio', 'inbound-rtp', { kind: 'audio', codecId: 'opus' }),
    stat('vp8', 'codec', { mimeType: 'video/VP8' }),
    stat('opus', 'codec', { mimeType: 'audio/opus' }),
    stat('t', 'transport', { selectedCandidatePairId: 'chosen' }),
    stat('unused', 'candidate-pair', { currentRoundTripTime: 33 }),
    stat('chosen', 'candidate-pair', { localCandidateId: 'c1', remoteCandidateId: 'c2', currentRoundTripTime: 0.029 }),
    stat('c1', 'local-candidate', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }),
    stat('c2', 'remote-candidate', { candidateType: 'srflx' }),
  )
  const rows = new Map(measurements(current, previous, false))
  assert.equal(rows.get('Видеокодек'), 'video/VP8')
  assert.equal(rows.get('Аудиокодек'), 'audio/opus')
  assert.equal(rows.get('Входящий видеобитрейт'), '4.00 Мбит/с')
  assert.equal(rows.get('Потери за интервал'), '1.00 %')
  assert.equal(rows.get('RTT'), '29.0 мс')
  assert.equal(rows.get('Путь медиапотока'), 'TURN')
  assert.equal(rows.get('Сетевой протокол'), 'udp / tls')
  assert.equal(rows.get('Частота приёма'), '29.0 кадр/с')
  assert.equal(rows.get('Частота декодирования'), '28.0 кадр/с')
  assert.equal(rows.get('Средняя задержка в jitter buffer'), '50.0 мс')
  assert.equal(rows.get('Среднее декодирование кадра'), '5.0 мс')
  assert.equal(rows.get('От захвата до показа (оценка браузера)'), undefined)
})
