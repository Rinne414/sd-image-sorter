import { expect, test, type Page } from '../fixtures/click-ledger'

// After an update the classic page says once what changed (the running
// version's summary from its release notes), with a link to the full notes.
// A fresh install says nothing; a reload does not show it again.
const SUMMARY_ZH = '读图能直接粘贴 QQ 里的图片。'
const SUMMARY_EN = 'Reader takes pictures from QQ.'

async function serveWhatsNew(page: Page, updated: boolean) {
  await page.route('**/api/updates/whats-new', (route) =>
    route.fulfill({
      json: {
        available: true,
        version: '9.9.9',
        title: 'Test',
        summary_zh: SUMMARY_ZH,
        summary_en: SUMMARY_EN,
        notes_url: 'https://github.com/Rinne414/sd-image-sorter/releases/tag/v9.9.9',
        updated,
        previous_version: updated ? '9.9.8' : null,
      },
    }),
  )
}

const toast = (page: Page) => page.locator('#toast-container .toast', { hasText: /9\.9\.9/ })

// Automated browsers skip the notice unless a test opts in (whats-new.js).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-whats-new-in-automation', '1'))
})

test('a fresh install says nothing and remembers the version', async ({ page }) => {
  await serveWhatsNew(page, false)
  await page.addInitScript(() => localStorage.removeItem('sd-whats-new-seen-version'))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sd-whats-new-seen-version')), { timeout: 10000 }).toBe('9.9.9')
  await expect(toast(page)).toHaveCount(0)
})

test('after an update the summary shows once, with the full notes link', async ({ page }) => {
  await serveWhatsNew(page, false)
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('whats-new-test-seeded')) {
      localStorage.setItem('sd-whats-new-seen-version', '9.9.8')
      sessionStorage.setItem('whats-new-test-seeded', '1')
    }
  })
  await page.goto('/')
  const shown = toast(page)
  await expect(shown).toBeVisible({ timeout: 10000 })
  await expect(shown).toContainText(new RegExp(`${SUMMARY_EN.replace('.', '\\.')}|${SUMMARY_ZH}`))
  await expect(shown.locator('.toast-action-btn')).toHaveText(/Full notes|完整说明/)

  // Shown once: a reload in the same window says nothing.
  await page.reload()
  await page.waitForTimeout(3500)
  await expect(toast(page)).toHaveCount(0)
})

test('an install updated before the notice existed still hears about it', async ({ page }) => {
  await serveWhatsNew(page, true)
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('whats-new-test-seeded')) {
      localStorage.removeItem('sd-whats-new-seen-version')
      sessionStorage.setItem('whats-new-test-seeded', '1')
    }
  })
  await page.goto('/')
  await expect(toast(page)).toBeVisible({ timeout: 10000 })
})

test('V Opus shows the same notice once, sharing what classic already showed', async ({ page }) => {
  await serveWhatsNew(page, false)
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('whats-new-test-seeded')) {
      localStorage.setItem('sd-whats-new-seen-version', '9.9.8')
      sessionStorage.setItem('whats-new-test-seeded', '1')
    }
  })
  await page.goto('/vopus/')
  const shown = page.getByText(/9\.9\.9/).first()
  await expect(shown).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: /Full notes|完整说明/ })).toBeVisible()
  // The remembered version is shared with classic: classic now says nothing.
  await page.goto('/')
  await page.waitForTimeout(3500)
  await expect(toast(page)).toHaveCount(0)
})
