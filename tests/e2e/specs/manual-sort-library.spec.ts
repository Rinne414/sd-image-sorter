import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Manual Sort progress and the library it belongs to (V3.5 issue #17).
 *
 * There is one saved sort session for every library. Opening Manual Sort in
 * another library must say whose images the unfinished sort holds, and a
 * resume must ask first (it moves or copies that library's files). A session
 * of the open library resumes as before, without an extra question.
 */

test.describe.configure({ mode: 'serial' })

const SHOT_DIR = '../../.tmp/v35-fix'
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

function savedSession(libraryId: string | null, mixed = false) {
  return {
    done: false,
    mode: 'slot',
    index: 2,
    total: 9,
    remaining: 7,
    operation_mode: 'copy',
    folders: { w: 'C:/sort-library-spec/w' },
    image: { id: 910001, filename: 'sort-library-spec.png', path: 'C:/sort-library-spec/a.png' },
    tags: [],
    library_id: libraryId,
    library_mixed: mixed,
  }
}

async function openManualWithSession(page: Page, session: ReturnType<typeof savedSession>) {
  await page.route('**/api/sort/current', (route) => route.fulfill({ json: session }))
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  await page.goto('/')
  await page.waitForFunction(() => {
    const w = window as any
    return document.documentElement.dataset.appReady === '1'
      && typeof w._switchSortingSub === 'function'
      && typeof w.App?.switchView === 'function'
  })
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#sort-setup')).toBeVisible()
  await expect(page.locator('#sort-resume-banner')).toBeVisible()
}

test('a saved sort of another library says so and asks before resuming', async ({ page }) => {
  const created = await page.request.post('/api/libraries', { data: { name: 'Sort elsewhere' } })
  expect(created.ok()).toBe(true)
  const otherId: string = (await created.json()).library.id
  try {
    await page.setViewportSize(VIEWPORTS[0])
    await openManualWithSession(page, savedSession(otherId))

    const line = page.locator('#sort-resume-banner .resume-library')
    await expect(line).toBeVisible()
    await expect(line).toHaveText('这份进度属于图库「Sort elsewhere」，不是当前打开的图库。')

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expect(line).toBeInViewport()
      await expect(page.locator('#btn-resume-sorting')).toBeInViewport()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBe(0)
      await page.screenshot({ path: `${SHOT_DIR}/sort-library-banner-${viewport.width}.png` })
    }

    await page.click('#btn-resume-sorting')
    const dialog = page.locator('#confirm-modal.visible')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('#confirm-title')).toHaveText('继续另一个图库的整理？')
    await expect(dialog.locator('#confirm-message')).toContainText('属于图库「Sort elsewhere」')
    await expect(dialog.locator('#confirm-message')).toContainText('当前打开的是「')
    await page.screenshot({ path: `${SHOT_DIR}/sort-library-confirm-${VIEWPORTS[2].width}.png` })

    await page.click('#btn-confirm-cancel')
    await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
    await expect(page.locator('#sort-setup')).toBeVisible()
    await expect(page.locator('#sort-interface')).toBeHidden()
    await expect(line).toBeVisible()

    await page.click('#btn-resume-sorting')
    await expect(page.locator('#confirm-modal.visible')).toBeVisible()
    await page.click('#btn-confirm-ok')
    await expect(page.locator('#sort-interface')).toBeVisible()
  } finally {
    await page.request.delete(`/api/libraries/${encodeURIComponent(otherId)}`)
  }
})

test('a saved sort whose images span libraries says so', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS[1])
  await openManualWithSession(page, savedSession(null, true))

  await expect(page.locator('#sort-resume-banner .resume-library')).toHaveText('这份进度里的图片来自多个图库。')
  await page.click('#btn-resume-sorting')
  await expect(page.locator('#confirm-modal.visible #confirm-message')).toContainText('来自多个图库')
  await page.click('#btn-confirm-cancel')
  await expect(page.locator('#sort-setup')).toBeVisible()
})

test('a saved sort of the open library resumes without an extra question', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS[1])
  await openManualWithSession(page, savedSession('main'))

  await expect(page.locator('#sort-resume-banner .resume-library')).toBeHidden()
  await page.click('#btn-resume-sorting')
  await expect(page.locator('#sort-interface')).toBeVisible()
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
})
