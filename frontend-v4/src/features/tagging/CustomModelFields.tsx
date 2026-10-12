import { useT, type MessageKey } from '../../i18n'
import styles from './TagDialog.module.css'
import { CUSTOM_PROFILES, type CustomModel, type CustomPathProblem, type CustomProfile } from './tagOptions'

const PROFILE_LABEL: Record<CustomProfile, MessageKey> = {
  wd14: 'dataset.tag.customProfile.wd14',
  'camie-tagger-v2': 'dataset.tag.customProfile.camie',
  'pixai-tagger-v0.9': 'dataset.tag.customProfile.pixai',
}

interface Props {
  value: CustomModel
  set: (value: CustomModel) => void
  /** What the backend refused about the paths, said in plain words under them. */
  problem: CustomPathProblem | null
}

/**
 * The user's own ONNX tagger: its family and the paths to the model and its
 * tags file. The paths are checked by the backend when the run starts, the
 * way V3.5 does; only an empty model path is caught here.
 */
export function CustomModelFields({ value, set, problem }: Props) {
  const t = useT()
  const ext = value.profile === 'camie-tagger-v2' ? '.json' : '.csv'
  return (
    <div className={styles.custom} data-testid="tag-custom">
      <label className={styles.field}>
        <span>{t('dataset.tag.customProfile')}</span>
        <select value={value.profile} onChange={(e) => set({ ...value, profile: CUSTOM_PROFILES.find((p) => p === e.target.value) ?? 'wd14' })} data-testid="tag-custom-profile">
          {CUSTOM_PROFILES.map((p) => (
            <option key={p} value={p}>
              {t(PROFILE_LABEL[p])}
            </option>
          ))}
        </select>
        <small>{t('dataset.tag.customProfileHint')}</small>
      </label>
      <label className={styles.field}>
        <span>{t('dataset.tag.customModelPath')}</span>
        <input
          type="text"
          value={value.modelPath}
          placeholder="D:\models\my-tagger.onnx"
          spellCheck={false}
          aria-invalid={problem?.field === 'model' || undefined}
          onChange={(e) => set({ ...value, modelPath: e.target.value })}
          data-testid="tag-custom-model"
        />
      </label>
      <label className={styles.field}>
        <span>{t('dataset.tag.customTagsPath')}</span>
        <input
          type="text"
          value={value.tagsPath}
          placeholder={value.profile === 'camie-tagger-v2' ? 'D:\\models\\metadata.json' : 'D:\\models\\selected_tags.csv'}
          spellCheck={false}
          aria-invalid={problem?.field === 'tags' || undefined}
          onChange={(e) => set({ ...value, tagsPath: e.target.value })}
          data-testid="tag-custom-tags"
        />
        <small>{t('dataset.tag.customTagsHint')}</small>
      </label>
      {problem && (
        <p className={styles.error} role="alert" data-testid="tag-custom-error">
          {t(`dataset.tag.customErr.${problem.field}.${problem.kind}` as MessageKey, { ext })}
        </p>
      )}
    </div>
  )
}
