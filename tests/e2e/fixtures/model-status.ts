import type { Page } from '@playwright/test'

/**
 * Report the given model cards as installed, on top of the real status.
 *
 * Starting a tagger first checks that its model is on disk and otherwise
 * downloads it. Specs that exercise the start / progress UI stub the tagging
 * endpoints, so the real test server must not go off and download weights.
 * `extraVariants` covers the stand-in tagger names some specs mock.
 */
export async function markModelsReady(
  page: Page,
  modelIds: string[] = ['wd14'],
  { extraVariants = [] }: { extraVariants?: string[] } = {},
): Promise<void> {
  await page.route('**/api/models/status', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    for (const card of body?.models ?? []) {
      if (!modelIds.includes(card?.id)) continue
      const variants: string[] = Array.isArray(card.variants) ? card.variants : []
      const installed: string[] = Array.isArray(card.installed_variants) ? card.installed_variants : []
      card.status = 'ready'
      card.available = true
      card.installed_variants = Array.from(new Set([...installed, ...variants, ...extraVariants]))
    }
    await route.fulfill({ response, json: body })
  })
}
