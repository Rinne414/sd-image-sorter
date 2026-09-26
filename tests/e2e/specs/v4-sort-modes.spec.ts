import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Sort tab, the other ways to sort and their comforts: the A/B showdown
 * and keep / reject (undo, a reload, the finished result used from the
 * summary), presets per library, the key cooldown, the sound, focus mode, and
 * a sort that belongs to another library. Runs on the isolated test server;
 * A/B and keep / reject never touch files, which is checked too.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4sortmodetoken'
const PREFIX = 'v4sortmode-'
const COUNT = 8
const DIR = 'v4-sort-modes'
const OTHER_LIBRARY = 'V4 e2e sort other'

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
})

test.beforeEach(async ({ page }) => {
  // One saved session per server: start every test without one.
  await page.request.delete('/api/sort/session')
})

async function pick(page: Page, count: number): Promise<{ ids: string[]; names: string[] }> {
  const tiles = page.getByTestId('tile')
  const ids: string[] = []
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    await tiles.nth(i).click({ modifiers: ['Control'] })
    ids.push((await tiles.nth(i).getAttribute('data-id'))!)
    names.push((await tiles.nth(i).getAttribute('title'))!)
  }
  return { ids, names }
}

async function sortPicks(page: Page, mode: 'bracket' | 'cull') {
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Sort into folders…' }).click()
  await page.getByTestId(mode === 'bracket' ? 'sort-mode-bracket' : 'sort-mode-cull').click()
  await expect(page.getByTestId('sort-how')).toBeVisible()
}

async function press(page: Page, key: string, expectPos: string) {
  await page.keyboard.press(key)
  await expect(page.getByTestId('sort-pos')).toHaveText(expectPos)
}

async function favoriteIds(page: Page): Promise<number[]> {
  return (await (await page.request.get('/api/collections/favorites/ids')).json()).image_ids
}

const sides = async (page: Page) => [await page.getByTestId('sort-side-a').getAttribute('data-id'), await page.getByTestId('sort-side-b').getAttribute('data-id')]

test('A/B showdown: pick, undo, a reload keeps the round, the winner is favourited and picked', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const { ids, names } = await pick(page, 4)
  await sortPicks(page, 'bracket')
  await expect(page.getByTestId('sort-start')).toHaveText('Start the showdown (4 images)')
  await page.getByTestId('sort-start').click()

  await expect(page.getByTestId('sort-pos')).toHaveText('Round 1 of 3')
  expect(await sides(page)).toEqual([ids[0], ids[1]])
  await expect(page.getByTestId('sort-diff')).toContainText('Differences')
  await press(page, 'ArrowRight', 'Round 2 of 3')
  expect(await sides(page)).toEqual([ids[1], ids[2]])

  await press(page, 'Backspace', 'Round 1 of 3')
  expect(await sides(page)).toEqual([ids[0], ids[1]])
  await page.reload()
  await expect(page.getByTestId('sort-pos')).toHaveText('Round 1 of 3')
  expect(await sides(page)).toEqual([ids[0], ids[1]])

  await press(page, 'a', 'Round 2 of 3')
  await expect(page.getByTestId('sort-side-a')).toContainText('held 1 round')
  await press(page, 'd', 'Round 3 of 3')
  expect(await sides(page)).toEqual([ids[2], ids[3]])
  await page.keyboard.press('ArrowLeft')

  const winner = page.getByTestId('sort-winner')
  await expect(winner).toHaveAttribute('data-id', ids[2]!)
  await expect(page.getByTestId('sort-summary-body')).toHaveText('4 images, 3 rounds, 0 skipped.')
  for (const name of names) expect(fs.existsSync(path.join(tmpRoot, DIR, name))).toBe(true)

  await winner.getByTestId('sort-winner-favorite').click()
  await expect(winner.getByTestId('sort-winner-favorite')).toHaveText('Favourited')
  await expect.poll(() => favoriteIds(page)).toContain(Number(ids[2]))
  await winner.getByTestId('sort-winner-favorite').click()
  await expect.poll(() => favoriteIds(page)).not.toContain(Number(ids[2]))

  await winner.getByTestId('sort-winner-pick').click()
  await expect(page.getByTestId('selection-bar')).toContainText('1 picked')
})

test('keep / reject: keys, undo, the tally, then favourite the kept and pick the rejected', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  const { ids, names } = await pick(page, 5)
  await sortPicks(page, 'cull')
  await page.getByTestId('sort-start').click()

  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 5')
  await press(page, 'k', 'Image 2 of 5')
  await press(page, 'x', 'Image 3 of 5')
  await press(page, 'Space', 'Image 4 of 5')
  await press(page, 'ArrowRight', 'Image 5 of 5')
  await expect(page.getByTestId('sort-kept')).toHaveText('2')
  await press(page, 'Backspace', 'Image 4 of 5')
  await expect(page.getByTestId('sort-kept')).toHaveText('1')
  await press(page, 'ArrowLeft', 'Image 5 of 5')
  await expect(page.getByTestId('sort-rejected')).toHaveText('2')
  await page.keyboard.press('d')

  await expect(page.getByTestId('sort-summary-body')).toHaveText('5 images: 2 kept, 2 rejected, 1 skipped.')
  const kept = page.getByTestId('sort-kept-group')
  await expect(kept).toHaveAttribute('data-count', '2')
  for (const name of names) expect(fs.existsSync(path.join(tmpRoot, DIR, name))).toBe(true)

  await kept.getByTestId('sort-kept-group-favorite').click()
  await expect.poll(async () => (await favoriteIds(page)).filter((id) => [ids[0], ids[4]].map(Number).includes(id)).length).toBe(2)
  await kept.getByTestId('sort-kept-group-favorite').click()
  await expect.poll(async () => (await favoriteIds(page)).filter((id) => [ids[0], ids[4]].map(Number).includes(id)).length).toBe(0)

  await page.getByTestId('sort-rejected-group-pick').click()
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')
})

test('presets: save the setup, load it back, replace by name, delete after asking', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openLibrary(page, TOKEN, COUNT)
  await page.goto('/v4/#/home')
  await page.getByTestId('home-start-sort').click()
  const bar = page.getByTestId('sort-presets')
  await page.getByTestId('sort-mode-cull').click()

  await page.getByTestId('sort-preset-save').click()
  await page.getByTestId('sort-preset-name').fill('Daily cull')
  await page.getByTestId('sort-preset-confirm').click()
  await expect(bar.locator('[data-preset="Daily cull"]')).toContainText('Keep / reject')

  await page.getByTestId('sort-mode-slots').click()
  await expect(page.getByTestId('sort-slots')).toBeVisible()
  await bar.locator('[data-preset="Daily cull"]').getByRole('button', { name: /^Daily cull/ }).click()
  await expect(page.getByTestId('sort-mode-cull')).toHaveAttribute('aria-checked', 'true')

  await page.reload()
  await expect(bar.locator('[data-preset="Daily cull"]')).toBeVisible()
  await page.getByTestId('sort-preset-save').click()
  await page.getByTestId('sort-preset-name').fill('Daily cull')
  await expect(page.getByTestId('sort-preset-dialog')).toContainText('saving replaces it')
  await page.getByTestId('sort-preset-confirm').click()
  await expect(bar.locator('[data-preset]')).toHaveCount(1)

  await bar.getByRole('button', { name: 'Delete preset “Daily cull”' }).click()
  const confirm = page.getByTestId('sort-confirm')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(bar.locator('[data-preset]')).toHaveCount(0)
})

test('cooldown ignores a key that comes too soon, the sound plays when on, focus mode hides the top bar until Esc', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    const w = window as unknown as { __pips: number; AudioContext: unknown }
    w.__pips = 0
    class FakeAudio {
      state = 'running'
      currentTime = 0
      destination = {}
      resume() {
        return Promise.resolve()
      }
      createOscillator() {
        w.__pips += 1
        return { type: '', frequency: { value: 0 }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }
      }
      createGain() {
        return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }
      }
    }
    w.AudioContext = FakeAudio
  })
  await openLibrary(page, TOKEN, COUNT)
  await pick(page, 4)
  await sortPicks(page, 'cull')
  await page.getByTestId('sort-cooldown').check()
  await page.getByTestId('sort-cooldown-ms').fill('2000')
  await expect(page.getByTestId('sort-options')).toContainText('at least 2,000 ms apart')
  await page.getByTestId('sort-sound-option').check()
  await page.getByTestId('sort-start').click()
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 4')

  await page.keyboard.press('k')
  await page.keyboard.press('k')
  await expect(page.getByTestId('sort-status')).toContainText('Too fast')
  await expect(page.getByTestId('sort-pos')).toHaveText('Image 2 of 4')
  await expect(page.getByTestId('sort-kept')).toHaveText('1')
  expect(await page.evaluate(() => (window as unknown as { __pips: number }).__pips)).toBe(1)

  await page.getByTestId('sort-focus').click()
  const frame = page.getByTestId('sort-focus-frame')
  await expect(frame).toBeVisible()
  const covered = await page.evaluate(() => {
    const el = document.elementFromPoint(40, 20)
    return !!el?.closest('[data-testid="sort-focus-frame"]')
  })
  expect(covered).toBe(true)
  await page.waitForTimeout(2100)
  await press(page, 'x', 'Image 3 of 4')
  await page.keyboard.press('Escape')
  await expect(frame).toHaveCount(0)
  await expect(page.getByTestId('sort-session')).toBeVisible()

  await page.getByTestId('sort-sound').click()
  await page.waitForTimeout(2100)
  await press(page, 'k', 'Image 4 of 4')
  expect(await page.evaluate(() => (window as unknown as { __pips: number }).__pips)).toBe(2)
})

test('a sort of another library waits for a yes before any key acts, and Home and Ctrl K name the library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const created = await (await page.request.post('/api/libraries', { data: { name: OTHER_LIBRARY } })).json()
  const otherId: string = created.library.id
  const actions: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/sort/action')) actions.push(r.url())
  })
  try {
    await openLibrary(page, TOKEN, COUNT)
    await pick(page, 2)
    await sortPicks(page, 'cull')
    await page.getByTestId('sort-start').click()
    await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 2')
    await expect(page.getByTestId('sort-other-library')).toHaveCount(0)

    await page.evaluate((id) => localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: id })), otherId)
    await page.reload()
    const banner = page.getByTestId('sort-other-library')
    const ok = page.getByTestId('sort-other-library-ok')
    await expect(banner).toContainText('belong to the library “Main library”')
    await expect(banner).toContainText('Until you confirm')
    await expect(ok).toBeInViewport({ ratio: 1 })

    // Before the yes, a key, a click and undo send nothing and move nothing.
    await page.keyboard.press('k')
    await expect(page.getByTestId('sort-status')).toContainText('belong to another library')
    await page.getByTestId('sort-keep').click()
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(400)
    expect(actions).toEqual([])
    await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 2')
    await expect(page.getByTestId('sort-kept')).toHaveText('0')

    await ok.click()
    await expect(ok).toHaveCount(0)
    await expect(banner).toContainText('Confirmed')
    await press(page, 'k', 'Image 2 of 2')
    expect(actions).toHaveLength(1)

    // Only for this page's sort: after a reload it asks again.
    await page.reload()
    await expect(ok).toBeVisible()

    await page.keyboard.press('Control+k')
    await page.getByTestId('palette').locator('input').fill('continue the last sort')
    await expect(page.getByTestId('palette').getByRole('option').first()).toHaveText(/Continue the last sort \(library “Main library”\)/)
    await page.keyboard.press('Escape')
    await page.goto('/v4/#/home')
    await expect(page.getByTestId('home-sort')).toContainText('belong to the library “Main library”')
    expect(actions).toHaveLength(1)
  } finally {
    await page.evaluate(() => localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' })))
    await page.request.delete(`/api/libraries/${otherId}`)
  }
})

test("the summary of another library's sort: favourite and pick wait for the same yes the keys do", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const created = await (await page.request.post('/api/libraries', { data: { name: `${OTHER_LIBRARY} summary` } })).json()
  const otherId: string = created.library.id
  const favoriteWrites: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/collections/favorites')) favoriteWrites.push(r.url())
  })
  try {
    await page.request.delete('/api/sort/session')
    await openLibrary(page, TOKEN, COUNT)
    await pick(page, 2)
    await sortPicks(page, 'cull')
    await page.getByTestId('sort-start').click()
    await expect(page.getByTestId('sort-pos')).toHaveText('Image 1 of 2')
    await press(page, 'k', 'Image 2 of 2')
    await page.keyboard.press('k')
    await expect(page.getByTestId('sort-summary-body')).toHaveText('2 images: 2 kept, 0 rejected, 0 skipped.')

    await page.evaluate((id) => localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: id })), otherId)
    await page.reload()
    const ok = page.getByTestId('sort-other-library-ok')
    await expect(ok).toBeVisible()
    const kept = page.getByTestId('sort-kept-group')
    await kept.getByTestId('sort-kept-group-favorite').click()
    await expect(page.getByTestId('sort-summary-error')).toContainText('belong to another library')
    await kept.getByTestId('sort-kept-group-pick').click()
    await page.waitForTimeout(300)
    expect(favoriteWrites).toEqual([])
    await expect(page.getByTestId('sort-summary')).toBeVisible()

    await ok.click()
    await kept.getByTestId('sort-kept-group-pick').click()
    await expect(page.getByTestId('selection-bar')).toContainText('2 picked')
  } finally {
    await page.evaluate(() => localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' })))
    await page.request.delete('/api/sort/session')
    await page.request.delete(`/api/libraries/${otherId}`)
  }
})

for (const viewport of VIEWPORTS) {
  test(`A/B and keep / reject fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await page.request.delete('/api/sort/session')
      await openLibrary(page, TOKEN, COUNT, theme)
      await pick(page, 3)
      await sortPicks(page, 'bracket')
      await expect(page.getByTestId('sort-start')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await page.getByTestId('sort-start').click()
      await expect(page.getByTestId('sort-pos')).toHaveText('Round 1 of 2')
      for (const id of ['sort-pick-a', 'sort-pick-b', 'sort-skip', 'sort-zoom', 'sort-undo', 'sort-focus', 'sort-end']) {
        await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
      }
      const side = await page.getByTestId('sort-side-a').boundingBox()
      expect(side!.height).toBeGreaterThan(viewport.height * 0.35)
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      await press(page, 'ArrowLeft', 'Round 2 of 2')
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByTestId('sort-winner')).toBeInViewport()
      await expect(page.getByTestId('sort-back')).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}
