// The UI side of the control-file protocol in downloader/gamdl_sync/control.py.
// Dropping a file in /config/control is the whole API: the daemon polls the
// directory every second, so no docker socket and no restart is ever needed.
import path from 'path'
import { CONTROL_DIR } from './paths.ts'
import { atomicWriteJson } from './fsx.ts'

const SYNC_NOW = 'sync-now'
const RELOAD = 'reload'
const CANCEL = 'cancel'

async function emit(name: string, payload: Record<string, unknown> = {}): Promise<void> {
  await atomicWriteJson(path.join(CONTROL_DIR, name), payload)
}

export async function requestSync(urls?: string[]): Promise<void> {
  const scoped = (urls || []).filter((u) => typeof u === 'string' && u.trim())
  await emit(SYNC_NOW, scoped.length ? { urls: scoped } : {})
}

export async function requestReload(): Promise<void> {
  await emit(RELOAD)
}

export async function requestCancel(): Promise<void> {
  await emit(CANCEL)
}
