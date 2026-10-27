import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Duplicate cleanup said "Moved N images to trash" with N = the pictures it
 * asked for, also when some could not be moved (open in another program,
 * gone), and took the group off the list as if it were done.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#567"/></svg>'

function groupsAnswer() {
  return {
    available: true,
    summary: { group_count: 1, redundant_count: 2, exact: true },
    groups: [{
      group_id: 1,
      similarity: 0.99,
      members: [
        { id: 95001, filename: 'keep.png', suggested_keep: true, width: 64, height: 64 },
        { id: 95002, filename: 'copy-a.png', suggested_keep: false, width: 64, height: 64 },
        { id: 95003, filename: 'copy-b.png', suggested_keep: false, width: 64, height: 64 },
      ],
    }],
    total_groups: 1,
    has_more: false,
  }
}

async function openCleanup(page: Page, deleteAnswer: unknown, status = 200) {
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/duplicates/groups*', (route) => route.fulfill({ json: groupsAnswer() }))
  await page.route('**/api/images/delete-selected', (route) => route.fulfill({ status, json: deleteAnswer }))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#nav-tools-toggle').click()
  await page.locator('#nav-tools-dup-cleaner').click()
  await expect(page.locator('#dup-cleaner-modal.visible')).toBeVisible()
  await expect(page.locator('.dup-group')).toHaveCount(1)
}

test('a trash run that moved only some pictures says how many and why, and keeps the group', async ({ page }) => {
  await openCleanup(page, {
    deleted: 1,
    failed: [{ image_id: 95003, filename: 'copy-b.png', error: 'The file is open in another program.' }],
    permanent_delete: false,
    trash_used: true,
  })

  await page.getByTestId('dup-keep-best').click()

  const toast = page.locator('#toast-container .toast.warning').last()
  await expect(toast).toContainText('Moved 1 image to trash; 1 could not be moved.')
  await expect(toast).toContainText('The file is open in another program.')
  await expect(page.locator('#toast-container .toast.success')).toHaveCount(0)
  await expect(page.locator('.dup-group')).toHaveCount(1)
})

test('a trash run that moved every picture says so and takes the group off the list', async ({ page }) => {
  await openCleanup(page, { deleted: 2, failed: [], permanent_delete: false, trash_used: true })

  await page.getByTestId('dup-keep-best').click()

  await expect(page.locator('#toast-container .toast.success').last()).toContainText('Moved 2 images to trash')
  await expect(page.locator('.dup-group')).toHaveCount(0)
})

test('a trash run the program refused says why', async ({ page }) => {
  await openCleanup(page, { error: 'Cannot delete while another delete is running', type: 'HTTPException', status_code: 409 }, 409)

  await page.getByTestId('dup-keep-best').click()

  await expect(page.locator('#toast-container .toast.error').last())
    .toContainText('Cannot delete while another delete is running')
  await expect(page.locator('.dup-group')).toHaveCount(1)
})
