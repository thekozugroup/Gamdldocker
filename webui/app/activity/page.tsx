'use client'

import * as React from 'react'
import { ArrowDownToLine, Loader2, Pause, Play, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const MAX_LINES = 2000

/*
 * The log view.
 *
 * The daemon writes to /config/logs/downloader.log, which both containers share,
 * so this reads a file rather than shelling out to `docker logs` — that was the
 * only reason the web container ever needed the docker socket. Streaming comes
 * from Server-Sent Events, with a polling fallback if the stream cannot open.
 */
export default function ActivityPage() {
  const [lines, setLines] = React.useState<string[]>([])
  const [connected, setConnected] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [follow, setFollow] = React.useState(true)

  const viewport = React.useRef<HTMLPreElement>(null)
  const pausedRef = React.useRef(paused)
  pausedRef.current = paused

  // Seed with history, then attach the live stream.
  React.useEffect(() => {
    let cancelled = false
    void api
      .logs(600)
      .then((result) => {
        if (!cancelled) setLines(result.logs ? result.logs.split('\n') : [])
      })
      .catch(() => {
        if (!cancelled) setLines(['Could not read the log file.'])
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let source: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | undefined

    const startPolling = () => {
      if (pollTimer) return
      pollTimer = setInterval(() => {
        if (pausedRef.current || document.hidden) return
        void api
          .logs(600)
          .then((result) => setLines(result.logs ? result.logs.split('\n') : []))
          .catch(() => undefined)
      }, 10_000)
    }

    try {
      source = new EventSource('/api/logs/stream')
      source.onopen = () => setConnected(true)
      source.onmessage = (event) => {
        if (pausedRef.current) return
        setLines((previous) => {
          const next = [...previous, ...String(event.data).split('\n')]
          // Bound the DOM: an all-night sync would otherwise accumulate tens of
          // thousands of nodes and make the page unresponsive.
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
        })
      }
      source.onerror = () => {
        setConnected(false)
        source?.close()
        startPolling()
      }
    } catch {
      startPolling()
    }

    return () => {
      source?.close()
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [])

  const visible = React.useMemo(() => {
    if (!filter.trim()) return lines
    const needle = filter.toLowerCase()
    return lines.filter((line) => line.toLowerCase().includes(needle))
  }, [lines, filter])

  React.useEffect(() => {
    if (!follow || paused) return
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
  }, [visible, follow, paused])

  const download = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = 'gamdl-downloader.log'
    anchor.click()
    URL.revokeObjectURL(href)
  }

  return (
    <Card className="frost frost-elevated flex h-[calc(100vh-9rem)] flex-col overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 space-y-0 border-b py-3">
        <CardTitle className="flex items-center gap-2 text-headline">
          Activity
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-normal',
              connected ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                connected ? 'bg-success' : 'bg-muted-foreground',
              )}
              aria-hidden="true"
            />
            {connected ? 'Live' : 'Polling'}
          </span>
        </CardTitle>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <label htmlFor="log-filter" className="sr-only">
              Filter log lines
            </label>
            <Input
              id="log-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter…"
              className="h-8 w-40 pl-8 text-footnote"
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setPaused((value) => !value)}
                aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
                aria-pressed={paused}
              >
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{paused ? 'Resume' : 'Pause'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={download}
                aria-label="Download the log as a file"
              >
                <ArrowDownToLine className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download log</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 p-0">
        <pre
          ref={viewport}
          tabIndex={0}
          aria-label="Downloader log output"
          onScroll={(event) => {
            const element = event.currentTarget
            // Scrolling up means "let me read"; scrolling back to the bottom
            // means "keep following". Never yank the view away mid-read.
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40
            setFollow(atBottom)
          }}
          className="h-full overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-4 font-mono text-caption leading-relaxed text-muted-foreground"
        >
          {visible.length === 0 ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {filter ? 'No lines match that filter.' : 'Waiting for output…'}
            </span>
          ) : (
            visible.join('\n')
          )}
        </pre>
      </CardContent>
    </Card>
  )
}
