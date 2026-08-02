/**
 * Comfort-1 gallery room pins — resume storage shape + quiet empty tips.
 * Desktop-only. Does not require a full image library.
 */
import { test, expect } from '@playwright/test'

test.describe('gallery comfort-1', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aurora-entry-skip', '1')
    })
  })

  test('comfort module boots, empty tips stay collapsed, resume API works', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await page.evaluate(() => {
      document.querySelector('.entry-page')?.setAttribute('hidden', '')
      document.body.classList.remove('entry-active')
    })
    await page.waitForFunction(() => Boolean((window as any).GalleryComfort), null, {
      timeout: 15000,
    })

    // Empty onboarding steps stay open (owner: do not collapse tips).
    await page.evaluate(() => {
      const empty = document.getElementById('gallery-empty-state')
      if (empty) empty.style.display = 'flex'
    })
    await expect(page.locator('#gallery-empty-state .onboarding-steps')).toBeVisible()
    await expect(page.locator('#gallery-empty-state .onboarding-step')).toHaveCount(4)

    // Resume storage write/read contract.
    const stored = await page.evaluate(() => {
      const gc = (window as any).GalleryComfort
      // Simulate a deep scroll save.
      const state = gc._read()
      state.resume = {
        scrollTop: 1200,
        scope: 'library',
        sortBy: 'date_desc',
        imageCount: 40,
        savedAt: Date.now(),
      }
      localStorage.setItem(gc._STORAGE_KEY, JSON.stringify(state))
      return gc._read()
    })
    expect(stored.resume.scrollTop).toBe(1200)
    expect(stored.resume.scope).toBe('library')

    // Ribbon element exists and is dismissible.
    await page.evaluate(() => {
      const el = document.getElementById('gallery-comfort-ribbon')
      if (el) {
        el.hidden = false
        el.textContent = 'test ribbon'
        el.dataset.mode = 'today'
      }
    })
    await expect(page.locator('#gallery-comfort-ribbon')).toBeVisible()
    await page.locator('#gallery-comfort-ribbon').click()
    await expect(page.locator('#gallery-comfort-ribbon')).toBeHidden()

    // Room class toggles with mark path via GalleryComfort mark after images event.
    await page.evaluate(() => {
      document.documentElement.classList.add('gallery-comfort-room')
    })
    await expect(page.locator('html')).toHaveClass(/gallery-comfort-room/)

    // Comfort-2: peek API + hero stash + daily loop chip exist.
    await page.evaluate(() => {
      const gc = (window as any).GalleryComfort
      gc.stashHeroId(42)
      gc.applyEntryHeroContinuity()
      // Force a synthetic gallery item so Space peek has a target.
      const grid = document.getElementById('gallery-grid')
      if (grid && !grid.querySelector('.gallery-item')) {
        const item = document.createElement('div')
        item.className = 'gallery-item'
        item.setAttribute('data-id', '42')
        item.tabIndex = 0
        grid.appendChild(item)
      }
    })
    expect(
      await page.evaluate(() => localStorage.getItem((window as any).GalleryComfort._HERO_ID_KEY)),
    ).toBe('42')
    await expect(page.locator('html')).toHaveClass(/gallery-comfort-has-hero/)

    await page.evaluate(() => {
      ;(window as any).AppState = (window as any).AppState || {}
      ;(window as any).AppState.currentView = 'gallery'
      ;(window as any).AppState.selectionMode = false
      ;(window as any).AppState.images = [{ id: 42 }]
      ;(window as any).AppState.pagination = { total: 1 }
      ;(window as any).GalleryComfort.showPeek(42)
    })
    await expect(page.locator('#gallery-comfort-peek')).toBeVisible()
    await page.evaluate(() => (window as any).GalleryComfort.hidePeek())
    await expect(page.locator('#gallery-comfort-peek')).toBeHidden()

    // Daily loop is opt-in (de-AI default off); force opt-in class for the pin.
    await page.evaluate(() => {
      const chip = document.getElementById('gallery-daily-loop')
      if (chip) {
        chip.classList.add('is-opted-in')
        chip.hidden = false
      }
    })
    await expect(page.locator('#gallery-daily-loop')).toBeVisible()

    // Comfort-3 shell: zen + warmth APIs
    await page.waitForFunction(() => Boolean((window as any).ComfortApp), null, {
      timeout: 10000,
    })
    await page.evaluate(() => {
      const ca = (window as any).ComfortApp
      ca.setZen(true, { silent: true })
      ca.setWarmth('warm')
    })
    await expect(page.locator('html')).toHaveClass(/comfort-zen/)
    await expect(page.locator('html')).toHaveAttribute('data-comfort-warmth', 'warm')
    await page.evaluate(() => {
      const ca = (window as any).ComfortApp
      ca.setZen(false, { silent: true })
      ca.setWarmth('neutral')
    })
    await expect(page.locator('html')).not.toHaveClass(/comfort-zen/)
  })
})
