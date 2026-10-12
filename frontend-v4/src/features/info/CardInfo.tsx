import { useModelStatus } from '../../api/queries'
import type { ImageDetail } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { copyText } from '../../lib/format'
import { formatScore, noParamsReason, type CivitaiResource, type ImageInfo, type ModelGroupId, type PromptNode } from '../../lib/imageInfo'
import { shortModelName, type GenerationInfo } from '../../lib/meta'
import cardStyles from '../card/Card.module.css'
import { CopyButton, Section } from '../card/CardParts'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { scoreImages } from './aesthetic'
import styles from './Info.module.css'
import { filterByModel } from './modelFilter'
import { aestheticModelState } from './scoring'

// The generation card's information beyond the prompt: the model and LoRAs
// (a click filters the library by them), the aesthetic score, img2img, the
// caption file, Civitai resources, ComfyUI prompt nodes and the workflow's
// other models; and why an image shows no parameters at all.

const I2I_KINDS: Record<string, MessageKey> = {
  img2img: 'info.i2i.kind.img2img',
  inpaint: 'info.i2i.kind.inpaint',
  'hires fix': 'info.i2i.kind.hiresFix',
  'latent upscale': 'info.i2i.kind.latentUpscale',
}

/** The img2img marker's words: the kind in the user's language, or as the parser wrote it. */
export function useI2iLabel(info: ImageInfo | null): string | null {
  const t = useT()
  if (!info?.img2img) return null
  const kind = info.img2img.kind
  const key = kind ? I2I_KINDS[kind] : undefined
  return key ? t(key) : (kind ?? t('info.i2i.label'))
}

/** Model, LoRAs, aesthetic score and img2img, as label / value rows. */
export function Facts({ id, image, gen, info }: { id: number; image: ImageDetail; gen: GenerationInfo | null; info: ImageInfo }) {
  const t = useT()
  const i2i = useI2iLabel(info)
  return (
    <dl className={styles.facts} data-testid="card-facts">
      {gen?.model && (
        <div className={styles.fact}>
          <dt className={cardStyles.label}>{t('card.model')}</dt>
          <dd className={styles.modelLine}>
            <FilterName kind="checkpoint" name={gen.model} className={styles.modelName} testId="card-model-filter" />
            {info.modelHash && <HashCode hash={info.modelHash} />}
          </dd>
        </div>
      )}
      {gen && gen.loras.length > 0 && (
        <div className={styles.fact}>
          <dt className={cardStyles.label}>{t('card.loras')}</dt>
          <dd className={styles.loras}>
            {gen.loras.map((l) => (
              <LoraChip key={l} name={l} weight={info.loraWeight(l)} />
            ))}
          </dd>
        </div>
      )}
      <div className={styles.fact}>
        <dt className={cardStyles.label}>{t('info.aes.label')}</dt>
        <dd>
          <AestheticValue id={id} score={image.aesthetic_score} />
        </dd>
      </div>
      {info.img2img && (
        <div className={styles.fact} data-testid="card-img2img">
          <dt className={cardStyles.label}>{t('info.i2i.label')}</dt>
          <dd className={styles.i2i}>
            <span>{i2i}</span>
            {info.img2img.denoise && <span className="mono">{t('info.i2i.denoise', { n: info.img2img.denoise })}</span>}
            {info.img2img.noise && <span className="mono">{t('info.i2i.noise', { n: info.img2img.noise })}</span>}
            {info.img2img.other.map(([k, v]) => (
              <span key={k} className="mono">
                {k.replace(/_/g, ' ')} {v}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  )
}

function FilterName({ kind, name, className, testId }: { kind: 'checkpoint' | 'lora'; name: string; className: string | undefined; testId?: string }) {
  const t = useT()
  const hint = `${name}\n${t(kind === 'checkpoint' ? 'info.filterModel' : 'info.filterLora')}`
  return (
    <button type="button" className={className} title={hint} onClick={() => filterByModel(kind, name)} data-testid={testId}>
      {shortModelName(name)}
    </button>
  )
}

function LoraChip({ name, weight }: { name: string; weight: string | null }) {
  const t = useT()
  return (
    <span className={styles.lora}>
      <FilterName kind="lora" name={name} className={styles.loraName} testId="card-lora-filter" />
      {weight && (
        <span className={`${styles.weight} mono`} title={t('info.loraWeight', { n: weight })}>
          {weight}
        </span>
      )}
    </span>
  )
}

function HashCode({ hash }: { hash: string }) {
  const t = useT()
  return (
    <button type="button" className={`${styles.hash} mono`} title={`${t('info.hash')} · ${t('card.clickToCopy')}`} onClick={() => void copyText(hash)}>
      {hash.toUpperCase()}
    </button>
  )
}

/** The score, or the offer to score this image (a job; the model downloads first the first time). */
function AestheticValue({ id, score }: { id: number; score: number | null }) {
  const t = useT()
  const models = useModelStatus()
  const scoring = useJobs((s) => s.jobs.some((j) => j.kind === 'aesthetic' && !isFinished(j.progress.status) && (j.ids.length === 0 || j.ids.includes(id))))
  const shown = formatScore(score)
  if (shown) {
    return (
      <span className={`${styles.score} mono`} data-testid="card-aesthetic">
        {t('info.aes.value', { score: shown })}
      </span>
    )
  }
  const firstUse = aestheticModelState(models.data?.models) === 'download'
  return (
    <span className={styles.unscored} data-testid="card-aesthetic">
      <span>{t('info.aes.none')}</span>
      <button
        type="button"
        className={cardStyles.more}
        onClick={() => void scoreImages([id])}
        disabled={scoring}
        title={firstUse ? t('info.aes.firstUse') : undefined}
        data-testid="card-score"
      >
        {scoring ? t('info.aes.scoring') : t('info.aes.scoreOne')}
      </button>
    </span>
  )
}

const NO_PARAMS: Record<NonNullable<ReturnType<typeof noParamsReason>>, MessageKey> = {
  gemini: 'info.noParams.gemini',
  gptImage: 'info.noParams.gptImage',
  runtime: 'info.noParams.runtime',
  none: 'info.noParams.none',
}

/** Why there is no prompt: some generators never write one. */
export function NoParamsNote({ generator }: { generator: string | null }) {
  const t = useT()
  const reason = noParamsReason({ generator, hasPrompt: false })
  if (!reason) return null
  return (
    <p className={styles.note} data-reason={reason} data-testid="card-no-params">
      {t(NO_PARAMS[reason])}
    </p>
  )
}

/** Text from a .txt / .json caption file beside the image (not a generation prompt). */
export function SidecarCaption({ text }: { text: string }) {
  const t = useT()
  return (
    <Section label={t('info.sidecar.title')} copy={text} testId="card-sidecar">
      <p className={cardStyles.caption} title={t('info.sidecar.hint')}>
        {text}
      </p>
    </Section>
  )
}

const CIVITAI_KINDS: Record<string, MessageKey> = {
  lora: 'info.civitai.kind.lora',
  locon: 'info.civitai.kind.lora',
  checkpoint: 'info.civitai.kind.checkpoint',
  embedding: 'info.civitai.kind.embedding',
}

export function CivitaiResources({ list }: { list: CivitaiResource[] }) {
  const t = useT()
  return (
    <Section label={t('info.civitai.title')} testId="card-civitai">
      <ul className={styles.rows}>
        {list.map((r, i) => {
          const kindKey = r.kind ? CIVITAI_KINDS[r.kind] : undefined
          return (
            <li key={`${r.name}-${r.version ?? ''}-${i}`} className={styles.civitai}>
              {r.kind && <span className={styles.kind}>{kindKey ? t(kindKey) : r.kind}</span>}
              <span className={styles.civitaiName} title={r.name}>
                {r.name}
                {r.version && <span className={styles.version}> {r.version}</span>}
              </span>
              {r.weight && <span className="mono">{t('info.civitai.weight', { n: r.weight })}</span>}
              {r.url && (
                <a className={styles.link} href={r.url} target="_blank" rel="noopener noreferrer">
                  {t('info.civitai.open')}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** Open or closed as the user left it (the Reader remembers); the card leaves it to the browser. */
interface Remembered {
  open?: boolean
  onToggle?: (open: boolean) => void
}

/** ComfyUI: every text node of the graph, with its role. */
export function PromptNodes({ nodes, open, onToggle }: { nodes: PromptNode[] } & Remembered) {
  const t = useT()
  return (
    <details className={cardStyles.extra} data-testid="card-nodes" open={open} onToggle={onToggle && ((e) => onToggle(e.currentTarget.open))}>
      <summary>
        {t('info.nodes.title')}
        <span className="mono">{nodes.length}</span>
      </summary>
      <ul className={styles.nodes}>
        {nodes.map((n) => (
          <li key={`${n.id}-${n.text.slice(0, 24)}`}>
            <header className={styles.nodeHead}>
              <span className="mono">{t('info.nodes.node', { id: n.id })}</span>
              <span className={styles.nodeType}>{n.type}</span>
              {n.role && (
                <span className={styles.role} data-role={n.role}>
                  {t(n.role === 'positive' ? 'info.nodes.positive' : 'info.nodes.negative')}
                </span>
              )}
              <CopyButton text={n.text} compact />
            </header>
            <p className={styles.nodeText}>{n.text}</p>
          </li>
        ))}
      </ul>
    </details>
  )
}

const GROUP_LABEL: Record<ModelGroupId, MessageKey> = {
  checkpoint: 'info.models.checkpoint',
  unet: 'info.models.unet',
  vae: 'info.models.vae',
  clip: 'info.models.clip',
  diffusion: 'info.models.diffusion',
  other: 'info.models.other',
  detector: 'info.models.detector',
  guessLora: 'info.models.guessLora',
  guessDetector: 'info.models.guessDetector',
}

/** The workflow's other models (VAE, text encoders, upscalers, detectors...). */
export function OtherModels({ groups, open, onToggle }: { groups: ImageInfo['otherModels'] } & Remembered) {
  const t = useT()
  const count = groups.reduce((n, g) => n + g.names.length, 0)
  return (
    <details className={cardStyles.extra} data-testid="card-other-models" open={open} onToggle={onToggle && ((e) => onToggle(e.currentTarget.open))}>
      <summary>
        {t('info.models.title')}
        <span className="mono">{count}</span>
      </summary>
      <div className={styles.groups}>
        {groups.map((g) => (
          <section key={g.group}>
            <h4 className={styles.groupName}>{t(GROUP_LABEL[g.group])}</h4>
            <ul className={styles.groupNames}>
              {g.names.map((name) => (
                <li key={name} className="mono">
                  {name}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  )
}
