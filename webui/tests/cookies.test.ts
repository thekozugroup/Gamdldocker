import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

// Redirect /config before lib/paths resolves its constants at import time.
const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamdl-cookies-'))
process.env.CONFIG_DIR = tmpRoot

const { readCookieStatus, soonestExpiry } = await import('../lib/store.ts')

function jar(lines: string[]): string {
  return ['# Netscape HTTP Cookie File', '# https://curl.se/docs/http-cookies.html', '', ...lines].join('\n') + '\n'
}

function cookieLine(domain: string, name: string, expiry: number): string {
  return [domain, 'TRUE', '/', 'TRUE', String(expiry), name, 'value'].join('\t')
}

test('soonestExpiry picks the earliest non-session expiry', () => {
  const text = jar([
    cookieLine('.apple.com', 'a', 2000000000),
    cookieLine('.apple.com', 'b', 1800000000),
    cookieLine('music.apple.com', 'c', 2100000000),
  ])
  assert.equal(soonestExpiry(text), 1800000000)
})

test('soonestExpiry skips session cookies, comments and malformed lines', () => {
  const text = jar([
    cookieLine('.apple.com', 'session', 0),
    '# a comment mid-file',
    'short\tline',
    cookieLine('.apple.com', 'real', 1900000000),
    ['.apple.com', 'TRUE', '/', 'TRUE', 'not-a-number', 'bad', 'v'].join('\t'),
  ])
  assert.equal(soonestExpiry(text), 1900000000)
})

test('soonestExpiry is null for an all-session jar or empty text', () => {
  assert.equal(soonestExpiry(jar([cookieLine('.apple.com', 's', 0)])), null)
  assert.equal(soonestExpiry(''), null)
})

test('readCookieStatus reports absence, then presence with expiry', async () => {
  const empty = await readCookieStatus()
  assert.equal(empty.exists, false)
  assert.equal(empty.activeFile, null)

  const inAWeek = Math.floor(Date.now() / 1000) + 7 * 86400
  await fsp.writeFile(path.join(tmpRoot, 'cookies.txt'), jar([cookieLine('.apple.com', 'x', inAWeek)]), 'utf-8')

  const present = await readCookieStatus()
  assert.equal(present.exists, true)
  assert.equal(present.activeFile, 'cookies.txt')
  assert.equal(present.expired, false)
  assert.ok(present.daysUntilExpiry !== null && present.daysUntilExpiry >= 6 && present.daysUntilExpiry <= 7)
  assert.equal(present.soonestExpiry, new Date(inAWeek * 1000).toISOString())
})

test('readCookieStatus flags an expired jar', async () => {
  const lastYear = Math.floor(Date.now() / 1000) - 365 * 86400
  await fsp.writeFile(path.join(tmpRoot, 'cookies.txt'), jar([cookieLine('.apple.com', 'x', lastYear)]), 'utf-8')
  const status = await readCookieStatus()
  assert.equal(status.expired, true)
  assert.ok(status.daysUntilExpiry !== null && status.daysUntilExpiry < 0)
})
