import { useEffect } from 'react'
import { BatchDialogs } from '../features/batch/BatchDialogs'
import { BatchPage } from '../features/batch/BatchPage'
import { CommandPalette } from '../features/command/CommandPalette'
import { HomePage } from '../features/home/HomePage'
import { JobsRunner } from '../features/jobs/JobsRunner'
import { startAutoRefresh } from '../features/library/autoRefreshRun'
import { DropImport } from '../features/import/DropImport'
import { SelectionDialogs } from '../features/selection/SelectionDialogs'
import { appKey } from '../features/library/keys'
import { LibraryPage } from '../features/library/LibraryPage'
import { ShortcutSheet } from '../features/library/ShortcutSheet'
import { CompareDialog } from '../features/similar/CompareDialog'
import { DuplicatesDialog } from '../features/similar/DuplicatesDialog'
import { SortPage } from '../features/sort/SortPage'
import { HealthDialog } from '../features/status/HealthDialog'
import { RestartOverlay } from '../features/settings/RestartOverlay'
import { SettingsPage } from '../features/settings/SettingsPage'
// Keeps the interface zoom in step with the window (auto) from the first render.
import '../features/settings/uiScaleStore'
import { ToolPage } from '../features/tools/ToolPage'
import { useLang } from '../i18n'
import { useApp } from '../state/store'
import styles from './App.module.css'
import { TopBar } from './TopBar'
import { Toasts } from '../ui/toasts'

export function App() {
  const page = useApp((s) => s.page)
  const lang = useLang((s) => s.lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // Settings › Library › checking the source folders for new images while idle (off unless switched on).
  useEffect(() => startAutoRefresh(), [])

  // Ctrl K opens the palette from anywhere, even while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (appKey(e) === 'palette') {
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
        {page === 'batch' && <BatchPage />}
        {page === 'sort' && <SortPage />}
        {page === 'home' && <HomePage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'tools' && <ToolPage />}
      </div>
      <CommandPalette />
      <ShortcutSheet />
      <CompareDialog />
      <DuplicatesDialog />
      <HealthDialog />
      <JobsRunner />
      <DropImport />
      <SelectionDialogs />
      <BatchDialogs />
      <RestartOverlay />
      <Toasts />
    </div>
  )
}
