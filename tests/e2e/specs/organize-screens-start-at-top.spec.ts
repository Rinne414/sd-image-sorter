import { expect, test, type Page } from '@playwright/test'

/**
 * Organize swaps whole screens inside one page: Auto-Separate and Manual Sort,
 * then the Manual Sort setup and its sorting screen. The swaps kept the scroll
 * offset of the screen that was left, so pressing Start after scrolling down the
 * setup opened the A/B Showdown clamped at its bottom, and Exit put the reader
 * back deep in the setup with the Resume banner out of sight above.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

function bracketImage(id: number) {
  return { id, filename: `showdown-${id}.png`, path: `/mock/showdown-${id}.png`, width: 64, height: 64 }
}

/** A Manual Sort backend with no saved session that starts a 5-image A/B Showdown. */
async function mockShowdownBackend(page: Page) {
  let started = false
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/sort/current**', async (route) => {
    if (!started) {
      await route.fulfill({ json: { done: true, mode: null } })
      return
    }
    await route.fulfill({ json: {
      mode: 'bracket',
      done: false,
      total: 5,
      champion_index: 0,
      challenger_index: 1,
      champion: { image: bracketImage(701) },
      challenger: { image: bracketImage(702) },
      undo_available: false,
      redo_available: false,
    } })
  })
  await page.route('**/api/sort/start**', async (route) => {
    started = true
    await route.fulfill({ json: { total_images: 5, mode: 'bracket' } })
  })
}

async function openOrganize(page: Page, sub: 'autosep' | 'manual') {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('manual_sort_mode_v1', 'bracket')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid')).toBeAttached()
  await page.evaluate((target) => {
    ;(window as any).switchView('sorting')
    ;(window as any)._switchSortingSub(target)
  }, sub)
  await expect(page.locator(sub === 'manual' ? '#sort-setup' : '#view-autosep')).toBeVisible()
}

/**
 * Scroll as far down the current screen as it goes and wait until that holds
 * across two frames (the view switch's own reset to the top runs out to 700 ms).
 * Returns the offset reached, which must be over `atLeast` for the test to mean anything.
 */
async function scrollToBottom(page: Page, atLeast = 150) {
  let reached = -1
  await expect.poll(async () => {
    reached = await page.evaluate(() => new Promise<number>((resolve) => {
      const bottom = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo({ top: bottom, behavior: 'instant' })
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(Math.round(window.scrollY) === bottom ? bottom : -1)
      }))
    }))
    return reached
  }).toBeGreaterThan(atLeast)
  return reached
}

/** Two frames after `selector` shows: where the page is and where that screen's top sits. */
async function landedOn(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible()
  return page.evaluate((sel) => new Promise<{ y: number, screenTop: number }>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      y: Math.round(window.scrollY),
      screenTop: Math.round(document.querySelector(sel)!.getBoundingClientRect().top),
    })))
  }), selector)
}

test('Start pressed down the Manual Sort setup opens the A/B Showdown at its top', async ({ page }) => {
  await mockShowdownBackend(page)
  await openOrganize(page, 'manual')
  await scrollToBottom(page)

  // A plain click, as on the button: a Playwright click would scroll it into view first.
  await page.evaluate(() => (document.getElementById('btn-start-sorting') as HTMLButtonElement).click())

  const landed = await landedOn(page, '#sort-bracket-interface')
  await expect(page.locator('#bracket-progress-text')).toHaveText('0 / 4')
  expect(landed.y).toBe(0)
  expect(landed.screenTop).toBeGreaterThanOrEqual(0)
  expect(landed.screenTop).toBeLessThan(768)
})

test('Exit from the A/B Showdown returns to the setup at its top, with Resume in sight', async ({ page }) => {
  await mockShowdownBackend(page)
  await openOrganize(page, 'manual')
  await page.evaluate(() => (document.getElementById('btn-start-sorting') as HTMLButtonElement).click())
  await expect(page.locator('#bracket-progress-text')).toHaveText('0 / 4')
  // The showdown screen is a little taller than a 768 px window.
  await scrollToBottom(page, 100)

  await page.evaluate(() => (document.getElementById('bracket-btn-exit') as HTMLButtonElement).click())

  const landed = await landedOn(page, '#sort-setup')
  expect(landed.y).toBe(0)
  await expect(page.locator('#sort-resume-banner')).toBeVisible()
  await expect(page.locator('#sort-resume-banner')).toBeInViewport()
})

test('Auto-Separate chosen while scrolled down the Manual Sort setup opens at its top', async ({ page }) => {
  await openOrganize(page, 'manual')
  await scrollToBottom(page)

  await page.evaluate(() => (window as any)._switchSortingSub('autosep'))

  const landed = await landedOn(page, '#view-autosep')
  expect(landed.y).toBe(0)
})
