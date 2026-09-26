import { useState } from 'react'
import { useModelStatus } from '../../../api/queries'
import { useT } from '../../../i18n'
import styles from './MaskEditor.module.css'
import { ENGINES, type MaskEngine } from './maskApi'
import type { MaskTool } from './maskModel'
import type { MaskSession } from './useMaskSession'

export interface ZoomCommand {
  kind: 'fit' | 'in' | 'out' | 'actual'
  n: number
}

interface Props {
  session: MaskSession
  tool: MaskTool
  onTool: (tool: MaskTool) => void
  size: number
  onSize: (size: number) => void
  engine: MaskEngine
  onEngine: (engine: MaskEngine) => void
  onZoom: (kind: ZoomCommand['kind']) => void
  ready: boolean
}

/** The mask editor's controls: brushes, whole-picture changes, the automatic mask, history, view, save. */
export function MaskTools({ session, tool, onTool, size, onSize, engine, onEngine, onZoom, ready }: Props) {
  const t = useT()
  const busy = session.busy !== null
  const { state, change } = session
  return (
    <aside className={styles.panel} data-testid="mask-tools">
      <div className={styles.panelBody}>
        <section className={styles.section}>
          <h3 className={styles.heading}>{t('dataset.masks.brush')}</h3>
          <div className={styles.segment} role="group" aria-label={t('dataset.masks.brush')}>
            <button type="button" aria-pressed={tool === 'keep'} onClick={() => onTool('keep')} data-testid="mask-tool-keep">
              {t('dataset.masks.keep')} <kbd>B</kbd>
            </button>
            <button type="button" aria-pressed={tool === 'drop'} onClick={() => onTool('drop')} data-testid="mask-tool-drop">
              {t('dataset.masks.drop')} <kbd>E</kbd>
            </button>
          </div>
          <label className={styles.field}>
            <span>{t('dataset.masks.size', { n: size })}</span>
            <input type="range" min={2} max={800} value={size} onChange={(e) => onSize(Number(e.target.value))} data-testid="mask-size" />
          </label>
          <p className={styles.hint}>{t('dataset.masks.brushHint')}</p>
        </section>
        <section className={styles.section}>
          <h3 className={styles.heading}>{t('dataset.masks.whole')}</h3>
          <div className={styles.row}>
            <button type="button" className="btn" disabled={!ready || busy} onClick={() => session.act({ kind: 'invert' })} data-testid="mask-invert">
              {t('dataset.masks.invert')}
            </button>
            <button type="button" className="btn" disabled={!ready || busy || (state.base === null && state.actions.length === 0)} onClick={() => change({ base: null, actions: [] })}>
              {t('dataset.masks.trainAll')}
            </button>
          </div>
        </section>
        <AutoSection session={session} engine={engine} onEngine={onEngine} ready={ready} />
        <section className={styles.section}>
          <h3 className={styles.heading}>{t('dataset.masks.historyView')}</h3>
          <div className={styles.row}>
            <button type="button" className="btn" disabled={session.history.past.length === 0} onClick={session.undo} data-testid="mask-undo">
              {t('dataset.masks.undo')}
            </button>
            <button type="button" className="btn" disabled={session.history.future.length === 0} onClick={session.redo}>
              {t('dataset.masks.redo')}
            </button>
          </div>
          <div className={styles.row}>
            <button type="button" className="btn btn-ghost" onClick={() => onZoom('fit')}>
              {t('dataset.masks.fit')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => onZoom('actual')}>
              1:1
            </button>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => onZoom('out')} aria-label={t('dataset.masks.zoomOut')} title={t('dataset.masks.zoomOut')}>
              −
            </button>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => onZoom('in')} aria-label={t('dataset.masks.zoomIn')} title={t('dataset.masks.zoomIn')}>
              +
            </button>
          </div>
          <p className={styles.hint}>{t('dataset.masks.keys')}</p>
        </section>
      </div>
      <SaveBar session={session} ready={ready} />
    </aside>
  )
}

function AutoSection({ session, engine, onEngine, ready }: { session: MaskSession; engine: MaskEngine; onEngine: (e: MaskEngine) => void; ready: boolean }) {
  const t = useT()
  const cards = useModelStatus().data?.models
  const card = cards?.find((c) => c.id === engine)
  const missing = !!card && card.status !== 'ready' && card.status !== 'needs_restart'
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{t('dataset.masks.auto')}</h3>
      <label className={styles.field}>
        <span>{t('dataset.masks.engine')}</span>
        <select value={engine} onChange={(e) => onEngine(e.target.value as MaskEngine)} data-testid="mask-engine">
          {(Object.keys(ENGINES) as MaskEngine[]).map((id) => (
            <option key={id} value={id}>
              {ENGINES[id].label}
            </option>
          ))}
        </select>
      </label>
      {engine === 'lucida' && <p className={styles.hint}>{t('dataset.masks.lucidaNote')}</p>}
      <button type="button" className="btn" disabled={!ready || session.busy !== null} onClick={() => void session.auto(engine)} data-testid="mask-auto">
        {session.busy === 'auto'
          ? t('dataset.masks.autoBusy')
          : missing
            ? t('dataset.masks.autoDownload', { name: ENGINES[engine].label, size: ENGINES[engine].size })
            : t('dataset.masks.autoOne')}
      </button>
      <p className={styles.hint}>{t('dataset.masks.autoHint')}</p>
    </section>
  )
}

function SaveBar({ session, ready }: { session: MaskSession; ready: boolean }) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  return (
    <footer className={styles.saveBar}>
      <p className={styles.share} data-testid="mask-share">
        {t('dataset.masks.share', { pct: Math.round(session.share * 100) })}
      </p>
      {asking ? (
        <div className={styles.confirm} role="group" aria-label={t('dataset.masks.removeAsk')}>
          <span>{t('dataset.masks.removeAsk')}</span>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setAsking(false)
              void session.remove()
            }}
            data-testid="mask-remove-yes"
          >
            {t('dataset.masks.remove')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setAsking(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className={styles.saveRow}>
          {session.hasMask && (
            <button type="button" className="btn btn-ghost" disabled={session.busy !== null} onClick={() => setAsking(true)} data-testid="mask-remove">
              {t('dataset.masks.remove')}
            </button>
          )}
          <span className={styles.gap} />
          <button type="button" className="btn btn-primary" disabled={!ready || session.busy !== null || !session.dirty} onClick={() => void session.save()} data-testid="mask-save">
            {session.busy === 'save' ? t('dataset.masks.saving') : t('dataset.masks.save')} <kbd>Ctrl S</kbd>
          </button>
        </div>
      )}
    </footer>
  )
}
