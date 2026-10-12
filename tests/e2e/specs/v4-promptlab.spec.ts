import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'
import { expectSuggestions, stubTagSuggest, suggestList } from '../fixtures/v4-suggest'

/**
 * V4 Prompt Lab (提示词助手) on the real backend, in a library of its own so
 * the statistics are exactly the seeded rows: Stats counts what was seeded,
 * "Show in library" only writes the search line (and the library then shows
 * those images), Compare starts from the two images picked in the library,
 * Build starts from the image being looked at, cleans a prompt while keeping
 * its LoRA, and the mode is remembered. Random draws the same prompts from
 * the same seed, keeps a locked slot, sends every option, makes and deletes
 * tag sets, presets and exclusion rules. No model is needed.
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4pltoken'
const PREFIX = 'v4pl-'
const COUNT = 7
const DIR = 'v4-promptlab'
const LIBRARY = 'v4pl-lib'
const LORA_PROMPT = `${TOKEN}, 1girl, 1GIRL, silver_hair, masterpiece, <lora:my_style_v2:0.8>, smile`

/** Ids of the seeded rows by index (00..06). */
let ids: number[] = []

function dropLibrary(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM tags WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${JSON.stringify(PREFIX)} + "%",))
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(LIBRARY)},))
    conn.commit()
print("ok")
`)
}

/**
 * Rows 00-05 carry tags, scores and models; row 06 has none (and later loses its file).
 *   tags: v4pl_common on 00-05, v4pl_four on 00-03, v4pl_pair on 00-01
 *   scores: 00 8.5, 01 7.5, 02 7.2, 03 5.0
 *   models: 00-02 v4pl_alpha, 03-04 v4pl_beta
 */
function seedLibrary(): number[] {
  const out = runBackendScript(`
import json, sqlite3
prefix = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e prompt lab', 0)", (${JSON.stringify(LIBRARY)},))
    conn.execute("UPDATE images SET library_id = ? WHERE filename LIKE ?", (${JSON.stringify(LIBRARY)}, prefix + "%"))
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE ? ORDER BY filename", (prefix + "%", prefix + "cache%"))]
    scores = [8.5, 7.5, 7.2, 5.0, None, None, None]
    models = ["models/v4pl_alpha.safetensors"] * 3 + ["v4pl_beta.safetensors"] * 2 + [None, None]
    for i, image_id in enumerate(ids):
        tags = (["v4pl_common"] if i < 6 else []) + (["v4pl_four"] if i < 4 else []) + (["v4pl_pair"] if i < 2 else [])
        for tag in tags:
            conn.execute("INSERT INTO tags (image_id, tag, confidence, source) VALUES (?, ?, 0.9, 'e2e')", (image_id, tag))
        model = models[i]
        conn.execute(
            "UPDATE images SET aesthetic_score = ?, checkpoint = ?, checkpoint_normalized = ? WHERE id = ?",
            (scores[i], model, model.split("/")[-1].rsplit(".", 1)[0] if model else None, image_id),
        )
    conn.execute("UPDATE images SET prompt = ? WHERE id = ?", (${JSON.stringify(LORA_PROMPT)}, ids[5]))
    conn.commit()
print(json.dumps(ids))
`)
  return JSON.parse(out.split('\n').at(-1)!) as number[]
}

test.beforeAll(() => {
  dropLibrary()
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  ids = seedLibrary()
  expect(ids).toHaveLength(COUNT)
})

/** Tag sets, rules and presets the Random tests made (they belong to the whole app, not the library). */
function dropPromptData(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM tag_set_members WHERE set_id IN (SELECT id FROM tag_sets WHERE name LIKE 'v4pl%')")
    conn.execute("DELETE FROM tag_sets WHERE name LIKE 'v4pl%'")
    conn.execute("DELETE FROM tag_exclusion_conditions WHERE exclusion_id IN (SELECT id FROM tag_exclusions WHERE rule_name LIKE 'v4pl%')")
    conn.execute("DELETE FROM tag_exclusion_targets WHERE exclusion_id IN (SELECT id FROM tag_exclusions WHERE rule_name LIKE 'v4pl%')")
    conn.execute("DELETE FROM tag_exclusions WHERE rule_name LIKE 'v4pl%'")
    conn.execute("DELETE FROM prompt_presets WHERE name LIKE 'v4pl%'")
    conn.commit()
print("ok")
`)
}

test.afterAll(() => {
  dropLibrary()
  dropPromptData()
  cleanupImages(PREFIX, [DIR])
})

/** V4 in English, in the test's own library, at `hash`. */
async function openAt(page: Page, hash: string, mode = 'stats') {
  await markModelsReady(page)
  await page.addInitScript(
    ({ library, first }) => {
      if (sessionStorage.getItem('v4pl-init')) return
      sessionStorage.setItem('v4pl-init', '1')
      localStorage.setItem('sd-image-sorter-lang', 'en')
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: library }))
      localStorage.removeItem('sd-v4-browse')
      localStorage.removeItem('sd-v4-promptlab-build')
      localStorage.removeItem('sd-v4-promptlab-random')
      localStorage.setItem('sd-v4-promptlab-mode', first)
    },
    { library: LIBRARY, first: mode },
  )
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

const tile = (page: Page, i: number) => page.locator(`[data-testid="tile"][data-id="${ids[i]}"]`)
const rowOf = (page: Page, list: string, tag: string) => page.getByTestId(list).locator(`[data-tag="${tag}"]`)
/** The newest toast saying `text`. */
const toast = (page: Page, text: string) => page.getByRole('status').locator('div', { hasText: text }).last()

test('Stats counts exactly what the library holds', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/tools/promptlab')
  await expect(page.getByTestId('pl-stats')).toBeVisible()

  await expect(page.getByTestId('pl-stat-total')).toContainText('7')
  await expect(page.getByTestId('pl-stat-total')).toContainText('6 tagged')
  await expect(page.getByTestId('pl-stat-scored')).toContainText('4')
  await expect(page.getByTestId('pl-stat-scored')).toContainText('57% of all images')
  await expect(page.getByTestId('pl-stat-caption')).toHaveCount(0)

  // most used tags, share of the 7 images on disk, in order
  const top = page.getByTestId('pl-top-tags').locator('li')
  await expect(top).toHaveCount(3)
  await expect(top.nth(0)).toHaveAttribute('data-tag', 'v4pl_common')
  await expect(top.nth(0)).toContainText('85.7%')
  await expect(rowOf(page, 'pl-top-tags', 'v4pl_four')).toContainText('57.1%')
  await expect(rowOf(page, 'pl-top-tags', 'v4pl_pair')).toContainText('28.6%')

  // tags of the 7+ images (00, 01, 02): common 3, four 3, pair 2
  await expect(rowOf(page, 'pl-high-tags', 'v4pl_pair')).toContainText('2')
  await expect(page.getByTestId('pl-high-tags').locator('li')).toHaveCount(3)

  // models: alpha 3, beta 2; only alpha has 3 scored images, averaging (8.5 + 7.5 + 7.2) / 3
  const models = page.getByTestId('pl-top-models').locator('li')
  await expect(models).toHaveCount(2)
  await expect(models.nth(0)).toContainText('v4pl_alpha')
  await expect(models.nth(0)).toContainText('3 images')
  await expect(models.nth(1)).toContainText('v4pl_beta')
  const best = page.getByTestId('pl-best-models').locator('li')
  await expect(best).toHaveCount(1)
  await expect(best.first()).toContainText('average 7.73 · 3 images')

  // the best-scoring images, highest first
  const examples = page.getByTestId('pl-examples').locator('li')
  await expect(examples).toHaveCount(4)
  await expect(examples.first()).toHaveAttribute('data-id', String(ids[0]))
  await expect(examples.first()).toContainText('score 8.50')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('"Show in library" only writes the search line, and the library shows those images', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/promptlab')
  await rowOf(page, 'pl-top-tags', 'v4pl_four').getByRole('button', { name: 'Show in library' }).click()
  await expect(page).toHaveURL(/#\/library/)
  await expect(page.getByTestId('query-input')).toHaveValue('tag:v4pl_four')
  await expect(page.getByTestId('result-count')).toHaveText('4 images')

  // a model replaces any model in the search and keeps the rest
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Prompt Lab' }).click()
  await page.getByTestId('pl-top-models').locator('li').first().getByRole('button', { name: 'Show in library' }).click()
  await expect(page.getByTestId('query-input')).toHaveValue('tag:v4pl_four checkpoint:v4pl_alpha')
  await expect(page.getByTestId('result-count')).toHaveText('3 images')
})

test('adding a stats tag and sending a recipe fill Build', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/promptlab')
  await rowOf(page, 'pl-top-tags', 'v4pl_pair').getByRole('button', { name: 'Add to Build' }).click()
  await expect(toast(page, 'Added to Build: v4pl_pair')).toBeVisible()
  await expect(page.getByTestId('pl-mode-stats')).toHaveAttribute('aria-selected', 'true')

  await page.getByTestId('pl-recipes').locator('li').first().getByRole('button', { name: 'Send to Build' }).click()
  await expect(page.getByTestId('pl-mode-build')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('pl-build-source')).toContainText('A draft from the recipe “v4pl_alpha”')
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue(/v4pl_common/)
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue(/v4pl_pair/)
  // the draft replaced the text; Undo brings the added tag back
  await toast(page, 'Sent to Build').getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue('v4pl_pair')
})

test('Compare starts from the two images picked in the library; a list becomes a draft', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/library')
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
  await tile(page, 0).click({ modifiers: ['Control'] })
  await tile(page, 2).click({ modifiers: ['Control'] })
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Prompt Lab' }).click()
  await page.getByTestId('pl-mode-compare').click()

  await expect(page.getByTestId('pl-compare-name-a')).toHaveText(`${PREFIX}00.png`)
  await expect(page.getByTestId('pl-compare-name-b')).toHaveText(`${PREFIX}02.png`)
  const common = page.getByTestId('pl-prompt-common')
  await expect(common).toContainText(TOKEN)
  await expect(common).toContainText('(silver hair:1.2)')
  await expect(page.getByTestId('pl-prompt-only-a')).toContainText('frame 0')
  await expect(page.getByTestId('pl-prompt-only-b')).toContainText('frame 2')
  await expect(page.getByTestId('pl-tags-common')).toContainText('v4pl_four')
  await expect(page.getByTestId('pl-tags-only-a')).toContainText('v4pl_pair')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

  // B from the picker: the search finds any image of the library
  await page.getByTestId('pl-compare-pick-b').click()
  const picker = page.getByTestId('pl-picker')
  await picker.getByTestId('pl-picker-search').fill(`${TOKEN} tag:v4pl_common -tag:v4pl_four`)
  await expect(picker.locator('[data-id]')).toHaveCount(2)
  await picker.locator(`[data-id="${ids[4]}"]`).click()
  await expect(picker).toHaveCount(0)
  await expect(page.getByTestId('pl-compare-name-b')).toHaveText(`${PREFIX}04.png`)
  await expect(page.getByTestId('pl-tags-only-a')).toContainText('v4pl_four')

  await page.getByTestId('pl-prompt-common').getByRole('button', { name: 'Send to Build' }).click()
  await expect(page.getByTestId('pl-build-source')).toContainText('A draft from Compare')
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue(new RegExp(`${TOKEN}`))
  await expect(page.getByTestId('pl-build-prompt')).not.toHaveValue(/frame/)
})

test('Build starts from the image being looked at and cleans its prompt, keeping the LoRA', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/library')
  await tile(page, 5).click()
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Prompt Lab' }).click()
  await page.getByTestId('pl-mode-build').click()
  await page.getByTestId('pl-build-use-viewed').click()
  await expect(page.getByTestId('pl-build-source-name')).toHaveText(`${PREFIX}05.png`)
  const prompt = page.getByTestId('pl-build-prompt')
  await expect(prompt).toHaveValue(LORA_PROMPT)
  await expect(page.getByTestId('pl-build-negative')).toHaveValue('lowres')

  await page.getByTestId('pl-build-clean').click()
  await expect(prompt).toHaveValue(`${TOKEN}, 1girl, silver_hair, masterpiece, <lora:my_style_v2:0.8>, smile`)
  await page.getByTestId('pl-build-spaces').click()
  await expect(prompt).toHaveValue(`${TOKEN}, 1girl, silver hair, masterpiece, <lora:my_style_v2:0.8>, smile`)
  await page.getByTestId('pl-build-dropQuality').click()
  await expect(prompt).not.toHaveValue(/masterpiece/)
  await expect(prompt).toHaveValue(/, <lora:my_style_v2:0\.8>$/)
  await toast(page, 'Cleaned: 6 words → 5').getByRole('button', { name: 'Undo' }).click()
  await expect(prompt).toHaveValue(/masterpiece/)

  // the library's tags by group; ticking only some makes them the prompt
  const recipe = page.getByTestId('pl-build-recipe')
  await expect(recipe).toContainText('These are the tags the library gave this image.')
  await expect(recipe).toContainText('v4pl_common')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('"Send to tool" opens a library image in Build, and the mode is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openAt(page, '#/library', 'compare')
  await tile(page, 1).click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Send to tool' }).hover()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Prompt Lab' }).click()
  await expect(page.getByTestId('pl-mode-build')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('pl-build-source-name')).toHaveText(`${PREFIX}01.png`)
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue(`${TOKEN}, 1girl, (silver hair:1.2), smile, frame 1`)

  await page.getByTestId('pl-mode-compare').click()
  await page.reload()
  await expect(page.getByTestId('pl-mode-compare')).toHaveAttribute('aria-selected', 'true')
  // the build text is kept across the reload too
  await page.getByTestId('pl-mode-build').click()
  await expect(page.getByTestId('pl-build-prompt')).toHaveValue(/frame 1/)
})

test('Compare says plainly when a file is missing from disk', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/library')
  await tile(page, 3).click({ modifiers: ['Control'] })
  await tile(page, 6).click({ modifiers: ['Control'] })
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET is_readable = 0 WHERE id = ?", (${ids[6]},))
    conn.commit()
print("ok")
`)
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Prompt Lab' }).click()
  await page.getByTestId('pl-mode-compare').click()
  await expect(page.getByTestId('pl-compare-problem')).toHaveText(
    'One of the files is missing from disk, so the two cannot be compared. Rescan its folder or choose another image.',
  )
  // the file is back for the tests after this one
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET is_readable = 1 WHERE id = ?", (${ids[6]},))
    conn.commit()
print("ok")
`)
})

/** Two tags of one category of the generator's pool (the pool depends on the test database). */
async function poolTags(page: Page, category: string): Promise<[string, string]> {
  const pool = await page.evaluate(async () => (await (await fetch('/api/prompts/categories')).json()).categories as Record<string, string[]>)
  const tags = pool[category] ?? []
  expect(tags.length, `the pool has no ${category} tags`).toBeGreaterThan(1)
  return [tags[0]!, tags[1]!]
}

/** Find a tag in the pool browser and click it into its slot. */
async function pickTag(page: Page, category: string, tag: string) {
  const browser = page.getByTestId('pl-browser')
  await browser.getByTestId('pl-browser-search').fill(tag)
  await browser.locator(`[data-cat="${category}"]`).getByRole('button', { name: tag, exact: true }).click()
  await expect(page.locator(`[data-slot="${category}"]`).locator(`[data-tag="${tag}"]`)).toBeVisible()
  await browser.getByTestId('pl-browser-search').fill('')
}

const resultTexts = (page: Page) => page.getByTestId('pl-result-prompt').allTextContents()

test('Random: the same seed writes the same prompts, a locked slot stays, and every option is sent', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/tools/promptlab', 'random')
  await expect(page.getByTestId('pl-random')).toBeVisible()
  const [pose] = await poolTags(page, 'pose')
  await pickTag(page, 'pose', pose)
  await page.getByTestId('pl-lock-pose').click()
  await expect(page.getByTestId('pl-lock-pose')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('pl-seed').fill('777')
  await page.getByTestId('pl-count').fill('3')
  await page.getByTestId('pl-quality').selectOption('medium')
  const bodies: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().includes('/api/prompts/generate') && bodies.push(r.postDataJSON() as Record<string, unknown>))

  await page.getByTestId('pl-randomize').click()
  await expect(page.getByTestId('pl-result')).toHaveCount(3)
  const first = await resultTexts(page)
  for (const text of first) expect(text).toContain(pose)
  await expect(page.getByTestId('pl-result').first()).toHaveAttribute('data-seed', '777')
  expect(bodies.map((b) => b.seed).sort()).toEqual([777, 778, 779])
  for (const body of bodies) {
    expect(body).toMatchObject({ count: 1, quality_preset: 'medium', include_negative: true, tag_sets: [], count_tag: '' })
    expect((body.categories as Record<string, { tags: string[]; locked: boolean }>).pose).toEqual({ tags: [pose], weight: 0.5, locked: true })
  }
  // the medium quality words and their negative prompt
  await expect(page.getByTestId('pl-result').first()).toContainText('Negative')

  await page.getByTestId('pl-randomize').click()
  await expect.poll(() => resultTexts(page)).toEqual(first)
  expect(bodies).toHaveLength(6)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('Random: a tag set is made, used and deleted; a preset brings the setup back', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/promptlab', 'random')
  const [pose] = await poolTags(page, 'pose')
  await pickTag(page, 'pose', pose)

  // a new tag set (V3.5 could only delete them)
  await page.getByTestId('pl-set-new').click()
  const dialog = page.getByTestId('pl-set-dialog')
  await dialog.getByTestId('pl-set-name').fill('v4pl set')
  await dialog.getByTestId('pl-set-tags').fill('v4pl_setone, v4pl_settwo')
  await dialog.getByTestId('pl-set-create').click()
  await expect(dialog).toHaveCount(0)
  const set = page.getByTestId('pl-sets').locator('[data-set="v4pl set"]')
  await expect(set).toContainText('v4pl_setone, v4pl_settwo')
  await set.getByRole('button', { name: 'Use' }).click()
  await expect(page.getByTestId('pl-sets-in-use')).toContainText('v4pl set')

  const body = page.waitForRequest((r) => r.url().includes('/api/prompts/generate'))
  await page.getByTestId('pl-quality').selectOption('none')
  await page.getByTestId('pl-generate').click()
  expect(((await body).postDataJSON() as { tag_sets: string[] }).tag_sets).toEqual([expect.stringMatching(/^\d+$/)])
  await expect(page.getByTestId('pl-result-prompt')).toContainText('v4pl_setone')
  await expect(page.getByTestId('pl-result-prompt')).toContainText(pose)

  // a preset keeps the slots and the tag set; clearing and loading brings them back
  await page.getByTestId('pl-preset-save').click()
  await page.getByTestId('pl-preset-name').fill('v4pl preset')
  await page.getByTestId('pl-preset-confirm').click()
  const preset = page.getByTestId('pl-presets').locator('[data-preset="v4pl preset"]')
  await expect(preset).toBeVisible()
  await page.getByTestId('pl-clear-slots').click()
  await expect(page.locator('[data-slot="pose"]').locator(`[data-tag="${pose}"]`)).toHaveCount(0)
  await set.getByRole('button', { name: 'Stop using' }).click()
  await expect(page.getByTestId('pl-sets-in-use')).not.toContainText('v4pl set')
  await preset.getByRole('button', { name: 'Load' }).click()
  await expect(page.locator('[data-slot="pose"]').locator(`[data-tag="${pose}"]`)).toBeVisible()
  await expect(page.getByTestId('pl-sets-in-use')).toContainText('v4pl set')

  // delete the set; Undo makes it again
  await set.getByRole('button', { name: 'Delete' }).click()
  await expect(set).toHaveCount(0)
  await expect(page.getByTestId('pl-sets-in-use')).not.toContainText('v4pl set')
  await toast(page, 'Deleted tag set “v4pl set”').getByRole('button', { name: 'Undo' }).click()
  await expect(set).toBeVisible()
  // and the preset
  await preset.getByRole('button', { name: 'Delete' }).click()
  await expect(preset).toHaveCount(0)
})

test('Random: a new exclusion rule explains the clash in its slot, and Check conflicts finds it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/tools/promptlab', 'random')
  const [a, b] = await poolTags(page, 'pose')
  await page.getByTestId('pl-rule-new').click()
  const dialog = page.getByTestId('pl-rule-dialog')
  await dialog.getByTestId('pl-rule-name').fill('v4pl rule')
  await dialog.getByTestId('pl-rule-when').fill(a)
  await dialog.getByTestId('pl-rule-not').fill(b)
  await dialog.getByTestId('pl-rule-create').click()
  await expect(dialog).toHaveCount(0)
  const rule = page.getByTestId('pl-rules').locator('[data-rule="v4pl rule"]')
  await expect(rule).toContainText(`with ${a}, no ${b}`)

  await pickTag(page, 'pose', a)
  await pickTag(page, 'pose', b)
  await expect(page.locator('[data-slot="pose"]').getByTestId('pl-slot-conflict')).toHaveText(`“v4pl rule”: ${b} should not be there with ${a}`)
  await page.getByTestId('pl-check').click()
  await expect(page.getByTestId('pl-check-result')).toContainText(`“v4pl rule”: ${b} should not be there with ${a}`)

  await rule.getByRole('button', { name: 'Delete' }).click()
  await expect(rule).toHaveCount(0)
  await expect(page.locator('[data-slot="pose"]').getByTestId('pl-slot-conflict')).toHaveCount(0)
})

test('Stats "Use in Random" fills a slot; a written prompt finds its images in the library', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/tools/promptlab')
  await rowOf(page, 'pl-top-tags', 'v4pl_pair').getByRole('button', { name: 'Use in Random' }).click()
  await expect(page.getByTestId('pl-mode-random')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-slot="unknown"]').locator('[data-tag="v4pl_pair"]')).toBeVisible()

  // a prompt of words the seeded images have
  await page.locator('[data-slot="unknown"]').getByRole('button', { name: 'Remove v4pl_pair' }).click()
  await pickTag(page, 'character', '1girl')
  await page.getByTestId('pl-quality').selectOption('none')
  await page.getByTestId('pl-prepend').fill(TOKEN)
  await page.getByTestId('pl-generate').click()
  await expect(page.getByTestId('pl-result-prompt')).toHaveText(`${TOKEN}, 1girl`)
  await page.getByTestId('pl-result').getByRole('button', { name: 'Find in library' }).click()
  await expect(page.getByTestId('query-input')).toHaveValue(`prompt:${TOKEN} prompt:1girl`)
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
})

test('tags are suggested in Build, the rules, the tag sets and the fixed words; Esc closes only the list', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubTagSuggest(page)
  await openAt(page, '#/tools/promptlab', 'build')

  // writing a prompt completes only the word under the caret, in the prompt's own tag style
  const prompt = page.getByTestId('pl-build-prompt')
  await prompt.fill('')
  await prompt.pressSequentially('masterpiece, (lon')
  await expectSuggestions(page, ['long hair', 'long sleeves'])
  await prompt.press('Enter')
  await expect(prompt).toHaveValue('masterpiece, (long hair')
  await prompt.pressSequentially(':1.2), hatsu')
  await expectSuggestions(page, ['hatsune miku', 'hatsune miku (append)'])
  await prompt.press('ArrowDown')
  await prompt.press('Enter')
  await expect(prompt).toHaveValue('masterpiece, (long hair:1.2), hatsune miku (append)')
  // Esc closes the list and nothing else
  await prompt.pressSequentially(', wat')
  await expectSuggestions(page, ['watermark', 'water'])
  await page.keyboard.press('Escape')
  await expect(suggestList(page)).toHaveCount(0)
  await expect(page.getByTestId('promptlab-page')).toHaveAttribute('data-mode', 'build')
  await expect(prompt).toHaveValue('masterpiece, (long hair:1.2), hatsune miku (append), wat')
  // a negative prompt written with underscores gets underscores
  const negative = page.getByTestId('pl-build-negative')
  await negative.fill('')
  await negative.pressSequentially('bad_anatomy, blu')
  await expectSuggestions(page, ['blue_sky'])
  await negative.press('Tab')
  await expect(negative).toHaveValue('bad_anatomy, blue_sky')
  await page.getByTestId('pl-build-clear').click()

  // a new exclusion rule: its tag lists suggest; Esc closes the list, then the dialog
  await page.getByTestId('pl-mode-random').click()
  await page.getByTestId('pl-rule-new').click()
  const ruleDialog = page.getByTestId('pl-rule-dialog')
  const when = ruleDialog.getByTestId('pl-rule-when')
  await when.pressSequentially('lon')
  await expectSuggestions(page, ['long hair', 'long sleeves'])
  await when.press('Tab')
  await expect(when).toHaveValue('long hair, ')
  await when.pressSequentially('wat')
  await expectSuggestions(page, ['watermark', 'water'])
  await page.keyboard.press('Escape')
  await expect(suggestList(page)).toHaveCount(0)
  await expect(ruleDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ruleDialog).toHaveCount(0)

  // a new tag set's tags
  await page.getByTestId('pl-set-new').click()
  const setDialog = page.getByTestId('pl-set-dialog')
  const tags = setDialog.getByTestId('pl-set-tags')
  await tags.pressSequentially('smile, blu')
  await expectSuggestions(page, ['blue sky'])
  await tags.press('Enter')
  await expect(tags).toHaveValue('smile, blue sky, ')
  await expect(setDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(setDialog).toHaveCount(0)

  // the words always put first
  const prepend = page.getByTestId('pl-prepend')
  await prepend.fill('')
  await prepend.pressSequentially('hatsu')
  await expectSuggestions(page, ['hatsune miku', 'hatsune miku (append)'])
  await prepend.press('Enter')
  await expect(prepend).toHaveValue('hatsune miku, ')
  await prepend.fill('')
})

for (const viewport of VIEWPORTS) {
  test(`Prompt Lab fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAt(page, '#/tools/promptlab')
    for (const mode of ['stats', 'compare', 'build', 'random'] as const) {
      await page.getByTestId(`pl-mode-${mode}`).click()
      await expect(page.getByTestId(`pl-mode-${mode}`)).toBeInViewport({ ratio: 1 })
      expect(await pageOverflow(page), mode).toBeLessThanOrEqual(0)
    }
    await expect(page.getByTestId('pl-randomize')).toBeInViewport({ ratio: 1 })
    await page.getByTestId('pl-mode-build').click()
    await page.getByTestId('pl-build-pick').click()
    await expect(page.getByTestId('pl-picker-search')).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pl-picker')).toHaveCount(0)
    await expect(page.getByTestId('promptlab-page')).toBeVisible()
  })
}
