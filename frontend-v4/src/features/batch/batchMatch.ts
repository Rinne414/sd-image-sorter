// Which of a batch's images a library search condition matches. The backend
// cannot limit a search to given ids, so, as V3.5's queue did, the library's
// matches are read in pages (selection-token, then selection-chunk; see
// stepView.ts) and intersected with the batch here.

/** V3.5's page size. */
export const PAGE = 5000

export interface MatchPage {
  image_ids: number[]
  has_more: boolean
  next_offset?: number | null
}

/** Where the pages come from (the server, or a fake in tests). */
export interface MatchPages {
  token: () => Promise<string>
  chunk: (token: string, offset: number, limit: number) => Promise<MatchPage>
}

/** The batch ids among the pages' ids; stops once every batch id is found. */
export async function intersectPages(pages: MatchPages, batchIds: readonly number[]): Promise<ReadonlySet<number>> {
  const wanted = new Set(batchIds)
  const found = new Set<number>()
  if (wanted.size === 0) return found
  const token = await pages.token()
  let offset = 0
  for (;;) {
    const page = await pages.chunk(token, offset, PAGE)
    for (const id of page.image_ids) if (wanted.has(id)) found.add(id)
    const next = page.next_offset ?? null
    if (!page.has_more || found.size === wanted.size || next === null || next <= offset) return found
    offset = next
  }
}
