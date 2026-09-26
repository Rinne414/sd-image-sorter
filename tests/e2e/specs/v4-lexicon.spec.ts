import { expect, test, type Page } from '@playwright/test'

import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 词库 (tag & prompt library) on the real backend, in a library of its own
 * so every count is exactly the seeded rows. A click only edits the library
 * search (values with a space or a colon quoted), and the library then really
 * shows those images; changing a tag's category is written to the test
 * database. No model is needed.
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4lextoken'
const PREFIX = 'v4lex-'
const COUNT = 6
const DIR = 'v4-lexicon'
const LIBRARY = 'v4lex-lib'

/**
 * tags: v4lex_common on 00-03, v4lex_pair on 00-01, v4lex:colon on 04
 * prompt words: "v4lex word" on 00-02 (plus the seed's own words on all six)
 * LoRAs: v4lex_style on 00-02, "v4lex v2" on 03
 * models: "v4lex alpha" on 00-01, v4lex_beta on 02
 */
function seedLibrary(): void {
  runBackendScript(`
import sqlite3
prefix = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e lexicon', 0)", (${JSON.stringify(LIBRARY)},))
    conn.execute("UPDATE images SET library_id = ? WHERE filename LIKE ?", (${JSON.stringify(LIBRARY)}, prefix + "%"))
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE ? ORDER BY filename", (prefix + "%", prefix + "cache%"))]
    tags = {0: ["v4lex_common", "v4lex_pair"], 1: ["v4lex_common", "v4lex_pair"], 2: ["v4lex_common"], 3: ["v4lex_common"], 4: ["v4lex:colon"]}
    for i, names in tags.items():
        for tag in names:
            conn.execute("INSERT INTO tags (image_id, tag, confidence, source) VALUES (?, ?, 0.9, 'e2e')", (ids[i], tag))
    for i in (0, 1, 2):
        conn.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, 'v4lex word')", (ids[i],))
        conn.execute("INSERT INTO image_loras (image_id, lora_name) VALUES (?, 'v4lex_style')", (ids[i],))
    conn.execute("INSERT INTO image_loras (image_id, lora_name) VALUES (?, 'v4lex v2')", (ids[3],))
    for i, model in ((0, "v4lex alpha"), (1, "v4lex alpha"), (2, "v4lex_beta")):
        conn.execute("UPDATE images SET checkpoint = ?, checkpoint_normalized = ? WHERE id = ?", (model + ".safetensors", model, ids[i]))
    conn.commit()
print("ok")
`)
}

function dropLibrary(): void {
  runBackendScript(`
import sqlite3
prefix = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    conn.execute("DELETE FROM image_loras WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (prefix + "%",))
    conn.execute("DELETE FROM tag_categories WHERE tag LIKE 'v4lex%'")
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(LIBRARY)},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  dropLibrary()
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  seedLibrary()
})

test.afterAll(() => {
  dropLibrary()
  cleanupImages(PREFIX, [DIR])
})

/** V4 in English, in the test's own library, at `hash`, with an empty search. */
async function openAt(page: Page, hash: string) {
  await page.addInitScript((library) => {
    if (sessionStorage.getItem('v4lex-init')) return
    sessionStorage.setItem('v4lex-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: library }))
    localStorage.removeItem('sd-v4-browse')
    localStorage.removeItem('sd-v4-lexicon')
  }, LIBRARY)
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('lexicon-page').or(page.getByTestId('gallery-scroller')).first()).toBeVisible()
}

const row = (page: Page, name: string) => page.locator(`[data-testid="lex-row"][data-name="${name}"]`)
const names = (page: Page) => page.getByTestId('lex-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-name')))
const queryText = (page: Page) => page.getByTestId('lex-query-text')
const toast = (page: Page, text: string) => page.getByRole('status').locator('div', { hasText: text }).last()

test('every tab lists the library’s entries with how many images use them', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/tools/lexicon')
  await page.getByTestId('lex-find').fill('v4lex')

  // tags, most images first
  await expect.poll(() => names(page)).toEqual(['v4lex_common', 'v4lex_pair', 'v4lex:colon'])
  await expect(row(page, 'v4lex_common').getByTestId('lex-count')).toHaveText('4')
  await expect(row(page, 'v4lex_pair').getByTestId('lex-count')).toHaveText('2')
  await expect(page.getByTestId('lex-total')).toHaveText(/^3 of \d+ shown$/)

  await page.getByTestId('lex-tab-prompts').click()
  await expect.poll(() => names(page)).toEqual([TOKEN, 'v4lex word'])
  await expect(row(page, TOKEN).getByTestId('lex-count')).toHaveText('6')
  await expect(row(page, 'v4lex word').getByTestId('lex-count')).toHaveText('3')

  await page.getByTestId('lex-tab-loras').click()
  await expect.poll(() => names(page)).toEqual(['v4lex_style', 'v4lex v2'])
  await expect(row(page, 'v4lex_style').getByTestId('lex-count')).toHaveText('3')

  await page.getByTestId('lex-tab-checkpoints').click()
  await expect.poll(() => names(page)).toEqual(['v4lex alpha', 'v4lex_beta'])
  await expect(row(page, 'v4lex alpha').getByTestId('lex-count')).toHaveText('2')

  // the tab is remembered
  await page.reload()
  await expect(page.getByTestId('lex-tab-checkpoints')).toHaveAttribute('aria-selected', 'true')
})

test('finding and sorting: part of a name, spaces for underscores, by images or A-Z', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/lexicon')
  await page.getByTestId('lex-tab-tags').click()
  await page.getByTestId('lex-find').fill('V4LEX PAIR')
  await expect.poll(() => names(page)).toEqual(['v4lex_pair'])

  // prompt words: by images the seed's own word (6) leads; by name 'v4lex word' comes first
  await page.getByTestId('lex-tab-prompts').click()
  await page.getByTestId('lex-find').fill('v4lex')
  await expect.poll(() => names(page)).toEqual([TOKEN, 'v4lex word'])
  await page.getByTestId('lex-sort-name').click()
  await expect.poll(() => names(page)).toEqual(['v4lex word', TOKEN])
  await page.getByTestId('lex-sort-count').click()
  await expect.poll(() => names(page)).toEqual([TOKEN, 'v4lex word'])

  await page.getByTestId('lex-find').fill('nothing-like-this')
  await expect(page.getByTestId('lex-list-prompts')).toContainText('Nothing has “nothing-like-this” in its name.')
})

test('a click puts an entry into the library search and a second takes it out; the library shows those images', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/lexicon')
  await page.getByTestId('lex-tab-tags').click()
  await page.getByTestId('lex-find').fill('v4lex')
  const entry = (name: string) => row(page, name).getByTestId('lex-entry')

  await entry('v4lex_pair').click()
  await expect(queryText(page)).toHaveText('tag:v4lex_pair')
  await expect(entry('v4lex_pair')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('lex-query-count')).toHaveText('Matching images: 2')
  await entry('v4lex_pair').click()
  await expect(queryText(page)).toHaveText('Empty: click an entry on the left to put it here.')
  await expect(entry('v4lex_pair')).toHaveAttribute('aria-pressed', 'false')

  // a tag with a colon is quoted, and the library finds its one image
  await entry('v4lex:colon').click()
  await expect(queryText(page)).toHaveText('tag:"v4lex:colon"')
  await page.getByTestId('lex-view').click()
  await expect(page).toHaveURL(/#\/library/)
  await expect(page.getByTestId('query-input')).toHaveValue('tag:"v4lex:colon"')
  await expect(page.getByTestId('result-count')).toHaveText(/^1 image/)

  // back in the lexicon: a prompt word, a LoRA and a model with spaces, each quoted
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Tag & prompt library' }).click()
  await page.getByTestId('lex-clear').click()
  await page.getByTestId('lex-tab-prompts').click()
  await entry('v4lex word').click()
  await expect(queryText(page)).toHaveText('prompt:"v4lex word"')
  await expect(page.getByTestId('lex-query-count')).toHaveText('Matching images: 3')
  await page.getByTestId('lex-clear').click()

  await page.getByTestId('lex-tab-loras').click()
  await entry('v4lex v2').click()
  await expect(queryText(page)).toHaveText('lora:"v4lex v2"')
  await expect(page.getByTestId('lex-query-count')).toHaveText('Matching images: 1')
  await page.getByTestId('lex-clear').click()

  await page.getByTestId('lex-tab-checkpoints').click()
  await entry('v4lex alpha').click()
  await expect(queryText(page)).toHaveText('checkpoint:"v4lex alpha"')
  await page.getByTestId('lex-view').click()
  await expect(page.getByTestId('result-count')).toHaveText('2 images')
})

test('a tag’s category can be changed; it is saved and the category filter follows', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/tools/lexicon')
  await page.getByTestId('lex-tab-tags').click()
  await page.getByTestId('lex-find').fill('v4lex')
  const select = row(page, 'v4lex_common').getByTestId('lex-category')
  await expect(select).toBeVisible()
  await select.selectOption('outfit')
  await expect(toast(page, 'v4lex_common moved to “Outfit”')).toBeVisible()

  const saved = runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    row = conn.execute("SELECT category, is_user_defined FROM tag_categories WHERE tag = 'v4lex_common'").fetchone()
print(row[0], row[1])
`)
  expect(saved.split('\n').at(-1)).toBe('outfit 1')

  await page.reload()
  await page.getByTestId('lex-find').fill('v4lex')
  await expect(row(page, 'v4lex_common').getByTestId('lex-category')).toHaveValue('outfit')
  await page.getByTestId('lex-category-filter').selectOption('outfit')
  await expect.poll(() => names(page)).toEqual(['v4lex_common'])
})

test('the filter panel opens the lexicon, and back returns to the library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/library')
  await expect(page.getByTestId('result-count')).toHaveText('6 images')
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.getByTestId('filter-open-lexicon').click()
  await expect(page).toHaveURL(/#\/tools\/lexicon$/)
  await expect(page.getByTestId('lexicon-page')).toBeVisible()
  await page.getByTestId('tool-back').click()
  await expect(page).toHaveURL(/#\/library/)
})

test('every size: nothing overflows and the main controls are on screen', async ({ page }) => {
  await openAt(page, '#/tools/lexicon')
  await page.getByTestId('lex-tab-tags').click()
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await expect(page.getByTestId('lex-row').first()).toBeVisible()
    for (const id of ['lex-tab-checkpoints', 'lex-find', 'lex-sort-name', 'lex-category-filter', 'lex-view', 'lex-clear']) {
      await expect(page.getByTestId(id), `${id} at ${viewport.width}`).toBeInViewport()
    }
    expect(await pageOverflow(page), `${viewport.width}`).toBeLessThanOrEqual(0)
  }
})
