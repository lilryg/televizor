import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } })
let browser
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  for (const tuned of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(origin + '/webrtc-clock.html')
    const result = await page.evaluate(async (tuned) => {
      const { captureOptions, tuneVideoSender } = await import('/src/rtcQuality.ts')
      const { measurements } = await import('/src/rtcStats.ts')
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      async function until(check, description) {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (check()) return
          await wait(40)
        }
        throw new Error('Timed out: ' + description)
      }
      async function stats(connection) {
        const values = new Map()
        const report = await connection.getStats()
        report.forEach((stat) => values.set(stat.id, stat))
        return values
      }

      const canvas = document.createElement('canvas')
      canvas.width = 1920
      canvas.height = 1080
      const draw = canvas.getContext('2d')
      let frame = 0
      function render() {
        const time = Date.now() & 65535
        for (let bit = 0; bit < 16; bit++) {
          draw.fillStyle = time & (1 << bit) ? 'white' : 'black'
          draw.fillRect(bit * 120, 0, 120, 108)
        }
        draw.fillStyle = '#222639'
        draw.fillRect(0, 108, 1920, 972)
        for (let block = 0; block < 150; block++) {
          draw.fillStyle = 'hsl(' + (block * 11 % 360) + ' 60% 56%)'
          draw.fillRect((block * 79 + frame * (block % 11 + 3)) % 1900,
            115 + (block * 89 + frame * 4) % 885, 40 + block % 40, 75)
        }
        frame++
      }
      render()
      const ticker = setInterval(render, 1000 / 30)
      const audio = new AudioContext()
      const oscillator = audio.createOscillator()
      const audioOutput = audio.createMediaStreamDestination()
      oscillator.connect(audioOutput)
      oscillator.start()
      await audio.resume()
      const stream = canvas.captureStream(30)
      stream.addTrack(audioOutput.stream.getAudioTracks()[0])
      if (tuned) stream.getVideoTracks()[0].contentHint = 'motion'
      const host = new RTCPeerConnection()
      const guest = new RTCPeerConnection()
      const player = document.createElement('video')
      player.style.width = '320px'
      player.muted = true
      player.playsInline = true
      document.body.prepend(player)
      guest.ontrack = (event) => { if (!player.srcObject) player.srcObject = event.streams[0] }
      const videoSender = host.addTrack(stream.getVideoTracks()[0], stream)
      host.addTrack(stream.getAudioTracks()[0], stream)

      const measureCanvas = document.createElement('canvas')
      measureCanvas.width = 16
      measureCanvas.height = 1
      const measure = measureCanvas.getContext('2d', { willReadFrequently: true })
      const delays = []
      let callback
      let sample = false
      function readFrame() {
        if (sample) {
          measure.drawImage(player, 0, 0, player.videoWidth, player.videoHeight / 10, 0, 0, 16, 1)
          const pixels = measure.getImageData(0, 0, 16, 1).data
          let sourceTime = 0
          for (let bit = 0; bit < 16; bit++) if (pixels[bit * 4] > 128) sourceTime |= 1 << bit
          const age = (Date.now() - sourceTime) & 65535
          if (age <= 3000) delays.push(age)
        }
        callback = player.requestVideoFrameCallback(readFrame)
      }
      try {
        await host.setLocalDescription(await host.createOffer())
        if (tuned) await tuneVideoSender(videoSender, 'balanced')
        await until(() => host.iceGatheringState === 'complete', 'host ICE gathering')
        await guest.setRemoteDescription(host.localDescription)
        await guest.setLocalDescription(await guest.createAnswer())
        await until(() => guest.iceGatheringState === 'complete', 'guest ICE gathering')
        await host.setRemoteDescription(guest.localDescription)
        await until(() => player.srcObject && host.connectionState === 'connected', 'guest track and connected host')
        await player.play()
        await until(() => player.videoWidth > 0 && player.currentTime > 0, 'first displayed video frame')
        await wait(1200)
        const [priorHost, priorGuest] = await Promise.all([stats(host), stats(guest)])
        sample = true
        callback = player.requestVideoFrameCallback(readFrame)
        await wait(4000)
        const [latestHost, latestGuest] = await Promise.all([stats(host), stats(guest)])
        sample = false
        const sorted = delays.sort((a, b) => a - b)
        return {
          mode: tuned ? 'balanced' : 'baseline',
          host: Object.fromEntries(measurements(latestHost, priorHost, true)),
          guest: Object.fromEntries(measurements(latestGuest, priorGuest, false)),
          rendered: player.getVideoPlaybackQuality().totalVideoFrames,
          tracks: player.srcObject.getTracks().map((track) => track.kind).sort(),
          visualDelayMs: {
            samples: sorted.length,
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
          },
          profileHeights: ['stable', 'balanced', 'high'].map((profile) => captureOptions(profile).video.height.max),
        }
      } finally {
        if (callback !== undefined) player.cancelVideoFrameCallback(callback)
        clearInterval(ticker)
        stream.getTracks().forEach((track) => track.stop())
        host.close()
        guest.close()
        await audio.close()
      }
    }, tuned)
    console.log(JSON.stringify(result))
    assert.deepEqual(result.tracks, ['audio', 'video'])
    assert.equal(result.host['Видеокодек'], result.guest['Видеокодек'])
    assert.match(result.guest['Видеокодек'], /^video\//i)
    assert.match(result.guest['Аудиокодек'], /^audio\//i)
    assert.ok(result.rendered > 20, 'Chromium rendered enough frames')
    assert.ok(result.visualDelayMs.samples > 15, 'The visual time signal survived WebRTC encoding')
    assert.deepEqual(result.profileHeights, [720, 1080, 1080])
    await page.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
