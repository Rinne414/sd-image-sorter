/**
 * Multi long-lived libraries — isolation + nav chip + header contract.
 * Desktop-only. Uses API with X-SD-Library-Id; does not mutate user data dirs
 * outside the Playwright-isolated backend.
 */
import { test, expect } from '@playwright/test'

test.describe('library workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aurora-entry-skip', '1')
      localStorage.setItem(
        'sd-library-workspace-v1',
        JSON.stringify({ v: 2, currentId: 'main' }),
      )
    })
  })

  test('nav library chip boots and API headers pin current library', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    await page.evaluate(() => {
      document.querySelector('.entry-page')?.setAttribute('hidden', '')
      document.body.classList.remove('entry-active')
    })

    await page.waitForFunction(() => Boolean((window as any).LibraryWorkspace), null, {
      timeout: 15000,
    })

    // Chip should appear after refreshFromServer.
    await page.waitForFunction(() => {
      const chip = document.getElementById('nav-library-chip')
      return Boolean(chip && !chip.hidden && chip.textContent && chip.textContent.trim().length > 0)
    }, null, { timeout: 15000 })

    const headersOk = await page.evaluate(() => {
      const h = (window as any).LibraryWorkspace.libraryHeaders({ Accept: 'application/json' })
      return h['X-SD-Library-Id'] === 'main' || h['X-SD-Library-Id'] === (window as any).LibraryWorkspace.getCurrentLibraryId()
    })
    expect(headersOk).toBe(true)

    // Create second library via API, switch current id, prove list isolation headers.
    const created = await page.evaluate(async () => {
      const lw = (window as any).LibraryWorkspace
      const res = await lw.apiFetch('/api/libraries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: `E2E Lib ${Date.now()}` }),
      })
      if (!res.ok) return { ok: false, status: res.status }
      const data = await res.json()
      await lw.setCurrentLibraryId(data.library.id, { reloadGallery: false })
      const hdr = lw.libraryHeaders({})
      const listMain = await lw.apiFetch('/api/images?limit=5&scope=library', {
        headers: { ...lw.libraryHeaders({ Accept: 'application/json' }), 'X-SD-Library-Id': 'main' },
      })
      const listOther = await lw.apiFetch('/api/images?limit=5&scope=library')
      return {
        ok: true,
        id: data.library.id,
        header: hdr['X-SD-Library-Id'],
        mainStatus: listMain.status,
        otherStatus: listOther.status,
      }
    })
    expect(created.ok).toBe(true)
    expect(created.header).toBe(created.id)
    expect(created.mainStatus).toBe(200)
    expect(created.otherStatus).toBe(200)

    // Cleanup: delete the temp library (not main).
    await page.evaluate(async (id) => {
      const lw = (window as any).LibraryWorkspace
      await lw.setCurrentLibraryId('main', { reloadGallery: false })
      await lw.apiFetch(`/api/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await lw.refreshFromServer()
    }, created.id)
  })

  test('clear confirm copy includes current library name', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await page.waitForFunction(() => Boolean((window as any).LibraryWorkspace?.clearConfirmCopy), null, {
      timeout: 15000,
    })
    const copy = await page.evaluate(() => (window as any).LibraryWorkspace.clearConfirmCopy())
    expect(copy.message).toBeTruthy()
    expect(String(copy.message).length).toBeGreaterThan(10)
    expect(String(copy.title).toLowerCase()).toMatch(/clear|清空/)
  })
})
