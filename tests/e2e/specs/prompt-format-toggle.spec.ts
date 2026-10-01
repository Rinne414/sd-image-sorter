import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

// The spec may be the first of its shard, so the gallery may be empty:
// seed one picture of its own and scan it before any test opens the grid.
const fixtureDir = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'prompt-format-toggle')

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(fixtureDir, { recursive: true })
  await createTestImage(fixtureDir, 'prompt-format-seed.png', { generator: 'nai', prompt: 'seed picture' })
  const response = await request.post('/api/scan', { data: { folder_path: fixtureDir, recursive: true } })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60_000 }).toBe('done')
})

/**
 * The image preview's format button switches the prompt between NovelAI and
 * SD syntax, and its label names the format you will get. It used to read
 * "View as SD" whatever the image or the state: the button kept its original
 * data-i18n key, so every translation pass wrote that text back, and the
 * way back was labelled "original" instead of the format's name.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const NAI_PROMPT = '{{masterpiece}}, 1girl, [[blurry]]'
const SD_PROMPT = '(masterpiece:1.2), 1girl, (blurry:0.8)'

async function openPreviewAs(page: Page, generator: string, prompt: string) {
  await page.route(/\/api\/images\/\d+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.image = { ...body.image, generator, prompt, negative_prompt: 'lowres', metadata: null }
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#btn-toggle-prompt-format')).toBeEnabled()
}

const reapplyTranslations = (page: Page) =>
  page.evaluate(() => (window as any).UIRefresh.applyTranslations())

const button = (page: Page) => page.locator('#btn-toggle-prompt-format')
const header = (page: Page) => page.locator('.modal-prompt h4 .section-toggle-label')

test('a NovelAI prompt switches to SD and back, and the labels follow', async ({ page }) => {
  await openPreviewAs(page, 'novelai', NAI_PROMPT)
  await expect(button(page)).toHaveText('View as SD')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toContainText('(masterpiece')
  await expect(button(page)).toHaveText('View as NovelAI')
  await expect(header(page)).toHaveText('Prompt (SD format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toHaveText(NAI_PROMPT)
  await expect(button(page)).toHaveText('View as SD')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')
})

test('an SD prompt offers NovelAI first', async ({ page }) => {
  await openPreviewAs(page, 'webui', SD_PROMPT)
  await expect(button(page)).toHaveText('View as NovelAI')
  await expect(header(page)).toHaveText('Prompt (SD format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toContainText('masterpiece::')
  await expect(button(page)).toHaveText('View as SD')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')
})

test('the preview action buttons share one row and no label is cut off at 1366x768', async ({ page }) => {
  await openPreviewAs(page, 'novelai', NAI_PROMPT)
  // The longer label is the one that has to fit.
  await button(page).click()
  await expect(button(page)).toHaveText('View as NovelAI')
  const layout = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('#image-modal .modal-action-primary > *')]
      .filter((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement[]
    return {
      count: kids.length,
      rows: new Set(kids.map((el) => Math.round(el.getBoundingClientRect().top))).size,
      cut: kids.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.id || el.className),
    }
  })
  expect(layout.count).toBe(5)
  expect(layout.rows).toBe(1)
  expect(layout.cut).toEqual([])
  await expect(page.locator('#btn-edit-metadata')).toHaveAttribute('title', /\S/)
})

test('the tag list toggle keeps "Show Less" while open, through a translation pass', async ({ page }) => {
  // It kept its original data-i18n key, so the next pass turned "Show Less"
  // back into "Show More" while the long list was open.
  await page.route(/\/api\/images\/\d+$/, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.tags = Array.from({ length: 60 }, (_, i) => ({ tag: `tag_${i}`, confidence: 0.9 - i / 100, category: 'general' }))
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('#gallery-grid .gallery-item').first().click()
  const toggle = page.locator('#btn-toggle-all-tags')
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await expect(toggle).toHaveText('Show More')

  await toggle.click()
  await reapplyTranslations(page)
  await expect(toggle).toHaveText('Show Less')
  await toggle.click()
  await reapplyTranslations(page)
  await expect(toggle).toHaveText('Show More')
})
