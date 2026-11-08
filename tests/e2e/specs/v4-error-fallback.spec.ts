import { expect, test } from '@playwright/test'

/**
 * A V Opus page that fails to render says so in place, with the reason and a
 * way on, and the rest of the program keeps working: never a blank window.
 * (Owner baseline: a whole-UI error fallback. A real case on 2026-11-08: a
 * listing time sent as a number made the Library throw and the whole program
 * went blank.)
 *
 * Needs the V Opus build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.use({ viewport: { width: 1920, height: 1080 } })

test('a page that throws shows what failed, and the top bar still reaches the other pages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  // A listing row without its fields makes the Library throw while it renders.
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/images') return route.fallback()
    await route.fulfill({ json: { images: [{ id: 1 }], total: 1, has_more: false, next_cursor: null } })
  })
  await page.goto('/vopus/#/library')

  const failed = page.getByTestId('next-error')
  await expect(failed).toBeVisible()
  await expect(failed).toContainText('This screen ran into an error')
  await expect(failed).toContainText('Reason:')
  await expect(failed.getByRole('button', { name: 'Reload' })).toBeVisible()

  // The program around the page is still there: another page opens.
  await page.getByRole('button', { name: 'Batches', exact: true }).or(page.getByRole('link', { name: 'Batches', exact: true })).first().click()
  await expect(failed).toHaveCount(0)
  await expect(page).toHaveURL(/#\/batch/)
})
