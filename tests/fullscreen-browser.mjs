import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } })
let browser
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch()
  const phone = { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } }
  for (const player of ['', '?tab']) {
    const page = await browser.newPage(phone)
    await page.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }))
    await page.clock.install()
    await page.goto(origin + '/tests/fullscreen-fixture.html' + player)
    const open = page.getByRole('button', { name: 'Полноэкранный режим', exact: true })
    const close = page.getByRole('button', { name: 'Выйти из полноэкранного режима', exact: true })
    const controls = page.locator('.player-controls')
    await open.tap()
    await close.waitFor()
    const stage = await page.locator('.player-stage').evaluate((element) => ({
      width: element.clientWidth, height: element.clientHeight, transform: getComputedStyle(element).transform,
    }))
    assert.ok(stage.width > stage.height, 'The mobile fallback lays out the player in landscape')
    assert.notEqual(stage.transform, 'none')
    const before = await page.locator('.screen').boundingBox()
    await page.clock.fastForward(9_000)
    assert.equal(await controls.getAttribute('inert'), null)
    await page.clock.fastForward(1_001)
    assert.notEqual(await controls.getAttribute('inert'), null, 'Controls hide after ten seconds')
    assert.deepEqual(await page.locator('.screen').boundingBox(), before, 'Hiding controls preserves video geometry')
    await page.locator('.screen').tap()
    await close.waitFor()
    assert.equal(await controls.getAttribute('inert'), null)
    await page.clock.fastForward(9_000)
    assert.equal(await controls.getAttribute('inert'), null, 'A tap restarts the ten-second timer')
    await close.tap()
    await open.waitFor()
    await page.clock.fastForward(11_000)
    assert.equal(await controls.getAttribute('inert'), null, 'Inline controls remain visible')
    assert.equal(await page.locator('html').evaluate((element) => element.classList.contains('video-viewport-open')), false)
    await page.close()
  }

  const android = await browser.newPage(phone)
  await android.addInitScript(() => {
    Object.defineProperty(screen.orientation, 'lock', { value: async (orientation) => { window.requestedLock = orientation } })
    Object.defineProperty(screen.orientation, 'unlock', { value: () => { window.releasedLock = true } })
  })
  await android.goto(origin + '/tests/fullscreen-fixture.html')
  await android.getByRole('button', { name: 'Полноэкранный режим', exact: true }).tap()
  await android.waitForFunction(() => document.fullscreenElement && window.requestedLock === 'landscape')
  // Exit from outside the button, as when the browser handles a system back action.
  await android.evaluate(() => document.exitFullscreen())
  await android.waitForFunction(() => window.releasedLock && !document.fullscreenElement)
  await android.getByRole('button', { name: 'Полноэкранный режим', exact: true }).waitFor()
  console.log('Both mobile players: landscape layout, ten-second idle timeout, touch reveal, and native orientation lifecycle.')
} finally {
  await browser?.close()
  await server.close()
}
