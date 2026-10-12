import styles from './Ai.module.css'
import { useVlmSettings } from './aiApi'
import { useAT } from './aiText'
import { ChatLog } from './ChatLog'
import { OllamaSection } from './OllamaSection'
import type { VlmSettings } from './types'
import { useVlmDraft } from './useVlmDraft'
import { VlmSection } from './VlmSection'

/** Settings › AI services: the VLM service (shared with V3.5), local Ollama, and the API chat log. */
export function AiTab() {
  const t = useAT()
  const settings = useVlmSettings()
  if (settings.isPending) return <p className={styles.state}>{t('ai.loading')}</p>
  if (settings.isError) {
    return (
      <div className={styles.sections}>
        <p className={styles.state} data-tone="error">
          {t('ai.loadFailed', { reason: settings.error.message })}
        </p>
        <div>
          <button type="button" className="btn" onClick={() => void settings.refetch()}>
            {t('ai.retry')}
          </button>
        </div>
      </div>
    )
  }
  return <Loaded settings={settings.data} />
}

/** The form starts from the settings as first read; later reads (after a save) only update what is shown as stored. */
function Loaded({ settings }: { settings: VlmSettings }) {
  const draft = useVlmDraft(settings)
  return (
    <div className={styles.sections} data-testid="ai-services">
      <VlmSection draft={draft} settings={settings} />
      <OllamaSection draft={draft} settings={settings} />
      <ChatLog />
    </div>
  )
}
