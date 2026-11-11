import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Feature entrances in a real browser (owner, 2026-10-23, M203): every
 * entrance in docs/feature-entrances.json is on the page. The static half is
 * backend/tests/test_feature_entrances.py.
 *
 * The program has one interface since 2026-11-12 (V Opus and the /next/ trial
 * were retired on the owner's word, recorded under `removed` in the file).
 */

type Feature = { id: string; en: string; classic: string[] }

const REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'feature-entrances.json'), 'utf8'),
) as { features: Feature[] }

/** Open a page with nothing remembered from an earlier test. */
async function openFresh(page: Page, url: string): Promise<void> {
  await page.goto('/api/health').catch(() => page.goto('/api/images/count'))
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  await page.goto(url)
}

test.beforeEach(async ({ page }) => {
  await markModelsReady(page)
  await page.setViewportSize({ width: 1920, height: 1080 })
})

test('every entrance in the inventory is on the page', async ({ page }) => {
  await openFresh(page, '/')
  await expect(page.locator('#view-gallery')).toBeAttached()
  const gone: string[] = []
  for (const feature of REGISTRY.features) {
    for (const selector of feature.classic) {
      if ((await page.locator(selector).count()) === 0) gone.push(`${feature.id}: ${selector}`)
    }
  }
  expect(gone, 'entrances missing from the page').toEqual([])
})

test('the retired interfaces\' addresses lead to the program', async ({ page }) => {
  for (const old of ['/vopus/', '/vopus/#/settings/models', '/v4/', '/next/']) {
    await page.goto(old)
    await expect(page.locator('#view-gallery'), old).toBeAttached()
    expect(new URL(page.url()).pathname, old).toBe('/')
  }
})
