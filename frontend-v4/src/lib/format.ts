import type { MessageKey } from '../i18n'

const GENERATOR_NAMES: Record<string, string> = {
  nai: 'NovelAI',
  comfyui: 'ComfyUI',
  webui: 'WebUI',
  forge: 'Forge',
  reforge: 'reForge',
  fooocus: 'Fooocus',
  invokeai: 'InvokeAI',
  swarmui: 'SwarmUI',
  'gpt-image': 'GPT Image',
  gemini: 'Gemini',
  midjourney: 'Midjourney',
}

const GENERATOR_KEYS: Record<string, MessageKey> = {
  unknown: 'gen.unknown',
  others: 'gen.others',
}

/** Display name for a generator id; translated only for the two non-product buckets. */
export function generatorName(id: string | null, t: (k: MessageKey) => string): string {
  if (!id) return t('gen.unknown')
  const key = GENERATOR_KEYS[id]
  if (key) return t(key)
  return GENERATOR_NAMES[id] ?? id
}

/** Short film-edge code for a generator (NAI, CUI, WUI...). */
export function generatorCode(id: string | null): string {
  switch (id) {
    case 'nai':
      return 'NAI'
    case 'comfyui':
      return 'CUI'
    case 'webui':
      return 'A11'
    case 'forge':
      return 'FRG'
    case 'reforge':
      return 'RFG'
    case null:
    case 'unknown':
      return '---'
    default:
      return id.slice(0, 3).toUpperCase()
  }
}

export function fileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** True when a keyboard event started inside something the user types into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}
