import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { AppShell } from '@/components/app-shell'
import { ThemeScript } from '@/components/theme-script'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Gamdl',
    template: '%s · Gamdl',
  },
  description: 'Keep your Apple Music playlists mirrored to a local library.',
  applicationName: 'Gamdl',
  // The UI is entirely private state behind an optional token; nothing here
  // belongs in a search index.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfc' },
    { media: '(prefers-color-scheme: dark)', color: '#141416' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Read on the server so the rail renders in its remembered state on the very
  // first paint. v1 wrote this cookie and never read it, so the sidebar sprang
  // open on every navigation.
  const sidebarOpen = cookies().get('sidebar_state')?.value !== 'false'

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans">
        {/*
          The first tab stop on every route was the Library nav link, six or
          seven presses from the content.
        */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <AppShell defaultSidebarOpen={sidebarOpen}>{children}</AppShell>
        <Toaster />
      </body>
    </html>
  )
}
