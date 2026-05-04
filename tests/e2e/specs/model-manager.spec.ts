import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const defaultPort = process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'
const e2eDataDir = path.join(repoRoot, '.tmp', `e2e-data-${defaultPort}`)

async function resetModelFixtures() {
  await fs.rm(path.join(e2eDataDir, 'models'), { recursive: true, force: true })
  await fs.rm(path.join(e2eDataDir, 'config'), { recursive: true, force: true })
}

async function openModelManager(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal')).toBeVisible()
  await expect(page.locator('.model-card').first()).toBeVisible({ timeout: 15_000 })
}

test.describe('Model Manager', () => {
  test.beforeEach(async () => {
    await resetModelFixtures()
  })

  test('model download progress updates while the frontend remains responsive', async ({ page }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="artist"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    const prepareButton = card.locator('.btn-prepare-model')
    await prepareButton.click()

    await expect(prepareButton).toContainText(/best_checkpoint\.pth.*MB/i, { timeout: 10_000 })

    const closeButton = page.locator('#model-manager-close')
    await expect(closeButton).toBeVisible()
    await expect(closeButton).toBeEnabled()
    await page.locator('#model-mirror-select').selectOption('hf-mirror')
    await expect(card.locator('.model-card-status')).toContainText(/Ready|已就绪/, { timeout: 30_000 })
  })

  test('Kaloscope prepare completes and changes Artist ID from Missing to Ready', async ({ page, request }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="artist"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    await card.locator('.btn-prepare-model').click()
    await expect(card.locator('.model-card-status')).toContainText(/Ready|已就绪/, { timeout: 30_000 })

    const response = await request.get('/api/models/status')
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.health.artist.available).toBe(true)
    expect(body.health.artist.checkpoint_path).toContain('data')
    expect(body.health.artist.runtime_path).toContain('data')
  })

  // See docs/TECHNICAL_DEBT_NOTES.md → Debt-19. The Playwright fixture creates a
  // single 32 MB stub `sam3-model.safetensors` file, but after the SAM3 backend
  // switch to `transformers.Sam3Model.from_pretrained(directory)`, the runtime
  // requires a directory containing `config.json` + `model.safetensors` + tokenizer
  // files. The prepare flow downloads the stub but `get_sam3_checkpoint_path()`
  // never returns a path because the directory is incomplete. Real ModelScope
  // downloads deliver a complete bundle, so production is unaffected. Re-enable
  // when the fixture is updated to produce a full stub bundle.
  test.fixme('SAM3 prepare shows byte progress and refreshes the card after completion', async ({ page, request }) => {
    await openModelManager(page)

    const card = page.locator('.model-card[data-model-id="sam3"]')
    await expect(card.locator('.model-card-status')).toContainText(/Missing|缺失/)

    const prepareButton = card.locator('.btn-prepare-model')
    await prepareButton.click()
    await expect(prepareButton).toContainText(/model\.safetensors.*MB/i, { timeout: 10_000 })

    await expect(card.locator('.model-card-path code')).toContainText(/model\.safetensors/, { timeout: 30_000 })

    const response = await request.get('/api/models/status')
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    expect(body.health.censor.sam3.checkpoint_path).toContain('model.safetensors')
  })

  // Cascading EBUSY follow-on from the SAM3 prepare test above (see Debt-19):
  // when that test errors out it leaves a `.tmp` file locked on Windows, which
  // makes this test's pre-cleanup `rm -rf data/models/sam3/...` fail. Re-enable
  // together with the SAM3 prepare test once the fixture is fixed.
  test.fixme('no model card shows Downloaded badge - only Ready or Missing', async ({ page }) => {
    await openModelManager(page)

    const statusBadges = page.locator('.model-card-status')
    const count = await statusBadges.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const text = await statusBadges.nth(i).textContent()
      expect(text?.trim()).toMatch(/^(Ready|Missing|已就绪|缺失)$/)
    }

    await expect(page.locator('.model-card-status.is-downloaded')).toHaveCount(0)
    await expect(page.getByText(/^Downloaded$/)).toHaveCount(0)
  })
})
