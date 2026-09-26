import { useT } from '../../../i18n'
import { useApp } from '../../../state/store'
import styles from './DescribeOption.module.css'
import { useVlmSettings } from './aiApi'
import { useAT } from './aiText'
import { vlmReadiness, type VlmReadiness } from './vlmForm'

/** The VLM service as the tag panel needs it: null until the settings are read (or when they cannot be). */
export function useDescriber(): VlmReadiness | null {
  const settings = useVlmSettings()
  return settings.data ? vlmReadiness(settings.data) : null
}

interface Props {
  vlm: VlmReadiness
  /** How many images would be described (one call each). */
  count: number
  checked: boolean
  onChange: (checked: boolean) => void
  /** The panel has tags to drop, which the describing run cannot do. */
  dropsTags: boolean
  /** Close what the option sits in before going to Settings › AI services. */
  onSetup: () => void
}

/**
 * "Also write a natural-language description" in the tag panel: off by
 * default and never remembered; once ticked it says how many calls it makes
 * (and that a cloud service may charge for them) before anything starts.
 * Without a service set up, a link to Settings › AI services stands in for it.
 */
export function DescribeOption({ vlm, count, checked, onChange, dropsTags, onSetup }: Props) {
  const at = useAT()
  const t = useT()
  if (!vlm.ready) {
    const go = () => {
      onSetup()
      useApp.getState().openSettings('ai')
    }
    return (
      <p className={styles.wrap}>
        <button type="button" className={styles.link} onClick={go} data-testid="tag-describe-setup">
          {at('ai.tag.setup')} →
        </button>
      </p>
    )
  }
  return (
    <div className={styles.box} data-testid="tag-describe">
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="tag-describe-check" />
        <span className={styles.name}>{at('ai.tag.describe')}</span>
      </label>
      <p className={styles.hint}>{at('ai.tag.describeHint', { name: vlm.label })}</p>
      {checked && (
        <p className={vlm.local ? styles.hint : styles.calls} role="status" data-testid="tag-describe-calls">
          {t(vlm.local ? 'dataset.tag.callsLocal' : 'dataset.tag.callsPaid', { n: count, name: vlm.label })}
        </p>
      )}
      {checked && dropsTags && <p className={styles.warn}>{at('ai.tag.blacklistOff')}</p>}
    </div>
  )
}
