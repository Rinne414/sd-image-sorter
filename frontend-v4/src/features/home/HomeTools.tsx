import { useT, type MessageKey } from '../../i18n'
import { useApp } from '../../state/store'
import { useSimilarDialogs } from '../similar/dialogs'
import { pickImageFile } from '../similar/imageSearch'
import styles from './HomeTools.module.css'

interface ToolCard {
  testId: string
  title: MessageKey
  body: MessageKey
  go: () => void
}

const app = () => useApp.getState()

// The first screen's tool cards (classic's Reader, Privacy, Similar, Models and
// the full list of features). Each opens what the Tools menu, the library and
// Ctrl K already open; this is one more way in.
const CARDS: readonly ToolCard[] = [
  { testId: 'home-tool-reader', title: 'tools.reader', body: 'partialsa.home.reader.body', go: () => app().openTool('reader') },
  { testId: 'home-tool-privacy', title: 'tools.privacy', body: 'partialsa.home.privacy.body', go: () => app().openTool('privacy') },
  {
    testId: 'home-tool-similar',
    title: 'partialsa.home.similar.title',
    body: 'partialsa.home.similar.body',
    // Results show over the library: go there first, then ask for the picture.
    go: () => {
      app().setPage('library')
      pickImageFile()
    },
  },
  { testId: 'home-tool-duplicates', title: 'partialsa.home.dups.title', body: 'partialsa.home.dups.body', go: () => useSimilarDialogs.getState().setDuplicates(true) },
  { testId: 'home-tool-models', title: 'settings.tab.models', body: 'partialsa.home.models.body', go: () => app().openSettings('models') },
  { testId: 'home-tool-all', title: 'partialsa.home.all.title', body: 'partialsa.home.all.body', go: () => app().setPaletteOpen(true) },
]

/** A row of cards under Home's two columns: the tools and pages that are not a way to start. */
export function HomeTools() {
  const t = useT()
  return (
    <section className={styles.tools} aria-label={t('partialsa.home.tools')} data-testid="home-tools">
      <h2 className={styles.heading}>{t('partialsa.home.tools')}</h2>
      <div className={styles.grid}>
        {CARDS.map((c) => (
          <button key={c.testId} type="button" className={styles.card} onClick={c.go} data-testid={c.testId}>
            <span className={styles.title}>{t(c.title)}</span>
            <span className={styles.body}>{t(c.body)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
