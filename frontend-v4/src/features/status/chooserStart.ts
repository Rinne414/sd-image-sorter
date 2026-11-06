/** The folder the chooser opens in: the backend's suggestion, else the first place the files used to be. */
export function chooserStart(summary: { suggested_search_folder?: string } | undefined, formerHomes: string[]): string | null {
  return summary?.suggested_search_folder || formerHomes[0] || null
}
