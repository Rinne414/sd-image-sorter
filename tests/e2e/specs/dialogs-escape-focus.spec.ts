import { expect, test, type Page } from '@playwright/test'

/**
 * Five dialogs opened by toggling a class by hand and so missed the app's
 * dialog handling: VLM settings, the VLM API chat, the Prompt Lab image picker,
 * GIFs & videos censoring and the Privacy Tools preview. Escape did nothing,
 * focus stayed behind the dialog and was dropped on close. VLM settings is
 * usually opened from inside AI tagging, where Escape went to the tagging
 * dialog underneath. They now open like every other dialog: focus moves in,
 * Escape closes them (only the top one), and focus goes back to the opener.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.route('**/api/vlm/caption-batch/debug-chat**', (route) => route.fulfill({ json: { events: [] } }))
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).VLMCaption
    && (window as any).MediaCensor && (window as any).ImageObfuscator))
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'dialog-opener'
    opener.textContent = 'Open'
    document.body.prepend(opener)
  })
}

const focusInside = (page: Page, id: string) => page.evaluate(
  (dialogId) => Boolean(document.getElementById(dialogId)?.contains(document.activeElement)), id)

/** Open a dialog from the page opener, then check focus in, Escape, focus back. */
async function expectEscapeAndFocus(page: Page, id: string, open: () => Promise<void>, opener = '#dialog-opener') {
  await page.locator(opener).focus()
  await open()
  await expect(page.locator(`#${id}`)).toHaveClass(/visible/)
  await expect.poll(() => focusInside(page, id)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator(`#${id}`)).not.toHaveClass(/visible/)
  await expect(page.locator(opener)).toBeFocused()
}

test('VLM settings takes focus, closes on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  await expectEscapeAndFocus(page, 'vlm-settings-modal', () => page.evaluate(() => (window as any).VLMCaption.openSettingsModal()))
})

test('Escape on VLM settings opened over AI tagging closes only VLM settings', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.showModal('tag-modal'))
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  await page.evaluate(() => (window as any).App.openVlmSettings())
  await expect(page.locator('#vlm-settings-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#vlm-settings-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
})

test('the VLM API chat takes focus, closes on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  await expectEscapeAndFocus(page, 'vlm-debug-chat-modal', () => page.evaluate(() => (window as any).VLMCaption.openDebugChat()))
})

test('the Prompt Lab image picker takes focus, closes on Escape and hands focus back to its button', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.switchView('promptlab'))
  await page.locator('[data-mode="compare"].promptlab-tab').click()
  await expectEscapeAndFocus(page, 'promptlab-image-picker-modal', () => page.locator('#pl-pick-a').click(), '#pl-pick-a')
})

test('GIFs & videos starts in its folder field, closes on Escape and hands focus back to its button', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-media-censor-open').focus()
  await page.locator('#btn-media-censor-open').click()
  await expect(page.locator('#media-censor-modal')).toHaveClass(/visible/)
  await expect(page.locator('#media-censor-folder')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#media-censor-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#btn-media-censor-open')).toBeFocused()
})

test('the Privacy Tools preview takes focus, closes on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  // The preview lives in the Reader's Privacy Tools panel.
  await page.evaluate(() => (window as any).App.switchView('reader'))
  await page.locator('#reader-tool-tab-obfuscation').click()
  await expectEscapeAndFocus(page, 'obfuscate-preview-modal', () => page.evaluate(
    (src) => (window as any).ImageObfuscator._openPreview(src, 0), PNG_1PX))
})
