// File names for what the queue hands out: a single download, a copy dragged
// out, and each entry of the ZIP.

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g

/** A name Windows accepts: no path separators or reserved characters, no trailing dots or spaces. */
export function safeName(name: string): string {
  const cleaned = name.replace(UNSAFE, '_').replace(/[. ]+$/, '').trim()
  return cleaned || 'image'
}

/** The file's name without its extension. */
export const stemOf = (fileName: string): string => fileName.replace(/\.[^./\\]+$/, '') || fileName

/** The name a result is handed out under: the user's rename, else the original's stem, with this extension. */
export function resultName(fileName: string, rename: string | null, extension: '.png' | '.jpg'): string {
  const base = rename?.trim() || stemOf(fileName)
  return `${safeName(base)}${extension}`
}

/** Names for a ZIP: a repeated one becomes "name (2).png", "name (3).png", … (Windows ignores case). */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const stem = stemOf(name)
    const extension = name.slice(stem.length)
    let candidate = name
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${extension}`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

const two = (n: number) => String(n).padStart(2, '0')

/** "privacy-20260926-134530.zip" */
export function zipName(when: Date): string {
  const day = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`
  return `privacy-${day}-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}.zip`
}
