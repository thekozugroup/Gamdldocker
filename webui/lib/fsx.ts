// Shared-file primitives, matching downloader/gamdl_sync/state.py: every write
// is temp-file + fsync + rename so a reader never observes a torn file, and
// read-modify-write cycles are serialised through a sidecar lockfile.
//
// Locking: both sides race for the SAME `<path>.lock` file using O_EXCL, which
// is the one primitive Node and Python both have — Node has no flock binding and
// a native dependency is off the table. An earlier version had the daemon take
// an flock on `<path>.lock` while this side took an O_EXCL lock on
// `<path>.webui.lock`; two mechanisms on two filenames are two locks that never
// exclude each other, which is worse than no lock because the code reads as
// though it is safe. LOCK_STALE_MS must stay equal to LOCK_STALE_SECONDS in
// downloader/gamdl_sync/state.py, or the two sides will disagree about when a
// lock left behind by a crashed process may be broken.
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

const LOCK_SUFFIX = '.lock'
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 50

async function acquireLock(target: string): Promise<string> {
  const lockPath = target + LOCK_SUFFIX
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      await handle.close()
      return lockPath
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const stat = await fsp.stat(lockPath).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // The holder died without releasing; break the lock and retry.
        await fsp.unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        // Same posture as state.py: proceeding unlocked beats wedging every
        // request behind a lock nobody will ever release.
        return ''
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

export async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = await acquireLock(target)
  try {
    return await fn()
  } finally {
    if (lockPath) await fsp.unlink(lockPath).catch(() => {})
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await fsp.readFile(filePath, 'utf-8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt shared file is an annoyance, not an outage.
    return fallback
  }
}

export async function atomicWriteText(filePath: string, text: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const handle = await fsp.open(tmp, 'w', mode ?? 0o644)
  try {
    await handle.writeFile(text, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (mode !== undefined) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, filePath)
    await fsyncDir(dir)
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
}

export async function atomicWriteJson(filePath: string, data: unknown, mode?: number): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2) + '\n', mode)
}

async function fsyncDir(dir: string): Promise<void> {
  // Persist the rename itself; best-effort because some filesystems refuse
  // directory fds.
  let fd: number | null = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // ignored
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

// How many bytes we are willing to pull in per requested line before giving up
// on finding earlier line breaks. Log lines are ~200 bytes; 512 is generous.
const TAIL_BYTES_PER_LINE = 512
const TAIL_MAX_BYTES = 4 * 1024 * 1024

export async function readTextTail(filePath: string, lines: number): Promise<string | null> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const want = Math.min(size, Math.min(TAIL_MAX_BYTES, Math.max(1, lines) * TAIL_BYTES_PER_LINE))
    const buffer = Buffer.alloc(want)
    await handle.read(buffer, 0, want, size - want)
    let text = buffer.toString('utf-8')
    if (want < size) {
      // We started mid-line; drop the partial first line.
      const firstBreak = text.indexOf('\n')
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : text
    }
    const all = text.split('\n')
    if (all.length && all[all.length - 1] === '') all.pop()
    return all.slice(-lines).join('\n')
  } finally {
    await handle.close()
  }
}
