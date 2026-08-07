import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

// next/server cannot be resolved by Node's loader outside a Next build, so the
// real middleware.ts is loaded with that single import replaced by a stub. The
// code under test is the shipped file itself, not a copy of it — a copy would
// keep passing after someone changed the original.
const SOURCE = new URL('../middleware.ts', import.meta.url)
const RUNTIME_IMPORT = "import { NextResponse } from 'next/server'"
const TYPE_IMPORT = "import type { NextRequest } from 'next/server'"

const STUB = `const NextResponse = {
  next: () => ({ status: 200, body: null, headers: {} }),
  json: (body, init = {}) => ({ status: init.status ?? 200, body, headers: init.headers ?? {} }),
}
type NextRequest = { headers: Headers; nextUrl: URL }`

const source = await fsp.readFile(SOURCE, 'utf-8')
assert.ok(source.includes(RUNTIME_IMPORT), 'middleware.ts no longer imports NextResponse as expected')
assert.ok(source.includes(TYPE_IMPORT), 'middleware.ts no longer imports the NextRequest type as expected')

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamdl-middleware-'))
await fsp.writeFile(path.join(sandbox, 'package.json'), '{"type":"module"}', 'utf-8')
const patched = path.join(sandbox, 'middleware.ts')
await fsp.writeFile(patched, source.replace(RUNTIME_IMPORT, STUB).replace(TYPE_IMPORT, ''), 'utf-8')

const { middleware, config } = await import(pathToFileURL(patched).href)

function requestFor(url: string, headers: Record<string, string> = {}) {
  return { headers: new Headers(headers), nextUrl: new URL(url) }
}

function basic(credentials: string, encoding: BufferEncoding = 'utf-8'): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(credentials, encoding).toString('base64')}` }
}

/** Run `fn` with the auth variables set to `vars` and nothing else. */
async function withAuth<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const names = ['WEBUI_AUTH_TOKEN', 'WEBUI_USERNAME', 'WEBUI_PASSWORD']
  const saved = names.map((name) => [name, process.env[name]] as const)
  for (const name of names) {
    const value = vars[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await fn()
  } finally {
    for (const [name, previous] of saved) {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }
}

test('with nothing configured every request passes', async () => {
  await withAuth({}, async () => {
    const response = await middleware(requestFor('http://ui/settings'))
    assert.equal(response.status, 200)
  })
})

test('a bearer token is accepted and a wrong one is not', async () => {
  await withAuth({ WEBUI_AUTH_TOKEN: 's3cret' }, async () => {
    const ok = await middleware(requestFor('http://ui/api/status', { authorization: 'Bearer s3cret' }))
    assert.equal(ok.status, 200)
    const wrong = await middleware(requestFor('http://ui/api/status', { authorization: 'Bearer nope' }))
    assert.equal(wrong.status, 401)
    const none = await middleware(requestFor('http://ui/api/status'))
    assert.equal(none.status, 401)
  })
})

test('?token= works for EventSource, which cannot send headers', async () => {
  await withAuth({ WEBUI_AUTH_TOKEN: 's3cret' }, async () => {
    const ok = await middleware(requestFor('http://ui/api/logs/stream?token=s3cret'))
    assert.equal(ok.status, 200)
    const wrong = await middleware(requestFor('http://ui/api/logs/stream?token=nope'))
    assert.equal(wrong.status, 401)
  })
})

test('basic auth accepts the configured credentials', async () => {
  await withAuth({ WEBUI_USERNAME: 'admin', WEBUI_PASSWORD: 'hunter2' }, async () => {
    const ok = await middleware(requestFor('http://ui/', basic('admin:hunter2')))
    assert.equal(ok.status, 200)
    const wrongPass = await middleware(requestFor('http://ui/', basic('admin:hunter3')))
    assert.equal(wrongPass.status, 401)
    const wrongUser = await middleware(requestFor('http://ui/', basic('root:hunter2')))
    assert.equal(wrongUser.status, 401)
  })
})

test('basic auth decodes UTF-8, which is what browsers send', async () => {
  // atob alone yields Latin-1, so these credentials could never authenticate.
  await withAuth({ WEBUI_USERNAME: 'jörg', WEBUI_PASSWORD: 'pässwörd🎵' }, async () => {
    const ok = await middleware(requestFor('http://ui/', basic('jörg:pässwörd🎵')))
    assert.equal(ok.status, 200)
  })
})

test('basic auth: a password with a colon keeps everything after the first one', async () => {
  await withAuth({ WEBUI_USERNAME: 'admin', WEBUI_PASSWORD: 'a:b:c' }, async () => {
    const ok = await middleware(requestFor('http://ui/', basic('admin:a:b:c')))
    assert.equal(ok.status, 200)
  })
})

test('basic auth: Latin-1 credentials are rejected, as the 401 advertises', async () => {
  await withAuth({ WEBUI_USERNAME: 'admin', WEBUI_PASSWORD: 'pässwörd' }, async () => {
    const response = await middleware(requestFor('http://ui/', basic('admin:pässwörd', 'latin1')))
    assert.equal(response.status, 401)
  })
})

test('basic auth: malformed input is a 401, never a crash', async () => {
  await withAuth({ WEBUI_USERNAME: 'admin', WEBUI_PASSWORD: 'hunter2' }, async () => {
    const notBase64 = await middleware(requestFor('http://ui/', { authorization: 'Basic !!!not base64!!!' }))
    assert.equal(notBase64.status, 401)
    const noColon = await middleware(requestFor('http://ui/', basic('adminhunter2')))
    assert.equal(noColon.status, 401)
  })
})

test('the 401 asks for credentials in UTF-8 when basic auth is configured', async () => {
  await withAuth({ WEBUI_USERNAME: 'admin', WEBUI_PASSWORD: 'hunter2' }, async () => {
    const response = await middleware(requestFor('http://ui/'))
    assert.equal(response.headers['WWW-Authenticate'], 'Basic realm="gamdl", charset="UTF-8"')
  })

  // A token-only deployment must not trigger a browser password prompt.
  await withAuth({ WEBUI_AUTH_TOKEN: 's3cret' }, async () => {
    const response = await middleware(requestFor('http://ui/'))
    assert.equal(response.status, 401)
    assert.equal('WWW-Authenticate' in response.headers, false)
  })
})

test('the matcher leaves /api/health public for the container healthcheck', async () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`)
  assert.equal(matcher.test('/api/health'), false)
  // Everything else stays gated.
  assert.equal(matcher.test('/api/settings'), true)
  assert.equal(matcher.test('/api/logs/stream'), true)
  assert.equal(matcher.test('/settings'), true)
  assert.equal(matcher.test('/'), true)
  assert.equal(matcher.test('/_next/static/chunks/main.js'), false)
})
