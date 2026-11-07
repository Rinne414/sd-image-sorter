import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Picture preview, default view: each fact once. The summary line and the
 * key-parameter bar carry the model, Steps, Sampler, CFG and Seed, so the
 * settings block below lists only what they do not; the parser's model and
 * LoRA details start folded and open on a click, with nothing lost.
 */

test.use({ viewport: { width: 1920, height: 1080 } })

async function openPreview(page: Page, generatedSize: string) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate((size) => {
    const image = {
      id: 1,
      filename: 'repeat-check.png',
      path: 'C:/tmp/sets/repeat-check.png',
      generator: 'webui',
      prompt: 'a prompt',
      negative_prompt: 'bad',
      width: 512,
      height: 512,
      file_size: 12345,
      checkpoint: 'model.safetensors',
      loras: JSON.stringify(['style_a']),
      metadata_json: JSON.stringify({
        _parsed: {
          generation_params: {
            steps: 28, sampler: 'Euler a', cfg_scale: 7, seed: 99, size, clip_skip: 2,
          },
          is_img2img: false,
          img2img_info: {},
          character_prompts: [],
          prompt_nodes: [],
          model_assets: {
            source: 'fast_path',
            primary_model_type: 'checkpoint',
            primary_model_name: 'model.safetensors',
            checkpoint_candidates: [{ name: 'model.safetensors' }],
            lora_candidates: [{ name: 'style_a' }],
            loras: ['style_a'],
          },
        },
      }),
    }
    ;(window as any).showModal?.('image-modal')
    ;(window as any).Gallery._initSectionToggles()
    ;(window as any).Gallery._hydratePreview(image, [])
  }, generatedSize)
  await expect(page.locator('#modal-filename')).toHaveText('repeat-check.png')
}

test('Steps, Sampler, CFG, Seed and the model show once; extras stay in the settings block', async ({ page }) => {
  await openPreview(page, '512x512')
  await expect(page.locator('#kp-steps')).toBeVisible()
  await expect(page.locator('#kp-seed')).toContainText('99')
  await expect(page.locator('#modal-checkpoint')).toHaveText('model.safetensors')

  const grid = page.locator('#modal-params-grid')
  await expect(grid).toContainText('Clip skip')
  for (const repeated of ['Steps', 'CFG scale', 'Sampler', 'Seed', 'Model', 'Size']) {
    await expect(grid.locator('.param-label', { hasText: new RegExp(`^${repeated}$`) })).toHaveCount(0)
  }
  // the file name is the title; the path line is where it lives
  await expect(page.locator('#modal-file-path')).toHaveText('C:/tmp/sets')
  await expect(page.locator('#modal-file-path')).toHaveAttribute('title', 'C:/tmp/sets/repeat-check.png')
})

test('a generated size that differs from the file size is still listed', async ({ page }) => {
  await openPreview(page, '512x640')
  await expect(page.locator('#modal-params-grid .param-label', { hasText: /^Size$/ })).toHaveCount(1)
})

test('the detected model block starts folded and opens on a click with its details', async ({ page }) => {
  await openPreview(page, '512x512')
  const grid = page.locator('#modal-model-assets-grid')
  await expect(page.locator('#modal-model-assets-section')).toBeVisible()
  await expect(grid).toBeHidden()
  await page.locator('[data-target="modal-model-assets-grid"]').click()
  await expect(grid).toBeVisible()
  await expect(grid).toContainText('model.safetensors')
  await expect(grid).toContainText('style_a')
  await page.locator('[data-target="modal-model-assets-grid"]').click()
  await expect(grid).toBeHidden()
})
