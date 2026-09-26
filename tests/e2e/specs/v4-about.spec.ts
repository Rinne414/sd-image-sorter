import { expect, test, type Page, type Route } from '@playwright/test'

import { markModelsReady } from '../fixtures/model-status'
import { pageOverflow, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 About & updates (slice 5c): the version, an update check that never says
 * "latest" before it knows, the new-version hint in the top bar (after the one
 * check half a minute after start, which can be switched off), the install
 * confirm that says what it replaces, the full screen that reloads once the
 * server comes back with a new boot id (and says what to do after three
 * minutes), restarting with the running jobs named, the update proxy, copying
 * diagnostics, opening the log folder and the detailed log.
 *
 * SAFETY: every /api/updates/* request is answered here (a real apply would
 * download a release and patch this worktree, a real restart would stop the
 * test server), and so are /api/support/open-log (it opens a file manager
 * window) and /api/system-info (the hardware probe touches the GPU).
 */

test.describe.configure({ mode: 'serial' })

type Json = Record<string, unknown>

const CURRENT = '3.5.1'
const NOTES =
  '## v3.6.0 — 大图库更稳 / Steadier large libraries\n\n扫描 8 万张图更稳。数据库更小。第一次启动只装核心依赖。\n\nScans of 80k images are steadier. The database is smaller. First launch installs only the core packages.\n\n---\n\n## Fixed\n\n- **Scan**: steadier.'

const status = (fields: Json = {}): Json => ({
  updater_enabled: true,
  current_version: CURRENT,
  latest_version: CURRENT,
  has_update: false,
  release_url: 'https://github.com/example/sd-image-sorter/releases/latest',
  release_notes: '',
  asset: null,
  error: null,
  update_unavailable_reason: null,
  channel_name: 'GitHub Releases',
  is_default_github_channel: true,
  has_channel_override: false,
  checked_at: Date.now() / 1000,
  ...fields,
})

const NEWER = status({
  latest_version: '3.6.0',
  has_update: true,
  release_notes: NOTES,
  release_url: 'https://github.com/example/sd-image-sorter/releases/tag/v3.6.0',
  asset: { name: 'sd-image-sorter-v3.6.0-app-patch.zip', size_bytes: 42 * 1024 * 1024 },
})

const DEFAULT_CHANNEL: Json = { channel_name: 'GitHub Releases', download_url_prefix: '', has_channel_override: false, is_default_github_channel: true }
const SYSTEM = {
  system_info: {
    gpu_name: 'NVIDIA GeForce RTX 3090',
    torch_cuda_available: true,
    gpu_vram_total_mb: 24576,
    gpu_vram_available_mb: 20480,
    total_ram_gb: 64,
    available_ram_gb: 40,
    cpu_count: 24,
    os_platform: 'Windows',
    onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
  },
}

interface Stub {
  status: Json
  channel: Json
  statusHits: string[]
  proxyPosts: Json[]
  channelDeletes: number
  applyPosts: Json[]
  restartPosts: Json[]
  /** What POST /api/updates/restart answers, in turn (the last one repeats). */
  restartAnswers: Json[]
  bootIds: string[]
  bootHits: number
  openLog: number
}

function newStub(fields: Partial<Stub> = {}): Stub {
  return {
    status: status(),
    channel: DEFAULT_CHANNEL,
    statusHits: [],
    proxyPosts: [],
    channelDeletes: 0,
    applyPosts: [],
    restartPosts: [],
    restartAnswers: [{ status: 'scheduled', boot_id: 'boot-A' }],
    bootIds: ['boot-A'],
    bootHits: 0,
    openLog: 0,
    ...fields,
  }
}

async function stubAll(page: Page, stub: Stub) {
  // the catch-all first: the more specific routes below win (Playwright tries the last added first)
  await page.route('**/api/updates/**', (route: Route) => route.fulfill({ status: 500, json: { detail: 'unexpected update call in a test' } }))
  await page.route('**/api/updates/status**', (route: Route) => {
    stub.statusHits.push(new URL(route.request().url()).search)
    return route.fulfill({ json: stub.status })
  })
  await page.route('**/api/updates/channel', (route: Route) => {
    if (route.request().method() === 'DELETE') {
      stub.channelDeletes += 1
      stub.channel = DEFAULT_CHANNEL
    }
    return route.fulfill({ json: stub.channel })
  })
  await page.route('**/api/updates/channel/proxy', (route: Route) => {
    const body = route.request().postDataJSON() as Json
    stub.proxyPosts.push(body)
    stub.channel = { channel_name: body.channel_name, download_url_prefix: body.proxy_prefix, has_channel_override: true, is_default_github_channel: false }
    return route.fulfill({ json: stub.channel })
  })
  await page.route('**/api/updates/apply', (route: Route) => {
    stub.applyPosts.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: { ...stub.status, status: 'scheduled', restart_required: true } })
  })
  await page.route('**/api/updates/restart', (route: Route) => {
    stub.restartPosts.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: stub.restartAnswers[Math.min(stub.restartPosts.length - 1, stub.restartAnswers.length - 1)] })
  })
  await page.route('**/api/updates/boot-id', (route: Route) => {
    const id = stub.bootIds[Math.min(stub.bootHits, stub.bootIds.length - 1)]
    stub.bootHits += 1
    return route.fulfill({ json: { boot_id: id } })
  })
  await page.route('**/api/support/open-log', (route: Route) => {
    stub.openLog += 1
    return route.fulfill({ json: { opened: true, path_redacted: '<DATA>/logs' } })
  })
  await page.route('**/api/system-info', (route: Route) => route.fulfill({ json: SYSTEM }))
  // nothing holds the AI (no chip) unless a test says otherwise
  await page.route('**/api/system/ai-jobs', (route: Route) => route.fulfill({ json: { active: 0, jobs: [] } }))
}

/** Open V4 at an address in a language (once per page, so reloads keep what the test changed). */
async function openAt(page: Page, hash: string, lang: 'en' | 'zh-CN' = 'en', theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript(
    ([l, th]) => {
      if (sessionStorage.getItem('v4about-init')) return
      sessionStorage.setItem('v4about-init', '1')
      localStorage.setItem('sd-image-sorter-lang', l)
      localStorage.setItem('sd-v4-theme', th)
      localStorage.removeItem('sd-v4-ui-scale')
      localStorage.removeItem('sd-v4-update-autocheck')
      localStorage.removeItem('sd-v4-debug')
    },
    [lang, theme] as const,
  )
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

test.beforeEach(async ({ page }) => markModelsReady(page))

test('About: the version, no "latest" before a check, a check that finds a new version, and the top bar hint leading back here', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openAt(page, '#/settings/about')

  await expect(page.getByTestId('settings-tab-about')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+/)
  await expect(page.getByTestId('about-privacy')).toContainText('Images are processed only on this computer')

  // nothing checked yet: nothing said about the latest version, nothing asked
  const state = page.getByTestId('update-state')
  await expect(state).toHaveAttribute('data-kind', 'unchecked')
  await expect(state).toHaveText('Not checked for a new version yet.')
  await expect(page.getByTestId('update-hint')).toHaveCount(0)
  expect(stub.statusHits).toEqual([])

  // a check that finds nothing newer
  await page.getByTestId('update-check').click()
  await expect(state).toHaveAttribute('data-kind', 'latest')
  await expect(state).toContainText('You have the latest version.')
  await expect(state).toContainText('update source: Official GitHub')
  expect(stub.statusHits).toEqual(['?force=true'])
  await expect(page.getByTestId('update-hint')).toHaveCount(0)

  // a new version: what it is, the start of its notes (to a sentence end), all of them on request, its page
  stub.status = NEWER
  await page.getByTestId('update-check').click()
  await expect(state).toHaveAttribute('data-kind', 'available')
  await expect(state).toContainText(`Version 3.6.0 is out; you have ${CURRENT}.`)
  const notes = page.getByTestId('update-notes')
  await expect(notes).toContainText('v3.6.0 — 大图库更稳 / Steadier large libraries')
  await expect(notes).not.toContainText('## ')
  await expect(notes).not.toContainText('Scan: steadier.')
  await page.getByTestId('update-notes-more').click()
  await expect(notes).toContainText('Scan: steadier.')
  await expect(page.getByTestId('update-page')).toHaveAttribute('href', 'https://github.com/example/sd-image-sorter/releases/tag/v3.6.0')
  await expect(page.getByTestId('update-install')).toBeInViewport({ ratio: 1 })

  // the top bar says so everywhere and leads back here
  const hint = page.getByTestId('update-hint')
  await expect(hint).toHaveText('New 3.6.0')
  await page.getByRole('navigation', { name: 'main' }).getByRole('button', { name: 'Library' }).click()
  await expect(hint).toBeInViewport({ ratio: 1 })
  await hint.click()
  await expect(page).toHaveURL(/#\/settings\/about$/)
  await expect(state).toHaveAttribute('data-kind', 'available')
})

test('one check half a minute after start (not before), the hint appears; switched off, nothing is asked after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.clock.install()
  const stub = newStub({ status: NEWER })
  await stubAll(page, stub)
  await openAt(page, '#/library')
  await expect(page.getByTestId('open-palette')).toBeVisible()

  await page.clock.fastForward(20_000)
  await page.waitForTimeout(300)
  expect(stub.statusHits, 'no check in the first half minute').toEqual([])
  await page.clock.fastForward(11_000)
  await expect(page.getByTestId('update-hint')).toHaveText('New 3.6.0')
  // an ordinary check: the backend's 15-minute answer is fine
  expect(stub.statusHits).toEqual(['?force=false'])

  // switch it off in About; "Saved" shows; it stays off after a reload and nothing is asked
  await page.getByTestId('update-hint').click()
  const auto = page.getByTestId('update-auto')
  await expect(auto).toBeChecked()
  await auto.uncheck()
  await expect(page.getByTestId('about-update').getByRole('status').first()).toHaveText('Saved')
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-update-autocheck'))).toBe('0')
  await page.reload()
  await expect(page.getByTestId('update-auto')).not.toBeChecked()
  await page.clock.fastForward(60_000)
  await page.waitForTimeout(300)
  expect(stub.statusHits).toEqual(['?force=false'])
  await expect(page.getByTestId('update-hint')).toHaveCount(0)
  await expect(page.getByTestId('update-state')).toHaveAttribute('data-kind', 'unchecked')

  // back on: the next start checks again
  await page.getByTestId('update-auto').check()
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-update-autocheck'))).toBeNull()
})

test('a failed check says so and opens the update proxy; saving and resetting the proxy send the right requests', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({ status: status({ error: 'Failed to reach the default GitHub update channel: timed out.' }) })
  await stubAll(page, stub)
  await openAt(page, '#/settings/about')

  const proxy = page.getByTestId('update-proxy')
  await expect(proxy).not.toHaveAttribute('open')
  await page.getByTestId('update-check').click()
  const state = page.getByTestId('update-state')
  await expect(state).toHaveAttribute('data-kind', 'error')
  await expect(state).toContainText('Could not reach the update source (Official GitHub)')
  await expect(state).toContainText('Your network may not reach GitHub')
  await expect(state).not.toContainText('latest version')
  await expect(page.getByTestId('update-check')).toHaveText('Try again')
  // the backend's own words only on request
  await expect(state.getByText('timed out')).toBeHidden()
  await state.getByText('Details').click()
  await expect(state.getByText('Failed to reach the default GitHub update channel: timed out.')).toBeVisible()

  // the proxy panel opened by itself
  await expect(proxy).toHaveAttribute('open')
  await expect(proxy).toContainText('Now using: Official GitHub')
  const input = page.getByTestId('proxy-input')
  await input.fill('http://plain.example/')
  await page.getByTestId('proxy-save').click()
  await expect(page.getByTestId('proxy-note')).toHaveText('The proxy prefix must start with https://.')
  expect(stub.proxyPosts).toEqual([])

  await input.fill('https://ghproxy.example/')
  await input.press('Enter')
  await expect(page.getByTestId('proxy-note')).toHaveText('Saved. The next check goes through this proxy.')
  expect(stub.proxyPosts).toEqual([{ proxy_prefix: 'https://ghproxy.example/', channel_name: 'Custom Proxy' }])
  await expect(proxy).toContainText('Now using: Custom proxy · https://ghproxy.example/')
  // what the old source said no longer holds
  await expect(state).toHaveAttribute('data-kind', 'unchecked')

  await page.getByTestId('proxy-reset').click()
  await expect(page.getByTestId('proxy-note')).toHaveText('Back to official GitHub.')
  expect(stub.channelDeletes).toBe(1)
  await expect(proxy).toContainText('Now using: Official GitHub')
  await expect(page.getByTestId('proxy-reset')).toHaveCount(0)
  await expect(proxy).toHaveAttribute('open')
})

test('install: the confirm says what it downloads, replaces and leaves alone; the full screen reloads once the server has a new boot id', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  // before the apply the old server answers; then it is gone for a moment; then a new one
  const stub = newStub({ status: NEWER, bootIds: ['boot-A', 'boot-A', 'boot-B'] })
  await stubAll(page, stub)
  await openAt(page, '#/settings/about')
  await page.getByTestId('update-check').click()
  await page.getByTestId('update-install').click()

  const dialog = page.getByTestId('install-dialog')
  await expect(dialog.getByRole('heading')).toHaveText('Install 3.6.0?')
  await expect(dialog).toContainText('downloads the 3.6.0 update package (about 42.0 MB)')
  await expect(dialog).toContainText('replaces the program files in this folder (backend, interface and launch scripts)')
  await expect(dialog).toContainText('Your images, library index, settings and downloaded models are left alone.')
  await expect(dialog).toContainText('restarts by itself, usually in one to three minutes')
  await expect(dialog).toContainText('If the new version does not include V4, carry on in V3.5')
  await expect(dialog.getByTestId('install-jobs')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

  // Esc closes the confirm only; nothing was sent
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('settings-page')).toBeVisible()
  expect(stub.applyPosts).toEqual([])

  await page.getByTestId('update-install').click()
  await page.evaluate(() => ((window as unknown as { beforeUpdate: boolean }).beforeUpdate = true))
  await dialog.getByTestId('install-go').click()
  const screen = page.getByTestId('restart-screen')
  await expect(screen).toBeVisible()
  await expect(screen).toContainText('Installing the update and restarting…')
  expect(stub.applyPosts).toEqual([{ force_check: true, relaunch: true }])

  // a new server: the page reloads by itself (a look during the reload itself counts as "not yet")
  const stillBefore = () =>
    page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate ?? false).catch(() => true)
  await expect.poll(stillBefore, { timeout: 15_000 }).toBe(false)
  await expect(page.getByTestId('settings-page')).toBeVisible()
  await expect(page.getByTestId('restart-screen')).toHaveCount(0)
})

test('restart asks first, names the running jobs, restarts anyway on request, and says what to do after three minutes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.clock.install()
  const stub = newStub({
    restartAnswers: [
      { status: 'busy', jobs: ['scan', 'tagging', 'mystery'], boot_id: 'boot-A' },
      { status: 'scheduled', boot_id: 'boot-A', launcher: 'run.bat' },
    ],
    // the server never comes back
    bootIds: ['boot-A'],
  })
  await stubAll(page, stub)
  await openAt(page, '#/settings/about')

  const ask = page.getByTestId('restart-ask')
  await page.getByTestId('about-restart').click()
  await expect(ask.getByRole('heading')).toHaveText('Restart the app?')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  expect(stub.restartPosts).toEqual([])

  await page.getByTestId('about-restart').click()
  await ask.getByTestId('restart-go').click()
  await expect(ask.getByRole('heading')).toHaveText('Restart now?')
  await expect(ask).toContainText('Still running: a folder scan, tagging, a background task.')
  await expect(ask.getByTestId('restart-go')).toHaveText('Restart anyway')
  await ask.getByTestId('restart-go').click()
  expect(stub.restartPosts).toEqual([
    { reason: 'user', force: false },
    { reason: 'user', force: true },
  ])

  const screen = page.getByTestId('restart-screen')
  await expect(screen).toContainText('Restarting the app…')
  await expect(screen).toContainText('This page reloads by itself when the app is back')
  // Esc does not leave a page whose server is gone
  await page.keyboard.press('Escape')
  await expect(screen).toBeVisible()

  await page.clock.fastForward(181_000)
  await expect(screen).toHaveAttribute('data-kind', 'slow')
  await expect(screen).toContainText('Three minutes, and the app is not back yet')
  await expect(screen).toContainText('run run.bat again')
  await expect(screen.getByRole('button', { name: 'Reload page' })).toBeFocused()
  await screen.getByRole('button', { name: 'Close' }).click()
  await expect(screen).toHaveCount(0)
})

test('a restart the app cannot do itself says how to restart it by hand', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({ restartAnswers: [{ status: 'unsupported', reason: 'no launcher', boot_id: 'boot-A' }] })
  await stubAll(page, stub)
  await openAt(page, '#/settings/about', 'zh-CN')

  await page.getByTestId('about-restart').click()
  await page.getByTestId('restart-ask').getByTestId('restart-go').click()
  const screen = page.getByTestId('restart-screen')
  await expect(screen).toHaveAttribute('data-kind', 'unsupported')
  await expect(screen).toContainText('没法自己重启')
  await expect(screen).toContainText('重新运行 run.bat')
  await page.keyboard.press('Escape')
  await expect(screen).toHaveCount(0)
})

test('support: diagnostics copied with the hardware, the log folder opened, the detailed log kept over a reload and writing requests', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openAt(page, '#/settings/about')

  const facts = page.getByTestId('system-facts')
  await expect(facts).toContainText('NVIDIA GeForce RTX 3090')
  await expect(facts).toContainText('4.0 GB used of 24.0 GB')
  await expect(facts).toContainText('40.0 GB free of 64.0 GB')
  await expect(facts).toContainText('24 threads')

  await page.getByTestId('about-copy-diag').click()
  await expect(page.getByText('Diagnostics copied')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('SD Image Sorter diagnostics')
  expect(copied).toContain('Interface: V4')
  expect(copied).toContain('GPU: NVIDIA GeForce RTX 3090 (AI can use it)')
  expect(copied).toContain('Update check: unchecked')
  expect(copied).toContain('Recent backend log:')

  await page.getByTestId('about-open-log').click()
  await expect.poll(() => stub.openLog).toBe(1)

  // the detailed log: off by default, on writes each request, kept over a reload
  const logged: string[] = []
  page.on('console', (m) => {
    if (m.text().startsWith('[sd-v4]')) logged.push(m.text())
  })
  const debug = page.getByTestId('debug-log')
  await expect(debug).not.toBeChecked()
  await debug.check()
  await expect(page.getByTestId('about-support').getByRole('status').first()).toHaveText('Saved')
  await page.getByTestId('update-check').click()
  await expect.poll(() => logged.some((line) => /^\[sd-v4\] GET \/api\/updates\/status\?force=true → 200 · \d+ ms$/.test(line))).toBe(true)
  await page.reload()
  await expect(page.getByTestId('debug-log')).toBeChecked()
  await page.getByTestId('debug-log').uncheck()
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-debug'))).toBeNull()
  const statusLines = () => logged.filter((line) => line.includes('/api/updates/status')).length
  const before = statusLines()
  await page.getByTestId('update-check').click()
  await expect(page.getByTestId('update-state')).toHaveAttribute('data-kind', 'latest')
  expect(statusLines()).toBe(before)
})

for (const viewport of VIEWPORTS) {
  test(`top bar fits at ${viewport.width} in both languages with the AI chip, Jobs and the update hint all showing`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const stub = newStub({ status: NEWER })
    await stubAll(page, stub)
    // tagging started elsewhere holds the GPU: the chip and a job in the drawer
    const lease = { label: 'wd14-tagger', tier: 'vram', priority: 50, estimated_vram_mb: null, elapsed_seconds: 42, stuck: false }
    await page.route('**/api/system/ai-jobs', (route: Route) => route.fulfill({ json: { active: 1, vram_active: 1, cpu_active: 0, jobs: [lease] } }))
    await page.route('**/api/tag/progress', (route: Route) =>
      route.fulfill({ json: { status: 'running', run_id: 9, current: 5, total: 40, tagged: 5, errors: 0, runtime_backend_actual: 'gpu' } }),
    )
    await openAt(page, '#/settings/about', 'zh-CN')
    for (const lang of ['zh-CN', 'en'] as const) {
      await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
      await page.reload()
      await page.getByTestId('update-check').click()
      for (const id of ['ai-busy', 'update-hint', 'jobs-button', 'import-button', 'open-palette', 'tools-menu', 'settings-button', 'theme-toggle']) {
        await expect(page.getByTestId(id), `${id} (${lang} at ${viewport.width})`).toBeInViewport({ ratio: 1 })
      }
      await expect(page.locator('header').getByRole('link', { name: lang === 'en' ? 'Back to V3.5' : '回到 V3.5' })).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page), `${lang} at ${viewport.width}`).toBeLessThanOrEqual(0)
      const overlaps = await page.evaluate(() => {
        const items = [...document.querySelector('header')!.children]
          .map((el) => ({ what: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24), r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.top >= 0)
        const hits: string[] = []
        for (let i = 1; i < items.length; i++) {
          if (items[i]!.r.left < items[i - 1]!.r.right - 1) hits.push(`${items[i - 1]!.what} | ${items[i]!.what}`)
        }
        const bar = document.querySelector('header')!.getBoundingClientRect()
        if (bar.right > document.documentElement.clientWidth + 1) hits.push(`bar ends at ${bar.right}`)
        return hits
      })
      expect(overlaps, `${lang} at ${viewport.width}`).toEqual([])
      // nothing in the bar breaks onto a second line (a squeezed 图库 tab stood as 图 over 库)
      const wrapped = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('header')!, NodeFilter.SHOW_TEXT)
        const hits: string[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)))
          if (lines.size > 1) hits.push(node.textContent.trim())
        }
        return hits
      })
      expect(wrapped, `${lang} at ${viewport.width}`).toEqual([])
      // the Ctrl K box gave way first, still saying what it is: the chip keeps its whole name
      await expect(page.getByTestId('open-palette').locator('kbd')).toBeVisible()
      const chipCut = await page.getByTestId('ai-busy').evaluate((chip) => [...chip.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1))
      expect(chipCut, `chip shortened (${lang} at ${viewport.width})`).toBe(false)
    }
  })
}
