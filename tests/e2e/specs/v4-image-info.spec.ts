import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { cleanupImages, dbPath, openLibrary, pageOverflow, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 image information: everything the generation card and the big image say
 * about one image — img2img, Civitai resources, ComfyUI prompt nodes, the
 * model hash, a click on the model or a LoRA filtering the library, the
 * "no parameters" note, colours with a histogram, aesthetic scoring as a job,
 * the sort notice, and wheel zoom past the original size.
 *
 * The aesthetic model never runs: its status, download and scoring endpoints
 * are stubbed (the scoring stub writes the score into the test database, so the
 * card and the tiles read it back from the real backend). Colour analysis of
 * one image runs for real on the seeded file.
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4infotoken'
const PREFIX = 'v4info-'
const COUNT = 4
const DIR = 'v4-info'
const name = (i: number) => `${PREFIX}0${i}.png`

const COMFY_META = {
  _parsed: {
    generation_params: {
      steps: 24,
      sampler: 'euler',
      seed: 7,
      cfg_scale: 6,
      denoising_strength: 0.45,
      lora_details: [{ name: 'loras\\v4info_lora_one.safetensors', strength_model: 0.8, strength_clip: 0.8 }],
    },
    is_img2img: true,
    img2img_info: { denoising_strength: 0.45, source: 'inpaint' },
    civitai_resources: [
      { model_name: 'V4Info Detail', version_name: 'v2', weight: 0.7, air: 'urn:air:sdxl:lora:civitai:111@222', civitai_url: 'https://civitai.red/models/111?modelVersionId=222' },
    ],
    prompt_nodes: [
      { node_id: '12', class_type: 'CLIPTextEncode', text: 'v4info node positive text', role: 'positive' },
      { node_id: '13', class_type: 'CLIPTextEncode', text: 'v4info node negative text', role: 'negative' },
    ],
    model_assets: { primary_model_name: 'v4info_model_alpha.safetensors', vae_candidates: [{ name: 'v4info_vae.safetensors' }] },
  },
}

/** Rows 00-03 each carry what one part of the card shows; 03 is a large picture for zooming. */
test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  runBackendScript(`
import json, sqlite3
from pathlib import Path
from PIL import Image
root = Path(${JSON.stringify(tmpRoot)}) / ${JSON.stringify(DIR)}
big = root / ${JSON.stringify(name(3))}
img = Image.new("RGB", (1600, 1000))
img.putdata([(x * 255 // 1600, 90, 255 - y * 255 // 1000) for y in range(1000) for x in range(1600)])
img.save(big)
st = big.stat()
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    by = lambda n: conn.execute("SELECT id FROM images WHERE filename = ?", (n,)).fetchone()[0]
    a = by(${JSON.stringify(name(0))})
    conn.execute(
        "UPDATE images SET generator='comfyui', checkpoint='v4info_model_alpha.safetensors', checkpoint_normalized='v4info_model_alpha', "
        "loras=?, metadata_json=? WHERE id=?",
        (json.dumps(["v4info_lora_one"]), ${JSON.stringify(JSON.stringify(COMFY_META))}, a),
    )
    conn.execute("DELETE FROM image_loras WHERE image_id=?", (a,))
    conn.execute("INSERT INTO image_loras (image_id, lora_name) VALUES (?, 'v4info_lora_one')", (a,))
    conn.execute(
        "UPDATE images SET generator='webui', checkpoint='v4info_model_beta', checkpoint_normalized='v4info_model_beta', model_hash='abc123def0' WHERE id=?",
        (by(${JSON.stringify(name(1))}),),
    )
    conn.execute("UPDATE images SET generator='gemini', prompt=NULL, negative_prompt=NULL, metadata_json=NULL WHERE id=?", (by(${JSON.stringify(name(2))}),))
    conn.execute(
        "UPDATE images SET width=1600, height=1000, file_size=?, source_size=?, source_mtime_ns=?, aesthetic_score=6.5, "
        "dominant_colors=?, avg_brightness=127.5, color_saturation=51, color_temperature='warm', brightness_distribution='left_heavy' WHERE id=?",
        (st.st_size, st.st_size, st.st_mtime_ns, json.dumps([{"hex": "#2A1F1B", "pct": 41.5}, {"hex": "#E8D2C0", "pct": 20}]), by(${JSON.stringify(name(3))})),
    )
    conn.commit()
print("ok")
`)
})
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const json = (route: Route, body: unknown) => route.fulfill({ json: body })

/** Clear the aesthetic scores of these rows (the tests score them again). */
function unscore(rows: number[]): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    for n in ${JSON.stringify(rows.map(name))}:
        conn.execute("UPDATE images SET aesthetic_score=NULL WHERE filename=?", (n,))
    conn.commit()
print("ok")
`)
}

interface AestheticStub {
  scored: number[]
  prepared: unknown[]
  libraryRuns: number
}

/**
 * The model (missing until a download is asked for, when `missing`), the
 * download, and scoring: one image writes 6.42 into the test database; the
 * whole-library run reports three images and finishes on its second poll.
 */
async function stubAesthetic(page: Page, missing = false): Promise<AestheticStub> {
  const stub: AestheticStub = { scored: [], prepared: [], libraryRuns: 0 }
  let downloadPolls = 0
  let libraryPolls = 0
  await page.route('**/api/models/status', (r) => {
    const ready = !missing || stub.prepared.length > 0
    return json(r, { models: [{ id: 'aesthetic', status: ready ? 'ready' : 'missing', available: ready }] })
  })
  await page.route('**/api/models/prepare', (r) => {
    stub.prepared.push(r.request().postDataJSON())
    return json(r, { status: 'started', model_id: 'aesthetic' })
  })
  await page.route('**/api/models/download-progress', (r) => {
    downloadPolls += 1
    return json(r, downloadPolls < 2 ? { active: true, downloaded: 40, total: 100, filename: 'sa_0_4_vit_l_14_linear.pth' } : { active: false, prepare_result: { model_id: 'aesthetic', status: 'ready', active: false } })
  })
  await page.route(/\/api\/aesthetic\/score\/\d+$/, (r) => {
    const id = Number(r.request().url().split('/').pop())
    stub.scored.push(id)
    runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("UPDATE images SET aesthetic_score=6.42 WHERE id=?", (${id},))
    conn.commit()
print("ok")
`)
    return json(r, { image_id: id, aesthetic_score: 6.42 })
  })
  await page.route('**/api/aesthetic/score-all?**', (r) => {
    stub.libraryRuns += 1
    libraryPolls = 0
    return json(r, { status: 'started', total: 3 })
  })
  await page.route('**/api/aesthetic/progress', (r) => {
    libraryPolls += 1
    return json(r, libraryPolls < 2 ? { running: true, total: 3, completed: 1, errors: 0, current: 'a.png', error: null } : { running: false, total: 3, completed: 3, errors: 0, current: '', error: null })
  })
  return stub
}

const tile = (page: Page, i: number) => page.getByTestId('tile').and(page.locator(`[title="${name(i)}"]`))
const card = (page: Page) => page.getByTestId('generation-card')
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

async function inspect(page: Page, i: number) {
  await tile(page, i).click()
  await expect(card(page)).toContainText(name(i))
}

test('the card shows img2img, Civitai, prompt nodes, other models, the hash and the no-parameters note', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubAesthetic(page)
  await openLibrary(page, TOKEN, COUNT)
  await inspect(page, 0)
  const c = card(page)

  const facts = c.getByTestId('card-facts')
  await expect(facts.getByTestId('card-model-filter')).toHaveText('v4info_model_alpha')
  await expect(facts.getByTestId('card-lora-filter')).toHaveText('v4info_lora_one')
  await expect(facts).toContainText('0.8')
  await expect(c.getByTestId('card-img2img')).toContainText('Inpaint')
  await expect(c.getByTestId('card-img2img')).toContainText('denoise 0.45')
  await expect(c.getByTestId('card-aesthetic')).toContainText('Not scored')
  // the img2img marker is printed on the film edge too
  await expect(c.locator('figure')).toContainText('INPAINT')

  const civitai = c.getByTestId('card-civitai')
  await expect(civitai).toContainText('V4Info Detail')
  await expect(civitai).toContainText('weight 0.7')
  const link = civitai.getByRole('link', { name: 'Open on Civitai' })
  await expect(link).toHaveAttribute('href', 'https://civitai.red/models/111?modelVersionId=222')
  await expect(link).toHaveAttribute('target', '_blank')

  await c.getByTestId('card-nodes').locator('summary').click()
  await expect(c.getByTestId('card-nodes')).toContainText('Node 12')
  await expect(c.getByTestId('card-nodes')).toContainText('v4info node negative text')
  await c.getByTestId('card-other-models').locator('summary').click()
  await expect(c.getByTestId('card-other-models')).toContainText('v4info_vae.safetensors')

  // the negative prompt on its own, and the shared Copy list with tags by category
  await c.getByTestId('card-copy-negative').click()
  await expect.poll(() => clipboard(page)).toBe('lowres')
  await c.getByTestId('card-copy-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Copy negative prompt' })).toBeVisible()
  await expect(page.getByRole('menu')).toContainText('Copy tags by category')
  await page.getByRole('menuitem', { name: 'Copy prompt' }).click()
  await expect.poll(() => clipboard(page)).toBe(`${TOKEN}, 1girl, (silver hair:1.2), smile, frame 0`)

  await inspect(page, 1)
  await expect(c.getByTestId('card-facts')).toContainText('ABC123DEF0')

  await inspect(page, 2)
  await expect(c.getByTestId('card-no-params')).toContainText('Gemini does not embed generation parameters')
})

test('a click on the model or a LoRA filters the library, from the card and from the big image', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubAesthetic(page)
  await openLibrary(page, TOKEN, COUNT)
  const input = page.getByTestId('query-input')
  const count = page.getByTestId('result-count')

  await inspect(page, 0)
  await card(page).getByTestId('card-model-filter').click()
  await expect(input).toHaveValue(`${TOKEN} checkpoint:v4info_model_alpha`)
  await expect(count).toHaveText('1 image')
  await expect(page.getByTestId('tile')).toHaveAttribute('title', name(0))

  await card(page).getByTestId('card-lora-filter').click()
  await expect(input).toHaveValue(`${TOKEN} checkpoint:v4info_model_alpha lora:v4info_lora_one`)
  await expect(count).toHaveText('1 image')

  // from the big image: it closes and the library shows the result
  await input.fill(TOKEN)
  await input.press('Enter')
  await expect(count).toHaveText(`${COUNT} images`)
  await tile(page, 1).dblclick()
  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await lightbox.getByTestId('card-model-filter').click()
  await expect(lightbox).toHaveCount(0)
  await expect(input).toHaveValue(`${TOKEN} checkpoint:v4info_model_beta`)
  await expect(count).toHaveText('1 image')
  await expect(page.getByTestId('tile')).toHaveAttribute('title', name(1))
})

test('right-click › Filter by this model filters the library by that image\'s checkpoint (V3.5 #112)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubAesthetic(page)
  await openLibrary(page, TOKEN, COUNT)
  const input = page.getByTestId('query-input')

  // an image with no model has no such entry
  await tile(page, 2).click({ button: 'right' })
  const menu = page.getByTestId('card-menu')
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Filter by this model' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await tile(page, 0).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Filter by this model' }).click()
  await expect(menu).toHaveCount(0)
  await expect(input).toHaveValue(`${TOKEN} checkpoint:v4info_model_alpha`)
  await expect(page.getByTestId('result-count')).toHaveText('1 image')
  await expect(page.getByTestId('tile')).toHaveAttribute('title', name(0))
})

test('colours: histogram views and main colours; an unanalysed image is analysed on the spot', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubAesthetic(page)
  await openLibrary(page, TOKEN, COUNT)
  await inspect(page, 3)
  const colors = card(page).getByTestId('card-colors')
  await colors.locator('summary').click()
  const histogram = colors.getByTestId('card-histogram')
  await expect(histogram).toHaveAttribute('data-mode', 'rgb')
  await expect(histogram.locator('path')).toHaveCount(4)
  await colors.getByRole('button', { name: 'Luma' }).click()
  await expect(histogram).toHaveAttribute('data-mode', 'luma')
  await colors.getByRole('button', { name: 'Split' }).click()
  await expect(histogram.locator('path')).toHaveCount(3)
  await expect(colors.getByTestId('card-swatches')).toContainText('#2A1F1B')
  await expect(colors).toContainText('Brightness 50%')
  await expect(colors).toContainText('Warm')
  await colors.getByRole('button', { name: /#E8D2C0/ }).click()
  await expect.poll(() => clipboard(page)).toBe('#E8D2C0')

  // the section stays open on the next image, which has no analysis yet
  await inspect(page, 0)
  await expect(colors.getByTestId('card-colors-missing')).toContainText('No colour analysis yet')
  await colors.getByTestId('card-colors-analyse').click()
  await expect(colors.getByTestId('card-swatches')).toBeVisible()
  await expect(colors.getByTestId('card-colors-missing')).toHaveCount(0)
})

test('aesthetic scoring: one image (downloading the model first), the sort notice, the picks, the whole library', async ({ page }) => {
  unscore([0, 1, 2])
  await page.setViewportSize({ width: 1920, height: 1080 })
  const stub = await stubAesthetic(page, true)
  // the library status reads the unscored count from the health report
  await page.route('**/api/library-health', (r) =>
    json(r, { summary: { total_images: 10, readable_images: 10, tagged_percent: 100, actionable_count: 0 }, issue_counts: { missing_aesthetic: 5 } }),
  )
  await openLibrary(page, TOKEN, COUNT)
  const drawerJobs = page.getByTestId('jobs-drawer').getByTestId('job')

  // one image from its card: the model downloads as a job first, then the score arrives
  await inspect(page, 0)
  await card(page).getByTestId('card-score').click()
  await expect.poll(() => stub.prepared).toEqual([{ model_id: 'aesthetic', variant: null }])
  await expect(card(page).getByTestId('card-aesthetic')).toHaveText('6.42 / 10')
  await expect(card(page).locator('figure')).toContainText('AES 6.42')
  await tile(page, 0).hover()
  await expect(tile(page, 0).getByTestId('tile-aesthetic')).toHaveText('AES 6.42')
  expect(stub.scored).toHaveLength(1)

  // sorted by score, the unscored ones are counted and offered
  await page.getByRole('button', { name: /^Sort\s*[:：]/ }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Aesthetic score' }).click()
  const notice = page.getByTestId('sort-notice-aesthetic')
  await expect(notice).toContainText('No aesthetic score yet for 2 of these images')
  await notice.getByRole('button', { name: 'Score the 2' }).click()
  await expect(notice).toHaveCount(0)
  expect(stub.scored).toHaveLength(3)

  // the picks, from the selection bar
  unscore([1, 2])
  await page.reload()
  await expect(page.locator('[data-testid="gallery-scroller"]:not([aria-busy])')).toBeVisible()
  await tile(page, 1).click({ modifiers: ['Control'] })
  await tile(page, 2).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Score aesthetics' }).click()
  await expect.poll(() => stub.scored.length).toBe(5)
  await page.getByTestId('jobs-button').click()
  await expect(drawerJobs.first()).toContainText('Aesthetic scores done: 2 images')
  await page.keyboard.press('Escape')

  // the whole library, from the library status
  await page.getByTestId('library-status').getByRole('button', { name: 'Score', exact: true }).click()
  await expect(page.getByText('Aesthetic scores done: 3 images').first()).toBeVisible()
  expect(stub.libraryRuns).toBe(1)
})

test('big image: the wheel zooms past the original size, a drag pans, Z fits, a click shows the original size', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubAesthetic(page)
  await openLibrary(page, TOKEN, COUNT)
  await tile(page, 3).dblclick()
  const lightbox = page.getByTestId('lightbox')
  const readout = lightbox.getByTestId('lightbox-zoom')
  const image = lightbox.getByTestId('lightbox-image')
  await expect(readout).toHaveText(/^\d+%$/)
  const fitted = parseInt((await readout.textContent()) ?? '0', 10)
  expect(fitted).toBeLessThan(100)

  const box = (await image.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -240)
  await expect.poll(async () => parseInt((await readout.textContent()) ?? '0', 10)).toBeGreaterThan(100)
  const zoomedStyle = await image.getAttribute('style')
  expect(zoomedStyle).toMatch(/scale\(/)

  // drag to pan
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  expect(await image.getAttribute('style')).not.toBe(zoomedStyle)
  await expect(readout).not.toHaveText(`${fitted}%`)

  await page.keyboard.press('z')
  await expect(readout).toHaveText(`${fitted}%`)
  expect((await image.getAttribute('style')) ?? '').not.toMatch(/scale/)

  await image.click()
  await expect(readout).toHaveText('100%')
  await expect(lightbox.getByTestId('lightbox-zoom-toggle')).toHaveAttribute('aria-pressed', 'true')
})

for (const viewport of VIEWPORTS) {
  test(`card sections and zoom controls fit at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await stubAesthetic(page)
    await openLibrary(page, TOKEN, COUNT)
    await inspect(page, 0)
    const c = card(page)
    await c.getByTestId('card-colors').locator('summary').click()
    await c.getByTestId('card-nodes').locator('summary').click()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    const cardOverflow = await c.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(cardOverflow).toBeLessThanOrEqual(0)
    await c.getByTestId('card-copy-menu').scrollIntoViewIfNeeded()
    await c.getByTestId('card-copy-menu').click()
    await expect(page.getByRole('menuitem', { name: 'Copy prompt' })).toBeInViewport()
    await page.keyboard.press('Escape')

    await tile(page, 3).dblclick()
    const lightbox = page.getByTestId('lightbox')
    await expect(lightbox.getByTestId('lightbox-zoom')).toBeInViewport()
    await expect(lightbox.getByTestId('lightbox-zoom-toggle')).toBeInViewport()
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    await page.keyboard.press('Escape')
  })
}
