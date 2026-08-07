import { cn } from '@/lib/utils'

/*
 * A single number with its label. Tabular figures matter here: without them the
 * count jitters horizontally every time a digit changes during a sync.
 */
export function StatTile({
  label,
  value,
  display,
  hint,
  tone,
}: {
  label: string
  value?: number
  display?: string
  hint?: string
  tone?: 'active'
}) {
  return (
    <div
      className={cn(
        'frost frost-elevated rounded-lg border p-4',
        tone === 'active' && 'ring-1 ring-primary/30',
      )}
    >
      <p className="text-caption uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('tnum mt-1 text-title2', tone === 'active' && 'text-primary')}>
        {display ?? (value ?? 0).toLocaleString()}
      </p>
      {hint ? <p className="mt-0.5 text-caption text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
