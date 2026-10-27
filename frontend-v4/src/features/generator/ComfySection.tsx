import { useState } from 'react'
import { useT } from '../../i18n'
import { ComfyAddress } from './ComfyAddress'
import { queueInComfy, saveWorkflowFile, useComfySetting, type GeneratorRecipe, type SeedMode } from './generatorApi'
import styles from './Generator.module.css'
import { comfyKind, readSeedMode, saidError, savedWhere, writeSeedMode } from './recipeText'
import type { Result } from './GeneratorDialog'

interface Props {
  id: number
  recipe: GeneratorRecipe
  onCopy: (text: string, done: string) => Promise<void>
  onResult: (result: Result) => void
}

const storage = (): Storage | null => {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** ComfyUI: copy or save the workflow, run the recipe again on the address from Settings. */
export function ComfySection({ id, recipe, onCopy, onResult }: Props) {
  const t = useT()
  const setting = useComfySetting()
  const [seed, setSeed] = useState<SeedMode>(() => readSeedMode(storage()))
  const [busy, setBusy] = useState<'save' | 'queue' | null>(null)
  const kind = comfyKind(recipe)
  const comfy = recipe.comfyui
  // The address in force now (a change in the field below updates it), else what the recipe was read with.
  const address = setting.data?.url ?? recipe.comfyui_url ?? ''

  const pickSeed = (mode: SeedMode) => {
    setSeed(mode)
    writeSeedMode(storage(), mode)
  }

  const save = async () => {
    setBusy('save')
    try {
      const saved = await saveWorkflowFile(id)
      onResult({ tone: 'ok', said: { message: t('generator.comfy.workflowSaved', savedWhere(saved)), details: [] } })
    } catch (error) {
      onResult({ tone: 'error', said: saidError(t, error, 'save') })
    } finally {
      setBusy(null)
    }
  }

  const queue = async () => {
    setBusy('queue')
    onResult({ tone: 'ok', said: { message: t('generator.run.sending', { url: address || '?' }), details: [] } })
    try {
      const run = await queueInComfy(id, seed)
      const message =
        seed === 'new'
          ? t('generator.run.queuedNew', { address: run.comfyui_url, count: run.seeds_changed })
          : t('generator.run.queuedSame', { address: run.comfyui_url })
      onResult({ tone: 'ok', said: { message, details: [] } })
    } catch (error) {
      onResult({ tone: 'error', said: saidError(t, error, 'queue') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={styles.block} aria-label={t('generator.comfy.title')} data-testid="generator-comfy">
      <div className={styles.head}>
        <h3 className={styles.title}>{t('generator.comfy.title')}</h3>
        {kind !== 'none' && (
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!comfy.has_workflow}
              title={t(comfy.has_workflow ? 'generator.comfy.copyWorkflowTip' : 'generator.comfy.runOnly')}
              onClick={() => void onCopy(JSON.stringify(comfy.workflow), t('generator.comfy.workflowCopied'))}
              data-testid="generator-copy-workflow"
            >
              {t('generator.comfy.copyWorkflow')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              title={t('generator.comfy.saveWorkflowTip')}
              onClick={() => void save()}
              data-testid="generator-save-workflow"
            >
              {busy === 'save' ? t('generator.comfy.saving') : t('generator.comfy.saveWorkflow')}
            </button>
          </div>
        )}
      </div>
      <p className={styles.facts} data-testid="generator-comfy-facts">
        {kind === 'none' ? t('generator.comfy.none') : t(`generator.comfy.${kind}`)}
        {comfy.has_api_prompt ? ` ${t('generator.comfy.seeds', { n: comfy.seed_inputs })}` : ''}
      </p>
      {comfy.has_api_prompt ? (
        <div className={styles.runRow}>
          <span className={styles.runLabel}>{t('generator.run.label')}</span>
          <div className={styles.seeds} role="group" aria-label={t('generator.run.seed')}>
            {(['new', 'same'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="btn btn-sm"
                aria-pressed={seed === mode}
                onClick={() => pickSeed(mode)}
                data-testid={`generator-seed-${mode}`}
              >
                {t(mode === 'new' ? 'generator.run.seedNew' : 'generator.run.seedSame')}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null}
            title={t('generator.run.tip', { url: address || '?' })}
            onClick={() => void queue()}
            data-testid="generator-run"
          >
            {t('generator.run.button')}
          </button>
        </div>
      ) : (
        kind !== 'none' && <p className={styles.note}>{t('generator.run.needsRecipe')}</p>
      )}
      <ComfyAddress testId="generator-address" />
    </section>
  )
}
