import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Collecting pictures in V Opus and /next/: Ctrl+V on the library page (a
 * pasted picture, a pasted picture address), "Paste picture" in the import
 * dialog, the browser extension's pairing prompt and its Settings section
 * (paired browsers, Revoke), and the "collected from" line on a picture's
 * card. Real backend; the real extension cannot run here, so a pairing request
 * is sent the way the extension sends it (an extension Origin, no page).
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const PREFIX = 'v4col-'
const TOKEN = 'v4coltoken'
const DIR = 'v4-col'
const COUNT = 3
const CHROME_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** A 1x1 PNG. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Lang = 'en' | 'zh-CN'
type Shell = 'vopus' | 'next'

test.beforeAll(() => {
  cleanupImages(PREFIX, [DIR])
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  // The newest seeded picture was collected from a web page by the extension.
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    row = conn.execute("SELECT id FROM images WHERE filename = ?", ("${PREFIX}00.png",)).fetchone()
    conn.execute("DELETE FROM collected_sources WHERE image_id = ?", (row[0],))
    conn.execute(
        "INSERT INTO collected_sources (image_id, source_url, page_url, page_title, collected_at, via) VALUES (?, ?, ?, ?, ?, ?)",
        (row[0], "https://img.example.test/cat.png", "https://blog.example.test/cats", "Cats on the web", "2026-10-20T12:30:00", "extension"),
    )
    conn.commit()
print("ok")
`)
})

test.afterAll(() => {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM collected_sources WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", ("${PREFIX}%",))
    conn.commit()
print("ok")
`)
  cleanupImages(PREFIX, [DIR])
})

async function open(page: Page, hash: string, opts: { lang?: Lang; shell?: Shell } = {}) {
  const lang = opts.lang ?? 'en'
  const shell = opts.shell ?? 'vopus'
  await page.addInitScript((language) => {
    const flag = 'v4e2e-collect-init-' + language
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  }, lang)
  const res = await page.goto(`/${shell}/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

async function openLibrary(page: Page, opts: { lang?: Lang; shell?: Shell } = {}) {
  await open(page, '#/library', opts)
  const input = page.getByTestId('query-input')
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(page.getByTestId('gallery-scroller')).toBeVisible()
  await expect(page.getByTestId('tile')).toHaveCount(COUNT)
}

/** A Ctrl+V: a paste event with a picture and/or text on the clipboard, aimed at `selector` (the page when none). */
async function paste(page: Page, what: { picture?: string; text?: string }, selector?: string) {
  await page.evaluate(
    ({ picture, text, selector: sel }) => {
      const data = new DataTransfer()
      if (picture) {
        const bytes = Uint8Array.from(atob(picture), (c) => c.charCodeAt(0))
        data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      }
      if (text) data.setData('text/plain', text)
      const target = (sel ? document.querySelector(sel) : document.body) as HTMLElement
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { ...what, selector },
  )
}

const toasts = (page: Page) => page.getByRole('status').filter({ hasText: /\S/ })

async function sendPairing(page: Page, token: string, name: string, browser = 'chrome') {
  const res = await page.request.post('/api/ext/pair', { headers: { Origin: CHROME_ORIGIN }, data: { token, name, browser } })
  expect(res.status()).toBe(200)
}

/** Remove every pairing this spec made (and any left waiting). */
async function clearPairings(page: Page) {
  await page.evaluate(async () => {
    const list = (await (await fetch('/api/browser-extension/paired')).json()) as { paired: { id: string }[] }
    for (const item of list.paired) await fetch(`/api/browser-extension/pairings/${item.id}`, { method: 'DELETE' })
  })
}

const tokenFor = (n: number) => `e2ecollecttoken${String(n).padStart(2, '0')}${'x'.repeat(24)}`

test.afterEach(async ({ page }) => {
  if (page.url().includes('/vopus/') || page.url().includes('/next/')) await clearPairings(page).catch(() => undefined)
})

for (const lang of ['en', 'zh-CN'] as const) {
  test(`Ctrl+V saves a pasted picture and says where it went (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await openLibrary(page, { lang })
    await paste(page, { picture: PNG_B64 })
    const say = toasts(page)
    if (lang === 'en') await expect(say).toContainText(/Saved shot[\w-]*\.png in collected\/\d{4}-\d{2}-\d{2}\. It appears in the library in a moment\./)
    else await expect(say).toContainText(/已保存 shot[\w-]*\.png 到 collected\/\d{4}-\d{2}-\d{2}，稍后出现在图库里。/)
  })
}

test('typing in a field is never taken over by Ctrl+V', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await paste(page, { picture: PNG_B64 }, '[data-testid="query-input"]')
  await paste(page, { text: 'https://img.example.test/a.png' }, '[data-testid="query-input"]')
  await page.waitForTimeout(600)
  await expect(page.getByTestId('collect-url-dialog')).toHaveCount(0)
  await expect(toasts(page)).toHaveCount(0)
})

test('nothing on the library page is taken while a dialog is open above it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('import-dialog')).toBeVisible()
  await paste(page, { text: 'https://img.example.test/a.png' })
  await page.waitForTimeout(400)
  await expect(page.getByTestId('collect-url-dialog')).toHaveCount(0)
})

test('a pasted picture address asks first, and says why a download failed', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await paste(page, { text: '  http://127.0.0.1:9/never.png  ' })
  const dialog = page.getByTestId('collect-url-dialog')
  await expect(dialog).toContainText('Save this picture from the web?')
  await expect(dialog).toContainText('downloads this picture from 127.0.0.1:9')
  await expect(page.getByTestId('collect-url-value')).toHaveText('http://127.0.0.1:9/never.png')
  // Esc closes it and downloads nothing
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(toasts(page)).toHaveCount(0)

  await paste(page, { text: 'http://127.0.0.1:9/never.png' })
  await page.getByTestId('collect-url-save').click()
  await expect(dialog).toHaveCount(0)
  // Nothing listens on port 9: said in words, not as the system's own error text.
  const failed = toasts(page).filter({ hasText: 'The site could not be reached' })
  await expect(failed).toBeVisible()
  await expect(failed).not.toContainText('WinError')
})

test('text that is not an address is left to the browser', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await paste(page, { text: 'just some words' })
  await page.waitForTimeout(400)
  await expect(page.getByTestId('collect-url-dialog')).toHaveCount(0)
  await expect(toasts(page)).toHaveCount(0)
})

test('Paste picture in the import dialog saves the clipboard picture', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, PNG_B64)
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('import-dialog')).toContainText('Press Ctrl+V in the library')
  await page.getByTestId('import-paste-picture').click()
  await expect(toasts(page).filter({ hasText: /Saved pasted\S*\.png in collected\// })).toBeVisible()
})

test('Paste picture with an empty clipboard says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.evaluate(() => navigator.clipboard.writeText('no picture here'))
  await page.getByTestId('import-button').click()
  await page.getByTestId('import-paste-picture').click()
  await expect(toasts(page).filter({ hasText: 'There is no picture or picture address on the clipboard.' })).toBeVisible()
})

test('a collected picture shows where it came from on its card', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page)
  await page.getByTestId('tile').first().click()
  const line = page.getByTestId('collected-source')
  await expect(line).toContainText('Collected from')
  await expect(page.getByTestId('collected-source-name')).toHaveText('Cats on the web')
  await expect(page.getByTestId('collected-source-page')).toHaveAttribute('href', 'https://blog.example.test/cats')
  await expect(page.getByTestId('collected-source-image')).toHaveAttribute('href', 'https://img.example.test/cat.png')
  // a picture that was not collected has no such line
  await page.getByTestId('tile').nth(1).click()
  await expect(page.getByTestId('collected-source')).toHaveCount(0)
})

test('a pairing request opens the prompt: Allow pairs, the list shows it, Revoke removes it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, '#/settings/library')
  await expect(page.getByTestId('ext-settings')).toBeVisible()
  await expect(page.getByTestId('ext-paired-none')).toBeVisible()

  await sendPairing(page, tokenFor(1), 'Chrome on this computer')
  const prompt = page.getByTestId('ext-pair-dialog')
  await expect(prompt).toBeVisible({ timeout: 10_000 })
  await expect(prompt).toContainText('Allow this browser extension?')
  await expect(prompt).toContainText('"Chrome on this computer" asks to save pictures')
  await expect(page.getByTestId('ext-pair-id')).toHaveText('abcdefghijklmnopabcdefghijklmnop')
  // Deny has the focus: Enter alone never allows
  await expect(page.getByTestId('ext-pair-deny')).toBeFocused()
  await page.getByTestId('ext-pair-allow').click()
  await expect(prompt).toHaveCount(0)
  await expect(toasts(page).filter({ hasText: 'Chrome is paired.' })).toBeVisible()

  const item = page.getByTestId('ext-paired-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('Chrome on this computer')
  await expect(item).toContainText('abcdefghijklmnopabcdefghijklmnop')
  await page.getByTestId('ext-revoke').click()
  await expect(page.getByTestId('ext-paired-none')).toBeVisible()
  await expect(toasts(page).filter({ hasText: 'can no longer save pictures here.' })).toBeVisible()
})

test('Deny refuses, and Esc leaves the request unanswered', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, '#/library')
  await sendPairing(page, tokenFor(2), 'Work browser', 'edge')
  const prompt = page.getByTestId('ext-pair-dialog')
  await expect(prompt).toContainText('"Work browser (Edge)" asks', { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(prompt).toHaveCount(0)
  // still waiting on the program's side, and not asked again here
  const waiting = () => page.evaluate(async () => ((await (await fetch('/api/browser-extension/state')).json()) as { pending: unknown[] }).pending.length)
  expect(await waiting()).toBe(1)
  await page.waitForTimeout(3600)
  await expect(prompt).toHaveCount(0)

  // a new request is asked about again
  await sendPairing(page, tokenFor(3), 'Other browser', 'firefox')
  await expect(prompt).toContainText('"Other browser (Firefox)" asks', { timeout: 10_000 })
  await page.getByTestId('ext-pair-deny').click()
  await expect(toasts(page).filter({ hasText: 'Pairing refused.' })).toBeVisible()
  await expect(page.getByTestId('ext-paired-item')).toHaveCount(0)
})

test('Settings shows the install folders when the install steps are opened', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await open(page, '#/settings/library')
  await page.getByTestId('ext-install').locator('summary').click()
  const chrome = page.getByTestId('ext-path-chrome')
  await expect(chrome).not.toHaveText('Preparing the extension folders...')
  await expect(chrome).toContainText(/chrome/i)
  await expect(page.getByTestId('ext-path-firefox')).toContainText(/firefox/i)
  await expect(page.getByTestId('ext-copy-chrome')).toBeEnabled()
  await expect(page.getByTestId('ext-open-firefox')).toBeEnabled()
})

for (const lang of ['en', 'zh-CN'] as const) {
  for (const size of VIEWPORTS) {
    test(`the extension settings and the prompts fit at ${size.width}x${size.height} (${lang})`, async ({ page }) => {
      await page.setViewportSize(size)
      await open(page, '#/settings/library', { lang })
      await page.getByTestId('ext-install').locator('summary').click()
      await expect(page.getByTestId('ext-path-chrome')).toContainText(/chrome/i)
      await sendPairing(page, tokenFor(4), 'Chrome on this computer')
      const prompt = page.getByTestId('ext-pair-dialog')
      await expect(prompt).toBeVisible({ timeout: 10_000 })
      await expect(prompt).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.getByTestId('ext-pair-allow').click()
      await expect(page.getByTestId('ext-paired-item')).toHaveCount(1)
      await page.getByTestId('ext-paired-item').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('ext-revoke')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      for (const testId of ['ext-card-chrome', 'ext-card-firefox']) {
        const box = await page.getByTestId(testId).boundingBox()
        expect(box && box.x >= 0 && box.x + box.width <= size.width, testId).toBe(true)
      }

      await page.goto(`/vopus/#/library`)
      await page.getByTestId('import-button').click()
      const dialog = page.getByTestId('import-dialog')
      await expect(dialog.getByTestId('import-paste-picture')).toBeInViewport({ ratio: 1 })
      await expect(dialog).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
      await paste(page, { text: 'https://img.example.test/some/very/long/path/to/a/picture/file-name-that-keeps-going-and-going.png?size=large&token=abcdef0123456789' })
      const url = page.getByTestId('collect-url-dialog')
      await expect(url).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    })
  }
}

test('/next/ has Ctrl+V, the import entrance, the card line and the settings section too', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, { shell: 'next' })
  await paste(page, { picture: PNG_B64 })
  await expect(toasts(page).filter({ hasText: /Saved shot[\w-]*\.png in collected\// })).toBeVisible()
  await page.getByTestId('tile').first().click()
  await expect(page.getByTestId('collected-source-name')).toHaveText('Cats on the web')
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('import-paste-picture')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto('/next/#/settings/library')
  await expect(page.getByTestId('ext-settings')).toBeVisible()
  await sendPairing(page, tokenFor(5), 'Chrome on this computer')
  await expect(page.getByTestId('ext-pair-dialog')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('ext-pair-deny').click()
})
