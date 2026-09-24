import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Sending library images to Privacy Tools must not download every original
 * into the browser before anything shows up. The queue fills at once with
 * thumbnails; each original is fetched when that image is processed and
 * released once its result exists. Thousands of selected images used to be
 * pulled into tab memory one by one with no feedback.
 */

const FIXTURE_PNG = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'obfuscation', 'sd-metadata-source.png'),
)

test('library images join the privacy queue at once and load one by one while processing', async ({ page }) => {
  const originalFetches: string[] = []
  await page.route('**/api/image-file/**', (route) => {
    originalFetches.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: FIXTURE_PNG })
  })
  await page.route('**/api/image-thumbnail/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: FIXTURE_PNG }))
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).ImageObfuscator?.addLibraryImages === 'function'
    && Boolean((window as any).ObfuscateEngine))

  const added = await page.evaluate(async () => {
    const tool = (window as any).ImageObfuscator
    const ok = await tool.addLibraryImages([101, 102, 103])
    return { ok, queued: tool._queue.length }
  })
  expect(added).toEqual({ ok: true, queued: 3 })
  expect(originalFetches).toHaveLength(0)

  await page.evaluate(async () => {
    await (window as any).ImageObfuscator._processAll('encode')
  })
  const after = await page.evaluate(() => (window as any).ImageObfuscator._queue.map((item: any) => ({
    status: item.status,
    hasResult: Boolean(item.resultBlob),
    keepsOriginal: Boolean(item.file),
  })))
  expect(originalFetches).toHaveLength(3)
  expect(after).toEqual([
    { status: 'done', hasResult: true, keepsOriginal: false },
    { status: 'done', hasResult: true, keepsOriginal: false },
    { status: 'done', hasResult: true, keepsOriginal: false },
  ])
})
