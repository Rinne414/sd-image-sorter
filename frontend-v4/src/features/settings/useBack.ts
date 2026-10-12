import { useT, type MessageKey } from '../../i18n'
import type { MainPage } from '../../lib/route'
import { useApp } from '../../state/store'

const NAME: Record<MainPage, MessageKey> = {
  home: 'nav.home',
  library: 'nav.library',
  batch: 'nav.batch',
  sort: 'nav.sort',
}

/** "← Back to <page>" for the settings and tools pages, and what it does. */
export function useBack(): { label: string; go: () => void } {
  const t = useT()
  const page = useApp((s) => s.back.page)
  const goBack = useApp((s) => s.goBack)
  return { label: t('settings.back', { page: t(NAME[page]) }), go: goBack }
}
