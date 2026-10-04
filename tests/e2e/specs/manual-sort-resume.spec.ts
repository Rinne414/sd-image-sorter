import { expect, test, type Page } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * Manual Sort resume journey (walkthrough of 批量整理):
 * - folders edited on the setup page are used on resume (set-folders), while
 *   untouched slots keep the saved session's folders;
 * - the entry page's 继续 resumes the saved session directly;
 * - the resume panel sits above the start button and shows compact folders;
 * - the file-action help line follows the move/copy toggle;
 * - the WASD screen names each key's destination folder, also after a resume.
 */

const FOLDERS = { w: 'C:/sort-resume-spec/old-w', a: 'C:/sort-resume-spec/keep-a' }

function savedSession() {
  return {
    done: false,
    mode: 'slot',
    index: 2,
    total: 9,
    remaining: 7,
    operation_mode: 'copy',
    folders: { ...FOLDERS },
    image: { id: 910001, filename: 'sort-resume-spec.png', path: 'C:/sort-resume-spec/a.png' },
    tags: [],
    library_id: 'main',
    library_mixed: false,
  }
}

async function mockSession(page: Page) {
  const setFoldersBodies: any[] = []
  await page.route('**/api/sort/current', (route) => route.fulfill({ json: savedSession() }))
  await page.route('**/api/sort/set-folders', (route) => {
    setFoldersBodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { status: 'ok', folders: route.request().postDataJSON().folders } })
  })
  return setFoldersBodies
}

async function bootManual(page: Page, { entry = false, remembered = true } = {}) {
  await page.addInitScript(({ entry: showEntry, remembered: prefill }) => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
    if (prefill) localStorage.setItem('sort-folder-w', 'C:/sort-resume-spec/remembered-w')
    if (showEntry && !sessionStorage.getItem('resume-spec-booted')) {
      sessionStorage.setItem('resume-spec-booted', '1')
      localStorage.removeItem('aurora-entry-skip')
    }
  }, { entry, remembered })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

async function openManual(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#sort-setup')).toBeVisible()
  await expect(page.locator('#sort-resume-banner')).toBeVisible()
}

test('edited slot folders are used on resume, untouched slots keep the saved ones', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const bodies = await mockSession(page)
  await bootManual(page)
  await openManual(page)

  await page.locator('.folder-path-input[data-key="w"]').fill('C:/sort-resume-spec/new-w')
  await page.locator('.folder-path-input[data-key="w"]').blur()
  await page.click('#btn-resume-sorting')

  await expect(page.locator('#sort-interface')).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect(bodies[0].folders).toEqual({ w: 'C:/sort-resume-spec/new-w', a: FOLDERS.a })
  await expect(page.locator('#folder-name-w')).toHaveText('new-w')
  await expect(page.locator('#folder-name-a')).toHaveText('keep-a')
  await expect(page.locator('#toast-container')).toContainText('W')
})

test('remembered (prefilled) values are not treated as edits on resume', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const bodies = await mockSession(page)
  await bootManual(page)
  await openManual(page)

  await expect(page.locator('.folder-path-input[data-key="w"]')).toHaveValue('C:/sort-resume-spec/remembered-w')
  await page.click('#btn-resume-sorting')

  await expect(page.locator('#sort-interface')).toBeVisible()
  expect(bodies).toHaveLength(0)
  await expect(page.locator('#folder-name-w')).toHaveText('old-w')
})

test('the resume panel says edited folders will be used and sits above the start button', async ({ page }) => {
  const viewports = [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]
  await mockSession(page)
  await bootManual(page)
  await openManual(page)
  await expect(page.locator('#sort-resume-banner .resume-note')).toContainText('改过')
  for (const viewport of viewports) {
    await resizeAndSettleUiScale(page, viewport)
    const geo = await page.evaluate(() => {
      const banner = document.getElementById('sort-resume-banner')!.getBoundingClientRect()
      const resume = document.getElementById('btn-resume-sorting')!.getBoundingClientRect()
      const start = document.getElementById('btn-start-sorting')!.getBoundingClientRect()
      return {
        resumeInView: resume.top >= 0 && resume.bottom <= window.innerHeight,
        above: banner.bottom <= start.top + 1,
      }
    })
    expect(geo).toEqual({ resumeInView: true, above: true })
  }
  // Compact folders: name prominent, full path in a tooltip.
  const chip = page.locator('#sort-resume-banner .resume-folders [title="C:/sort-resume-spec/old-w"]')
  await expect(chip).toContainText('old-w')
  await expect(chip).not.toContainText('sort-resume-spec/old-w')
})

test('entry page continue resumes the saved session directly', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const bodies = await mockSession(page)
  await bootManual(page, { entry: true })
  await expect(page.locator('#entry-anchor')).toBeVisible()
  await page.click('#entry-anchor-continue')
  await expect(page.locator('#sort-interface')).toBeVisible()
  await expect(page.locator('#folder-name-w')).toHaveText('old-w')
  expect(bodies).toHaveLength(0)
})

test('the file action help line follows the move/copy toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await bootManual(page, { remembered: false })
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#sort-setup')).toBeVisible()
  const help = page.locator('#manual-sort-operation-help')
  await page.locator('input[name="manual-sort-operation"][value="move"]').check({ force: true })
  await expect(help).toContainText('移动')
  await expect(help).not.toContainText('保留原图不动')
  await page.waitForTimeout(400) // the i18n re-apply must not restore the copy text
  await expect(help).not.toContainText('保留原图不动')
  await page.locator('input[name="manual-sort-operation"][value="copy"]').check({ force: true })
  await expect(help).toContainText('保留原图不动')
})

test('the WASD screen names each key destination', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockSession(page)
  await bootManual(page, { remembered: false })
  await openManual(page)
  await page.click('#btn-resume-sorting')
  await expect(page.locator('#sort-interface')).toBeVisible()
  for (const [key, name] of [['w', 'old-w'], ['a', 'keep-a']]) {
    const label = page.locator(`#folder-name-${key}`)
    await expect(label).toBeVisible()
    await expect(label).toHaveText(name)
    await expect(label).toHaveAttribute('title', FOLDERS[key as 'w' | 'a'])
  }
})
