'use client'

import * as React from 'react'
import { CircleDashed, CircleSlash, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { SidebarMenuButton } from '@/components/ui/sidebar'
import { api, ApiError } from '@/lib/api'
import { useStatus } from '@/hooks/use-status'
import { formatRelative } from '@/lib/format'

/*
 * The rail's "is anything happening?" indicator, and the fastest path to a
 * manual sync. Both states are labelled, so the collapsed rail never reduces to
 * an unexplained coloured dot.
 */
export function DownloaderPill() {
  const { data, refresh } = useStatus()
  const [syncing, setSyncing] = React.useState(false)

  const downloader = data?.downloader
  const active = (data?.summary.running ?? 0) > 0
  const offline = data ? !downloader?.alive : false

  const label = offline
    ? 'Downloader offline'
    : active
      ? `Syncing ${data?.summary.running}`
      : 'Sync now'

  const Icon = offline ? CircleSlash : active ? Loader2 : syncing ? Loader2 : RefreshCw

  const onSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await api.sync()
      toast.success('Sync started', { description: 'The downloader is picking it up now.' })
      // The daemon polls the control directory about once a second; give it a
      // beat before asking for status so the UI does not flash "idle" first.
      setTimeout(() => void refresh(), 1500)
    } catch (err) {
      toast.error('Could not start a sync', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    } finally {
      setSyncing(false)
    }
  }

  const detail = offline
    ? downloader?.lastHeartbeat
      ? `Last seen ${formatRelative(downloader.lastHeartbeat)}`
      : 'No heartbeat yet'
    : active
      ? downloader?.detail || 'Downloading'
      : 'Run a sync now'

  return (
    <SidebarMenuButton
      onClick={onSync}
      disabled={offline || syncing}
      tooltip={{ children: `${label} — ${detail}`, side: 'right' }}
      aria-label={`${label}. ${detail}.`}
      className="text-muted-foreground"
    >
      {data ? (
        <Icon className={active || syncing ? 'animate-spin' : undefined} />
      ) : (
        <CircleDashed className="opacity-50" />
      )}
      <span className="truncate">{data ? label : 'Connecting…'}</span>
    </SidebarMenuButton>
  )
}
