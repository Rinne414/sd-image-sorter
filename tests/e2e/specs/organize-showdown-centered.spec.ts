import { expect, test, type Page } from '@playwright/test'

/**
 * The A/B Showdown screen sat against the left edge of Organize: at 1366 px its
 * two images and buttons filled the left 844 px and left ~440 px empty on the
 * right, under tabs and a hint that are centred. It now sits centred, like its
 * sibling Keep / Reject screen.
 */

// A real-size picture: the screen's width comes from the image frames, not the file.
const IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1280"><rect width="1024" height="1280" fill="#789"/></svg>'

function showdownImage(id: number) {
  return { id, filename: `showdown-${id}.png`, path: `/mock/showdown-${id}.png`, width: 1024, height: 1280 }
}

async function openShowdown(page: Page, width: number, height: number) {
  let started = false
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMAGE_SVG })
  })
  await page.route('**/api/sort/current**', async (route) => {
    await route.fulfill({ json: started
      ? {
        mode: 'bracket',
        done: false,
        total: 5,
        champion_index: 0,
        challenger_index: 1,
        champion: { image: showdownImage(701) },
        challenger: { image: showdownImage(702) },
        undo_available: false,
        redo_available: false,
      }
      : { done: true, mode: null } })
  })
  await page.route('**/api/sort/start**', async (route) => {
    started = true
    await route.fulfill({ json: { total_images: 5, mode: 'bracket' } })
  })
  await page.setViewportSize({ width, height })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('manual_sort_mode_v1', 'bracket')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid')).toBeAttached()
  await page.evaluate(() => {
    ;(window as any).switchView('sorting')
    ;(window as any)._switchSortingSub('manual')
  })
  await expect(page.locator('#sort-setup')).toBeVisible()
  await page.evaluate(() => (document.getElementById('btn-start-sorting') as HTMLButtonElement).click())
  await expect(page.locator('#bracket-progress-text')).toHaveText('0 / 4')
}

for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
  test(`the A/B Showdown sits centred under the Organize tabs at ${width}x${height}`, async ({ page }) => {
    await openShowdown(page, width, height)

    const geometry = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect()
      const centre = (rect: DOMRect) => rect.left + rect.width / 2
      const screen = box(document.getElementById('sort-bracket-interface')!)
      const tabs = box(document.querySelector('.sorting-sub-tabs')!)
      const champion = box(document.getElementById('bracket-champion')!)
      const challenger = box(document.getElementById('bracket-challenger')!)
      return {
        screenCentre: Math.round(centre(screen)),
        tabsCentre: Math.round(centre(tabs)),
        // The two pictures, taken together, are centred too (not just an empty box).
        pairCentre: Math.round((champion.left + challenger.right) / 2),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    const detail = JSON.stringify(geometry)
    expect(Math.abs(geometry.screenCentre - geometry.tabsCentre), detail).toBeLessThanOrEqual(2)
    expect(Math.abs(geometry.pairCentre - geometry.tabsCentre), detail).toBeLessThanOrEqual(2)
    expect(geometry.overflowX, detail).toBeLessThanOrEqual(0)
  })
}
