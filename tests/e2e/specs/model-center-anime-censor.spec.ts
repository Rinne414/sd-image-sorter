import { expect, test } from '../fixtures/click-ledger'

/**
 * The anime censor detector + face guard card (deepghs, MIT) is an opt-in
 * Model Center download like Privacy YOLO: listed under Censor, not part of
 * "download all", and its status line is localized.
 */

test('the Model Center lists the anime censor card with a localized status', async ({ page, request }) => {
  const status = await (await request.get('/api/models/status')).json()
  const card = (status.models || []).find((model: any) => model.id === 'censor-anime')
  expect(card).toMatchObject({ group: 'Censor', download_supported: true, message_key: 'models.censorAnime.missing' })

  const bundle = await (await request.get('/api/models/bulk-bundle')).json()
  expect(bundle.excluded.map((entry: any) => entry.id)).toContain('censor-anime')
  expect(bundle.items.map((entry: any) => entry.id)).not.toContain('censor-anime')

  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).EntryPage?.hide?.())
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()

  const rendered = page.locator('.model-card[data-model-id="censor-anime"]')
  await expect(rendered).toBeVisible()
  await expect(rendered.locator('.model-card-title')).toHaveText('Anime Censor + Face Guard (deepghs)')
  await expect(rendered).toContainText('还没有下载。点击准备 / 下载（约 89 MB）。')
})
