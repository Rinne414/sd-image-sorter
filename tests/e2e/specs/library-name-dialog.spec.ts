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
