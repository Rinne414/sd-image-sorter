import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { AXIS_TITLE, canApply, customNotes, isStarted, NAME_MAX, type CustomNote, type End } from './customAxes'
import { addPicked, applyCustom, clearAxis, removePicture, revertCustom, setEndName, unfoldAxis, useCustom } from './customStore'
import styles from './CustomAxes.module.css'
import panel from './MapCanvas.module.css'
import { mapOnScreen, setPreview, useMap } from './mapStore'
import { usePicks } from './pickStore'
import { getScene } from './sceneHandle'
import { AXIS_NAMES, type AxisName } from './types'

const THUMB = 96

const END_LABEL = { a: 'stylemap.custom.endA', b: 'stylemap.custom.endB' } as const
const PLACEHOLDER = { a: 'stylemap.custom.namePlaceholderA', b: 'stylemap.custom.namePlaceholderB' } as const

/**
 * "My axes": per axis two ends, each with a name, its example pictures
 * (removable) and "add the picked pictures"; axes nobody started stay folded
 * to one button. Below, the honest state of the last answer (examples that
 * do not separate, pictures that could not be used, axes that point the same
 * way), Apply and Back to the model's layout. The definitions are kept per
 * library in this browser (customStore.ts).
 */
export function CustomAxesTab() {
  const t = useT()
  const defs = useCustom((s) => s.defs)
  const expanded = useCustom((s) => s.expanded)
  const status = useCustom((s) => s.status)
  const error = useCustom((s) => s.error)
  const applied = useCustom((s) => s.applied)
  const result = useCustom((s) => s.result)
  // Re-render when the map comes and goes (Apply needs one).
  useMap((s) => s.points)
  const hasMap = mapOnScreen() !== null
  const open = AXIS_NAMES.filter((axis) => isStarted(defs[axis]) || expanded.includes(axis))
  const folded = AXIS_NAMES.filter((axis) => !open.includes(axis))
  const notes = customNotes({ status, error, applied, result, defs })
  const ready = canApply(defs)
  const working = status === 'working'
  let applyTip = ''
  if (!ready) applyTip = t('stylemap.custom.applyNeed')
  else if (!hasMap) applyTip = t('stylemap.axes.idle')

  return (
    <div className={styles.tab} data-testid="stylemap-custom">
      <p className={panel.axesNote}>{t('stylemap.custom.note')}</p>
      <div className={panel.axesBody}>
        {open.map((axis) => (
          <CustomAxis key={axis} axis={axis} />
        ))}
        {folded.length > 0 && (
          <div className={styles.folded}>
            {folded.map((axis) => (
              <button key={axis} type="button" className="btn btn-sm" onClick={() => unfoldAxis(axis)} data-testid={`stylemap-custom-open-${axis}`}>
                {t('stylemap.custom.openAxis', { axis: t(AXIS_TITLE[axis]) })}
              </button>
            ))}
          </div>
        )}
        {notes
          .filter((note) => note.tone === 'info')
          .map((note) => (
            <NoteLine key={note.key} note={note} />
          ))}
      </div>
      <div className={styles.foot}>
        {notes
          .filter((note) => note.tone !== 'info')
          .map((note, i) => (
            <NoteLine key={`${note.key}-${note.axis ?? ''}-${i}`} note={note} />
          ))}
        <div className={styles.actions}>
          <button type="button" className="btn btn-primary btn-sm" disabled={working || !ready || !hasMap} title={applyTip || undefined} onClick={applyCustom} data-testid="stylemap-custom-apply">
            {t('stylemap.custom.apply')}
          </button>
          <button type="button" className="btn btn-sm" disabled={!applied} onClick={revertCustom} data-testid="stylemap-custom-revert">
            {t('stylemap.custom.revert')}
          </button>
        </div>
      </div>
    </div>
  )
}

function NoteLine({ note }: { note: CustomNote }) {
  const t = useT()
  const params = { ...note.params }
  if (note.axis) params.axis = t(AXIS_TITLE[note.axis])
  if (note.pair) {
    params.a = t(AXIS_TITLE[note.pair[0]])
    params.b = t(AXIS_TITLE[note.pair[1]])
  }
  return (
    <p className={styles.note} data-tone={note.tone} role={note.tone === 'error' ? 'alert' : undefined} data-testid="stylemap-custom-note">
      {t(note.key, params)}
    </p>
  )
}

function CustomAxis({ axis }: { axis: AxisName }) {
  const t = useT()
  const def = useCustom((s) => s.defs[axis])
  return (
    <div className={panel.axis} data-axis={axis} data-testid="stylemap-custom-axis">
      <div className={styles.axisHead}>
        <span className={panel.axisName}>{t(AXIS_TITLE[axis])}</span>
        {isStarted(def) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => clearAxis(axis)} data-testid="stylemap-custom-clear">
            {t('stylemap.custom.clearAxis')}
          </button>
        )}
      </div>
      <div className={panel.ends}>
        <CustomEnd axis={axis} end="a" />
        <CustomEnd axis={axis} end="b" />
      </div>
    </div>
  )
}

function CustomEnd({ axis, end }: { axis: AxisName; end: End }) {
  const t = useT()
  const def = useCustom((s) => s.defs[axis])
  const canAdd = usePicks((s) => s.picked.size > 0)
  const ids = def[end]
  const name = end === 'a' ? def.nameA : def.nameB
  const endLabel = t(END_LABEL[end])

  const preview = (id: number) => {
    setPreview({ id, members: 1 })
    const scene = getScene()
    const at = scene?.positionOf(id)
    if (scene && at) scene.flyTo(at, { exact: true })
  }

  return (
    <div className={styles.end} data-end={end}>
      <div className={panel.endName}>
        {endLabel}
        {ids.length > 0 && <span className={styles.count}>{t('stylemap.custom.count', { n: ids.length })}</span>}
      </div>
      <input
        type="text"
        className={styles.name}
        maxLength={NAME_MAX}
        value={name}
        placeholder={t(PLACEHOLDER[end])}
        aria-label={t('stylemap.custom.nameLabel', { axis: t(AXIS_TITLE[axis]), end: endLabel })}
        onChange={(e) => setEndName(axis, end, e.target.value)}
        data-testid="stylemap-custom-name"
        data-axis={axis}
        data-end={end}
      />
      {ids.length > 0 && (
        <div className={styles.chips}>
          {ids.map((id) => (
            <span key={id} className={styles.chip} data-testid="stylemap-custom-chip" data-id={id}>
              <button type="button" className={styles.chipThumb} onClick={() => preview(id)} title={t('stylemap.axes.pickTip')}>
                <img src={thumbnailUrl(id, THUMB)} alt="" loading="lazy" decoding="async" />
              </button>
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => removePicture(axis, end, id)}
                aria-label={t('stylemap.custom.remove')}
                title={t('stylemap.custom.remove')}
                data-testid="stylemap-custom-remove"
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={!canAdd}
        title={canAdd ? undefined : t('stylemap.custom.addNone')}
        onClick={() => addPicked(axis, end)}
        data-testid="stylemap-custom-add"
        data-axis={axis}
        data-end={end}
      >
        {t('stylemap.custom.add')}
      </button>
    </div>
  )
}
