import type { ComponentType } from 'react'
import { useSourceHandoff } from '../intake/sourceStore'
import { BuildPanel } from './BuildPanel'
import { openBuildImage } from './buildStore'
import { ComparePanel } from './ComparePanel'
import { MODES, setMode, useLabMode, type LabMode } from './labStore'
import { usePL, type PlKey } from './plText'
import styles from './PromptLab.module.css'
import { StatsPanel } from './StatsPanel'

// 提示词助手: four ways to work with prompts, the last one used opens again.
// An image sent here from the library ("送到工具 ▸") opens in Build.

const PANELS: Record<LabMode, { label: PlKey; Panel: ComponentType }> = {
  stats: { label: 'pl.mode.stats', Panel: StatsPanel },
  compare: { label: 'pl.mode.compare', Panel: ComparePanel },
  build: { label: 'pl.mode.build', Panel: BuildPanel },
}

const openSent = (id: number) => void openBuildImage(id)

export function PromptLabPage() {
  const t = usePL()
  const mode = useLabMode((s) => s.mode)
  useSourceHandoff('promptlab', openSent)
  const { Panel } = PANELS[mode]
  return (
    <div className={styles.page} data-testid="promptlab-page" data-mode={mode}>
      <div className={styles.modes} role="tablist" aria-label={t('pl.modes')}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            id={`pl-tab-${m}`}
            aria-selected={m === mode}
            aria-controls="pl-panel"
            className={styles.modeTab}
            onClick={() => setMode(m)}
            data-testid={`pl-mode-${m}`}
          >
            {t(PANELS[m].label)}
          </button>
        ))}
      </div>
      <div className={styles.body} id="pl-panel" role="tabpanel" aria-labelledby={`pl-tab-${mode}`}>
        <Panel />
      </div>
    </div>
  )
}
