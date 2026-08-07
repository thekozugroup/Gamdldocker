'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, ListMusic, Music2, ShieldCheck, SlidersHorizontal } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/theme-toggle'
import { DownloaderPill } from '@/components/downloader-pill'
import { cn } from '@/lib/utils'

/*
 * The four destinations are the whole app. v1 rendered them twice — once in the
 * sidebar and again in a full-width tab bar — which meant two competing sources
 * of truth for "where am I" and a wasted row of vertical space on every page.
 * The rail is now the only primary navigation.
 */
const NAV = [
  { href: '/', label: 'Library', icon: ListMusic, hint: 'Your playlists' },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal, hint: 'How and where things download' },
  { href: '/account', label: 'Account', icon: ShieldCheck, hint: 'Apple Music sign-in' },
  { href: '/activity', label: 'Activity', icon: Activity, hint: 'Live log output' },
] as const

export function AppShell({
  children,
  defaultSidebarOpen = true,
}: {
  children: React.ReactNode
  defaultSidebarOpen?: boolean
}) {
  const pathname = usePathname()
  const current = NAV.find((item) =>
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
  )

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      {/*
        collapsible="icon" is the point of the whole layout: collapsing leaves a
        labelled icon rail rather than removing navigation from the screen.
      */}
      <Sidebar collapsible="icon" className="frost frost-edge border-r">
        <SidebarHeader className="h-14 justify-center px-2">
          <div className="flex items-center gap-2 px-1">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
              aria-hidden="true"
            >
              <Music2 className="size-4" />
            </span>
            <span className="truncate text-headline group-data-[collapsible=icon]:hidden">
              Gamdl
            </span>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              {/*
                A real <nav> landmark with an accessible name, so screen-reader
                users can jump straight here.
              */}
              <nav aria-label="Main">
                <SidebarMenu>
                  {NAV.map((item) => {
                    const Icon = item.icon
                    const active = current?.href === item.href
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          // Shows the label when the rail is collapsed; without
                          // it a collapsed rail is four unlabelled glyphs.
                          tooltip={{ children: item.label, side: 'right' }}
                        >
                          <Link href={item.href} aria-current={active ? 'page' : undefined}>
                            <Icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="gap-2 pb-3">
          <DownloaderPill />
          <ThemeToggle />
        </SidebarFooter>

        {/* Drag handle on the sidebar edge — the affordance people reach for. */}
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0">
        <header
          className={cn(
            'frost frost-edge sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3',
            'border-b px-4 lg:px-6',
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarTrigger className="-ml-1" />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Toggle sidebar <kbd className="ml-1 opacity-70">⌘B</kbd>
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-5" />

          <h1 className="truncate text-headline">{current?.label ?? 'Gamdl'}</h1>
          <p className="hidden truncate text-footnote text-muted-foreground sm:block">
            {current?.hint}
          </p>
        </header>

        {/*
          A div, not a <main>: SidebarInset already renders one, and two main
          landmarks make screen-reader landmark navigation ambiguous.
        */}
        <div
          id="content"
          className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 lg:px-8 lg:py-8"
          style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
