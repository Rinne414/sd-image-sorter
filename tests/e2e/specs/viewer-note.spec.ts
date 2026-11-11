import { expect, test, type Page } from '@playwright/test'

/**
 * The viewer's Note: saved when the field is left or with Ctrl+Enter, kept per
 * picture, and typing in it never drives the viewer's own keys.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockViewer(page: Page) {
  const notes: Record<number, string | null> = { 8001: null, 8002: 'for the winter book' }
  const saved: Array<{ id: number; note: string }> = []
  const images = [8001, 8002].map((id) => ({ id, filename: `note-${id}.png`, path: `/mock/note-${id}.png`, prompt: '', generator: 'unknown' }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    const note = url.pathname.match(/^\/api\/images\/(\d+)\/note$/)
    const one = url.pathname.match(/^\/api\/images\/(\d+)$/)
    if (note) {
      const id = Number(note[1])
      const text = String(route.request().postDataJSON().note || '')
      notes[id] = text || null
      saved.push({ id, note: text })
      await route.fulfill({ json: { image_id: id, note: text } })
    } else if (one) {
      const id = Number(one[1])
      await route.fulfill({ json: { image: { ...images.find((image) => image.id === id), note: notes[id] }, tags: [] } })
    } else if (url.pathname === '/api/images') {
      await route.fulfill({ json: { images, total: 2, has_more: false, next_cursor: null } })
    } else {
      await route.fulfill({ json: { before: null, comparable: false } })
    }
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  return { saved: () => [...saved] }
}

test('a note is saved from the viewer and belongs to its picture', async ({ page }) => {
  const viewer = await mockViewer(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  await page.evaluate(() => (window as any).Gallery.openPreview(8001))
  const note = page.locator('#modal-note-text')
  await expect(note).toBeVisible()
  await expect(note).toHaveValue('')
  await expect(page.locator('#modal-note-status')).toHaveText('Only in this program. The search finds its words.')

  // Arrow keys typed in the note move the caret, not the viewer.
  await note.click()
  await page.keyboard.type('fix the left hand')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#modal-filename')).toHaveText('note-8001.png')
  expect(viewer.saved()).toEqual([])

  await page.keyboard.press('Control+Enter')
  await expect(page.locator('#modal-note-status')).toHaveText('Saved.')
  expect(viewer.saved()).toEqual([{ id: 8001, note: 'fix the left hand' }])

  // The other picture shows its own note; leaving the field saves an edit.
  await page.evaluate(() => (window as any).Gallery.openPreview(8002))
  await expect(note).toHaveValue('for the winter book')
  await note.fill('for the winter book, page 3')
  await page.locator('#modal-filename').click()
  await expect.poll(() => viewer.saved().at(-1)).toEqual({ id: 8002, note: 'for the winter book, page 3' })

  // Esc on an unsaved edit gives the stored text back and the viewer stays open.
  await note.click()
  await page.keyboard.type(' and more')
  await page.keyboard.press('Escape')
  await expect(note).toHaveValue('for the winter book, page 3')
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)

  // Emptying the field removes the note.
  await note.fill('')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('#modal-note-status')).toHaveText('Note removed.')
  expect(viewer.saved().at(-1)).toEqual({ id: 8002, note: '' })
})
