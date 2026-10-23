import type { MessageKey } from '../../i18n'

/** The backend seeds the default library under this English name. */
export const SEEDED_DEFAULT_NAME = 'Main library'

interface NamedLibrary {
  name?: string | null
  is_default?: boolean | null
}

/**
 * A library's name for the UI. Until the user renames it, the seeded default
 * library is shown in the UI language (主图库), as the classic page does
 * (library-workspace.js libraryDisplayName); a chosen name is kept.
 */
export function libraryName(lib: NamedLibrary | null | undefined, t: (key: MessageKey) => string): string {
  const name = lib?.name ?? ''
  return lib?.is_default && name === SEEDED_DEFAULT_NAME ? t('rail.mainLibrary') : name
}
