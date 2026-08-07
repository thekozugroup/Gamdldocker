'use client'

import * as React from 'react'
import { AlertTriangle, CheckCircle2, Circle, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Playlist } from '@/lib/api'
import { formatAbsolute, formatCount, formatRelative, shortenUrl } from '@/lib/format'
import { cn } from '@/lib/utils'

/*
 * Status is carried by an icon *and* a colour *and* a word. Colour alone fails
 * for the ~4% of users with a colour-vision deficiency, and v1's bare coloured
 * dot was the only signal in the compact layout.
 */
const STATUS = {
  running: { icon: Loader2, label: 'Syncing', tone: 'text-primary', spin: true },
  complete: { icon: CheckCircle2, label: 'Synced', tone: 'text-success', spin: false },
  partial: { icon: AlertTriangle, label: 'Partial', tone: 'text-warning', spin: false },
  failed: { icon: XCircle, label: 'Failed', tone: 'text-destructive', spin: false },
  idle: { icon: Circle, label: 'Waiting', tone: 'text-muted-foreground', spin: false },
} as const

export function PlaylistRow({
  playlist,
  onRemove,
  onSync,
  busy,
}: {
  playlist: Playlist
  onRemove: (url: string) => void
  onSync: (url: string) => void
  busy?: boolean
}) {
  const status = STATUS[playlist.status] ?? STATUS.idle
  const StatusIcon = status.icon
  const progress = playlist.progress
  const showProgress = playlist.status === 'running' && progress && progress.total > 0
  const percent = showProgress ? Math.min(100, (progress.current / progress.total) * 100) : 0

  return (
    <li
      className={cn(
        'group relative flex items-center gap-4 px-4 py-3.5 transition-colors ease-hig',
        'hover:bg-muted/50',
        busy && 'pointer-events-none opacity-50',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('flex size-5 shrink-0 items-center justify-center', status.tone)}>
            <StatusIcon className={cn('size-4', status.spin && 'animate-spin')} aria-hidden="true" />
            <span className="sr-only">{status.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          {playlist.lastError ? `${status.label} — ${playlist.lastError}` : status.label}
        </TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <p className="truncate text-callout font-medium leading-snug">{playlist.name}</p>

        {showProgress ? (
          <div className="mt-1.5 flex items-center gap-2">
            <div
              className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={progress.current}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-label={`${playlist.name} sync progress`}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-hig"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="tnum shrink-0 text-caption text-muted-foreground">
              {progress.current}/{progress.total}
            </span>
          </div>
        ) : (
          <>
            {/*
              Below md the right-hand meta column is hidden for width, so the
              counts move here. Without this, a phone shows no track count at
              all — the single most useful fact about a playlist.
            */}
            <p className="truncate text-caption text-muted-foreground md:hidden">
              {playlist.songCount ? formatCount(playlist.songCount, 'track') : 'Not synced yet'}
              {(playlist.missingCount ?? 0) > 0 ? (
                <span className="text-warning"> · {playlist.missingCount} missing</span>
              ) : playlist.lastDownloaded ? (
                <span> · {formatRelative(playlist.lastDownloaded)}</span>
              ) : null}
            </p>
            <p
              className="hidden truncate font-mono text-caption text-muted-foreground md:block"
              title={playlist.url}
            >
              {shortenUrl(playlist.url)}
            </p>
          </>
        )}
      </div>

      <div className="hidden shrink-0 text-right md:block">
        <p className="tnum text-footnote text-muted-foreground">
          {playlist.songCount ? formatCount(playlist.songCount, 'track') : '—'}
        </p>
        {(playlist.missingCount ?? 0) > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="tnum text-caption text-warning">{playlist.missingCount} missing</p>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              These tracks are in the playlist but not on disk — usually unavailable in your
              storefront. They are left out of the .m3u8 so players do not show dead entries.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-caption text-muted-foreground">
                {formatRelative(playlist.lastDownloaded)}
              </p>
            </TooltipTrigger>
            <TooltipContent side="left">
              Last synced {formatAbsolute(playlist.lastDownloaded)}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onSync(playlist.url)}
            disabled={playlist.status === 'running'}
            className={cn(
              'size-9 shrink-0 text-muted-foreground opacity-60 transition-opacity ease-hig',
              'hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
              '[@media(hover:none)]:opacity-100',
            )}
            aria-label={`Sync ${playlist.name} now`}
          >
            <RefreshCw className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Sync this playlist now</TooltipContent>
      </Tooltip>

      {/*
        Removal is destructive and irreversible from the UI's point of view, so
        it asks first and names the playlist. v1 deleted on a single click of a
        28px icon with no confirmation and no undo.
      */}
      <Dialog>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  // Never fully hidden: a touch device has no hover state, so
                  // opacity-0 left the only way to remove a playlist
                  // undiscoverable on a phone. Dimmed, then full on
                  // hover/focus, and always solid where hover does not exist.
                  'size-9 shrink-0 text-muted-foreground opacity-60 transition-opacity ease-hig',
                  'hover:bg-destructive/10 hover:text-destructive',
                  'focus-visible:opacity-100 group-hover:opacity-100',
                  '[@media(hover:none)]:opacity-100',
                )}
                aria-label={`Remove ${playlist.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="left">Remove</TooltipContent>
        </Tooltip>

        <DialogContent className="frost frost-elevated sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove “{playlist.name}”?</DialogTitle>
            <DialogDescription>
              It stops syncing and disappears from this list. Music already downloaded stays on
              disk; the playlist file is moved to the <code>.trash</code> folder next to it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive" onClick={() => onRemove(playlist.url)}>
                Remove playlist
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}
