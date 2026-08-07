'use client'

import * as React from 'react'
import { CheckCircle2, AlertCircle, Loader2, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type CookieState } from '@/lib/api'
import { formatAbsolute, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

export function AccountPage() {
  const [state, setState] = React.useState<CookieState | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    try {
      setState(await api.cookies())
    } catch {
      setState({ exists: false, activeFile: null, updatedAt: null, soonestExpiry: null, daysUntilExpiry: null, expired: false })
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const upload = async (file: File) => {
    setUploading(true)
    try {
      await api.uploadCookies(file)
      toast.success('Signed in', { description: 'Downloads can start on the next sync.' })
      await load()
    } catch (err) {
      toast.error('That file was not accepted', {
        description:
          err instanceof ApiError
            ? err.message
            : 'It should be a Netscape-format cookies.txt export.',
      })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async () => {
    try {
      await api.deleteCookies()
      toast.success('Sign-in removed')
      await load()
    } catch (err) {
      toast.error('Could not remove the cookie file', {
        description: err instanceof ApiError ? err.message : undefined,
      })
    }
  }

  const expiring =
    typeof state?.daysUntilExpiry === 'number' && state.daysUntilExpiry >= 0 && state.daysUntilExpiry < 7
  const expired = state?.expired ?? false
  const healthy = state?.exists && !expired

  return (
    <div className="space-y-6">
      <Card className="frost frost-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-headline">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
            Apple Music sign-in
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-5">
          {!state ? (
            <Skeleton className="h-16 rounded-md" />
          ) : (
            <div
              className={cn(
                'flex items-start gap-3 rounded-md border p-3.5',
                healthy && !expiring && 'border-success/40 bg-success/5',
                expiring && 'border-warning/40 bg-warning/5',
                (!state.exists || expired) && 'border-destructive/40 bg-destructive/5',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 shrink-0',
                  healthy && !expiring ? 'text-success' : expiring ? 'text-warning' : 'text-destructive',
                )}
              >
                {healthy && !expiring ? (
                  <CheckCircle2 className="size-5" aria-hidden="true" />
                ) : (
                  <AlertCircle className="size-5" aria-hidden="true" />
                )}
              </span>

              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-callout font-medium">
                  {!state.exists
                    ? 'Not signed in'
                    : expired
                      ? 'Sign-in expired'
                      : expiring
                        ? 'Sign-in expires soon'
                        : 'Signed in'}
                </p>
                <p className="text-footnote text-muted-foreground">
                  {!state.exists ? (
                    'Upload a cookies.txt export to let the downloader authenticate.'
                  ) : (
                    <>
                      Uploaded {formatRelative(state.updatedAt)}
                      {state.soonestExpiry ? (
                        <>
                          {' · '}
                          {expired ? 'expired' : 'expires'} {formatRelative(state.soonestExpiry)}
                          <span className="hidden sm:inline"> ({formatAbsolute(state.soonestExpiry)})</span>
                        </>
                      ) : null}
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/*
              A real <input type="file"> driven by a real <button>. v1 hid the
              input inside a <label> with display:none, which removed it from the
              tab order entirely — the page was unusable without a mouse.
            */}
            <input
              ref={inputRef}
              type="file"
              accept=".txt,text/plain"
              className="sr-only"
              // The visible Button is the control; this is only a click proxy.
              // Left tabbable it was a second, differently-named tab stop
              // announcing the browser's own "Choose File".
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
              }}
            />
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="gap-2"
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {state?.exists ? 'Replace cookies.txt' : 'Upload cookies.txt'}
            </Button>

            {state?.exists ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" className="gap-2 text-muted-foreground">
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                </DialogTrigger>
                <DialogContent className="frost frost-elevated sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Remove the stored sign-in?</DialogTitle>
                    <DialogDescription>
                      Downloads stop until a new cookies.txt is uploaded. Music already on disk is
                      untouched.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="gap-2 sm:gap-2">
                    <DialogClose asChild>
                      <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button variant="destructive" onClick={() => void remove()}>
                        Remove
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="frost frost-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-headline">How to export cookies</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-footnote text-muted-foreground">
            {[
              'Sign in to music.apple.com in your browser with an active Apple Music subscription.',
              'Install a cookies.txt exporter extension for your browser (search the extension store for “cookies.txt”).',
              'With music.apple.com open, use the extension to export cookies for that site in Netscape format.',
              'Upload the resulting .txt file above.',
            ].map((step, index) => (
              <li key={index} className="flex gap-3">
                <span
                  className="tnum flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium text-foreground"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="pt-px">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 rounded-md bg-muted/50 p-3 text-caption text-muted-foreground">
            The file is stored at <code className="font-mono">/config/cookies.txt</code> with owner-only
            permissions and never leaves your server. It grants access to your Apple Music account,
            so treat it like a password.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
