import { useEffect } from 'react'
import { BatchDialogs } from '../features/batch/BatchDialogs'
import { BatchPage } from '../features/batch/BatchPage'
import { CommandPalette } from '../features/command/CommandPalette'
import { HomePage } from '../features/home/HomePage'
import { JobsRunner } from '../features/jobs/JobsRunner'
import { startAutoRefresh } from '../features/library/autoRefreshRun'
import { listenForCollected } from '../features/settings/desktop/collected'
import { startWhatsNew } from '../features/whatsnew/whatsNew'
import { startFolderWatch } from '../features/settings/library/watchApi'
import { CollectHost } from '../features/collect/CollectHost'
import { DropImport } from '../features/import/DropImport'
import { useLibraryArrival } from '../features/libraries/useArrival'
import { useLibraryExists } from '../features/libraries/useLibraryExists'
import { GeneratorDialog } from '../features/generator/GeneratorDialog'
import { SelectionDialogs } from '../features/selection/SelectionDialogs'
import { MediaCensorHost } from '../features/censor/media/MediaCensorHost'
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
import { useBackNav } from './useBackNav'
import { Toasts } from '../ui/toasts'

export function App() {
  const page = useApp((s) => s.page)
  const lang = useLang((s) => s.lang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // Settings › Library › checking the source folders for new images while idle (off unless switched on).
  useEffect(() => startAutoRefresh(), [])
  useEffect(() => startFolderWatch(), [])
  // Quick collect (its own small window) added pictures: show them.
  useEffect(() => listenForCollected(), [])
  // After an update: say once what changed (shared with classic).
  useEffect(() => startWhatsNew(), [])

  // Browser and mouse Back go up one level instead of leaving the program.
  useBackNav()

  // Coming from V3.5: open the library it had open.
  useLibraryArrival()
  // After it: a library deleted elsewhere (or a stale stored id) is left for one that exists.
  useLibraryExists()

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
      <CollectHost />
      <SelectionDialogs />
      <MediaCensorHost />
      <GeneratorDialog />
      <BatchDialogs />
      <RestartOverlay />
      <Toasts />
    </div>
  )
}
