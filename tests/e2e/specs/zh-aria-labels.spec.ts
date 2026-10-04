import { expect, test } from '@playwright/test'

/**
 * Screen readers announce aria-label, so in the Simplified Chinese UI no
 * aria-label may be left in English. Every static aria-label in index.html
 * needs a data-i18n-aria key; this fails and lists any element that does not.
 */

// Proper names that stay in English inside a Chinese label.
const ALLOWED_NAMES = ['SD Image Sorter']
const TWO_ENGLISH_WORDS = /\b[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/

test('zh-CN aria-labels contain no English phrases', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.waitForTimeout(600)

  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label]'))
      .filter((el) => el.closest('#app') !== null || el.id === 'app')
      .map((el) => ({
        id: el.id || `<${el.tagName.toLowerCase()} class="${el.className}">`,
        label: el.getAttribute('aria-label') || '',
      })),
  )
  expect(labels.length).toBeGreaterThan(100)

  const offenders = labels.filter(({ label }) => {
    let text = label
    for (const name of ALLOWED_NAMES) text = text.split(name).join('')
    return TWO_ENGLISH_WORDS.test(text)
  })
  expect(
    offenders,
    `English aria-labels in zh-CN:\n${offenders.map((o) => `  ${o.id}: "${o.label}"`).join('\n')}`,
  ).toEqual([])
})
