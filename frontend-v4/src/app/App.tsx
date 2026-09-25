import { useEffect } from 'react'
import { CommandPalette } from '../features/command/CommandPalette'
import { LibraryPage } from '../features/library/LibraryPage'
import { useLang } from '../i18n'
import { useApp } from '../state/store'
import styles from './App.module.css'
import { PlannedPage } from './PlannedPage'
import { TopBar } from './TopBar'
import { Toasts } from '../ui/toasts'

export function App() {
  const page = useApp((s) => s.page)
  const lang = useLang((s) => s.lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // Ctrl K opens the palette from anywhere, even while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        const s = useApp.getState()
        s.setPaletteOpen(!s.paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className={styles.app}>
      <TopBar />
      <div className={styles.body}>
        {page === 'library' && <LibraryPage />}
        {page === 'batch' && <PlannedPage title="planned.batch.title" body="planned.batch.body" />}
        {page === 'sort' && <PlannedPage title="planned.sort.title" body="planned.sort.body" />}
        {page === 'home' && <PlannedPage title="planned.home.title" body="planned.home.body" />}
      </div>
      <CommandPalette />
      <Toasts />
    </div>
  )
}
