import { test, expect, type Page } from '@playwright/test'

async function openMainPage(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#btn-tag')).toBeVisible()
}

async function openTagRuntimeAdvanced(page: Page) {
  const details = page.locator('#tag-runtime-advanced')
  await expect(details).toHaveCount(1)
  await expect.poll(async () => {
    return details.evaluate((node) => {
      if (node instanceof HTMLDetailsElement) {
        node.open = true
        return node.open
      }
      return false
    })
  }, { timeout: 5000 }).toBe(true)
}

test.describe('Tagger Runtime UI', () => {
  test('custom model defaults to GPU and still allows a CPU override', async ({ page }) => {
    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            torch_cuda_available: true,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 12,
            recommended_cpu_chunk_size: 32,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'Sufficient VRAM for aggressive batched GPU inference.',
          },
        }),
      })
    })

    await openMainPage(page)

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#tag-model-select').selectOption('custom')
    await expect(page.locator('#custom-model-group')).toBeVisible()
    await expect(page.locator('#custom-tags-group')).toBeVisible()
    await openTagRuntimeAdvanced(page)
    await expect(page.locator('#tag-use-gpu')).toBeChecked()
    await expect(page.locator('#tag-runtime-summary')).toContainText(/Custom model on GPU|Custom model/i)
    await expect(page.locator('#tag-model-help')).toContainText(/Custom (WD14-compatible )?ONNX model.*GPU|Custom (WD14-compatible )?ONNX model/i)

    await page.locator('#tag-use-gpu').evaluate((node) => {
      const input = node as HTMLInputElement
      input.checked = false
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.locator('#tag-use-gpu')).not.toBeChecked()
    await expect(page.locator('#tag-runtime-summary')).toContainText(/CPU mode|Custom model/i)
  })

  test('similarity progress keeps 5/5 completion text for the legacy progress shape', async ({ page }) => {
    await openMainPage(page)

    await page.evaluate(() => {
      const view = document.getElementById('view-similar')
      if (view) {
        document.querySelectorAll('.view').forEach((node) => {
          if (node !== view) {
            ;(node as HTMLElement).style.display = 'none'
          }
        })
        ;(view as HTMLElement).style.display = 'flex'
        view.classList.add('active')
      }

      ;(window as any).SimilarImages.renderEmbeddingProgress({
        running: false,
        total: 5,
        processed: 4,
        errors: 1,
      })
    })

    await expect(page.locator('#similar-embed-text')).toContainText('5/5')
    await expect(page.locator('#similar-embed-text')).toContainText('4 embedded, 1 failed')
  })

  test('ToriiGate runtime UI shows actual backend, fallback reason, and memory pressure warning', async ({ page }) => {
    await page.route('**/api/system-info', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          system_info: {
            total_ram_gb: 64,
            available_ram_gb: 48,
            gpu_name: 'NVIDIA GeForce RTX 4090',
            gpu_vram_total_mb: 24576,
            gpu_vram_available_mb: 22000,
            torch_cuda_available: true,
            onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
          },
          recommendation: {
            recommended_batch_size: 2,
            recommended_cpu_chunk_size: 2,
            recommended_use_gpu: true,
            recommended_session_refresh_interval: 180,
            risk_level: 'low',
            message: 'CUDA is available for ToriiGate.',
          },
        }),
      })
    })

    await openMainPage(page)

    await page.locator('#btn-tag').click()
    await expect(page.locator('#tag-modal.visible')).toBeVisible()

    await page.locator('#tag-model-select').selectOption('toriigate-0.5')
    await openTagRuntimeAdvanced(page)
    await page.evaluate(() => {
      const gpuCheckbox = document.getElementById('tag-use-gpu') as HTMLInputElement | null
      if (gpuCheckbox) gpuCheckbox.checked = true
      ;(window as any).syncTaggerModelUi?.({ applyModelDefaults: false })
    })
    await expect(page.locator('#tag-use-gpu')).toBeChecked()

    await page.evaluate(() => {
      const startButton = document.getElementById('btn-start-tag') as HTMLButtonElement | null
      if (startButton) startButton.disabled = true

      ;(window as any).__liveTagProgress = {
        runtime_backend_target: 'gpu',
        runtime_backend_actual: 'cpu',
        runtime_backend_reason: 'CUDA unavailable or this build only has the CPU PyTorch runtime.',
        memory_pressure_warning: 'Memory pressure is critical. Pausing briefly and reducing chunk size.',
      }

      ;(window as any).syncTaggerModelUi?.({ applyModelDefaults: false })
    })

    await expect(page.locator('#tag-runtime-summary')).toContainText('Requested GPU, actual CPU.')
    await expect(page.locator('#tag-runtime-summary')).toContainText(
      'CUDA unavailable or this build only has the CPU PyTorch runtime.',
    )
    await expect(page.locator('#tag-runtime-summary')).toContainText(
      'Memory pressure is critical. Pausing briefly and reducing chunk size.',
    )
    await expect(page.locator('#tag-runtime-detail')).toContainText('Actual backend: CPU.')
    await expect(page.locator('#tag-runtime-detail')).toContainText('Target requested GPU.')
    await expect(page.locator('#tag-runtime-mode-chip')).toContainText('GPU target -> CPU actual')
  })
})
