import { ApiError } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { collectPicture, collectUrl } from './collectApi'
import { errorKeyFor, errorParams, folderTail, pastedPictureUrl, pictureFromItems } from './collectLogic'
import { useCollect } from './collectState'
import { pokeCollectWatch } from './collectWatch'

// Saving a pasted picture or picture address, and saying plainly where it went
// or why it did not work.

const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

/** Pictures arrive in the library by the program's indexer; these lists are refetched when they do. */
export function refreshLibraryLists(): void {
  for (const key of ['images', 'image-count', 'folders', 'generators', 'libraries', 'library-health', 'collect-source']) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/** The reason a call failed, in the user's language; `fallback` leads when the backend gave no known code. */
export function explain(error: unknown, fallback: MessageKey): string {
  if (error instanceof ApiError) {
    const key = errorKeyFor(error.code)
    if (key) return say(key, errorParams(error.body))
    return error.message ? `${say(fallback)}: ${error.message}` : say(fallback)
  }
  return say(fallback)
}

function savedMessage(result: { filename: string; folder: string; converted_from?: string | null }): string {
  const converted = result.converted_from ? ` ${say('collect.paste.converted', { format: result.converted_from })}` : ''
  return say('collect.paste.saved', { name: result.filename, folder: folderTail(result.folder) }) + converted
}

export async function savePicture(file: File): Promise<boolean> {
  try {
    const result = await collectPicture(file)
    useToasts.getState().push(savedMessage(result))
    pokeCollectWatch()
    return true
  } catch (error) {
    useToasts.getState().push(explain(error, 'collect.paste.failed'), 'error')
    return false
  }
}

/** Download the address the user agreed to. */
export async function saveOfferedUrl(): Promise<void> {
  const url = useCollect.getState().offeredUrl
  useCollect.getState().clearOffer()
  if (!url) return
  useToasts.getState().push(say('collect.url.downloading'))
  try {
    const result = await collectUrl(url)
    useToasts.getState().push(savedMessage(result))
    pokeCollectWatch()
  } catch (error) {
    useToasts.getState().push(explain(error, 'collect.url.failed'), 'error')
  }
}

/** Ctrl+V: a pasted picture is saved now; a pasted address asks first. Returns true when the paste was taken. */
export function takePaste(data: DataTransfer | null): boolean {
  if (!data) return false
  const file = pictureFromItems([...data.items])
  if (file) {
    void savePicture(file)
    return true
  }
  const url = pastedPictureUrl(data.getData('text/plain'))
  if (url) {
    useCollect.getState().offerUrl(url)
    return true
  }
  return false
}

/** The "Paste picture" button: reads the clipboard itself (the browser may ask first). */
export async function pasteFromClipboard(): Promise<void> {
  const toast = (key: MessageKey) => useToasts.getState().push(say(key))
  if (!navigator.clipboard?.read) {
    toast('collect.paste.noApi')
    return
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((kind) => kind.startsWith('image/'))
      if (type) {
        const blob = await item.getType(type)
        await savePicture(new File([blob], `pasted.${type.slice(6)}`, { type }))
        return
      }
    }
    const url = pastedPictureUrl(await navigator.clipboard.readText())
    if (url) {
      useCollect.getState().offerUrl(url)
      return
    }
    toast('collect.paste.empty')
  } catch {
    toast('collect.paste.denied')
  }
}
