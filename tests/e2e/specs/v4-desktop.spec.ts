import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'
import { markModelsReady } from '../fixtures/model-status'
import { dbPath, pageOverflow, runBackendScript, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 desktop pack: Settings > Desktop (start at login, keep running in the
 * tray, the global shortcut, Quick collect), the hard refresh of the
 * interface, the Background line (loaded AI models, free after idle, Unload
 * now) and the one output-folder root with the Pixiv export starting from
 * <root>/publish.
 *
 * The desktop shell cannot run here: window.sdDesktop is STUBBED by an init
 * script (it records each call and answers like the shell's preload does), so
 * these tests prove the page's side only. The Background line's models and the
 * unload are stubbed too (no AI model is loaded in the test server); the output
 * root is real, against a temp folder, and is put back at the end.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

type Lang = 'en' | 'zh-CN'

const DIR = 'v4-desktop'
const PREFIX = 'v4dsk-'
const ROOT = path.join(tmpRoot, DIR, 'root')

test.beforeEach(async ({ page }) => markModelsReady(page))

async function openAt(page: Page, hash: string, lang: Lang = 'en') {
  await page.addInitScript((l) => {
    if (sessionStorage.getItem('v4dsk-init')) return
    sessionStorage.setItem('v4dsk-init', '1')
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.removeItem('sd-v4-pixiv-export')
  }, lang)
  const res = await page.goto(`/vopus/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`page: ${err.message}`))
  return errors
}

/** A stand-in for the shell's preload bridge: it keeps the calls on window.__sd and answers like the shell. */
async function stubShell(page: Page, refuse: string[] = []) {
  await page.addInitScript((refused) => {
    const state = { startAtLogin: false, closeToTray: true, shortcut: 'Control+Alt+Space', shortcutOk: true } as Record<string, unknown>
    const calls: unknown[][] = []
    ;(window as unknown as Record<string, unknown>).__sd = { calls, collectOpened: 0 }
    ;(window as unknown as Record<string, unknown>).sdDesktop = {
      shell: 'electron',
      getSettings: async () => ({ ...state }),
      setSetting: async (key: string, value: unknown) => {
        calls.push([key, value])
        if (key === 'shortcut') {
          const refusedNow = refused.includes(String(value))
          state.shortcut = value
          state.shortcutOk = !refusedNow
          state.shortcutReason = refusedNow ? 'refused' : undefined
        } else state[key] = value
        return { ...state }
      },
      openQuickCollect: () => {
        ;((window as unknown as Record<string, { collectOpened: number }>).__sd as { collectOpened: number }).collectOpened += 1
      },
    }
  }, refuse)
}

const sdCalls = (page: Page) => page.evaluate(() => (window as unknown as { __sd: { calls: unknown[][] } }).__sd.calls)

test('Desktop in a plain browser says these settings belong to the desktop program, and Quick collect opens its popup', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/settings/desktop')
  await expect(page.getByTestId('settings-tab-desktop')).toHaveAttribute('aria-current', 'page')
  const note = page.getByTestId('desktop-browser-note')
  await expect(note).toContainText('These settings belong to the desktop program')
  await expect(note).toContainText('only work in the desktop program')
  await expect(page.getByTestId('desktop-login')).toHaveCount(0)
  await expect(page.getByTestId('desktop-shortcut')).toHaveCount(0)

  const popup = page.waitForEvent('popup')
  await page.getByTestId('desktop-quick-collect').click()
  const opened = await popup
  expect(new URL(opened.url()).pathname).toBe('/static/quick-collect.html')
  await opened.close()
  expect(errors).toEqual([])
})

test('Desktop inside the program (stubbed shell): both switches flip, the shortcut is captured, refused and reset, Quick collect opens the shell window', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubShell(page, ['Control+Alt+K'])
  await openAt(page, '#/settings/desktop')
  await expect(page.getByTestId('desktop-browser-note')).toHaveCount(0)

  const login = page.getByTestId('desktop-login')
  const close = page.getByTestId('desktop-close')
  await expect(login).toHaveAttribute('aria-pressed', 'false')
  await expect(login).toHaveText('Off')
  await expect(close).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('desktop-shortcut')).toHaveValue('Ctrl+Alt+Space')

  await login.click()
  await expect(login).toHaveAttribute('aria-pressed', 'true')
  await expect(login).toHaveText('On')
  await close.click()
  await expect(close).toHaveAttribute('aria-pressed', 'false')
  await expect(close).toHaveText('Off')

  // press a combination in the box: the shell gets it as an accelerator
  const box = page.getByTestId('desktop-shortcut')
  await box.focus()
  await page.keyboard.press('Control+Alt+KeyJ')
  await expect(box).toHaveValue('Ctrl+Alt+J')
  // a key with no modifier is ignored
  await page.keyboard.press('KeyZ')
  await expect(box).toHaveValue('Ctrl+Alt+J')
  // one the system refuses is said so, in words, and stays visible
  await page.keyboard.press('Control+Alt+KeyK')
  await expect(page.getByTestId('desktop-shortcut-note')).toContainText('The system refused this shortcut')
  // reset
  await page.getByTestId('desktop-shortcut-reset').click()
  await expect(box).toHaveValue('Ctrl+Alt+Space')
  await expect(page.getByTestId('desktop-shortcut-note')).toContainText('Works from any program')

  expect(await sdCalls(page)).toEqual([
    ['startAtLogin', true],
    ['closeToTray', false],
    ['shortcut', 'Control+Alt+J'],
    ['shortcut', 'Control+Alt+K'],
    ['shortcut', 'Control+Alt+Space'],
  ])

  await page.getByTestId('desktop-quick-collect').click()
  expect(await page.evaluate(() => (window as unknown as { __sd: { collectOpened: number } }).__sd.collectOpened)).toBe(1)
  expect(errors).toEqual([])
})

test('Esc in the shortcut box leaves the box and closes nothing else', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubShell(page)
  await openAt(page, '#/settings/desktop')
  const box = page.getByTestId('desktop-shortcut')
  await box.focus()
  await page.keyboard.press('Escape')
  await expect(box).not.toBeFocused()
  await expect(page.getByTestId('desktop-program')).toBeVisible()
})

for (const shell of [false, true]) {
  test(`Desktop fits at every size in both languages (${shell ? 'inside the program, stubbed shell' : 'plain browser'})`, async ({ page }) => {
    if (shell) await stubShell(page)
    await openAt(page, '#/settings/desktop')
    // the interface scale is chosen at load, so each size is loaded afresh
    for (const lang of ['en', 'zh-CN'] as const) {
      await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
      for (const vp of VIEWPORTS) {
        await page.setViewportSize(vp)
        await page.reload()
        await expect(page.getByTestId(shell ? 'desktop-program' : 'desktop-browser-note')).toBeVisible()
        await expect(page.getByTestId('desktop-collect')).toBeVisible()
        expect(await pageOverflow(page), `${lang} ${vp.width}x${vp.height}`).toBeLessThanOrEqual(0)
      }
    }
  })
}

test('About: hard refresh clears the caches, loads the page again under a new address, and keeps the route and the settings', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/settings/about')
  await expect(page.getByTestId('hard-refresh')).toBeVisible()
  await page.evaluate(async () => {
    await caches.open('v4dsk-test-cache')
    localStorage.setItem('sd-v4-ui-scale', '1.15')
  })
  expect(await page.evaluate(async () => (await caches.keys()).includes('v4dsk-test-cache'))).toBe(true)

  await Promise.all([page.waitForURL(/_t=\d+/), page.getByTestId('hard-refresh-button').click()])
  expect(page.url()).toContain('#/settings/about')
  await expect(page.getByTestId('hard-refresh-button')).toBeVisible()
  expect(await page.evaluate(async () => (await caches.keys()).includes('v4dsk-test-cache'))).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-ui-scale'))).toBe('1.15')
  await page.evaluate(() => localStorage.removeItem('sd-v4-ui-scale'))
})

interface Bg {
  idle_unload_minutes: number
  models: { key: string; device: string; in_use: boolean; idle_seconds: number }[]
  last_release: { at: number; keys: string[] } | null
  gpu_busy_fallbacks: { at: number; label?: string }[]
}

test('Models: the Background line names the loaded models, saves the idle choice, and Unload now frees them and says what a job kept', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  let state: Bg = {
    idle_unload_minutes: 10,
    models: [
      { key: 'clip', device: 'gpu', in_use: false, idle_seconds: 185 },
      { key: 'tagger', device: 'cpu', in_use: true, idle_seconds: 0 },
    ],
    last_release: null,
    gpu_busy_fallbacks: [],
  }
  const patches: unknown[] = []
  await page.route('**/api/background-models/unload', (route: Route) => {
    state = { ...state, models: state.models.filter((m) => m.in_use), last_release: { at: 1_700_000_000, keys: ['clip'] } }
    return route.fulfill({ json: { ...state, released: ['clip'], busy: ['tagger'] } })
  })
  await page.route('**/api/background-models', (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { minutes: number }
      patches.push(body)
      state = { ...state, idle_unload_minutes: body.minutes }
    }
    return route.fulfill({ json: state })
  })
  await openAt(page, '#/settings/models')
  const status = page.getByTestId('background-status')
  await expect(status).toHaveText('Loaded now: CLIP search (GPU, idle 3 min), Tagger (CPU, in use)')
  const idle = page.getByTestId('background-idle')
  await expect(idle).toHaveValue('10')
  await idle.selectOption('0')
  await expect(page.getByTestId('background-models')).toContainText('Saved')
  expect(patches).toEqual([{ minutes: 0 }])

  await page.getByTestId('background-unload').click()
  await expect(page.getByText('Freed: CLIP search')).toBeVisible()
  await expect(page.getByText('Kept Tagger: a running job is using it.')).toBeVisible()
  await expect(status).toHaveText('Loaded now: Tagger (CPU, in use)')
  await expect(page.getByTestId('background-note')).toContainText('Freed at')

  // a stored value outside the four choices is shown, not replaced by a wrong one
  state = { ...state, idle_unload_minutes: 45 }
  await page.reload()
  await expect(page.getByTestId('background-idle')).toHaveValue('45')
  await expect(page.getByTestId('background-idle').locator('option:checked')).toHaveText('45 min')
  expect(errors).toEqual([])
})

test('Models: with no model loaded the line says so and Unload now is off; Chinese reads in full; it fits at every size', async ({ page }) => {
  const state: Bg = { idle_unload_minutes: 5, models: [], last_release: null, gpu_busy_fallbacks: [{ at: 1_700_000_000, label: 'tagger:wd-v3' }] }
  await page.route('**/api/background-models', (route: Route) => route.fulfill({ json: state }))
  await openAt(page, '#/settings/models', 'zh-CN')
  await expect(page.getByTestId('background-status')).toHaveText('当前没有加载任何 AI 模型。')
  await expect(page.getByTestId('background-note')).toContainText('显卡正忙')
  await expect(page.getByTestId('background-unload')).toBeDisabled()
  await expect(page.getByTestId('background-unload')).toHaveText('立即释放')
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await page.reload()
    await page.getByTestId('background-models').scrollIntoViewIfNeeded()
    expect(await pageOverflow(page), `${vp.width}x${vp.height}`).toBeLessThanOrEqual(0)
    const box = await page.getByTestId('background-models').boundingBox()
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(vp.width)
  }
})

function seedPixiv(): number[] {
  const out = runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(path.join(tmpRoot, DIR))})
shutil.rmtree(root, ignore_errors=True)
(root / "pics").mkdir(parents=True, exist_ok=True)
prefix = ${JSON.stringify(PREFIX)}
ids = []
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE 'v4dsk%'")
    delete_images(conn, "filename LIKE ?", (prefix + "%",))
    for n in (1, 2):
        path = (root / "pics" / f"{prefix}{n}.png").resolve()
        Image.new("RGB", (40, 30), (n * 40, 90, 160)).save(path)
        cur = conn.execute(
            """INSERT INTO images (path, filename, generator, prompt, metadata_json, width, height, file_size,
                   source_size, source_mtime_ns, is_readable, metadata_status, created_at, library_order_time, user_rating)
               VALUES (?, ?, 'nai', 'v4dsktoken', '{}', 40, 30, ?, ?, ?, 1, 'complete', datetime('now'), datetime('now'), 0)""",
            (str(path), path.name, path.stat().st_size, path.stat().st_size, path.stat().st_mtime_ns),
        )
        ids.append(cur.lastrowid)
    conn.commit()
print(" ".join(str(i) for i in ids))
`)
  return (out.split('\n').at(-1) ?? '').trim().split(' ').map(Number)
}

function cleanup(): void {
  runBackendScript(`
${PY_DELETE_IMAGES}
import shutil, sqlite3
from pathlib import Path
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM batches WHERE name LIKE 'v4dsk%'")
    delete_images(conn, "filename LIKE ?", (${JSON.stringify(PREFIX + '%')},))
    conn.commit()
shutil.rmtree(Path(${JSON.stringify(path.join(tmpRoot, DIR))}), ignore_errors=True)
print("ok")
`)
}

async function putRoot(page: Page, root: string): Promise<void> {
  // the guard accepts the program's own page only: call from the page
  const status = await page.evaluate(async (r) => (await fetch('/api/output-folders', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: r }) })).status, root)
  expect(status).toBe(200)
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await page.goto('/vopus/', { waitUntil: 'domcontentloaded' })
  await putRoot(page, '')
  await page.close()
  cleanup()
})

test('Disk: the output root is typed, chosen with the folder chooser, refused with the reason, listed per feature, and reset to the program folder', async ({ page }) => {
  const errors = watchErrors(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  seedPixiv()
  fs.mkdirSync(path.join(ROOT, 'publish'), { recursive: true })
  await openAt(page, '#/settings/disk')
  const input = page.getByTestId('output-root-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(page.getByTestId('output-root-reset')).toBeDisabled()

  // a relative path is refused in words, and nothing changes
  await input.fill('not-absolute')
  await input.press('Enter')
  await expect(page.getByText(/Could not change the save folder: .*full folder path/)).toBeVisible()
  await expect(input).toHaveValue('')

  // typing a full path saves it
  await input.fill(ROOT)
  await input.press('Enter')
  await expect(page.getByTestId('output-root')).toContainText('Saved')
  await expect(input).toHaveValue(ROOT)
  await expect(page.getByTestId('output-root-reset')).toBeEnabled()
  await page.getByTestId('output-root').locator('summary').click()
  await expect(page.getByTestId('output-root-folders')).toContainText(path.join(ROOT, 'publish'))
  await expect(page.getByTestId('output-root-folders')).toContainText(path.join(ROOT, 'collected'))

  // the folder chooser picks another one
  const other = path.join(tmpRoot, DIR, 'other')
  fs.mkdirSync(other, { recursive: true })
  await page.getByTestId('output-root-browse').click()
  const chooser = page.getByTestId('output-root-picker')
  const pathInput = chooser.getByTestId('folder-path')
  await expect(pathInput).toHaveValue(ROOT)
  await pathInput.fill(other)
  await pathInput.press('Enter')
  await chooser.getByRole('button', { name: 'Use this folder' }).click()
  await expect(chooser).toHaveCount(0)
  await expect(input).toHaveValue(other)

  // back to the program folder
  await page.getByTestId('output-root-reset').click()
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('placeholder', /^Empty = /)
  expect(errors.filter((e) => !e.includes('400'))).toEqual([])
})

test('Pixiv export starts from <root>/publish when no folder was picked, and the user can still pick another', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/home')
  await putRoot(page, ROOT)
  const ids = seedPixiv()
  fs.mkdirSync(path.join(ROOT, 'publish'), { recursive: true })
  const created = await page.request.post('/api/batches', { data: { kind: 'pixiv', name: 'v4dsk Set', image_ids: ids } })
  expect(created.status()).toBe(201)
  const batchId = ((await created.json()).batch as { id: number }).id

  await page.goto(`/vopus/#/batch/${batchId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('batch-view')).toBeVisible()
  for (let i = 0; i < 4 && !(await page.getByTestId('export-step').isVisible()); i++) {
    await page.getByTestId('step-next').click()
    await page.waitForTimeout(250)
  }
  await expect(page.getByTestId('export-step')).toBeVisible()
  const publish = path.join(ROOT, 'publish')
  await expect(page.getByTestId('export-folder')).toHaveText(publish)
  await expect(page.getByTestId('export-folder-default')).toContainText(publish)

  // the chooser opens in that folder, and another can be picked
  await page.getByTestId('export-choose-folder').click()
  const chooser = page.getByTestId('export-folder-picker')
  await expect(chooser.getByTestId('folder-path')).toHaveValue(publish)
  // while <root>/publish does not exist yet, it opens at the nearest folder above it that does
  await page.keyboard.press('Escape')
  await expect(chooser).toHaveCount(0)
  fs.rmSync(publish, { recursive: true })
  await page.getByTestId('export-choose-folder').click()
  await expect(chooser.getByTestId('folder-path')).toHaveValue(ROOT)
  const mine = path.join(tmpRoot, DIR, 'mine')
  fs.mkdirSync(mine, { recursive: true })
  await chooser.getByTestId('folder-path').fill(mine)
  await chooser.getByTestId('folder-path').press('Enter')
  await chooser.getByRole('button', { name: 'Use this folder' }).click()
  await expect(page.getByTestId('export-folder')).toHaveText(mine)
  await expect(page.getByTestId('export-folder-default')).toHaveCount(0)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('Disk and About fit at every size in both languages', async ({ page }) => {
  await openAt(page, '#/settings/disk')
  for (const lang of ['en', 'zh-CN'] as const) {
    await page.evaluate((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
    for (const tab of ['disk', 'about'] as const) {
      await page.evaluate((h) => {
        window.location.hash = h
      }, `#/settings/${tab}`)
      for (const vp of VIEWPORTS) {
        await page.setViewportSize(vp)
        await page.reload()
        await expect(page.getByTestId(tab === 'disk' ? 'output-root' : 'hard-refresh')).toBeVisible()
        expect(await pageOverflow(page), `${tab} ${lang} ${vp.width}x${vp.height}`).toBeLessThanOrEqual(0)
      }
    }
  }
})
