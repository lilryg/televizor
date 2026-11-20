import assert from 'node:assert/strict'
import test from 'node:test'
import { inviteCode, validNickname, videoUrl, playbackPosition, formatTime, isOnline } from '../src/model.ts'

test('accepts Cyrillic and Latin names with 2–20 Unicode characters', () => {
  for (const name of ['Ян', '  Film  ', '🙂🙂', 'я'.repeat(20)]) assert.ok(validNickname(name))
  for (const name of [' ', 'Я', 'я'.repeat(21), 'a\nb']) assert.equal(validNickname(name), false)
})

test('extracts invitations from GitHub Pages links and raw codes', () => {
  const code = '12345678-1234-4134-a234-123456789abc'
  assert.equal(inviteCode('https://user.github.io/televizor/#room=' + code), code)
  assert.equal(inviteCode(code.toUpperCase()), code)
  assert.equal(inviteCode('short'), '')
})

test('allows direct HTTPS video sources without user credentials', () => {
  assert.equal(videoUrl('https://example.org/video.m3u8?q=1'), 'https://example.org/video.m3u8?q=1')
  for (const url of ['javascript:alert(1)', 'http://example.org/video.mp4', 'https://user:pass@example.org/v']) {
    assert.equal(videoUrl(url), '')
  }
})

test('projects playback time from the authoritative clock', () => {
  const changedAt = '2026-11-20T12:00:00Z'
  const now = Date.parse(changedAt) + 1250
  const state = { changed_at: changedAt, paused: false, position: 10 }
  assert.equal(playbackPosition(state, now), 11.25)
  assert.equal(playbackPosition({ ...state, paused: true }, now), 10)
  assert.equal(playbackPosition(state, now - 10_000), 10)
  assert.equal(formatTime(3723), '1:02:03')
})

test('marks participants offline when their lease expires', () => {
  const seen = '2026-11-20T12:00:00Z'
  assert.ok(isOnline({ seen_at: seen }, Date.parse(seen) + 94_999))
  assert.equal(isOnline({ seen_at: seen }, Date.parse(seen) + 95_000), false)
})
