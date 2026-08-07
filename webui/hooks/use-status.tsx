'use client'

import * as React from 'react'
import { api, ApiError, type StatusSnapshot } from '@/lib/api'

/*
 * One polling loop for the whole app.
 *
 * v1 ran two independent intervals that kept ticking on tabs where their data
 * was never rendered, and neither paused when the tab went to the background.
 * This hook polls a single ETag'd endpoint, backs off when the page is hidden,
 * and speeds up while something is actually syncing — which is the only time
 * fresh data matters.
 */

const ACTIVE_MS = 3_000
const IDLE_MS = 15_000
const HIDDEN_MS = 60_000

export interface StatusState {
  data: StatusSnapshot | null
  error: string | null
  /** True only before the first successful load, so skeletons show once. */
  loading: boolean
  refresh: () => Promise<void>
  mutate: (update: (previous: StatusSnapshot) => StatusSnapshot) => void
}

export function useStatus(): StatusState {
  const [data, setData] = React.useState<StatusSnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  // Held in a ref so the polling effect does not restart on every tick.
  const dataRef = React.useRef<StatusSnapshot | null>(null)
  dataRef.current = data

  const refresh = React.useCallback(async () => {
    try {
      const snapshot = await api.status()
      setData(snapshot)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load status')
    } finally {
      setLoading(false)
    }
  }, [])

  const mutate = React.useCallback((update: (previous: StatusSnapshot) => StatusSnapshot) => {
    setData((previous) => (previous ? update(previous) : previous))
  }, [])

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    const interval = () => {
      if (document.hidden) return HIDDEN_MS
      const snapshot = dataRef.current
      return snapshot && snapshot.summary.running > 0 ? ACTIVE_MS : IDLE_MS
    }

    const tick = async () => {
      if (cancelled) return
      await refresh()
      if (cancelled) return
      timer = setTimeout(tick, interval())
    }

    void tick()

    // Coming back to the tab should show current data immediately, not after a
    // full minute of the background cadence.
    const onVisible = () => {
      if (document.hidden) return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { data, error, loading, refresh, mutate }
}
