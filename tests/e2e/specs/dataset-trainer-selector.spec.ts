import { expect, test, type Page } from '../fixtures/click-ledger'

test.describe.configure({ mode: 'serial' })

type IntegerBounds = {
  minimum: number
  maximum: number
  default: number
}

type JsonPrimitive = boolean | null | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type TrainerContractBase = {
  contract_version: '1.0.0'
  verified: true
  mask_export_modes: string[]
  upstream: {
    repository: string
    tag: string
    commit: string
  }
  capabilities: {
    caption_extensions: string[]
  }
  option_bounds: {
    repeats: IntegerBounds
    batch_size: IntegerBounds
    resolution: IntegerBounds
    keep_tokens: IntegerBounds
  }
  generated_artifacts: {
    dataset_config: string
    caption_sidecar: string
  }
  verification_boundary: {
    module: string
    validates_upstream_schema: true
    requires_module_path_match: true
    starts_training: false
  }
}

type KohyaTrainerContract = TrainerContractBase & {
  id: 'kohya_sd_scripts'
  display_name: 'Kohya sd-scripts'
  wire_value: 'kohya_toml'
  capabilities: {
    caption_extensions: ['.txt']
    bucketed_training: true
    caption_shuffle_keep_tokens: true
    conditioning_masks: true
    conditioning_training_args: ['--masked_loss']
    class_tokens_behavior: 'caption_fallback_only'
  }
  generated_artifacts: {
    dataset_config: 'dataset_config.toml'
    caption_sidecar: '<image-stem>.txt'
    conditioning_directory: 'mask'
  }
  verification_boundary: TrainerContractBase['verification_boundary'] & {
    required_flags: ['--support_dreambooth', '--support_finetuning', '--support_dropout']
    conditioning_flag: '--support_controlnet'
    validates_artifact_completeness: false
    artifact_completeness_gate: 'all_conditioning_files_before_generation'
  }
}

type AnimaTrainerContract = TrainerContractBase & {
  id: 'anima_lora'
  display_name: 'Anima LoRA'
  wire_value: 'anima_lora_toml'
  upstream: TrainerContractBase['upstream'] & {
    license: 'MIT'
    python_requirement: '==3.13.*'
  }
  capabilities: {
    caption_extensions: ['.txt']
    separate_loss_masks: true
    loss_mask_suffix: '_mask.png'
    class_tokens_behavior: 'forbidden'
  }
  generated_artifacts: {
    dataset_config: 'dataset_config.toml'
    caption_sidecar: '<image-stem>.txt'
    loss_mask: '<relative-path>/<image-stem>_mask.png'
    mask_directory: 'mask'
  }
  verification_boundary: TrainerContractBase['verification_boundary'] & {
    required_flags: ['--support_dropout']
    validates_artifact_completeness: false
    artifact_completeness_gate: 'all_captions_and_requested_masks_before_generation'
  }
}

const KOHYA_CONTRACT: KohyaTrainerContract = {
  id: 'kohya_sd_scripts',
  display_name: 'Kohya sd-scripts',
  wire_value: 'kohya_toml',
  contract_version: '1.0.0',
  verified: true,
  mask_export_modes: ['none', 'kohya'],
  upstream: {
    repository: 'https://github.com/kohya-ss/sd-scripts',
    tag: 'v0.11.1',
    commit: '6721028c79ee85a78b3a06dfd8954dae310a1cce',
  },
  capabilities: {
    caption_extensions: ['.txt'],
    bucketed_training: true,
    caption_shuffle_keep_tokens: true,
    conditioning_masks: true,
    conditioning_training_args: ['--masked_loss'],
    class_tokens_behavior: 'caption_fallback_only',
  },
  option_bounds: {
    repeats: { minimum: 1, maximum: 1000, default: 10 },
    batch_size: { minimum: 1, maximum: 64, default: 2 },
    resolution: { minimum: 256, maximum: 4096, default: 1024 },
    keep_tokens: { minimum: 0, maximum: 50, default: 0 },
  },
  generated_artifacts: {
    dataset_config: 'dataset_config.toml',
    caption_sidecar: '<image-stem>.txt',
    conditioning_directory: 'mask',
  },
  verification_boundary: {
    module: 'library.config_util',
    required_flags: ['--support_dreambooth', '--support_finetuning', '--support_dropout'],
    conditioning_flag: '--support_controlnet',
    validates_upstream_schema: true,
    validates_artifact_completeness: false,
    requires_module_path_match: true,
    artifact_completeness_gate: 'all_conditioning_files_before_generation',
    starts_training: false,
  },
}

const ANIMA_CONTRACT: AnimaTrainerContract = {
  id: 'anima_lora',
  display_name: 'Anima LoRA',
  wire_value: 'anima_lora_toml',
  contract_version: '1.0.0',
  verified: true,
  mask_export_modes: ['none', 'anima_lora'],
  upstream: {
    repository: 'https://github.com/sorryhyun/anima_lora',
    tag: 'v1.14.2.hotfix',
    commit: '13eaf97a3903405baa939d7cb4a524f8f3e11303',
    license: 'MIT',
    python_requirement: '==3.13.*',
  },
  capabilities: {
    caption_extensions: ['.txt'],
    separate_loss_masks: true,
    loss_mask_suffix: '_mask.png',
    class_tokens_behavior: 'forbidden',
  },
  option_bounds: {
    repeats: { minimum: 1, maximum: 1000, default: 10 },
    batch_size: { minimum: 1, maximum: 64, default: 2 },
    resolution: { minimum: 1024, maximum: 1024, default: 1024 },
    keep_tokens: { minimum: 0, maximum: 0, default: 0 },
  },
  generated_artifacts: {
    dataset_config: 'dataset_config.toml',
    caption_sidecar: '<image-stem>.txt',
    loss_mask: '<relative-path>/<image-stem>_mask.png',
    mask_directory: 'mask',
  },
  verification_boundary: {
    module: 'library.config.loader',
    required_flags: ['--support_dropout'],
    validates_upstream_schema: true,
    validates_artifact_completeness: false,
    requires_module_path_match: true,
    artifact_completeness_gate: 'all_captions_and_requested_masks_before_generation',
    starts_training: false,
  },
}

const VALID_RESPONSE = { trainers: [KOHYA_CONTRACT, ANIMA_CONTRACT] }

async function stubSupportingRoutes(page: Page) {
  await page.route(/\/api\/images\/(?:1201|1202)(?:\?.*)?$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    return route.fulfill({
      json: {
        id,
        filename: id === 1201 ? 'trainer-a.png' : 'trainer-b.png',
        path: `C:/source/trainer-${id}.png`,
        width: 1024,
        height: 1024,
      },
    })
  })
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
}

async function seedExportableDataset(page: Page, waitUntil: 'domcontentloaded' | 'networkidle') {
  await stubSupportingRoutes(page)
  await page.goto('/', { waitUntil })
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._trainerExportFields === 'function')
  await page.evaluate(() => {
    ;(window as any).App.switchView('dataset')
  })
  await page.waitForFunction(() => (
    (window as any).DatasetMaker?._projectSettingsPersistenceBound === true
  ))
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [1201, 1202]
    dm.meta.set(1201, { filename: 'trainer-a.png', width: 1024, height: 1024 })
    dm.meta.set(1202, { filename: 'trainer-b.png', width: 1024, height: 1024 })
    dm.captions.set(1201, 'subject, standing')
    dm.captions.set(1202, 'subject, sitting')
    ;(window as any).DatasetEstimator.refresh()
    dm._setActive(1201)
    dm._setPipelineTab('export')
    const output = document.getElementById('dataset-output-folder') as HTMLInputElement
    output.value = 'C:/training/verified-package'
    output.dispatchEvent(new Event('input', { bubbles: true }))
    const panel = document.getElementById('dataset-trainer-package-panel') as HTMLElement
    const advanced = panel.closest('details') as HTMLDetailsElement
    advanced.open = true
  })
}

async function selectCustomOption(page: Page, selectId: string, value: string) {
  const wrapper = page.locator(`.dataset-custom-dropdown[data-select-id="${selectId}"]`)
  const display = wrapper.locator('.dataset-custom-dropdown-display')
  await display.evaluate((element) => {
    const details = element.closest('details')
    if (details instanceof HTMLDetailsElement) details.open = true
  })
  await display.scrollIntoViewIfNeeded()
  await expect(display).toBeVisible()
  await display.click()
  await page.locator(
    `.dataset-custom-dropdown-list:not([hidden]) .dataset-custom-dropdown-option[data-value="${value}"]`,
  ).click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('loads verified contracts before enabling Readiness', async ({ page }) => {
  let releaseResponse!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route('**/api/dataset/trainers', async (route) => {
    await gate
    await route.fulfill({ json: VALID_RESPONSE })
  })
  await seedExportableDataset(page, 'domcontentloaded')

  const selector = page.getByTestId('dataset-trainer-package')
  await expect(page.getByTestId('dataset-trainer-contract-state')).toHaveAttribute('data-state', 'loading')
  await expect(selector).toBeDisabled()
  await expect(page.locator(
    '.dataset-custom-dropdown[data-select-id="dataset-trainer-package"] .dataset-custom-dropdown-display',
  )).toBeDisabled()
  await expect(page.getByTestId('dataset-readiness-check')).toBeDisabled()
  await expect(page.getByTestId('dataset-readiness-check')).toHaveAttribute('title', /Loading verified trainer contracts/i)

  releaseResponse()
  await expect(page.getByTestId('dataset-trainer-contract-state')).toHaveAttribute('data-state', 'ready')
  await expect(selector).toBeEnabled()
  await expect(selector.locator('option')).toHaveCount(3)
  await expect(selector.locator('option')).toHaveText([
    'Images + captions only',
    'Kohya sd-scripts',
    'Anima LoRA',
  ])
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
})

test('maps Anima and Kohya contracts into exact controls and payload fields', async ({ page }) => {
  await page.route('**/api/dataset/trainers', (route) => route.fulfill({ json: VALID_RESPONSE }))
  await seedExportableDataset(page, 'networkidle')
  const selector = page.getByTestId('dataset-trainer-package')
  await expect(selector).toBeEnabled()

  await page.evaluate(() => {
    const beside = document.querySelector(
      'input[name="dataset-output-mode"][value="beside_image"]',
    ) as HTMLInputElement
    const move = document.querySelector(
      'input[name="dataset-image-op-radio"][value="move"]',
    ) as HTMLInputElement
    const operation = document.getElementById('dataset-image-op') as HTMLInputElement
    beside.disabled = false
    beside.checked = true
    move.disabled = false
    move.checked = true
    operation.value = 'move'
  })
  await selectCustomOption(page, 'dataset-trainer-package', 'anima_lora_toml')

  await expect(page.locator('input[name="dataset-output-mode"][value="folder"]')).toBeChecked()
  await expect(page.locator('input[name="dataset-output-mode"][value="beside_image"]')).toBeDisabled()
  await expect(page.locator('input[name="dataset-image-op-radio"][value="copy"]')).toBeChecked()
  await expect(page.locator('input[name="dataset-image-op-radio"][value="move"]')).toBeDisabled()
  await expect(page.locator('#dataset-mask-export option')).toHaveText([
    "Don't export",
    'Anima LoRA (mask/<stem>_mask.png)',
  ])
  await selectCustomOption(page, 'dataset-mask-export', 'anima_lora')
  await expect(page.getByTestId('dataset-trainer-resolution')).toHaveValue('1024')
  await expect(page.getByTestId('dataset-trainer-resolution')).toBeDisabled()
  await expect(page.locator('#dataset-trainer-keep-tokens')).toHaveValue('0')
  await expect(page.locator('#dataset-trainer-keep-tokens')).toBeDisabled()

  const animaPayload = await page.evaluate(() => (window as any).DatasetMaker._buildExportPayload())
  expect(animaPayload).toMatchObject({
    output_mode: 'folder',
    image_op: 'copy',
    mask_export: 'anima_lora',
    trainer_config: 'anima_lora_toml',
    trainer_repeats: 10,
    trainer_batch: 2,
    trainer_resolution: 1024,
    trainer_keep_tokens: 0,
  })

  await selectCustomOption(page, 'dataset-trainer-package', 'kohya_toml')
  await expect(page.locator('#dataset-mask-export option')).toHaveText([
    "Don't export",
    'Kohya conditioning masks (mask/ folder)',
  ])
  const resolution = page.getByTestId('dataset-trainer-resolution')
  const keepTokens = page.locator('#dataset-trainer-keep-tokens')
  await expect(resolution).toBeEnabled()
  await expect(resolution).toHaveAttribute('min', '256')
  await expect(resolution).toHaveAttribute('max', '4096')
  await expect(keepTokens).toBeEnabled()
  await expect(keepTokens).toHaveAttribute('min', '0')
  await expect(keepTokens).toHaveAttribute('max', '50')
  await resolution.fill('1536')
  await keepTokens.fill('3')
  await page.locator('#dataset-est-repeats').fill('12')
  await page.locator('#dataset-est-batch').fill('4')
  await selectCustomOption(page, 'dataset-mask-export', 'kohya')

  const kohyaPayload = await page.evaluate(() => (window as any).DatasetMaker._buildExportPayload())
  expect(kohyaPayload).toMatchObject({
    output_mode: 'folder',
    image_op: 'copy',
    mask_export: 'kohya',
    trainer_config: 'kohya_toml',
    trainer_repeats: 12,
    trainer_batch: 4,
    trainer_resolution: 1536,
    trainer_keep_tokens: 3,
  })
})

test('fails closed for HTTP errors and succeeds only after explicit Retry', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/dataset/trainers', (route) => {
    attempts += 1
    if (attempts === 1) {
      return route.fulfill({ status: 503, json: { detail: 'contracts unavailable' } })
    }
    return route.fulfill({ json: VALID_RESPONSE })
  })
  await seedExportableDataset(page, 'networkidle')

  const state = page.getByTestId('dataset-trainer-contract-state')
  await expect(state).toHaveAttribute('data-state', 'error')
  await expect(state).toContainText('503')
  await expect(page.getByTestId('dataset-trainer-package')).toBeDisabled()
  await expect(page.getByTestId('dataset-readiness-check')).toBeDisabled()
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  const payloadError = await page.evaluate(() => {
    try {
      ;(window as any).DatasetMaker._buildExportPayload()
      return ''
    } catch (error) {
      return (error as Error).message
    }
  })
  expect(payloadError).toContain('503')

  await page.getByTestId('dataset-trainer-contract-retry').click()
  await expect(state).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('dataset-trainer-package')).toBeEnabled()
  expect(attempts).toBe(2)
})

test('rejects malformed, duplicate, unverified, unsupported, and empty responses', async ({ page }) => {
  const invalidResponses: Array<{ body?: string; json?: JsonValue }> = [
    { body: '{"trainers":' },
    { json: { trainers: [KOHYA_CONTRACT, { ...ANIMA_CONTRACT, id: KOHYA_CONTRACT.id }] } },
    { json: { trainers: [{ ...KOHYA_CONTRACT, verified: false }] } },
    { json: { trainers: [{ ...KOHYA_CONTRACT, wire_value: 'unknown_toml' }] } },
    { json: { trainers: [KOHYA_CONTRACT] } },
    {
      json: {
        trainers: [
          { ...KOHYA_CONTRACT, mask_export_modes: ['none', 'anima_lora'] },
          ANIMA_CONTRACT,
        ],
      },
    },
    {
      json: {
        trainers: [
          { ...KOHYA_CONTRACT, id: ANIMA_CONTRACT.id },
          { ...ANIMA_CONTRACT, id: KOHYA_CONTRACT.id },
        ],
      },
    },
    {
      json: {
        trainers: [
          { ...KOHYA_CONTRACT, upstream: { ...KOHYA_CONTRACT.upstream, tag: 'v0.11.2' } },
          ANIMA_CONTRACT,
        ],
      },
    },
    {
      json: {
        trainers: [
          KOHYA_CONTRACT,
          {
            ...ANIMA_CONTRACT,
            option_bounds: {
              ...ANIMA_CONTRACT.option_bounds,
              resolution: { minimum: 256, maximum: 4096, default: 1024 },
            },
          },
        ],
      },
    },
    {
      json: {
        trainers: [
          KOHYA_CONTRACT,
          {
            ...ANIMA_CONTRACT,
            generated_artifacts: {
              ...ANIMA_CONTRACT.generated_artifacts,
              loss_mask: '<image-stem>-mask.png',
            },
          },
        ],
      },
    },
    { json: { trainers: [] } },
    {
      json: {
        future_response_field: 'ignored',
        trainers: [
          { ...KOHYA_CONTRACT, future_contract_field: 'ignored' },
          ANIMA_CONTRACT,
        ],
      },
    },
  ]
  let attempt = 0
  await page.route('**/api/dataset/trainers', (route) => {
    const response = invalidResponses[attempt]
    attempt += 1
    if (response.body !== undefined) {
      return route.fulfill({ body: response.body, contentType: 'application/json' })
    }
    return route.fulfill({ json: response.json })
  })
  await seedExportableDataset(page, 'networkidle')
  const state = page.getByTestId('dataset-trainer-contract-state')

  for (let index = 0; index < invalidResponses.length - 1; index += 1) {
    await expect(state).toHaveAttribute('data-state', 'error')
    await expect(page.getByTestId('dataset-trainer-package')).toBeDisabled()
    await page.getByTestId('dataset-trainer-contract-retry').click()
  }
  await expect(state).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('dataset-trainer-package')).toBeEnabled()
  expect(attempt).toBe(invalidResponses.length)
})

test('changing trainer settings invalidates an accepted Readiness report', async ({ page }) => {
  await page.route('**/api/dataset/trainers', (route) => route.fulfill({ json: VALID_RESPONSE }))
  await seedExportableDataset(page, 'networkidle')
  await expect(page.getByTestId('dataset-trainer-contract-state')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._readinessAcceptedSignature = dm._readinessPayloadSnapshot().signature
    dm._setReadinessView({
      state: 'ready',
      message: '',
      report: {
        report_id: 'report',
        input_fingerprint: 'fingerprint',
        summary: {
          processed: 2,
          total_requested: 2,
          trainable_pairs: 2,
          blocker_count: 0,
          warning_count: 0,
        },
        issues: [],
      },
      activeJobId: null,
      processed: 2,
      total: 2,
    })
  })
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')

  await selectCustomOption(page, 'dataset-trainer-package', 'kohya_toml')
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
})

test('trainer controls stay visible and unclipped at supported desktop widths', async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/api/dataset/trainers', (route) => route.fulfill({ json: VALID_RESPONSE }))
  await seedExportableDataset(page, 'networkidle')
  await selectCustomOption(page, 'dataset-trainer-package', 'kohya_toml')

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const panel = document.getElementById('dataset-trainer-package-panel')
      const selector = document.querySelector(
        '.dataset-custom-dropdown[data-select-id="dataset-trainer-package"] .dataset-custom-dropdown-display',
      )
      const settings = document.getElementById('dataset-trainer-settings')
      if (!panel || !selector || !settings) throw new Error('Trainer selector layout nodes are missing')
      const panelRect = panel.getBoundingClientRect()
      const selectorRect = selector.getBoundingClientRect()
      const settingsRect = settings.getBoundingClientRect()
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        selectorLeft: selectorRect.left,
        selectorRight: selectorRect.right,
        settingsLeft: settingsRect.left,
        settingsRight: settingsRect.right,
        panelWidth: panelRect.width,
        panelHeight: panelRect.height,
        viewportWidth: window.innerWidth,
      }
    })
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(layout.panelLeft).toBeGreaterThanOrEqual(0)
    expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.selectorLeft).toBeGreaterThanOrEqual(layout.panelLeft)
    expect(layout.selectorRight).toBeLessThanOrEqual(layout.panelRight + 1)
    expect(layout.settingsLeft).toBeGreaterThanOrEqual(layout.panelLeft)
    expect(layout.settingsRight).toBeLessThanOrEqual(layout.panelRight + 1)
    expect(layout.panelWidth).toBeGreaterThan(200)
    expect(layout.panelHeight).toBeGreaterThan(0)
  }

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})
