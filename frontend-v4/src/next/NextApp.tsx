import { useEffect } from 'react'
import { useBackNav } from '../app/useBackNav'
import { BatchDialogs } from '../features/batch/BatchDialogs'
import { BatchPage } from '../features/batch/BatchPage'
import { CommandPalette } from '../features/command/CommandPalette'
import { HomePage } from '../features/home/HomePage'
import { CollectHost } from '../features/collect/CollectHost'
import { DropImport } from '../features/import/DropImport'
import { JobsRunner } from '../features/jobs/JobsRunner'
import { useLibraryArrival } from '../features/libraries/useArrival'
import { useLibraryExists } from '../features/libraries/useLibraryExists'
import { startAutoRefresh } from '../features/library/autoRefreshRun'
import { listenForCollected } from '../features/settings/desktop/collected'
import { startFolderWatch } from '../features/settings/library/watchApi'
import { appKey } from '../features/library/keys'
import { ShortcutSheet } from '../features/library/ShortcutSheet'
import { GeneratorDialog } from '../features/generator/GeneratorDialog'
import { SelectionDialogs } from '../features/selection/SelectionDialogs'
import { MediaCensorHost } from '../features/censor/media/MediaCensorHost'
import { RestartOverlay } from '../features/settings/RestartOverlay'
import { SettingsPage } from '../features/settings/SettingsPage'
// Keeps the interface zoom in step with the window (auto) from the first render.
import '../features/settings/uiScaleStore'
import { CompareDialog } from '../features/similar/CompareDialog'
import { DuplicatesDialog } from '../features/similar/DuplicatesDialog'
import { SortPage } from '../features/sort/SortPage'
import { HealthDialog } from '../features/status/HealthDialog'
import { ToolPage } from '../features/tools/ToolPage'
import { useLang } from '../i18n'
import { useApp } from '../state/store'
import { Toasts } from '../ui/toasts'
import { ErrorBoundary, useBackgroundErrors } from './ErrorFallback'
import styles from './NextApp.module.css'
import { NextLibraryPage } from './NextLibraryPage'
import { NextTopBar } from './NextTopBar'

/**
 * The shell of the new interface: its top edge, the page, and the layers every
 * page shares. Pages other than the library are frontend-v4's own, drawn in
 * this interface's tokens until they are redesigned.
 */
export function NextApp() {
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

  useBackNav()
  useBackgroundErrors()
  useLibraryArrival()
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
    <ErrorBoundary>
      <div className={styles.app}>
        <NextTopBar />
        <div className={styles.body}>
          {/* A page that fails says so in place; the top edge stays usable. */}
          <ErrorBoundary key={page} home>
            {page === 'library' && <NextLibraryPage />}
            {page === 'batch' && <BatchPage />}
            {page === 'sort' && <SortPage />}
            {page === 'home' && <HomePage />}
            {page === 'settings' && <SettingsPage />}
            {page === 'tools' && <ToolPage />}
          </ErrorBoundary>
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
    </ErrorBoundary>
  )
}
