import { expect, test, type Page } from '../fixtures/click-ledger'

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
  await expect(button(page)).toHaveText('View as SD format')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toContainText('(masterpiece')
  await expect(button(page)).toHaveText('View as NovelAI format')
  await expect(header(page)).toHaveText('Prompt (SD format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toHaveText(NAI_PROMPT)
  await expect(button(page)).toHaveText('View as SD format')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')
})

test('an SD prompt offers NovelAI first', async ({ page }) => {
  await openPreviewAs(page, 'webui', SD_PROMPT)
  await expect(button(page)).toHaveText('View as NovelAI format')
  await expect(header(page)).toHaveText('Prompt (SD format)')

  await button(page).click()
  await reapplyTranslations(page)
  await expect(page.locator('#modal-prompt-text')).toContainText('masterpiece::')
  await expect(button(page)).toHaveText('View as SD format')
  await expect(header(page)).toHaveText('Prompt (NovelAI format)')
})
