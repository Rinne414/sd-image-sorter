import { create } from 'zustand'
import { usePrivacy } from '../privacyStore'
import { useToasts } from '../../../../ui/toasts'
import { clearDefaultCover, defaultCoverInfo, saveDefaultCover } from './disguiseApi'
import { DEFAULT_DISGUISE, readDisguise, type DisguiseSettings, type PackFormat } from './disguiseModel'
import { dt, errorText } from './disguiseText'

// The disguise's settings (remembered), the cover picture chosen for this
// visit, whether a default cover is saved, and the one packed file a pack run
// makes. The queue itself lives in privacyStore.

const KEY = 'sd-v4-privacy-disguise'

/** The packed file a "pack all pictures" run made. */
export interface PackResult {
  token: string
  fileName: string
  outputPath: string
  width: number
  height: number
  bytes: number
  frames: number
  coverUrl: string
  format: PackFormat
  blob: Blob
  /** Object URL of `blob`, for the download. */
  url: string
}

interface DisguiseState {
  settings: DisguiseSettings
  /** The cover picture chosen for "A picture I choose"; not remembered across visits. */
  uploadCover: { file: File; url: string } | null
  /** null until asked. */
  defaultCover: { exists: boolean; version: number } | null
  pack: PackResult | null
}

function load(): DisguiseSettings {
  try {
    return readDisguise(localStorage.getItem(KEY))
  } catch {
    return { ...DEFAULT_DISGUISE }
  }
}

export const useDisguise = create<DisguiseState>(() => ({ settings: load(), uploadCover: null, defaultCover: null, pack: null }))

export function setDisguise(patch: Partial<DisguiseSettings>): void {
  const settings = { ...useDisguise.getState().settings, ...patch }
  useDisguise.setState({ settings })
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // storage blocked: the choice lasts until reload
  }
}


export function setUploadCover(file: File | null): void {
  const old = useDisguise.getState().uploadCover
  if (old) URL.revokeObjectURL(old.url)
  useDisguise.setState({ uploadCover: file ? { file, url: URL.createObjectURL(file) } : null })
}

export function setPack(pack: PackResult | null): void {
  const old = useDisguise.getState().pack
  if (old) URL.revokeObjectURL(old.url)
  useDisguise.setState({ pack })
}

export const clearPack = (): void => setPack(null)

// An emptied queue takes the packed file's card with it.
usePrivacy.subscribe((state) => {
  if (state.items.length === 0 && useDisguise.getState().pack) clearPack()
})

/** Ask the program whether a default cover is saved. */
export async function refreshDefaultCover(): Promise<boolean> {
  try {
    useDisguise.setState({ defaultCover: await defaultCoverInfo() })
  } catch {
    useDisguise.setState({ defaultCover: { exists: false, version: 0 } })
  }
  return useDisguise.getState().defaultCover?.exists === true
}

export async function setDefaultCover(file: Blob): Promise<boolean> {
  try {
    await saveDefaultCover(file)
  } catch (error) {
    useToasts.getState().push(dt('disguise.cover.defaultFailed', { reason: errorText(error) }), 'error')
    return false
  }
  useToasts.getState().push(dt('disguise.cover.defaultSaved'))
  return refreshDefaultCover()
}

export async function removeDefaultCover(): Promise<void> {
  try {
    await clearDefaultCover()
  } catch (error) {
    useToasts.getState().push(dt('disguise.cover.defaultFailed', { reason: errorText(error) }), 'error')
    return
  }
  await refreshDefaultCover()
  useToasts.getState().push(dt('disguise.cover.defaultRemoved'))
}

/** Open the file picker for an image; resolves to null when it is closed without a pick. */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** Choose the default cover from disk; true when one is saved afterwards. */
export async function chooseDefaultCover(): Promise<boolean> {
  const file = await pickImage()
  return file ? setDefaultCover(file) : false
}
