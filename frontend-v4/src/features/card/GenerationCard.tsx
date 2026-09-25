import { useMemo, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import { useCategories, useFavorites, useImageDetail, useSetRating, useToggleFavorite } from '../../api/queries'
import type { ImageTag, TagCategory } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { copyText, fileSize, generatorCode } from '../../lib/format'
import { readGeneration, shortModelName, toParameterText, type GenerationInfo } from '../../lib/meta'
import { promptTagKeys, segmentPrompt, tagKey } from '../../lib/prompt'
import { useApp } from '../../state/store'
import styles from './Card.module.css'
import { PromptText } from './PromptText'
import { Stars } from './Stars'

const TAGS_SHOWN = 24

const RATING_KEYS: Record<string, MessageKey> = {
  general: 'rating.general',
  sensitive: 'rating.sensitive',
  questionable: 'rating.questionable',
  explicit: 'rating.explicit',
}

interface Props {
  id: number | null
  /** 'panel' = right column in the library; 'overlay' = beside the big image. */
  variant?: 'panel' | 'overlay'
}

export function GenerationCard({ id, variant = 'panel' }: Props) {
  const t = useT()
  if (id === null) {
    return (
      <aside className={styles.card} data-variant={variant} data-testid="generation-card">
        <div className={styles.empty}>
          <div className={styles.emptyFrame} aria-hidden />
          <p>{t('card.empty')}</p>
          <p className={styles.muted}>{t('card.emptyKeys')}</p>
        </div>
      </aside>
    )
  }
  return <CardBody id={id} variant={variant} />
}

function CardBody({ id, variant }: { id: number; variant: 'panel' | 'overlay' }) {
  const t = useT()
  const detail = useImageDetail(id)
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()
  const openLightbox = useApp((s) => s.openLightbox)

  const image = detail.data?.image
  const tags = useMemo(() => sortTags(detail.data?.tags ?? []), [detail.data])
  const gen = useMemo(() => (image ? readGeneration(image) : null), [image])
  const promptSegments = useMemo(() => segmentPrompt(image?.prompt ?? ''), [image?.prompt])
  const keys = useMemo(() => {
    const all = promptTagKeys(promptSegments)
    for (const tg of tags.general) all.push(tagKey(tg.tag))
    for (const c of gen?.characters ?? []) all.push(...promptTagKeys(segmentPrompt(c.prompt)))
    return all
  }, [promptSegments, tags, gen])
  const categories = useCategories(keys)

  if (detail.isError) {
    return (
      <aside className={styles.card} data-variant={variant} data-testid="generation-card">
        <p className={styles.error}>{t('card.loadError', { reason: String(detail.error.message) })}</p>
      </aside>
    )
  }

  const isFav = favorites.data?.ids.has(id) ?? false
  const stars = image?.user_rating ?? 0

  return (
    <aside className={styles.card} data-variant={variant} data-testid="generation-card">
      {variant === 'panel' && <Frame id={id} gen={gen} generator={image?.generator ?? null} rating={tags.rating} />}

      {variant === 'panel' && (
      <div className={styles.titleRow}>
        <span className={`${styles.filename} mono`} title={image?.path}>
          {image?.filename ?? '…'}
        </span>
        <button
          type="button"
          className={styles.heartBtn}
          data-on={isFav || undefined}
          title={isFav ? t('card.unfavorite') : t('card.favorite')}
          aria-pressed={isFav}
          onClick={() => toggleFav.mutate({ ids: [id], favorited: !isFav })}
        >
          ♥
        </button>
        <Stars value={stars} onChange={(n) => setRating.mutate({ ids: [id], stars: n })} />
      </div>
      )}

      {image && !image.prompt && !gen?.characters.length && <p className={styles.muted}>{t('card.noPrompt')}</p>}

      {image?.prompt && (
        <Section label={t('card.prompt')} copy={image.prompt}>
          <Expandable>
            <PromptText text={image.prompt} categories={categories.data} />
          </Expandable>
        </Section>
      )}

      {image?.negative_prompt && <Negative text={image.negative_prompt} />}

      {gen && gen.characters.length > 0 && (
        <Section label={t('card.characters')}>
          <ol className={styles.characters}>
            {gen.characters.map((c) => (
              <li key={c.index}>
                <span className={`${styles.castNo} mono`}>{c.index + 1}</span>
                <PromptText text={c.prompt} categories={categories.data} />
              </li>
            ))}
          </ol>
        </Section>
      )}

      {gen && (gen.model || gen.loras.length > 0) && (
        <div className={styles.models}>
          {gen.model && (
            <div className={styles.modelRow}>
              <span className={styles.label}>{t('card.model')}</span>
              <span className={styles.modelName} title={gen.model}>
                {shortModelName(gen.model)}
              </span>
            </div>
          )}
          {gen.loras.length > 0 && (
            <div className={styles.modelRow}>
              <span className={styles.label}>{t('card.loras')}</span>
              <span className={styles.loras}>
                {gen.loras.map((l) => (
                  <span key={l} className={styles.lora} title={l}>
                    {shortModelName(l)}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {variant === 'overlay' && gen && <EdgeCodes gen={gen} generator={image?.generator ?? null} rating={tags.rating} inline />}

      {tags.general.length > 0 && <TagList tags={tags.general} categories={categories.data} />}

      {(image?.nl_caption || image?.ai_caption) && (
        <Section label={t('card.caption')} copy={image.nl_caption ?? image.ai_caption ?? ''}>
          <p className={styles.caption}>{image.nl_caption ?? image.ai_caption}</p>
        </Section>
      )}

      {gen && gen.extra.length > 0 && (
        <details className={styles.extra}>
          <summary>
            {t('card.moreParams')}
            <span className="mono">+{gen.extra.length}</span>
          </summary>
          <dl>
            {gen.extra.map(([k, v]) => (
              <div key={k}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <div className={styles.actions}>
        {variant === 'panel' && (
          <button type="button" className="btn btn-primary" onClick={() => openLightbox(id)}>
            {t('card.openFull')} <kbd>Enter</kbd>
          </button>
        )}
        {image && gen && (
          <CopyButton text={toParameterText(image.prompt, image.negative_prompt, gen)} label={t('card.copyAll')} />
        )}
        {image?.file_size ? <span className={`${styles.muted} mono`}>{fileSize(image.file_size)}</span> : null}
      </div>
    </aside>
  )
}

function sortTags(tags: ImageTag[]): { general: ImageTag[]; rating: string | null } {
  let rating: string | null = null
  let best = -1
  const general: ImageTag[] = []
  for (const tg of tags) {
    if (tg.category === 'rating') {
      if ((tg.confidence ?? 0) > best) {
        best = tg.confidence ?? 0
        rating = tg.tag
      }
      continue
    }
    general.push(tg)
  }
  general.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  return { general, rating }
}

function Frame({
  id,
  gen,
  generator,
  rating,
}: {
  id: number
  gen: GenerationInfo | null
  generator: string | null
  rating: string | null
}) {
  const [bigLoaded, setBigLoaded] = useState<number | null>(null)
  const openLightbox = useApp((s) => s.openLightbox)
  return (
    <figure className={styles.frame}>
      <EdgeCodes gen={gen} generator={generator} rating={rating} part="top" />
      <div className={styles.window} onDoubleClick={() => openLightbox(id)}>
        <img className={styles.under} src={thumbnailUrl(id, 384)} alt="" draggable={false} />
        <img
          key={id}
          className={styles.over}
          data-ready={bigLoaded === id || undefined}
          src={thumbnailUrl(id, 768)}
          alt=""
          draggable={false}
          onLoad={() => setBigLoaded(id)}
        />
      </div>
      <EdgeCodes gen={gen} generator={generator} rating={rating} part="bottom" />
    </figure>
  )
}

/** Parameters printed on the film edge; click a code to copy its value. */
function EdgeCodes({
  gen,
  generator,
  rating,
  part,
  inline,
}: {
  gen: GenerationInfo | null
  generator: string | null
  rating?: string | null
  part?: 'top' | 'bottom'
  inline?: boolean
}) {
  const t = useT()
  // [label, what is shown, what gets copied]
  type Code = [string, string, string]
  const code = (label: string, value: string | null | undefined, shown?: string): Code | null =>
    value ? [label, shown ?? value, value] : null
  const ratingKey = rating && RATING_KEYS[rating]
  const top = [
    code('SEED', gen?.seed),
    code('', gen?.steps, gen?.steps ? t('edge.steps', { n: gen.steps }) : undefined),
    code('CFG', gen?.cfg),
    code('', gen?.denoise, gen?.denoise ? t('edge.denoise', { n: gen.denoise }) : undefined),
  ]
  const bottom = [
    code('', gen?.sampler),
    code('', gen?.scheduler),
    code('', gen?.size),
    code('', rating, ratingKey ? t(ratingKey) : undefined),
    code('', generatorCode(generator)),
  ]
  const rows = inline ? [...top, ...bottom] : part === 'top' ? top : bottom
  const shown = rows.filter((c): c is Code => c !== null)
  return (
    <div className={styles.edgeStrip} data-part={part} data-inline={inline || undefined}>
      {!inline && <span className={styles.holes} aria-hidden />}
      <span className={styles.codes}>
        {shown.map(([label, display, value]) => (
          <button
            key={`${label}${value}`}
            type="button"
            className={styles.code}
            title={t('card.clickToCopy')}
            onClick={() => void copyText(value)}
          >
            {label && <span className={styles.codeKey}>{label}</span>}
            {display.toUpperCase()}
          </button>
        ))}
      </span>
    </div>
  )
}

function Section({ label, copy, children }: { label: string; copy?: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.label}>{label}</span>
        {copy !== undefined && <CopyButton text={copy} compact />}
      </header>
      {children}
    </section>
  )
}

function Expandable({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={styles.expandable} data-open={open || undefined} onClick={() => setOpen(true)}>
      {children}
    </div>
  )
}

function Negative({ text }: { text: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <button type="button" className={styles.negative} data-open={open || undefined} onClick={() => setOpen(!open)}>
      <span className={styles.label}>{t('card.negative')}</span>
      <span className={styles.negText}>{text}</span>
    </button>
  )
}

function TagList({ tags, categories }: { tags: ImageTag[]; categories: Map<string, TagCategory> | undefined }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const shown = all ? tags : tags.slice(0, TAGS_SHOWN)
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.label}>
          {t('card.tags')} <span className="mono">{tags.length}</span>
        </span>
        <CopyButton text={tags.map((tg) => tg.tag).join(', ')} compact />
      </header>
      <div className={styles.chips}>
        {shown.map((tg) => (
          <span
            key={tg.tag}
            className={`chip cat-${categories?.get(tagKey(tg.tag)) ?? 'unknown'}`}
            title={tg.confidence ? `${Math.round(tg.confidence * 100)}%` : undefined}
          >
            {tg.tag.replace(/_/g, ' ')}
          </span>
        ))}
        {tags.length > TAGS_SHOWN && (
          <button type="button" className={styles.more} onClick={() => setAll(!all)}>
            {all ? t('card.fewerTags') : t('card.allTags', { n: tags.length })}
          </button>
        )}
      </div>
    </section>
  )
}

function CopyButton({ text, label, compact }: { text: string; label?: string; compact?: boolean }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true)
      window.setTimeout(() => setDone(false), 1200)
    }
  }
  if (compact) {
    return (
      <button type="button" className={styles.copy} onClick={() => void onClick()} title={t('card.copy')}>
        {done ? t('card.copied') : '⧉'}
      </button>
    )
  }
  return (
    <button type="button" className="btn" onClick={() => void onClick()}>
      {done ? t('card.copied') : label}
    </button>
  )
}
