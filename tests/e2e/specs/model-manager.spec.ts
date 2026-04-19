import { test, expect } from '@playwright/test'

test.describe('Model Manager', () => {
  test('censor-legacy prepare shows the structured Civitai auth-wall message instead of a generic server crash', async ({
    page,
  }) => {
    await page.route('**/api/models/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          models: [
            {
              id: 'censor-legacy',
              name: 'Privacy YOLO',
              group: 'Censor',
              available: false,
              status: 'missing',
              status_label: 'Missing',
              message: 'Privacy YOLO files are missing.',
              download_supported: true,
              external_links: [{ label: 'Civitai', url: 'https://example.com/civitai' }],
            },
          ],
          health: {},
        }),
      })
    })

    await page.route('**/api/models/prepare', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Civitai login required for the Privacy YOLO download.',
          type: 'CivitaiLoginRequired',
          message:
            'Privacy YOLO cannot be downloaded automatically because Civitai now requires a signed-in browser session.',
          manual_steps: [
            'Open the Civitai page and sign in.',
            'Download the archive manually.',
            'Extract the files into the local yolo folder.',
          ],
        }),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    await page.locator('#btn-open-model-manager').click()
    await expect(page.locator('#model-manager-modal')).toBeVisible()

    await page.locator('.btn-prepare-model[data-model-id="censor-legacy"]').click()

    await expect(page.locator('.toast, #toast-container .toast')).toContainText(
      /Civitai.*signed-in browser session|Civitai login required/i,
      { timeout: 5000 },
    )
  })
})
