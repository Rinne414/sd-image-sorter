import { useT } from '../../i18n'
import { Section } from '../settings/about/Section'
import { useSaved } from '../settings/useSaved'
import { ComfyAddress } from './ComfyAddress'
import styles from './Generator.module.css'

/** Settings › AI services › ComfyUI address: where "Run in ComfyUI" sends a picture's recipe. */
export function ComfySettingsSection() {
  const t = useT()
  const [saved, markSaved] = useSaved<'address'>()
  return (
    <Section title={t('generator.address.title')} saved={saved === 'address'} testId="settings-comfyui">
      <div className={styles.settings}>
        <p className={styles.lead}>{t('generator.address.body')}</p>
        <ComfyAddress onSaved={() => markSaved('address')} testId="settings-comfyui-address" />
      </div>
    </Section>
  )
}
