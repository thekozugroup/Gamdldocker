'use client'

import * as React from 'react'

import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/*
 * The settings vocabulary. Three shapes cover every control on the page, which
 * keeps label placement, description tone and spacing identical throughout —
 * the thing HIG cares about most in a form.
 */

export function SettingGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="space-y-1">
        <h2 id={headingId} className="text-title3">
          {title}
        </h2>
        {description ? (
          <p className="max-w-2xl text-footnote text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="frost frost-elevated divide-y overflow-hidden rounded-lg border">
        {children}
      </div>
    </section>
  )
}

export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  stacked,
}: {
  label: string
  description?: React.ReactNode
  htmlFor?: string
  /**
   * Either a node, or a function given the generated ids. Callers that render
   * their own control take the function form so the label and description
   * actually attach to it — a bare `htmlFor` that no field claims produced a
   * label pointing at nothing and an input with no accessible name.
   */
  children: React.ReactNode | ((ids: { id: string; describedBy?: string }) => React.ReactNode)
  /** Put the control on its own line — for wide inputs like file paths. */
  stacked?: boolean
}) {
  const generatedId = React.useId()
  const descriptionId = React.useId()
  const id = htmlFor ?? generatedId
  return (
    <div
      className={cn(
        'gap-3 p-4',
        stacked ? 'flex flex-col' : 'flex flex-col sm:flex-row sm:items-center sm:justify-between',
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="block text-callout font-medium">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="max-w-xl text-footnote text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className={cn('shrink-0', stacked && 'w-full')}>
        {typeof children === 'function'
          ? children({ id, describedBy: description ? descriptionId : undefined })
          : children}
      </div>
    </div>
  )
}

export function SettingSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  const id = React.useId()
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  )
}

/*
 * A segmented picker. v1 built these from plain buttons whose only selected-state
 * signal was a background colour — invisible to a screen reader and to anyone
 * who cannot distinguish the two shades. This is a real radiogroup.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
  describedBy,
}: {
  label: string
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  columns?: boolean
  describedBy?: string
}) {
  const groupId = React.useId()
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  /*
   * The APG radiogroup contract: one tab stop for the whole group, arrows to
   * move between options. Declaring role="radiogroup" without it was worse than
   * using plain buttons — it promised a keyboard model that did not exist, and
   * every option was its own tab stop.
   */
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (forward ? 1 : -1) + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        'inline-flex gap-1 rounded-md bg-muted p-1',
        columns ? 'flex w-full flex-col' : 'flex-wrap',
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        const hintId = option.hint ? `${groupId}-${index}` : undefined
        return (
          <React.Fragment key={option.value}>
            <button
              ref={(node) => {
                refs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={hintId}
              // Roving tabindex: the group is one stop, arrows move within it.
              tabIndex={index === selectedIndex ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClick={() => onChange(option.value)}
              className={cn(
                'min-h-9 rounded px-3 py-1.5 text-footnote font-medium transition-colors ease-hig',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
            {/* title= is invisible to keyboard and screen-reader users. */}
            {hintId ? (
              <span id={hintId} className="sr-only">
                {option.hint}
              </span>
            ) : null}
          </React.Fragment>
        )
      })}
    </div>
  )
}

/**
 * A number field that tolerates an empty box.
 *
 * v1 used `Number(e.target.value) || 3600`, so clearing the field to type a new
 * value snapped it back to the default mid-keystroke. Here the raw text is held
 * while editing and only committed on blur.
 */
export function NumberField({
  id,
  value,
  onCommit,
  min,
  max,
  suffix,
  className,
}: {
  id?: string
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  suffix?: string
  className?: string
}) {
  const [draft, setDraft] = React.useState(String(value))
  const [editing, setEditing] = React.useState(false)

  React.useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    let next = Math.round(parsed)
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    setDraft(String(next))
    onCommit(next)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        className={cn(
          'tnum h-9 w-28 rounded-md border border-input bg-background px-3 text-right text-footnote',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      />
      {suffix ? <span className="text-footnote text-muted-foreground">{suffix}</span> : null}
    </div>
  )
}
