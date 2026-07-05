import { expect, test } from '@playwright/test'

/**
 * Owner feedback batch 2026-07-05 (v3.5.0): regression tests for
 * - search-syntax help modal re-rendering after an in-app language switch
 *   (it listened for the wrong event and stayed in the first-open language)
 * - settings toggle rows being whole-row clickable with a visible state
 * - image-to-image navigation keeping the previous image (no black flash:
 *   the skeleton must NOT hide the current image on re-navigation)
 * - WASD slot cards keeping their folder buttons inside the card box
 */

test.use({ viewport: { width: 1600, height: 900 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('aurora-entry-skip', '1')
  })
})

test('search help rows re-render in English after switching language', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Open once in Chinese so the row cache is populated…
  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal.visible')).toBeVisible()
  const zhDesc = await page.locator('.search-help-row .search-help-desc').first().textContent()
  expect(zhDesc).toContain('文字')
  await page.locator('#btn-close-search-help').click()

  // …switch to English in-app…
  await page.evaluate(() => (window as any).I18n.setLang('en'))

  // …and the next open must be English, not the cached Chinese rows.
  await page.locator('#btn-search-help').click()
  await expect(page.locator('#search-help-modal.visible')).toBeVisible()
  await expect(page.locator('.search-help-row .search-help-desc').first())
    .toContainText('Plain words')
})

test('settings toggle rows flip on whole-row click, not just the button', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  const result = await page.evaluate(() => {
    const btn = document.getElementById('btn-settings-entry-toggle')!
    const row = btn.closest('.settings-row') as HTMLElement
    const before = localStorage.getItem('aurora-entry-skip')
    ;(row.querySelector('.settings-row-copy') as HTMLElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return {
      flipped: localStorage.getItem('aurora-entry-skip') !== before,
      rowIsToggle: row.classList.contains('settings-row-toggle'),
      pressed: btn.getAttribute('aria-pressed'),
    }
  })
  expect(result.flipped).toBe(true)
  expect(result.rowIsToggle).toBe(true)
})

test('image navigation keeps the previous image visible (no skeleton over it)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Simulate: modal already open and showing an image, then navigate.
  const probe = await page.evaluate(() => {
    const modal = document.getElementById('image-modal')!
    const img = document.getElementById('modal-image') as HTMLImageElement
    modal.classList.add('visible')
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    img.style.opacity = '1'

    // Re-navigation: keepImage must leave the current image untouched.
    ;(window as any).SkeletonModal.showImageModal('image-modal', { keepImage: true })
    const renav = {
      opacity: img.style.opacity,
      imageSkeleton: !!document.getElementById('skeleton-modal-image'),
    }
    ;(window as any).SkeletonModal.hideImageModal('image-modal')

    // Cold open (no keepImage) still uses the image skeleton.
    ;(window as any).SkeletonModal.showImageModal('image-modal')
    const cold = {
      opacity: img.style.opacity,
      imageSkeleton: !!document.getElementById('skeleton-modal-image'),
    }
    ;(window as any).SkeletonModal.hideImageModal('image-modal')
    modal.classList.remove('visible')
    return { renav, cold }
  })

  expect(probe.renav.opacity).toBe('1')          // old image stays visible
  expect(probe.renav.imageSkeleton).toBe(false)  // no gray block over it
  expect(probe.cold.opacity).toBe('0')           // cold open keeps skeleton UX
  expect(probe.cold.imageSkeleton).toBe(true)
})

test('WASD slot folder buttons stay inside their cards', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  await page.evaluate(() => document.getElementById('nav-tab-sorting')?.click())
  // v3.5.0 naming unification made 手动排序 appear on the (hidden) entry tile
  // too — target the sub-tab directly instead of ambiguous display text.
  await page.locator('.sorting-sub-tab[data-sorting-sub="manual"]').click()
  await expect(page.locator('.folder-config.sort-slot-only')).toBeVisible()

  const overflow = await page.evaluate(() => {
    const out: Array<{ key: string | undefined }> = []
    document.querySelectorAll('.folder-slot').forEach((slot) => {
      const s = slot.getBoundingClientRect()
      slot.querySelectorAll('.browse-folder').forEach((b) => {
        const r = b.getBoundingClientRect()
        if (r.right > s.right + 1 || r.left < s.left - 1) {
          out.push({ key: (slot as HTMLElement).dataset.key })
        }
      })
    })
    return out
  })
  expect(overflow).toEqual([])
})
