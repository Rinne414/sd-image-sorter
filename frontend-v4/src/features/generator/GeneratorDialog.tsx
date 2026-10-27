import { useMemo, useState } from 'react'
import { useImageDetail } from '../../api/queries'
import { useT } from '../../i18n'
import { copyText } from '../../lib/format'
import { Dialog } from '../../ui/Dialog'
import { ComfySection } from './ComfySection'
import { useGeneratorRecipe } from './generatorApi'
import styles from './Generator.module.css'
import { useGeneratorDialog } from './generatorStore'
import { hasNothing, naiText, webuiText, type Said } from './recipeText'
import { TextBlock } from './TextBlock'

export interface Result {
  tone: 'ok' | 'error'
  said: Said
}

/** Mounts the dialog while a picture is chosen. */
export function GeneratorDialog() {
  const imageId = useGeneratorDialog((s) => s.imageId)
  const close = useGeneratorDialog((s) => s.close)
  if (imageId === null) return null
  return <Body key={imageId} id={imageId} onClose={close} />
}

/** One picture's recipe for WebUI, NovelAI and ComfyUI: what will be copied, saved or queued, and what happened. */
function Body({ id, onClose }: { id: number; onClose: () => void }) {
  const t = useT()
  const recipe = useGeneratorRecipe(id)
  const detail = useImageDetail(id)
  const [result, setResult] = useState<Result | null>(null)

  const say = (tone: Result['tone'], message: string, details: string[] = []) => setResult({ tone, said: { message, details } })

  const prompt = detail.data?.image.prompt ?? null
  const negative = detail.data?.image.negative_prompt ?? null
  const texts = useMemo(() => {
    if (!recipe.data) return null
    return { webui: webuiText(recipe.data, prompt, negative), nai: naiText(recipe.data, prompt, negative) }
  }, [recipe.data, prompt, negative])

  const copy = async (text: string, done: string) => {
    if (!text) return say('error', t('generator.nothingToCopy'))
    if (await copyText(text)) say('ok', done)
    else say('error', t('generator.copyFailed'))
  }

  return (
    <Dialog
      title={t('generator.title')}
      wide
      onClose={onClose}
      testId="generator-dialog"
      footer={
        <div className={styles.foot}>
          <div className={styles.result} data-tone={result?.tone} role="status" aria-live="polite" data-testid="generator-result">
            {result && (
              <>
                <p>{result.said.message}</p>
                {result.said.details.length > 0 && (
                  <ul>
                    {result.said.details.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <button type="button" className="btn" onClick={onClose} data-testid="generator-close">
            {t('common.close')}
          </button>
        </div>
      }
    >
      {recipe.isPending && <p className={styles.state}>{t('generator.loading')}</p>}
      {recipe.isError && (
        <div className={styles.body}>
          <p className={styles.state} data-tone="error" data-testid="generator-load-failed">
            {t('generator.loadFailed', { reason: recipe.error.message })}
          </p>
          <div>
            <button type="button" className="btn" onClick={() => void recipe.refetch()}>
              {t('common.retry')}
            </button>
          </div>
        </div>
      )}
      {recipe.data && texts && (
        <div className={styles.body}>
          {recipe.data.metadata_source === 'stored' && <p className={styles.stored}>{t('generator.fromStored')}</p>}
          {hasNothing(recipe.data, texts.webui, texts.nai) && (
            <p className={styles.state} data-testid="generator-nothing">
              {t('generator.nothing')}
            </p>
          )}
          <TextBlock
            testId="generator-webui"
            title={t('generator.webui.title')}
            lead={t('generator.webui.lead')}
            text={texts.webui}
            copyLabel={t('generator.webui.copy')}
            onCopy={() => void copy(texts.webui, t('generator.webui.copied'))}
          />
          <TextBlock
            testId="generator-nai"
            title={t('generator.nai.title')}
            lead={t('generator.nai.lead')}
            text={texts.nai}
            copyLabel={t('generator.nai.copy')}
            onCopy={() => void copy(texts.nai, t('generator.nai.copied'))}
          />
          <ComfySection id={id} recipe={recipe.data} onCopy={copy} onResult={setResult} />
        </div>
      )}
    </Dialog>
  )
}
