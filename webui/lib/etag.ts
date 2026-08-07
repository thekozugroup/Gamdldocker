// Cheap conditional-GET support for the endpoints the dashboard polls: hash
// the JSON payload into a weak ETag and answer 304 when the client already has
// that exact snapshot, so an idle dashboard costs bytes instead of kilobytes.
import crypto from 'crypto'
import { NextResponse } from 'next/server'

export function weakEtag(payload: unknown): string {
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('base64url')
  return `W/"${hash}"`
}

export function jsonWithEtag(request: Request, payload: unknown, init?: ResponseInit): NextResponse {
  const etag = weakEtag(payload)
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch.split(',').map((v) => v.trim()).includes(etag)) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } })
  }
  const response = NextResponse.json(payload, init)
  response.headers.set('ETag', etag)
  response.headers.set('Cache-Control', 'no-cache')
  return response
}
