import type { TaggerModel } from '../../api/queries'
import { useT } from '../../i18n'
import styles from './TagDialog.module.css'
import { CUSTOM_MODEL } from './tagOptions'
import { readiness, taggerInfo, type ModelCard, type Readiness, type TaggerInfo } from './taggers'

interface Props {
  list: TaggerModel[]
  /** The chosen model, or CUSTOM_MODEL. */
  chosen: string | null
  cards: ModelCard[] | undefined
  /** Until the status arrives (about a second) nothing is claimed about downloads. */
  statusKnown: boolean
  onPick: (model: string) => void
}

/** The built-in taggers with what first use costs, and last the user's own ONNX file. */
export function TaggerList({ list, chosen, cards, statusKnown, onPick }: Props) {
  const t = useT()
  const stateText = (r: Readiness, inf: TaggerInfo) => {
    if (!statusKnown) return t('tagging.checking')
    switch (r) {
      case 'ready':
        return t('tagging.ready')
      case 'download':
        return inf.sizeHint ? t('tagging.download', { size: inf.sizeHint }) : t('tagging.downloadUnknown')
      case 'check':
        return t('tagging.check')
      case 'restart':
        return t('tagging.restart')
    }
  }
  const custom = chosen === CUSTOM_MODEL
  return (
    <div className={styles.list} role="radiogroup" aria-label={t('tagging.tagger')}>
      {list.map((m) => {
        const inf = taggerInfo(m.name)
        const r = readiness(inf, cards)
        const checked = chosen === m.name
        return (
          <label key={m.name} className={styles.row} data-checked={checked || undefined}>
            <input type="radio" name="tagger" checked={checked} onChange={() => onPick(m.name)} />
            <span className={styles.name}>
              {inf.label}
              {m.recommended && <span className={styles.badge}>{t('tagging.recommended')}</span>}
              {!m.recommended && inf.familyPick && (
                <span className={styles.badge} data-kind="family">
                  {t(inf.familyPick)}
                </span>
              )}
            </span>
            <span className={styles.note}>{t(inf.note)}</span>
            <span className={styles.state} data-state={statusKnown ? r : 'checking'}>
              {stateText(r, inf)}
            </span>
          </label>
        )
      })}
      <label className={styles.row} data-checked={custom || undefined} data-testid="tagger-custom">
        <input type="radio" name="tagger" checked={custom} onChange={() => onPick(CUSTOM_MODEL)} />
        <span className={styles.name}>{t('dataset.tag.custom')}</span>
        <span className={styles.note}>{t('dataset.tag.customNote')}</span>
        <span className={styles.state}>{t('dataset.tag.customState')}</span>
      </label>
    </div>
  )
}
