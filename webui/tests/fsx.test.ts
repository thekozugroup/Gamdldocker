import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { atomicWriteJson, atomicWriteText, readJson, readTextTail, withFileLock } from '../lib/fsx.ts'

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'gamdl-fsx-'))
}

test('readJson returns the fallback for a missing file', async () => {
  const dir = await tmpDir()
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), { a: 1 }), { a: 1 })
})

test('readJson tolerates a corrupt file', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'corrupt.json')
  await fsp.writeFile(file, '{"truncated": tru', 'utf-8')
  assert.deepEqual(await readJson(file, []), [])
  await fsp.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]))
  assert.equal(await readJson(file, 'fallback'), 'fallback')
})

test('atomicWriteJson round-trips and leaves no temp files behind', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'data.json')
  const payload = { url: 'https://example.com', n: 3, nested: { ok: true } }
  await atomicWriteJson(file, payload)
  assert.deepEqual(await readJson(file, null), payload)
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('atomicWriteText creates parent directories and honors mode', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'deep', 'nested', 'file.txt')
  await atomicWriteText(file, 'hello\n', 0o600)
  assert.equal(await fsp.readFile(file, 'utf-8'), 'hello\n')
  const stat = await fsp.stat(file)
  assert.equal(stat.mode & 0o777, 0o600)
})

test('a write that replaces an existing file never exposes a partial state', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'swap.json')
  await atomicWriteJson(file, { generation: 0 })
  // Interleave writers and readers; every read must parse as complete JSON.
  const writes = Array.from({ length: 20 }, (_, i) => atomicWriteJson(file, { generation: i + 1 }))
  const reads = Array.from({ length: 20 }, async () => {
    const seen = await readJson<{ generation: number } | null>(file, null)
    assert.notEqual(seen, null)
    assert.equal(typeof seen!.generation, 'number')
  })
  await Promise.all([...writes, ...reads])
})

test('withFileLock serialises read-modify-write cycles', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'counter.json')
  await atomicWriteJson(file, { count: 0 })

  const bump = () =>
    withFileLock(file, async () => {
      const data = await readJson<{ count: number }>(file, { count: 0 })
      // Yield so unserialised writers would interleave and lose updates.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await atomicWriteJson(file, { count: data.count + 1 })
    })

  await Promise.all(Array.from({ length: 10 }, bump))
  assert.deepEqual(await readJson(file, null), { count: 10 })
})

test('withFileLock breaks a stale lock instead of hanging forever', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'stale.json')
  const lock = file + '.webui.lock'
  await fsp.writeFile(lock, '999999 long-dead\n', 'utf-8')
  const past = new Date(Date.now() - 120_000)
  await fsp.utimes(lock, past, past)

  const started = Date.now()
  await withFileLock(file, async () => {
    await atomicWriteJson(file, { recovered: true })
  })
  assert.ok(Date.now() - started < 5000, 'stale lock should be broken quickly')
  assert.deepEqual(await readJson(file, null), { recovered: true })
})

test('withFileLock releases on error', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'oops.json')
  await assert.rejects(
    withFileLock(file, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  // The lockfile must be gone, so the next writer does not wait for staleness.
  await assert.rejects(fsp.stat(file + '.webui.lock'), /ENOENT/)
})

test('readTextTail returns the last N lines and null for a missing file', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'log.txt')
  assert.equal(await readTextTail(file, 50), null)

  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`)
  await fsp.writeFile(file, lines.join('\n') + '\n', 'utf-8')
  const tail = await readTextTail(file, 3)
  assert.equal(tail, 'line 498\nline 499\nline 500')

  const everything = await readTextTail(file, 5000)
  assert.equal(everything!.split('\n').length, 500)
})
