import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Installing an update asks first while work is running (V3.5 #19).
 *
 * Installing restarts the program and stops a running scan or tagging run.
 * The page now sends check_busy, and when the backend answers "busy" it
 * names the running work and asks "install anyway?"; only a yes installs.
 */

test.describe.configure({ mode: 'serial' })

async function startInstall(page: Page, firstAnswer: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/updates/apply', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    const answer = bodies.length === 1 ? firstAnswer : { status: 'scheduled', boot_id: 'boot-1' }
    await route.fulfill({ json: answer })
  })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any).applyAppUpdate === 'function')
  await page.evaluate(() => {
    void (window as any).applyAppUpdate({ has_update: true, current_version: '3.5.0', latest_version: '3.5.1' })
  })
  return bodies
}

test('with work running the install asks first and Cancel installs nothing', async ({ page }) => {
  const bodies = await startInstall(page, { status: 'busy', jobs: ['scan', 'tagging'], boot_id: 'boot-1' })

  const dialog = page.locator('#confirm-modal.visible')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#confirm-title')).toHaveText('现在安装更新吗？')
  await expect(dialog.locator('#confirm-message')).toHaveText(
    '还在进行：文件夹扫描、打标。安装更新会重启程序并中断它，之后可以再开始。仍要安装吗？')
  await expect(dialog.locator('#btn-confirm-ok')).toBeInViewport()
  expect(bodies).toEqual([{ force_check: true, relaunch: true, check_busy: true }])

  await dialog.locator('#btn-confirm-cancel').click()
  await page.waitForTimeout(300)
  expect(bodies).toHaveLength(1)
  await expect(page.locator('#global-loading')).toBeHidden()
})

test('install anyway sends the install without the busy check', async ({ page }) => {
  const bodies = await startInstall(page, { status: 'busy', jobs: ['scan'], boot_id: 'boot-1' })

  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()

  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual({ force_check: true, relaunch: true, check_busy: false })
})

test('with nothing running the install goes ahead without a question', async ({ page }) => {
  const bodies = await startInstall(page, { status: 'scheduled', boot_id: 'boot-1' })

  await expect.poll(() => bodies.length).toBe(1)
  await page.waitForTimeout(300)
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
})
