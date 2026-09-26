import { useEffect, useMemo, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import { useCategories, useFavorites, useImageDetail, useSetRating, useToggleFavorite } from '../../api/queries'
import type { ImageTag, TagCategory } from '../../api/types'
import { useT } from '../../i18n'
import { fileSize } from '../../lib/format'
import { readImageInfo } from '../../lib/imageInfo'
import { readGeneration } from '../../lib/meta'
import { parentFolder, tailOfPath } from '../../lib/paths'
import { promptTagKeys, segmentPrompt, tagKey } from '../../lib/prompt'
import { useApp } from '../../state/store'
import styles from './Card.module.css'
import { PromptText } from './PromptText'
import { Stars } from './Stars'
import { Icon } from '../../ui/Icon'
import { Menu } from '../../ui/Menu'
import { TagInput } from '../../ui/TagInput'
import { addTags, removeTag, reparse, saveCaptions } from './cardEdits'
import { CopyButton, Section } from './CardParts'
import { EdgeCodes, type EdgeFacts } from './sections/FilmEdge'
import { CivitaiResources, Facts, NoParamsNote, OtherModels, PromptNodes, SidecarCaption, useI2iLabel } from '../info/CardInfo'
import { ColorSection } from '../info/ColorSection'
import { copyAndSay, openImageFolder } from '../library/fileActions'
import { menuItemsOf } from '../selection/actions'
import { useImageActions } from '../selection/actionOps'
import { showLikeImage } from '../similar/similarStore'
import { IdentifyButton } from '../tools/artist/IdentifyButton'
import { sendToTool } from '../tools/handoff'
import { useTT } from '../tools/toolText'

const TAGS_SHOWN = 24

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
  const info = useMemo(() => (image ? readImageInfo({ ...image, model_hash: image.model_hash ?? null }) : null), [image])
  const i2i = useI2iLabel(info)
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
  const edge = { gen, generator: image?.generator ?? null, rating: tags.rating, score: image?.aesthetic_score ?? null, i2i }

  return (
    <aside className={styles.card} data-variant={variant} data-testid="generation-card">
      {variant === 'panel' && <Frame id={id} edge={edge} />}

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
          aria-label={isFav ? t('card.unfavorite') : t('card.favorite')}
          aria-pressed={isFav}
          onClick={() => toggleFav.mutate({ ids: [id], favorited: !isFav })}
        >
          <Icon name="heart" filled={isFav} size={16} />
        </button>
        <Stars value={stars} onChange={(n) => setRating.mutate({ ids: [id], stars: n })} />
      </div>
      )}

      {variant === 'panel' && image?.path && <FileRow id={id} path={image.path} />}

      {image && !image.prompt && !gen?.characters.length && <NoParamsNote generator={image.generator} />}

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

      {image && info && <Facts id={id} image={image} gen={gen} info={info} />}

      {variant === 'overlay' && gen && <EdgeCodes {...edge} inline />}

      {info && info.civitai.length > 0 && <CivitaiResources list={info.civitai} />}

      {(tags.general.length > 0 || variant === 'panel') && (
        <TagList id={id} tags={tags.general} categories={categories.data} editable={variant === 'panel'} />
      )}

      {image && (
        <CaptionSection
          key={id}
          id={id}
          ai={image.ai_caption}
          nl={image.nl_caption}
          editable={variant === 'panel'}
        />
      )}

      {image?.sidecar_caption?.trim() && <SidecarCaption text={image.sidecar_caption.trim()} />}

      {image && <ColorSection id={id} image={image} />}

      {info && info.nodes.length > 0 && <PromptNodes nodes={info.nodes} />}

      {info && info.otherModels.length > 0 && <OtherModels groups={info.otherModels} />}

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
        {variant === 'panel' && image && (
          <button type="button" className="btn" onClick={() => showLikeImage(id, image.filename, false)} data-testid="card-find-similar">
            {t('sim.find.similar')}
          </button>
        )}
        {image && <CopyMenu id={id} />}
        {variant === 'panel' && image && <OpenInReader id={id} />}
        {variant === 'panel' && image && <IdentifyButton id={id} />}
        {variant === 'panel' && (
          <button type="button" className="btn btn-ghost" onClick={() => void reparse(id)} title={t('card.reparseHint')}>
            {t('card.reparse')}
          </button>
        )}
        {image?.file_size ? <span className={`${styles.muted} mono`}>{fileSize(image.file_size)}</span> : null}
      </div>
    </aside>
  )
}

/** Where the file lives, with the two ways to reach it. */
function FileRow({ id, path }: { id: number; path: string }) {
  const t = useT()
  const folder = parentFolder(path) ?? path
  return (
    <div className={styles.fileRow}>
      <span className={`${styles.folder} mono`} title={path}>
        {tailOfPath(folder, 56)}
      </span>
      <button
        type="button"
        className={styles.copy}
        onClick={() => void openImageFolder(id)}
        title={t('lib.file.openFolder')}
        aria-label={t('lib.file.openFolder')}
        data-testid="card-open-folder"
      >
        <Icon name="folder" size={14} />
      </button>
      <button
        type="button"
        className={styles.copy}
        onClick={() => void copyAndSay(path, { key: 'lib.file.path' })}
        title={t('lib.file.copyPath')}
        aria-label={t('lib.file.copyPath')}
        data-testid="card-copy-path"
      >
        <Icon name="copy" size={14} />
      </button>
    </div>
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

function Frame({ id, edge }: { id: number; edge: EdgeFacts }) {
  const [bigLoaded, setBigLoaded] = useState<number | null>(null)
  const openLightbox = useApp((s) => s.openLightbox)
  return (
    <figure className={styles.frame}>
      <EdgeCodes {...edge} part="top" />
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
      <EdgeCodes {...edge} part="bottom" />
    </figure>
  )
}

/** The image's captions; in the side card they can be written or cleared. */
function CaptionSection({ id, ai, nl, editable }: { id: number; ai: string | null; nl: string | null; editable: boolean }) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [aiText, setAiText] = useState(ai ?? '')
  const [nlText, setNlText] = useState(nl ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (editing) return
    setAiText(ai ?? '')
    setNlText(nl ?? '')
  }, [ai, nl, editing])

  const shown = nl || ai
  if (!shown && !editable) return null

  if (editing) {
    const save = async () => {
      const patch: { ai_caption?: string; nl_caption?: string } = {}
      if (aiText !== (ai ?? '')) patch.ai_caption = aiText
      if (nlText !== (nl ?? '')) patch.nl_caption = nlText
      setSaving(true)
      const ok = await saveCaptions(id, patch)
      setSaving(false)
      if (ok) setEditing(false)
    }
    return (
      <section className={styles.section} data-testid="caption-editor">
        <header className={styles.sectionHead}>
          <span className={styles.label}>{t('card.caption')}</span>
        </header>
        <label className={styles.captionField}>
          <span>{t('card.nlCaption')}</span>
          <textarea value={nlText} rows={3} onChange={(e) => setNlText(e.target.value)} autoFocus />
        </label>
        <label className={styles.captionField}>
          <span>{t('card.aiCaption')}</span>
          <textarea value={aiText} rows={2} onChange={(e) => setAiText(e.target.value)} />
        </label>
        <div className={styles.captionActions}>
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {t('card.saveCaption')}
          </button>
        </div>
      </section>
    )
  }

  const edit = editable ? (
    <button type="button" className={styles.more} onClick={() => setEditing(true)}>
      {shown ? t('card.editCaption') : t('card.addCaption')}
    </button>
  ) : undefined
  return (
    <Section label={t('card.caption')} copy={shown ? shown : undefined} action={edit}>
      {shown && <p className={styles.caption}>{shown}</p>}
    </Section>
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
    <div className={styles.negativeRow}>
      <button type="button" className={styles.negative} data-open={open || undefined} onClick={() => setOpen(!open)}>
        <span className={styles.label}>{t('card.negative')}</span>
        <span className={styles.negText}>{text}</span>
      </button>
      <CopyButton text={text} compact testId="card-copy-negative" />
    </div>
  )
}

/** The Reader shows everything the file records, and edits it. */
function OpenInReader({ id }: { id: number }) {
  const t = useTT()
  return (
    <button type="button" className="btn btn-ghost" onClick={() => sendToTool('reader', [id])} title={t('reader.openInReaderHint')} data-testid="card-open-reader">
      {t('reader.openInReader')}
    </button>
  )
}

/** Every "copy part of this image" choice, the same list as the right-click menu's Copy. */
function CopyMenu({ id }: { id: number }) {
  const t = useT()
  const copy = useImageActions(id).find((a) => a.id === 'copy')
  if (!copy?.children?.length) return null
  return <Menu label={t('card.copy')} items={menuItemsOf(t, copy.children)} up align="right" testId="card-copy-menu" />
}

function TagList({
  id,
  tags,
  categories,
  editable,
}: {
  id: number
  tags: ImageTag[]
  categories: Map<string, TagCategory> | undefined
  editable: boolean
}) {
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
            className={`chip cat-${categories?.get(tagKey(tg.tag)) ?? 'unknown'} ${styles.tagChip}`}
            title={tg.confidence ? `${Math.round(tg.confidence * 100)}%` : undefined}
          >
            {tg.tag.replace(/_/g, ' ')}
            {editable && (
              <button
                type="button"
                className={styles.tagRemove}
                onClick={() => void removeTag(id, tg.tag)}
                aria-label={t('card.removeTag', { tag: tg.tag })}
                title={t('card.removeTag', { tag: tg.tag })}
              >
                <Icon name="close" size={10} />
              </button>
            )}
          </span>
        ))}
        {tags.length > TAGS_SHOWN && (
          <button type="button" className={styles.more} onClick={() => setAll(!all)}>
            {all ? t('card.fewerTags') : t('card.allTags', { n: tags.length })}
          </button>
        )}
      </div>
      {editable && (
        <TagInput
          placeholder={t('card.addTag')}
          label={t('card.addTag')}
          onSubmit={(added) => addTags(id, added)}
          testId="card-tag-input"
        />
      )}
    </section>
  )
}
