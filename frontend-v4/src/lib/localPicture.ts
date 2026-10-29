// Pictures that arrive as a file location. QQ and other chat apps copy a
// picture as `<img src="file://L:\...\x.png">` (HTML, or the same tag as plain
// text) and drag it out as a file:// link, so a drop or paste can carry no
// picture file. These read what a drop or paste carries; the locations are
// fetched from disk by api/localPicture.ts. Pure: no DOM, no network.

/** The picture types POST /api/local-picture reads. */
const PICTURE_NAME = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i
/** A dropped file's name that says picture (the upload decides whether it decodes). */
const PICTURE_FILE_NAME = /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i
const LOCAL = /^(?:file:|[A-Za-z]:[\\/]|\\\\[^\\]|\/[^/])/i
const WEB = /^https?:\/\//i
const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' }

/** Why a drop or paste held nothing usable. */
export type MissingReason = 'empty' | 'web-only' | 'not-picture'

/** The text parts of a drop or paste. */
export interface TransferText {
  uriList: string
  html: string
  plain: string
}

export interface FoundLocations {
  /** Picture locations, in order, without repeats. */
  paths: string[]
  /** A local file that is not a picture came along. */
  otherLocal: boolean
  /** A web address came along. */
  web: boolean
}

/** A picture by its MIME type, or by its name when the type is blank (Windows takes types from the registry). */
export const isPictureFile = (file: File): boolean => file.type.startsWith('image/') || PICTURE_FILE_NAME.test(file.name)

const isPictureLocation = (location: string) => PICTURE_NAME.test(location) || PICTURE_NAME.test(location.split(/[?#]/)[0] ?? '')

function unwrap(value: string): string {
  const text = value.trim()
  const quoted = /^(["'<])([\s\S]*)(["'>])$/.exec(text)
  return quoted ? (quoted[2] ?? '').trim() : text
}

const decodeEntities = (value: string) => value.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (e) => ENTITIES[e] ?? e)

/** The src of every <img> in HTML, or in plain text that holds an <img> tag. */
export function imageSources(html: string): string[] {
  return [...html.matchAll(IMG_SRC)].map((m) => decodeEntities(m[1] ?? m[2] ?? m[3] ?? ''))
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** The picture locations a drop or paste names, and whether other things came along. */
export function locationsIn({ uriList, html, plain }: TransferText): FoundLocations {
  const values = [
    ...lines(uriList).filter((line) => !line.startsWith('#')),
    ...imageSources(html),
    ...(/<img\b/i.test(plain) ? imageSources(plain) : lines(plain)),
  ].map(unwrap)
  const found: FoundLocations = { paths: [], otherLocal: false, web: false }
  for (const value of values) {
    if (LOCAL.test(value)) {
      if (!isPictureLocation(value)) found.otherLocal = true
      else if (!found.paths.includes(value)) found.paths.push(value)
    } else if (WEB.test(value)) {
      found.web = true
    }
  }
  return found
}

/** What a drop or paste carries. */
export interface Inspected {
  /** Picture files (the others are left out). */
  files: File[]
  /** Picture locations to read from disk. */
  paths: string[]
  /** Why nothing is usable, when files and paths are both empty. */
  reason: MissingReason
}

export function inspect(files: readonly File[], text: TransferText): Inspected {
  const found = locationsIn(text)
  const reason: MissingReason = files.length || found.otherLocal ? 'not-picture' : found.web ? 'web-only' : 'empty'
  return { files: files.filter(isPictureFile), paths: found.paths, reason }
}

function read(data: DataTransfer, type: string): string {
  try {
    return data.getData(type) || ''
  } catch {
    return ''
  }
}

/** Read a DataTransfer at once (it is emptied once the event handler returns). */
export function inspectTransfer(data: DataTransfer | null): Inspected {
  if (!data) return { files: [], paths: [], reason: 'empty' }
  let files = Array.from(data.files)
  if (!files.length) files = [...data.items].flatMap((i) => (i.kind === 'file' ? [i.getAsFile()] : [])).filter((f): f is File => !!f)
  return inspect(files, { uriList: read(data, 'text/uri-list'), html: read(data, 'text/html'), plain: read(data, 'text/plain') })
}

/** The last name in a location, decoded when it is percent-encoded. */
export function locationName(location: string): string {
  const name = location.split(/[\\/]/).pop() ?? ''
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
