// Optional authentication. With no auth env vars set the UI stays open, which
// is today's behavior for LAN-only deployments. Setting WEBUI_AUTH_TOKEN
// and/or WEBUI_USERNAME+WEBUI_PASSWORD gates every route; either credential
// type is accepted when both are configured (the token also works as ?token=
// so EventSource, which cannot send headers, can reach the log stream).
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Comparisons go through a SHA-256 digest first: equal-length buffers compared
// byte-by-byte in full, so neither length nor prefix leaks through timing.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const va = new Uint8Array(da)
  const vb = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

export const SESSION_COOKIE = 'gamdl_session'

/** The only route allowed to authenticate with ?token= — EventSource cannot
 *  set headers, and it is the one client that needs the escape hatch. */
const STREAM_PATH = '/api/logs/stream'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Refuse state-changing requests that a third-party page initiated.
 *
 * Now that a session cookie exists, a browser attaches it automatically — so
 * without this, any page the user visits could POST to /api/playlists or
 * /api/settings on their behalf. `Sec-Fetch-Site` is the modern signal;
 * `Origin` is the fallback for anything that does not send it.
 */
function isCrossSiteWrite(request: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return false

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none'

  const origin = request.headers.get('origin')
  if (!origin) return false // curl and other non-browser clients send neither
  try {
    return new URL(origin).host !== request.headers.get('host')
  } catch {
    return true
  }
}

async function tokenAllows(request: NextRequest, token: string): Promise<boolean> {
  const header = request.headers.get('authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    if (await timingSafeEqual(header.slice(7).trim(), token)) return true
  }
  // A query token is only honoured on the SSE endpoint, which is the one
  // consumer that genuinely cannot send a header. Query strings end up in
  // proxy logs, browser history and Referer headers, so accepting one
  // everywhere would be handing the secret out for convenience.
  if (request.nextUrl.pathname === STREAM_PATH) {
    const query = request.nextUrl.searchParams.get('token')
    if (query !== null && (await timingSafeEqual(query, token))) return true
  }
  // A browser cannot attach an Authorization header to a document request, and
  // EventSource cannot attach one at all — so without a cookie, token auth
  // locked people out of their own UI with a JSON 401 and no way to sign in.
  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  if (cookie && (await timingSafeEqual(cookie, token))) return true
  return false
}

function wantsHtml(request: NextRequest): boolean {
  if (request.nextUrl.pathname.startsWith('/api/')) return false
  return (request.headers.get('accept') || '').includes('text/html')
}

async function basicAllows(request: NextRequest, username: string, password: string): Promise<boolean> {
  const header = request.headers.get('authorization') || ''
  if (!header.toLowerCase().startsWith('basic ')) return false
  let decoded: string
  try {
    // atob returns one character per byte, i.e. Latin-1. Browsers encode Basic
    // credentials as UTF-8 and our own 401 advertises charset="UTF-8", so the
    // bytes have to be re-read as UTF-8 — otherwise an accent or an emoji in
    // WEBUI_USERNAME/WEBUI_PASSWORD can never authenticate.
    const bytes = Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0))
    decoded = new TextDecoder().decode(bytes)
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  const [user, pass] = [decoded.slice(0, separator), decoded.slice(separator + 1)]
  // Evaluate both so a wrong username costs the same time as a wrong password.
  const [userOk, passOk] = await Promise.all([
    timingSafeEqual(user, username),
    timingSafeEqual(pass, password),
  ])
  return userOk && passOk
}

export async function middleware(request: NextRequest) {
  if (isCrossSiteWrite(request)) {
    return NextResponse.json(
      {
        error: 'Cross-site request blocked',
        detail: 'State-changing requests must come from this origin.',
      },
      { status: 403 },
    )
  }

  const token = process.env.WEBUI_AUTH_TOKEN || ''
  const username = process.env.WEBUI_USERNAME || ''
  const password = process.env.WEBUI_PASSWORD || ''
  const basicConfigured = Boolean(username && password)

  if (!token && !basicConfigured) return NextResponse.next()

  if (token && (await tokenAllows(request, token))) return NextResponse.next()

  if (basicConfigured && (await basicAllows(request, username, password))) return NextResponse.next()

  // A browser asking for a page gets somewhere it can actually sign in. An API
  // client gets a machine-readable refusal.
  if (wantsHtml(request) && token && request.nextUrl.pathname !== '/sign-in') {
    const signIn = request.nextUrl.clone()
    signIn.pathname = '/sign-in'
    signIn.search = ''
    signIn.searchParams.set('next', request.nextUrl.pathname)
    return NextResponse.redirect(signIn)
  }

  const headers: Record<string, string> = {}
  if (basicConfigured) headers['WWW-Authenticate'] = 'Basic realm="gamdl", charset="UTF-8"'
  return NextResponse.json(
    { error: 'Unauthorized', detail: 'Provide the configured credentials (Bearer token, ?token= or Basic auth).' },
    { status: 401, headers }
  )
}

export const config = {
  // Everything except Next's own static assets; API routes included.
  //
  // api/health is deliberately public: compose's healthcheck fetches it from
  // inside the container with no credentials, so gating it would mark the
  // container unhealthy forever as soon as an operator sets WEBUI_AUTH_TOKEN.
  // It exposes nothing but heartbeat state and a version string.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/health|sign-in).*)'],
}
