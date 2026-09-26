import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'
import { expectSuggestions, stubTagSuggest, suggestList } from '../fixtures/v4-suggest'

/**
 * V4 generation card editing on the real backend: add tags with library
 * suggestions, remove one and undo, write a caption, read the file again.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4cardtoken'
const PREFIX = 'v4card-'
const COUNT = 3
const DIR = 'v4-card'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

async function detail(page: Page, id: string): Promise<{ tags: string[]; nl: string | null; ai: string | null }> {
  return page.evaluate(async (x) => {
    const body = (await (await fetch(`/api/images/${x}`)).json()) as { tags: { tag: string }[]; image: { nl_caption: string | null; ai_caption: string | null } }
    return { tags: body.tags.map((t) => t.tag), nl: body.image.nl_caption, ai: body.image.ai_caption }
  }, id)
}

for (const viewport of VIEWPORTS) {
  test(`card editing controls fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openLibrary(page, TOKEN, COUNT)
    await page.getByTestId('tile').first().click()
    const card = page.getByTestId('generation-card')
    await expect(card.getByTestId('card-tag-input')).toBeVisible()
    await card.getByRole('button', { name: 'Add a caption' }).click()
    await expect(card.getByTestId('caption-editor')).toBeVisible()
    await card.getByRole('button', { name: 'Save caption' }).scrollIntoViewIfNeeded()
    await expect(card.getByRole('button', { name: 'Save caption' })).toBeInViewport()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  })
}

test('the tag-style caption suggests the word at the caret: a whole tag with its series, a word in a sentence alone; Esc closes only the list', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubTagSuggest(page)
  await openLibrary(page, TOKEN, COUNT)
  const tile = page.getByTestId('tile').nth(2)
  await tile.click()
  const id = (await tile.getAttribute('data-id'))!
  const card = page.getByTestId('generation-card')
  await card.getByRole('button', { name: 'Add a caption' }).click()
  const ai = card.getByLabel('Tag-style caption')

  // a whole tag of the list: written as library tags are (spaces); a character brings its series; ", " waits
  await ai.pressSequentially('smile, hatsu')
  await expectSuggestions(page, ['hatsune miku', 'hatsune miku (append)'])
  await ai.press('Enter')
  await expect(ai).toHaveValue('smile, hatsune miku, vocaloid, ')

  // a word inside a sentence: only that word changes
  await ai.pressSequentially('a girl with lon')
  await expectSuggestions(page, ['long hair', 'long sleeves'])
  await ai.press('Tab')
  await expect(ai).toHaveValue('smile, hatsune miku, vocaloid, a girl with long hair')

  // Esc closes the list; the caption editor stays open with the text as typed
  await ai.pressSequentially(' wat')
  await expectSuggestions(page, ['watermark', 'water'])
  await page.keyboard.press('Escape')
  await expect(suggestList(page)).toHaveCount(0)
  await expect(card.getByTestId('caption-editor')).toBeVisible()
  await expect(ai).toHaveValue('smile, hatsune miku, vocaloid, a girl with long hair wat')

  await ai.fill('smile, hatsune miku, vocaloid')
  await card.getByRole('button', { name: 'Save caption' }).click()
  await expect.poll(async () => (await detail(page, id)).ai).toBe('smile, hatsune miku, vocaloid')
})

test('tags: add with suggestions, remove and undo; captions; read again', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click()
  const first = (await tiles.nth(0).getAttribute('data-id'))!
  const card = page.getByTestId('generation-card')
  const input = card.getByTestId('card-tag-input')

  await input.fill('v4 card alpha, v4 card beta')
  await input.press('Enter')
  await expect(card).toContainText('v4 card alpha')
  await expect.poll(async () => (await detail(page, first)).tags).toEqual(expect.arrayContaining(['v4 card alpha', 'v4 card beta']))

  // remove one from its chip, then take it back
  const chip = card.locator('span', { hasText: /^v4 card alpha$/ }).first()
  await chip.hover()
  await card.getByRole('button', { name: 'Remove tag v4 card alpha' }).click()
  await expect.poll(async () => (await detail(page, first)).tags).not.toContain('v4 card alpha')
  const removedToast = page.getByRole('status').locator('div', { hasText: 'Removed: v4 card alpha' }).last()
  await removedToast.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Undone: 1 image restored.')).toBeVisible()
  await expect.poll(async () => (await detail(page, first)).tags).toContain('v4 card alpha')

  // the next image is offered the tags the library already has
  await tiles.nth(1).click()
  const second = (await tiles.nth(1).getAttribute('data-id'))!
  await input.fill('v4 card b')
  // the list floats over the page (it is never cut off by the card's scrolling)
  await expect(page.getByTestId('tag-suggest').getByRole('option', { name: /v4 card beta/ })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('v4 card beta, ')
  await input.press('Enter')
  await expect.poll(async () => (await detail(page, second)).tags).toContain('v4 card beta')

  // a caption, written and kept
  await card.getByRole('button', { name: 'Add a caption' }).click()
  await card.getByLabel('Natural-language caption').fill('A quiet test caption.')
  await card.getByRole('button', { name: 'Save caption' }).click()
  await expect(card).toContainText('A quiet test caption.')
  await expect.poll(async () => (await detail(page, second)).nl).toBe('A quiet test caption.')

  // read the file again
  await card.getByRole('button', { name: 'Read again' }).click()
  await expect(page.getByText('Generation details read again')).toBeVisible()
})
