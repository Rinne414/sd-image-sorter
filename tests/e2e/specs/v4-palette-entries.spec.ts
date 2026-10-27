import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Ctrl K reaches the features ported from classic (a second way in besides
 * their own place): collect the picture on the clipboard, Quick collect,
 * customize the top bar, hard refresh, free the AI models, VLM prompt presets,
 * AI defaults and video support.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-update-autocheck', '0')
  })
  await page.goto('/vopus/#/library')
  await expect(page.getByTestId('open-palette')).toBeVisible()
}

async function runEntry(page: Page, words: string, label: string | RegExp): Promise<void> {
  await page.getByTestId('open-palette').click()
  await page.keyboard.type(words)
  const option = page.getByTestId('palette').getByRole('option').filter({ hasText: label }).first()
  await expect(option).toBeVisible()
  await option.click()
}

test('Customize top bar opens its dialog', async ({ page }) => {
  await open(page)
  await runEntry(page, 'customize', 'Customize top bar')
  await expect(page.getByTestId('navcustom-dialog')).toBeVisible()
})

test('settings entries open their tab with the section in view and focus on it', async ({ page }) => {
  await open(page)
  await runEntry(page, 'video support', 'Video support (install ffmpeg)')
  await expect(page).toHaveURL(/#\/settings\/models/)
  await expect(page.getByTestId('video-support')).toBeInViewport()

  await runEntry(page, 'ai defaults', 'AI defaults (save or reset)')
  await expect(page).toHaveURL(/#\/settings\/ai/)
  await expect(page.getByTestId('ai-defaults')).toBeInViewport()

  await runEntry(page, 'prompt presets', 'VLM prompt presets')
  await expect(page.getByTestId('vlm-preset-save-as')).toBeFocused()
})

test('Free the AI models now says what it did', async ({ page }) => {
  await open(page)
  await runEntry(page, 'free the ai', 'Free the AI models now')
  // a fresh test server has nothing loaded
  await expect(page.getByRole('status').filter({ hasText: /Nothing to free|Freed:|Kept / }).first()).toBeVisible()
})

test('Quick collect opens its window; an empty clipboard is said in words', async ({ page, context }) => {
  await open(page)
  const popup = context.waitForEvent('page')
  await runEntry(page, 'quick collect', 'Open Quick collect')
  const quick = await popup
  await expect(quick).toHaveURL(/quick-collect/)
  await quick.close()

  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await runEntry(page, 'clipboard', 'Collect the picture on the clipboard')
  await expect(page.getByRole('status').filter({ hasText: /clipboard/i }).first()).toBeVisible()
})

test('Hard refresh reloads the interface on a fresh address and keeps the page', async ({ page }) => {
  await open(page)
  await page.evaluate(() => (location.hash = '#/settings/about'))
  await runEntry(page, 'hard refresh', 'Hard refresh the interface')
  await expect(page).toHaveURL(/[?&]_t=\d+.*#\/settings\/about/)
})
