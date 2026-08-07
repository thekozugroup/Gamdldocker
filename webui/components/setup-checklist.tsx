'use client'

import Link from 'next/link'
import { AlertTriangle, ArrowRight, AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { StatusSnapshot } from '@/lib/api'
import { formatCount, formatRelative } from '@/lib/format'

/*
 * The "why isn't it downloading?" banner.
 *
 * Almost every support question for this stack has one of three answers: no
 * cookies, expired cookies, or the downloader container is not running. Rather
 * than making people find that in a log, the one blocking problem is stated at
 * the top of the page with the fix one click away. Nothing renders when there is
 * nothing wrong.
 */
export function SetupChecklist({ snapshot }: { snapshot: StatusSnapshot }) {
  const issue = firstIssue(snapshot)
  if (!issue) return null

  return (
    <div
      role="status"
      className="frost frost-elevated flex flex-col gap-3 rounded-lg border border-warning/40 p-4 sm:flex-row sm:items-center"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
        {issue.severity === 'blocking' ? (
          <AlertCircle className="size-5" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-5" aria-hidden="true" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-callout font-medium">{issue.title}</p>
        <p className="text-footnote text-muted-foreground">{issue.detail}</p>
      </div>

      {issue.href ? (
        <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Link href={issue.href}>
            {issue.action}
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

interface Issue {
  title: string
  detail: string
  severity: 'blocking' | 'warning'
  href?: string
  action?: string
}

function firstIssue(snapshot: StatusSnapshot): Issue | null {
  const { downloader, cookies, playlists } = snapshot

  if (!downloader.alive) {
    return {
      title: 'The downloader is not responding',
      detail: downloader.lastHeartbeat
        ? `Last heartbeat ${formatRelative(downloader.lastHeartbeat)}. Check the container logs.`
        : 'No heartbeat yet. The gamdl-downloader container may still be starting, or it may have failed.',
      severity: 'blocking',
      href: '/activity',
      action: 'View logs',
    }
  }

  if (!cookies.exists) {
    return {
      title: 'Apple Music sign-in required',
      detail: 'Downloads cannot start until you upload a cookies.txt export from your browser.',
      severity: 'blocking',
      href: '/account',
      action: 'Set up',
    }
  }

  if (cookies.expired) {
    return {
      title: 'Your Apple Music cookies expired',
      detail: `They lapsed ${formatRelative(cookies.soonestExpiry)}. Export a fresh cookies.txt to resume downloads.`,
      severity: 'blocking',
      href: '/account',
      action: 'Replace',
    }
  }

  if (typeof cookies.daysUntilExpiry === 'number' && cookies.daysUntilExpiry < 7) {
    return {
      title: 'Your Apple Music cookies expire soon',
      detail: `About ${formatCount(Math.max(0, cookies.daysUntilExpiry), 'day')} left. Replacing them now avoids a gap in syncing.`,
      severity: 'warning',
      href: '/account',
      action: 'Replace',
    }
  }

  const failed = playlists.filter((p) => p.status === 'failed')
  if (failed.length > 0) {
    return {
      title: `${failed.length} playlist${failed.length === 1 ? '' : 's'} failed to sync`,
      // The daemon already turns gamdl's output into one actionable sentence.
      detail: failed[0].lastError || 'See the activity log for the reason.',
      severity: 'warning',
      href: '/activity',
      action: 'View logs',
    }
  }

  return null
}
