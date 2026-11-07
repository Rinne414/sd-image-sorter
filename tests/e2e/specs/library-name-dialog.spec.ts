import { expect, test } from '../fixtures/click-ledger'

// New library and Rename library ask for the name in the program's own
// dialog. They used the browser's prompt box, which the desktop program
// (Electron) does not have: it throws, so both buttons did nothing there.
test('New library and Rename library ask in the program dialog, never a browser box', async ({ page, request }) => {
  const browserBoxes: string[] = []
  page.on('dialog', (dialog) => {
    browserBoxes.push(dialog.type())
    dialog.dismiss().catch(() => {})
  })
  const name = `dialog lib ${Date.now()}`
  const renamed = `${name} renamed`
  const created: string[] = []
  try {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    // The entry page's switcher, or the top bar's library chip: both open the same menu.
    const menu = page.locator('#entry-library-menu')
    const openMenu = async () => {
      if (!(await menu.isHidden())) return
      const switcher = page.locator('#entry-library-switcher')
      await ((await switcher.isVisible()) ? switcher : page.locator('#nav-library-chip')).click()
      await expect(menu).toBeVisible()
    }

    await openMenu()
    await page.locator('#entry-library-menu .entry-library-menu-create').first().click()
    await expect(page.locator('#input-modal')).toBeVisible()
    await expect(page.locator('#input-modal-title')).toHaveText(/New library|新建图库/)
    await page.locator('#input-modal-field').fill(name)
    await page.locator('#btn-input-ok').click()

    await expect.poll(async () => {
      const body = await (await request.get('/api/libraries')).json()
      const found = body.libraries.find((library: { name: string }) => library.name === name)
      if (found) created.push(found.id)
      return Boolean(found)
    }).toBe(true)

    // Rename it from the same menu.
    await openMenu()
    const row = page.locator('#entry-library-menu .entry-library-menu-row', { hasText: name })
    await row.locator('.entry-library-menu-rename').click()
    await expect(page.locator('#input-modal')).toBeVisible()
    await expect(page.locator('#input-modal-field')).toHaveValue(name)
    await page.locator('#input-modal-field').fill(renamed)
    await page.locator('#btn-input-ok').click()
    await expect.poll(async () => {
      const body = await (await request.get('/api/libraries')).json()
      return body.libraries.some((library: { name: string }) => library.name === renamed)
    }).toBe(true)

    expect(browserBoxes).toEqual([])
  } finally {
    const body = await (await request.get('/api/libraries')).json()
    for (const library of body.libraries as { id: string; name: string }[]) {
      if (library.name === name || library.name === renamed || created.includes(library.id)) {
        await request.delete(`/api/libraries/${encodeURIComponent(library.id)}`)
      }
    }
  }
})

// The library menu waits for the server before it shows. A close or reopen
// that the user makes in that time is the last word: the create flow closed
// the menu only after switching libraries and reloading the gallery, so a
// menu reopened meanwhile vanished under the pointer, and Esc pressed while
// the menu was still loading did not stop it from popping open.
test.describe('library menu keeps the user\'s last open or close', () => {
  const libraryMenu = (page: import('@playwright/test').Page) => page.locator('#entry-library-menu')
  const clickSwitcher = async (page: import('@playwright/test').Page) => {
    const switcher = page.locator('#entry-library-switcher')
    await ((await switcher.isVisible()) ? switcher : page.locator('#nav-library-chip')).click()
  }

  test('a menu reopened while a new library is still being set up stays open', async ({ page, request }) => {
    const name = `race lib ${Date.now()}`
    try {
      await page.setViewportSize({ width: 1366, height: 768 })
      await page.goto('/')
      await clickSwitcher(page)
      await expect(libraryMenu(page)).toBeVisible()

      // Hold the create response so the reopen lands while it is pending.
      let releaseCreate: () => void = () => {}
      const createHeld = new Promise<void>((resolve) => { releaseCreate = resolve })
      await page.route('**/api/libraries', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        const response = await route.fetch()
        await createHeld
        await route.fulfill({ response })
      })

      await page.locator('#entry-library-menu .entry-library-menu-create').first().click()
      await page.locator('#input-modal-field').fill(name)
      await page.locator('#btn-input-ok').click()
      await expect(page.locator('#input-modal')).toBeHidden()

      if (await libraryMenu(page).isHidden()) await clickSwitcher(page)
      await expect(libraryMenu(page)).toBeVisible()
      releaseCreate()

      await expect(page.getByText(`Library “${name}” created`).first()).toBeVisible()
      // The create flow's last steps (switch library, reload the gallery) run after the toast.
      await expect.poll(() => page.evaluate(() => (window as any).LibraryWorkspace.getCurrentLibrary().name)).toBe(name)
      await page.waitForLoadState('networkidle')
      await expect(libraryMenu(page)).toBeVisible()
      await expect(libraryMenu(page).locator('.entry-library-menu-row', { hasText: name })).toBeVisible()
    } finally {
      await page.unroute('**/api/libraries')
      const body = await (await request.get('/api/libraries')).json()
      for (const library of body.libraries as { id: string; name: string }[]) {
        if (library.name === name) await request.delete(`/api/libraries/${encodeURIComponent(library.id)}`)
      }
    }
  })

  test('Esc pressed while the menu is still loading keeps it closed', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await page.waitForFunction(() => {
      const chip = document.getElementById('nav-library-chip')
      return Boolean(chip && !chip.hidden)
    })

    let releaseList: () => void = () => {}
    const listHeld = new Promise<void>((resolve) => { releaseList = resolve })
    await page.route('**/api/libraries', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      await listHeld
      await route.fulfill({ response })
    })

    const listed = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/libraries' && response.request().method() === 'GET'
    ))
    await clickSwitcher(page)
    await page.keyboard.press('Escape')
    releaseList()
    await listed
    // Let the menu's own continuation run after the response.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(libraryMenu(page)).toBeHidden()
    await page.unroute('**/api/libraries')
  })
})
