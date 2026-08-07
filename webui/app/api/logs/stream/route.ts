// Server-Sent Events tail of the downloader log so the UI can stop polling.
// The stream stats the file once a second and only reads the bytes appended
// since the last tick; log rotation (size shrink) restarts from the top.
import fsp from 'fs/promises'
import { readTextTail } from '@/lib/fsx'
import { DOWNLOADER_LOG } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_MS = 1000
const HEARTBEAT_MS = 15000
const INITIAL_LINES = 100
// One tick will never ship more than this, so a hung client cannot make us
// buffer an unbounded backlog.
const MAX_CHUNK_BYTES = 256 * 1024

function sseEvent(event: string, data: string): string {
  const body = data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')
  return `event: ${event}\n${body}\n\n`
}

export async function GET(request: Request) {
  const encoder = new TextEncoder()
  let offset = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastBeat = Date.now()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)))
      }

      const initial = await readTextTail(DOWNLOADER_LOG, INITIAL_LINES)
      if (initial === null) {
        send('info', `No log file at ${DOWNLOADER_LOG} yet — waiting for the downloader to start.`)
      } else {
        send('log', initial)
        offset = (await fsp.stat(DOWNLOADER_LOG).catch(() => null))?.size ?? 0
      }

      const tick = async () => {
        if (request.signal.aborted) {
          close()
          return
        }
        try {
          const stat = await fsp.stat(DOWNLOADER_LOG).catch(() => null)
          if (stat) {
            if (stat.size < offset) offset = 0
            if (stat.size > offset) {
              const want = Math.min(stat.size - offset, MAX_CHUNK_BYTES)
              const handle = await fsp.open(DOWNLOADER_LOG, 'r')
              try {
                const buffer = Buffer.alloc(want)
                await handle.read(buffer, 0, want, offset)
                offset += want
                send('log', buffer.toString('utf-8'))
              } finally {
                await handle.close()
              }
            }
          }
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            lastBeat = Date.now()
            // Comment line: keeps proxies from timing the connection out.
            controller.enqueue(encoder.encode(`: keepalive ${new Date().toISOString()}\n\n`))
          }
          timer = setTimeout(tick, POLL_MS)
        } catch {
          close()
        }
      }

      const close = () => {
        if (timer) clearTimeout(timer)
        timer = null
        try {
          controller.close()
        } catch {
          // already closed by the cancel handler
        }
      }

      request.signal.addEventListener('abort', close)
      timer = setTimeout(tick, POLL_MS)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
