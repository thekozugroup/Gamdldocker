// Thin alias of /api/sync, kept only so bookmarks and scripts that POSTed to
// /api/download in v1 keep working. New callers should use /api/sync.
import { POST as syncPost } from '@/app/api/sync/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return syncPost(request)
}
