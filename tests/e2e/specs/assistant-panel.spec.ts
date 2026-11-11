import { expect, test, type Page } from '@playwright/test'

/**
 * The built-in assistant's panel. The model service is not part of these
 * tests: the assistant's own endpoints are answered here, so what is pinned is
 * what the user sees: the setup comes first when nothing is set up, a result
 * lands in the Gallery, and a change happens only through its confirmation card.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

interface Assistant {
  ready: boolean
  /** Events the next run plays, in order. */
  script: Array<Record<string, unknown>>
  confirmations: Array<{ id: string; approved: boolean }>
  runs: Array<{ messages: Array<{ role: string }>; view: Record<string, unknown> }>
  galleryQueries: string[]
  stops: number
}

async function mockProgram(page: Page, assistant: Assistant) {
  const images = Array.from({ length: 12 }, (_, index) => ({
    id: 3001 + index,
    filename: `assistant-${index + 1}.png`,
    path: `/mock/assistant-${index + 1}.png`,
    prompt: `mock prompt ${index + 1}`,
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.continue()
      return
    }
    assistant.galleryQueries.push(url.search)
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })

  const settings = () => ({
    endpoint: assistant.ready ? 'http://127.0.0.1:11434/v1' : '',
    model: assistant.ready ? 'local-model' : '',
    api_key_display: '',
    access: 'ask',
    extra_instructions: '',
    use_caption_service: false,
    caption_service: null,
    ready: assistant.ready,
    using: assistant.ready ? { source: 'own', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-model' } : null,
  })
  let release: (() => void) | null = null
  let answered: Promise<void> | null = null
  let played = 0
  await page.route('**/api/assistant/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/assistant', '')
    const method = route.request().method()
    if (path === '/settings') {
      if (method === 'POST' && route.request().postDataJSON().endpoint) assistant.ready = true
      await route.fulfill({ json: settings() })
    } else if (path === '/runs') {
      assistant.runs.push(route.request().postDataJSON())
      played = 0
      await route.fulfill({ json: { run_id: 'run1' } })
    } else if (path.endsWith('/events')) {
      // Play up to and including the next confirmation; what follows waits for the answer.
      if (answered) await answered
      const batch: Array<Record<string, unknown>> = []
      while (played < assistant.script.length) {
        const event = assistant.script[played]
        played += 1
        batch.push(event)
        if (event.type === 'confirm') {
          answered = new Promise<void>((resolve) => { release = resolve })
          break
        }
      }
      await route.fulfill({ json: { events: batch, next: played, finished: played >= assistant.script.length } }).catch(() => {})
    } else if (path.endsWith('/confirm')) {
      assistant.confirmations.push(route.request().postDataJSON())
      release?.()
      answered = null
      await route.fulfill({ json: { ok: true } })
    } else if (path.endsWith('/stop')) {
      assistant.stops += 1
      await route.fulfill({ json: { ok: true } })
    } else {
      await route.fulfill({ json: {} })
    }
  })
}

function newAssistant(ready: boolean): Assistant {
  return { ready, script: [], confirmations: [], runs: [], galleryQueries: [], stops: 0 }
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.locator('#btn-assistant').click()
  await expect(page.locator('#assistant-panel')).toBeVisible()
}

test('with no model set up the panel opens on the setup and says what is sent', async ({ page }) => {
  const assistant = newAssistant(false)
  await mockProgram(page, assistant)
  await open(page)

  await expect(page.locator('.assistant-setup')).toBeVisible()
  await expect(page.locator('.assistant-setup-sent')).toContainText('Pictures themselves are not sent')
  await expect(page.locator('#assistant-access')).toHaveValue('ask')

  await page.locator('#assistant-endpoint').fill('http://127.0.0.1:11434/v1')
  await page.locator('#assistant-model').fill('local-model')
  await page.locator('#assistant-save').click()

  await expect(page.locator('.assistant-welcome')).toBeVisible()
  await expect(page.locator('.assistant-model')).toHaveText('local-model')
  // The panel stays inside the window.
  const box = await page.locator('#assistant-panel').boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(1366)
})

test('a result is put in the Gallery and a change waits for its confirmation card', async ({ page }) => {
  const assistant = newAssistant(true)
  assistant.script = [
    { type: 'tool', name: 'count_images', id: 'a' },
    { type: 'tool_end', id: 'a', ok: true },
    { type: 'tool', name: 'show_in_gallery', id: 'b' },
    { type: 'show', action: 'show_in_gallery', args: { tags: ['cat_ears'], min_user_rating: 4 } },
    { type: 'tool_end', id: 'b', ok: true },
    { type: 'tool', name: 'add_tags', id: 'c' },
    { type: 'confirm', id: 'k1', summary: { action: 'add_tags', pictures: 12, tags: ['favourite'] } },
    { type: 'confirm_closed', id: 'k1', approved: true },
    { type: 'tool_end', id: 'c', ok: true },
    { type: 'text', delta: 'Twelve pictures are **shown** and tagged.' },
    { type: 'done', messages: [{ role: 'assistant', content: 'Twelve pictures are shown and tagged.' }] },
  ]
  await mockProgram(page, assistant)
  await open(page)

  await page.locator('#assistant-input').fill('show my best cat ear pictures and tag them favourite')
  await page.locator('#assistant-input').press('Enter')

  // The request carries the conversation and what is on screen.
  await expect.poll(() => assistant.runs.length).toBe(1)
  expect(assistant.runs[0].messages.at(-1)?.role).toBe('user')
  expect(assistant.runs[0].view.page).toBe('gallery')

  // The Gallery now shows what the assistant asked for.
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual(['cat_ears'])
  expect(await page.evaluate(() => (window as any).App.AppState.filters.minUserRating)).toBe(4)
  await expect.poll(() => assistant.galleryQueries.some((query) => query.includes('cat_ears'))).toBe(true)

  // Nothing is confirmed until the user presses the button on the card.
  const card = page.locator('.assistant-confirm.is-waiting')
  await expect(card).toContainText('12 pictures')
  await expect(card).toContainText('favourite')
  expect(assistant.confirmations).toEqual([])
  await card.locator('[data-assistant-confirm="yes"]').click()

  await expect.poll(() => assistant.confirmations).toEqual([{ id: 'k1', approved: true }])
  await expect(page.locator('.assistant-confirm.is-approved')).toBeVisible()
  await expect(page.locator('.assistant-msg-reply strong')).toHaveText('shown')
  await expect(page.locator('.assistant-step.is-done')).toHaveCount(3)
  await expect(page.locator('#assistant-send')).toHaveText('Send')

  // The conversation survives a reload, with the panel still open.
  await page.reload()
  await expect(page.locator('#assistant-panel')).toBeVisible()
  await expect(page.locator('.assistant-msg-user')).toHaveCount(1)

  // Esc inside the panel closes it and nothing else.
  await page.locator('#assistant-input').focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('#assistant-panel')).toBeHidden()
  await expect(page.locator('#btn-assistant')).toHaveAttribute('aria-expanded', 'false')
})

test('a caption service already set up is offered, not used, until the user saves the setup', async ({ page }) => {
  const assistant = newAssistant(false)
  await mockProgram(page, assistant)
  let saved: Record<string, unknown> | null = null
  await page.route('**/api/assistant/settings', async (route) => {
    if (route.request().method() === 'POST') saved = route.request().postDataJSON()
    const chosen = Boolean(saved?.use_caption_service)
    await route.fulfill({ json: {
      endpoint: '', model: '', api_key_display: '', access: 'ask', extra_instructions: '',
      use_caption_service: chosen,
      caption_service: { endpoint: 'https://api.example.test/v1', model: 'cloud-model' },
      ready: chosen,
      using: chosen ? { source: 'caption_service', endpoint: 'https://api.example.test/v1', model: 'cloud-model' } : null,
    } })
  })
  await open(page)

  // The setup comes first, names the service and says what would be sent.
  await expect(page.locator('.assistant-setup')).toBeVisible()
  await expect(page.locator('.assistant-setup-borrowed')).toContainText('cloud-model at https://api.example.test/v1')
  await expect(page.locator('.assistant-setup-sent')).toContainText('What is sent')
  expect(assistant.runs).toEqual([])

  await page.locator('#assistant-save').click()
  await expect(page.locator('.assistant-welcome')).toBeVisible()
  expect(saved).toMatchObject({ use_caption_service: true, endpoint: null })
  await expect(page.locator('.assistant-model')).toHaveText('cloud-model')
})

test('keys typed in the panel never reach the page shortcuts', async ({ page }) => {
  const assistant = newAssistant(true)
  await mockProgram(page, assistant)
  await open(page)
  await page.evaluate(() => {
    ;(window as any).__pageKeys = []
    document.addEventListener('keydown', (event) => (window as any).__pageKeys.push(event.key))
  })

  await page.locator('#assistant-input').focus()
  await page.keyboard.type('was d')

  await expect(page.locator('#assistant-input')).toHaveValue('was d')
  expect(await page.evaluate(() => (window as any).__pageKeys)).toEqual([])
})
