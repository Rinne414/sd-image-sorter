// The one output-folder root (GET and PATCH /api/output-folders): every save
// that is not given a folder goes to <root>/<feature>, with _2 added to a name
// already taken. Pure helpers here; the calls are in outputApi.ts.

/** The features that save into the root (the server's own list). */
export const OUTPUT_FEATURES = ['censor', 'publish', 'video-censor', 'workflows', 'collected'] as const
export type OutputFeature = (typeof OUTPUT_FEATURES)[number]

export interface OutputFolders {
  /** The root in force. */
  root: string
  /** The program's own output folder (what an empty setting means). */
  builtin_root: string
  /** What the user chose; '' for the program's folder. */
  custom_root: string
  /** <root>/<feature> for each feature. */
  folders: Partial<Record<OutputFeature, string>>
}

/** The server's answer as OutputFolders; null when it is not one, so a half answer never becomes a default folder. */
export function readOutputFolders(raw: unknown): OutputFolders | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.root !== 'string' || typeof r.builtin_root !== 'string') return null
  const folders: OutputFolders['folders'] = {}
  const given = r.folders && typeof r.folders === 'object' ? (r.folders as Record<string, unknown>) : {}
  for (const feature of OUTPUT_FEATURES) {
    const path = given[feature]
    if (typeof path === 'string' && path) folders[feature] = path
  }
  return { root: r.root, builtin_root: r.builtin_root, custom_root: typeof r.custom_root === 'string' ? r.custom_root : '', folders }
}

/** Where a feature saves when the user picks no folder; null until the server has said. */
export function defaultFolder(outputs: OutputFolders | null | undefined, feature: OutputFeature): string | null {
  return outputs?.folders[feature] ?? null
}

/** The folder a save dialog starts in: what the user chose before, else the feature's default folder, else the newest recent one. */
export function startFolder(chosen: string, outputs: OutputFolders | null | undefined, feature: OutputFeature, recent: readonly string[]): string | null {
  return chosen.trim() || defaultFolder(outputs, feature) || recent[0] || null
}
