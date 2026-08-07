import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { Music2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SESSION_COOKIE } from '@/middleware'

export const dynamic = 'force-dynamic'

/*
 * The one page outside the auth check.
 *
 * It exists because a browser cannot put an Authorization header on a document
 * request, and EventSource cannot send one at all — so with only header auth,
 * setting WEBUI_AUTH_TOKEN made the UI unreachable from a browser. Submitting
 * here stores the token in an httpOnly cookie that every subsequent request,
 * including the log stream, carries automatically.
 */
export default function SignInPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string }
}) {
  async function signIn(formData: FormData) {
    'use server'
    const token = process.env.WEBUI_AUTH_TOKEN || ''
    const supplied = String(formData.get('token') || '')
    const next = String(formData.get('next') || '/')
    // Only same-origin paths, so a crafted link cannot bounce someone offsite.
    const target = next.startsWith('/') && !next.startsWith('//') ? next : '/'

    if (!token || supplied !== token) {
      redirect(`/sign-in?error=1&next=${encodeURIComponent(target)}`)
    }

    cookies().set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    redirect(target)
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <form
        action={signIn}
        className="frost frost-elevated w-full max-w-sm space-y-5 rounded-lg border p-6"
      >
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Music2 className="size-4" />
          </span>
          <div>
            <h1 className="text-headline">Sign in</h1>
            <p className="text-footnote text-muted-foreground">
              This instance requires an access token.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="token" className="text-footnote font-medium">
            Access token
          </label>
          <Input
            id="token"
            name="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="font-mono text-footnote"
          />
          <p className="text-caption text-muted-foreground">
            The value of <code className="font-mono">WEBUI_AUTH_TOKEN</code> in your{' '}
            <code className="font-mono">.env</code>.
          </p>
        </div>

        <input type="hidden" name="next" value={searchParams.next || '/'} />

        {searchParams.error ? (
          <p role="alert" className="text-footnote text-destructive">
            That token was not accepted.
          </p>
        ) : null}

        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  )
}
