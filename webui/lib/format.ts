/*
 * Shared display formatting. Kept in one place so a duration reads the same on
 * the library page as it does in the activity log.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "Just now", "12 minutes ago", or an absolute date once it stops being useful. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Never'

  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)

  if (abs < 45) return 'Just now'
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour')
  if (abs < 604800) return RELATIVE.format(Math.round(seconds / 86400), 'day')

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A full timestamp for tooltips, where precision beats brevity. */
export function formatAbsolute(value: string | null | undefined): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString()
}

/** Turns a seconds interval into something a human would say out loud. */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86400) {
    const hours = seconds / 3600
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
  }
  const days = seconds / 86400
  return `${Number.isInteger(days) ? days : days.toFixed(1)} days`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`
}

/**
 * Shortens a URL to the part that identifies the playlist.
 * The full URL is always available in a title attribute; the row just should not
 * be dominated by 70 characters of storefront path.
 */
export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const id = parts[parts.length - 1] ?? ''
    return `${parsed.hostname}/…/${id}`
  } catch {
    return url
  }
}
