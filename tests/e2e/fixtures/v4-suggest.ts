import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Tag suggestions for V4 specs, stubbed so the lists are the same on every
 * run: GET /api/tags/suggest (the danbooru vocabulary, answered in its
 * underscore spelling like the real endpoint) and GET /api/tags/library
 * (the library's own tags, as stored). Both only read.
 */

interface Entry {
  tag: string
  count: number
  category: string
  zh: string | null
  copyright: string | null
}

const VOCABULARY: Entry[] = [
  { tag: 'hatsune_miku', count: 98000, category: 'character', zh: '初音未来', copyright: 'vocaloid' },
  { tag: 'hatsune_miku_(append)', count: 1200, category: 'character', zh: null, copyright: 'vocaloid' },
  { tag: 'long_hair', count: 4200000, category: 'hair', zh: '长发', copyright: null },
  { tag: 'long_sleeves', count: 2100000, category: 'outfit', zh: '长袖', copyright: null },
  { tag: 'looking_at_viewer', count: 3900000, category: 'pose', zh: null, copyright: null },
  { tag: 'watermark', count: 390000, category: 'meta', zh: '水印', copyright: null },
  { tag: 'water', count: 310000, category: 'background', zh: '水', copyright: null },
  { tag: 'blue_sky', count: 280000, category: 'background', zh: '蓝天', copyright: null },
]

/** The library's tags for the "library" suggestions (remove, find). */
export const LIBRARY_TAGS = [
  { tag: 'v4 stored tag', count: 3 },
  { tag: 'v4 stored_under', count: 1 },
]

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '_')

export async function stubTagSuggest(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/api/tags/suggest', (route) => {
    const q = key(new URL(route.request().url()).searchParams.get('q') ?? '')
    const suggestions = q ? VOCABULARY.filter((e) => e.tag.startsWith(q)).map((e) => ({ ...e, source: 'danbooru' })) : []
    return route.fulfill({ json: { suggestions, danbooru_loaded: true, zh_loaded: true } })
  })
  await page.route((url) => url.pathname === '/api/tags/library', (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase()
    return route.fulfill({ json: { tags: LIBRARY_TAGS.filter((t) => t.tag.startsWith(q)), total: LIBRARY_TAGS.length, sort: 'frequency' } })
  })
}

/** The floating list of suggestions (one at a time on the page). */
export const suggestList = (page: Page): Locator => page.getByTestId('tag-suggest')

/** The list shows these rows, in this order (each row starts with its tag). */
export async function expectSuggestions(page: Page, tags: string[]): Promise<void> {
  const list = suggestList(page)
  await expect(list).toBeVisible()
  await expect(list.getByRole('option')).toHaveCount(tags.length)
  for (const [i, tag] of tags.entries()) await expect(list.getByRole('option').nth(i)).toContainText(tag)
  await expect(list).toBeInViewport({ ratio: 1 })
}

/** The highlighted row. */
export const activeSuggestion = (page: Page): Locator => suggestList(page).locator('[aria-selected="true"]')
