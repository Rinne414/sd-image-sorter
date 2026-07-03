import { test, expect, type Page } from '@playwright/test'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII='

async function openMainPage(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const isVisible = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return false
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }

      return isVisible(document.querySelector('.nav-tabs [data-view="reader"]'))
        || isVisible(document.getElementById('mobile-menu-toggle'))
    })
  }).toBe(true)
}

async function showReader(page: Page) {
  await openMainPage(page)
  await page.evaluate(() => {
    const view = document.getElementById('view-reader')
    if (view) {
      document.querySelectorAll('.view').forEach((node) => {
        if (node !== view) {
          ;(node as HTMLElement).style.display = 'none'
        }
      })
      ;(view as HTMLElement).style.display = 'flex'
      view.classList.add('active')
    }
    document.getElementById('reader-tool-panel-reader')?.classList.add('active')
  })
}

test.describe('Model Asset Details UI', () => {
  test('Reader shows model asset details in the pro-only collapsed section', async ({ page }) => {
    await showReader(page)

    await page.route('**/api/parse-image', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generator: 'comfyui',
          prompt: 'test prompt',
          negative_prompt: '',
          width: 1,
          height: 1,
          file_size: 70,
          checkpoint: 'model.safetensors',
          loras: ['style_a.safetensors'],
          metadata: {
            _parsed: {
              generation_params: {},
              model_assets: {
                source: 'activity_subgraph_fallback',
                primary_model_type: 'checkpoint',
                primary_model_name: 'model.safetensors',
                checkpoint_candidates: [{ name: 'model.safetensors' }],
                lora_candidates: [{ name: 'style_a.safetensors' }],
                loras: ['style_a.safetensors'],
              },
            },
          },
        }),
      })
    })

    await page.evaluate((b64) => {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const file = new File([bytes], 'reader-model-assets.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      } as ClipboardEventInit)
      document.dispatchEvent(evt)
    }, TINY_PNG_BASE64)

    await expect(page.locator('#reader-model-assets-section')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-target="reader-model-assets"]').click()
    await expect(page.locator('#reader-model-assets')).toContainText(/Primary Model|主模型/)
    await expect(page.locator('#reader-model-assets')).toContainText('model.safetensors')
    await expect(page.locator('#reader-model-assets')).toContainText('style_a.safetensors')
  })

  test('Gallery image modal shows model asset details when parsed metadata includes candidates', async ({ page }) => {
    await openMainPage(page)

    await page.evaluate(() => {
      const closeModal = (window as any).showModal
      closeModal?.('image-modal')

      const image = {
        id: 1,
        filename: 'gallery-model-assets.png',
        path: 'C:/tmp/gallery-model-assets.png',
        generator: 'comfyui',
        prompt: 'gallery prompt',
        negative_prompt: '',
        width: 512,
        height: 512,
        file_size: 12345,
        checkpoint: 'model.safetensors',
        loras: JSON.stringify(['style_a.safetensors']),
        metadata_json: JSON.stringify({
          _parsed: {
            generation_params: {},
            is_img2img: false,
            img2img_info: {},
            character_prompts: [],
            prompt_nodes: [],
            model_assets: {
              source: 'activity_subgraph_fallback',
              primary_model_type: 'checkpoint',
              primary_model_name: 'model.safetensors',
              checkpoint_candidates: [{ name: 'model.safetensors' }],
              lora_candidates: [{ name: 'style_a.safetensors' }],
              loras: ['style_a.safetensors'],
            },
          },
        }),
      }

      ;(window as any).Gallery._hydratePreview(image, [])
    })

    await expect(page.locator('#modal-model-assets-section')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-target="modal-model-assets-grid"]').click()
    await expect(page.locator('#modal-model-assets-grid')).toContainText(/Primary Model|主模型/)
    await expect(page.locator('#modal-model-assets-grid')).toContainText('model.safetensors')
    await expect(page.locator('#modal-model-assets-grid')).toContainText('style_a.safetensors')
  })
})
