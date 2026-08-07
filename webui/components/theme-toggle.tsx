'use client'

import * as React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

import { SidebarMenuButton } from '@/components/ui/sidebar'

type ThemeMode = 'light' | 'dark' | 'system'

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(mode: ThemeMode) {
  const dark = resolve(mode) === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  // Tells the browser to draw native form controls and scrollbars to match.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function ThemeToggle() {
  // Starts as null so the first render matches what ThemeScript already put on
  // <html>; committing to a value before hydration would cause a mismatch.
  const [mode, setMode] = React.useState<ThemeMode | null>(null)

  React.useEffect(() => {
    const stored = localStorage.getItem('theme-mode') as ThemeMode | null
    setMode(stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system')
  }, [])

  React.useEffect(() => {
    if (mode === null) return
    localStorage.setItem('theme-mode', mode)
    apply(mode)

    if (mode !== 'system') return
    // Follow the OS while it is the chosen source of truth.
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [mode])

  const index = Math.max(0, MODES.findIndex((m) => m.value === mode))
  const active = MODES[index]
  const next = MODES[(index + 1) % MODES.length]
  const Icon = active.icon

  return (
    <SidebarMenuButton
      onClick={() => setMode(next.value)}
      tooltip={{ children: `Appearance: ${active.label}`, side: 'right' }}
      aria-label={`Appearance: ${active.label}. Switch to ${next.label}.`}
      className="text-muted-foreground"
    >
      <Icon />
      <span>{active.label}</span>
    </SidebarMenuButton>
  )
}
