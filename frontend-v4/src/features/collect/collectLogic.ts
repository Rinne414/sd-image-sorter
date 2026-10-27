import type { MessageKey } from '../../i18n'

// The pure parts of collecting pictures: what a clipboard holds, how a saved
// folder and a source are named, and which words an error code gets.

/** A picture address is one http(s) word. */
const PICTURE_URL = /^https?:\/\/\S+$/i

/** The address in pasted text, or null when the text is not a web address. */
export function pastedPictureUrl(text: string): string | null {
  const trimmed = text.trim()
  return PICTURE_URL.test(trimmed) ? trimmed : null
}

interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile: () => File | null
}

/** The first picture file among pasted items. */
export function pictureFromItems(items: readonly ClipboardItemLike[]): File | null {
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

/** "collected/2026-10-23": the last two parts of the folder the picture was saved in. */
export function folderTail(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

/** The address when it is a web address (never a javascript: or file: link), else ''. */
export function safeWebUrl(value: unknown): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : ''
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export interface CollectedSource {
  source_url?: string | null
  page_url?: string | null
  page_title?: string | null
  collected_at?: string | null
  via?: string | null
}

export interface SourceLine {
  /** The page's title, or its host, or how it came in. */
  name: string
  /** The address behind the name, for a tooltip. */
  title: string
  pageUrl: string
  imageUrl: string
  when: string
}

/** What the picture card shows for a collected picture; `via` words come from the caller. */
export function sourceLine(source: CollectedSource, viaWords: { paste: string; url: string }, formatWhen: (value: string) => string): SourceLine {
  const pageUrl = safeWebUrl(source.page_url)
  const imageUrl = safeWebUrl(source.source_url)
  const host = hostOf(pageUrl) || hostOf(imageUrl)
  const via = source.via === 'url' ? host || viaWords.url : viaWords.paste
  return {
    name: source.page_title || host || via,
    title: pageUrl || imageUrl,
    pageUrl,
    imageUrl,
    when: source.collected_at ? formatWhen(source.collected_at) : '',
  }
}

export interface PairingLike {
  id: string
  name: string
  browser: string
  origin?: string | null
  paired_at?: string | null
  replaces_existing?: boolean
}

const BROWSER_NAMES: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' }

/** Chrome, Edge or Firefox by name; null for any other browser. */
export function browserName(kind: string): string | null {
  return BROWSER_NAMES[kind] ?? null
}

/** "Chrome on this computer" already names its browser: say it only once. */
export function pairingName(item: PairingLike, otherBrowser: string): string {
  const label = browserName(item.browser) ?? otherBrowser
  return item.name.includes(label) ? item.name : `${item.name} (${label})`
}

/** The extension's own address part: chrome-extension://<id> or moz-extension://<uuid>. */
export function extensionId(item: PairingLike): string {
  return item.origin ? item.origin.replace(/^[a-z-]+:\/\//i, '').replace(/\/$/, '') : ''
}

/** The next waiting request that was not already set aside. */
export function nextRequest(pending: readonly PairingLike[], dismissed: ReadonlySet<string>): PairingLike | null {
  return pending.find((item) => !dismissed.has(item.id)) ?? null
}

const ERROR_KEYS = new Set([
  'collect_url_not_web',
  'collect_site_refused',
  'collect_download_failed',
  'collect_not_picture',
  'collect_too_large_to_convert',
  'collect_convert_failed',
  'collect_empty',
  'collect_no_file',
  'collect_index_failed',
  'ext_own_page_only',
  'ext_request_gone',
  'ext_pairing_not_found',
  'ext_folders_failed',
  'ext_unknown_browser',
  'ext_no_file_manager',
])

/** The text key for a backend error code, or null for a code this page has no words for. */
export function errorKeyFor(code: string | null | undefined): MessageKey | null {
  return code && ERROR_KEYS.has(code) ? (`collect.err.${code}` as MessageKey) : null
}

/** The `params` an error body carries (flat, or inside `detail`). */
export function errorParams(body: unknown): Record<string, string | number> {
  if (!body || typeof body !== 'object') return {}
  const flat = (body as { params?: unknown }).params
  const nested = (body as { detail?: { params?: unknown } }).detail?.params
  const params = flat ?? nested
  if (!params || typeof params !== 'object') return {}
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value
  }
  return out
}
