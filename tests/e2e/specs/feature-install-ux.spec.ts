import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * First-use installs that report no byte progress (package installs, Hub
 * downloads) show how long they have been running instead of a false
 * "download may have stalled", and can continue in the background. Before a
 * setup starts, the confirm says whether a restart will follow.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function stubPlan(page: Page, plan: { packages: string[]; restart_likely: boolean | null }) {
  await page.route('**/api/models/plan**', (route) => route.fulfill({ json: { model_id: 'clip', ...plan } }))
}

async function stubSilentInstall(page: Page, settleAfterPolls: number) {
  let polls = 0
  await stubPlan(page, { packages: [], restart_likely: false })
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: {
      status: 'ok',
      models: [{ id: 'clip', name: 'CLIP', status: 'missing', available: false, download_supported: true }],
      health: {},
    },
  }))
  await page.route('**/api/models/prepare', (route) => route.fulfill({ json: { status: 'started', model_id: 'clip' } }))
  await page.route('**/api/models/download-progress', (route) => {
    polls += 1
    const settled = polls > settleAfterPolls
    return route.fulfill({
      json: {
        active: false,
        prepare_result: settled
          ? { active: false, model_id: 'clip', status: 'done', message: '' }
          : { active: true, model_id: 'clip' },
      },
    })
  })
}

test('an install without byte progress shows its elapsed time and can continue in the background', async ({ page }) => {
  await stubSilentInstall(page, 8)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', { label: 'CLIP', confirmBytes: 0 }))
  const overlay = page.locator('#feature-model-install-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.feature-model-install-status')).toContainText('so far')

  await overlay.locator('[data-action="install-background"]').click()
  await expect(overlay).toBeHidden()
  expect(await ensured).toMatchObject({ ok: true })
  await expect(page.locator('#toast-container .toast', { hasText: 'CLIP is installed' }).first()).toBeVisible()
  await expect(overlay).toBeHidden()
  await expect(page.locator('#toast-container .toast', { hasText: 'may have stalled' })).toHaveCount(0)
})

// Hugging Face's Xet transfer reports a file in large steps: measured through
// a 1.5 MB/s proxy, 64 MB arrived every 40 s and the count stood still in
// between. The speed read over the last few seconds then fell to 0, so the
// speed and the time left vanished on the slow connections that need them.
test('a download that arrives in large steps keeps its speed and counts the time left down', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).FeatureInstallProgress)).toBe('object')
  const timeline = await page.evaluate(() => {
    const { createRateMeter, formatStatus } = (window as any).FeatureInstallProgress
    const MB = 1048576
    const measure = createRateMeter()
    const at = (downloadedMb: number, seconds: number) => {
      const progress = { active: true, filename: 'model.onnx', downloaded: downloadedMb * MB, total: 400 * MB }
      const measured = measure(progress, seconds * 1000)
      // The time left is glued with no-break spaces; compare it as plain words.
      return { text: formatStatus('Tagger', progress, measured).text.replace(/\u00a0/g, ' '), longestGapMs: measured.longestGapMs, raw: formatStatus('Tagger', progress, measured).text }
    }
    return [at(0, 0), at(0, 20), at(64, 40), at(64, 50), at(64, 60), at(128, 80)]
  })
  expect(timeline.map((line: { text: string }) => line.text)).toEqual([
    'model.onnx: 0 / 400 MB (0%)',
    'model.onnx: 0 / 400 MB (0%)',
    'model.onnx: 64 / 400 MB (16%), 1.6 MB/s, about 3 min 30 s left',
    'model.onnx: 64 / 400 MB (16%), 1.6 MB/s, about 3 min 20 s left',
    'model.onnx: 64 / 400 MB (16%), 1.6 MB/s, about 3 min 10 s left',
    'model.onnx: 128 / 400 MB (32%), 1.6 MB/s, about 2 min 50 s left',
  ])
  // The "may have stalled" warning waits for several of the gaps seen so far.
  expect(timeline[5].longestGapMs).toBe(40000)
  // "2 min 50 s" never breaks across lines.
  expect(timeline[5].raw).toContain('about 2\u00a0min\u00a050\u00a0s left')
})

test('a download whose first step has not arrived shows how long it has been running', async ({ page }) => {
  await stubPlan(page, { packages: [], restart_likely: false })
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: { status: 'ok', models: [{ id: 'clip', name: 'CLIP', status: 'missing', available: false, download_supported: true }], health: {} },
  }))
  await page.route('**/api/models/prepare', (route) => route.fulfill({ json: { status: 'started', model_id: 'clip' } }))
  await page.route('**/api/models/download-progress', (route) => route.fulfill({
    json: { active: true, filename: 'model.onnx', downloaded: 0, total: 400 * 1048576, prepare_result: { active: true, model_id: 'clip' } },
  }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')
  // The install never settles here; the call ends with the page.
  page.evaluate(() => (window as any).ensureFeatureModel('clip', { label: 'CLIP', confirmBytes: 0 })).catch(() => {})
  const status = page.locator('#feature-model-install-overlay .feature-model-install-status')
  await expect(status).toContainText('model.onnx: 0 / 400 MB (0%)')
  await expect(status).toContainText('so far')
})

test('a download that reports every chunk shows its average speed', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).FeatureInstallProgress)).toBe('object')
  const lines = await page.evaluate(() => {
    const { createRateMeter, formatStatus } = (window as any).FeatureInstallProgress
    const MB = 1048576
    const measure = createRateMeter()
    return [[0, 0], [5, 2], [10, 4], [15, 6]].map(([mb, seconds]) => {
      const progress = { active: true, filename: 'model.safetensors', downloaded: mb * MB, total: 60 * MB }
      return formatStatus('CLIP', progress, measure(progress, seconds * 1000)).text.replace(/\u00a0/g, ' ')
    })
  })
  // Under 3 s of history there is no speed yet; then 2.5 MB/s and 18 s for the 45 MB left.
  expect(lines[1]).toBe('model.safetensors: 5 / 60 MB (8%)')
  expect(lines[3]).toBe('model.safetensors: 15 / 60 MB (25%), 2.5 MB/s, about 18 s left')
})

test('a setup that will need a restart says so before anything downloads', async ({ page }) => {
  let prepareCalls = 0
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: {
      status: 'ok',
      models: [{ id: 'clip', name: 'CLIP', status: 'missing', available: false, download_supported: true }],
      health: {},
    },
  }))
  await stubPlan(page, { packages: ['fastembed>=0.4.0', 'onnxruntime>=1.17'], restart_likely: true })
  await page.route('**/api/models/prepare', (route) => {
    prepareCalls += 1
    return route.fulfill({ json: { status: 'started', model_id: 'clip' } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', {
    label: 'CLIP', sizeHint: '~580 MB', confirmBytes: 0,
  }))
  const message = page.locator('#confirm-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('580 MB')
  await expect(message).toContainText('2 Python package')
  await expect(message).toContainText('restart')

  await page.locator('#btn-confirm-cancel').click()
  expect(await ensured).toEqual({ ok: false, cancelled: true })
  expect(prepareCalls).toBe(0)
})

test('a large download that needs no restart says it is ready once downloaded', async ({ page }) => {
  await stubSilentInstall(page, 0)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', {
    label: 'CLIP', sizeHint: '~580 MB', confirmBytes: 580 * 1024 * 1024,
  }))
  const message = page.locator('#confirm-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('no restart')

  await page.locator('#btn-confirm-ok').click()
  expect(await ensured).toMatchObject({ ok: true })
})

test('when the plan cannot tell, the confirm does not promise there is no restart', async ({ page }) => {
  await stubSilentInstall(page, 0)
  await page.unroute('**/api/models/plan**')
  await stubPlan(page, { packages: [], restart_likely: null })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const ensured = page.evaluate(() => (window as any).ensureFeatureModel('clip', {
    label: 'CLIP', sizeHint: '~580 MB', confirmBytes: 580 * 1024 * 1024,
  }))
  const message = page.locator('#confirm-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('580 MB')
  await expect(message).not.toContainText('no restart')
  await expect(message).not.toContainText('needs one restart')

  await page.locator('#btn-confirm-cancel').click()
  expect(await ensured).toMatchObject({ ok: false })
})

test('a gated model that needs the user to accept its terms opens the setup guide', async ({ page }) => {
  await page.route('**/api/models/status', (route) => route.fulfill({
    json: {
      status: 'ok',
      models: [{ id: 'cl-tagger-v2', name: 'CL Tagger v2', status: 'missing', available: false, download_supported: true }],
      health: {},
    },
  }))
  await stubPlan(page, { packages: [], restart_likely: false })
  await page.route('**/api/models/prepare', (route) => route.fulfill({ json: { status: 'started', model_id: 'cl-tagger-v2' } }))
  await page.route('**/api/models/download-progress', (route) => route.fulfill({
    json: {
      active: false,
      prepare_result: {
        active: false,
        model_id: 'cl-tagger-v2',
        status: 'error',
        message: 'This model is gated on Hugging Face.',
        provider: 'Hugging Face',
        manual_steps: ['Open the CL Tagger v2 page and accept the model terms.'],
        external_url: 'https://huggingface.co/cella110n/cl_tagger_v2',
      },
    },
  }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => typeof (window as any).ensureFeatureModel)).toBe('function')

  const result = await page.evaluate(() => (window as any).ensureFeatureModel('cl-tagger-v2', {
    label: 'CL Tagger v2', confirmBytes: 0,
  }))
  expect(result).toMatchObject({ ok: false, needsAction: true })
  const guide = page.locator('#model-setup-guide-backdrop')
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('accept the model terms')
})
