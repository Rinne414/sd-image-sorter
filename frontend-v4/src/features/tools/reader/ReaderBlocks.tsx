import type { TagCategory } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { copyText } from '../../../lib/format'
import { modelFilterValue } from '../../../lib/imageInfo'
import { shortModelName } from '../../../lib/meta'
import type { GroupedTags, TagGroupId } from '../../../lib/tagGroups'
import { TAG_GROUPS } from '../../../lib/tagGroups'
import { tagKey } from '../../../lib/prompt'
import { isAnyOf, isKey, replaceTokens, tokenValue } from '../../../lib/queryEdit'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { CopyButton } from '../../card/CardParts'
import { PromptText } from '../../card/PromptText'
import { filterByModel } from '../../info/modelFilter'
import { tt, useTT, type ToolKey } from '../toolText'
import { Fold } from './Fold'
import styles from './Reader.module.css'
import { promptLoraWeight, type NamedHash, type ReaderView } from './readerAdapter'

// The Reader's sections beyond the prompt: NovelAI characters, the models
// and LoRAs with their hashes, every parameter, and the tags by category.

type Categories = Map<string, TagCategory> | undefined

const civitaiSearch = (query: string) => `https://civitai.com/search/models?sortBy=models_v9&query=${encodeURIComponent(query)}`

export function CharactersBlock({ view, convert, categories }: { view: ReaderView; convert: (text: string) => string; categories: Categories }) {
  const t = useTT()
  const list = view.gen.characters
  if (list.length === 0) return null
  return (
    <Fold id="characters" label={t('reader.characters')} count={list.length}>
      <ol className={styles.characters}>
        {list.map((c) => (
          <li key={c.index} data-testid="reader-character">
            <header className={styles.characterHead}>
              <span className={`${styles.castNo} mono`}>{c.index + 1}</span>
              {c.center && <span className={`${styles.muted} mono`}>{t('reader.characterAt', { x: c.center.x.toFixed(2), y: c.center.y.toFixed(2) })}</span>}
              <CopyButton text={convert(c.prompt)} compact />
            </header>
            <PromptText text={convert(c.prompt)} categories={categories} />
            {c.negative && (
              <p className={styles.characterNegative}>
                <span className={styles.subLabel}>{t('reader.characterNegative')}</span> {convert(c.negative)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </Fold>
  )
}

function HashLink({ hash }: { hash: string }) {
  const t = useTT()
  return (
    <span className={styles.hashRow}>
      <button type="button" className={`${styles.hash} mono`} title={t('reader.copyHash')} onClick={() => void copyText(hash)}>
        {hash}
      </button>
      <CivitaiLink query={hash} />
    </span>
  )
}

function CivitaiLink({ query }: { query: string }) {
  const t = useTT()
  return (
    <a className={styles.link} href={civitaiSearch(query)} target="_blank" rel="noopener noreferrer" title={t('reader.civitaiHint')}>
      Civitai
    </a>
  )
}

function ModelName({ kind, name }: { kind: 'checkpoint' | 'lora'; name: string }) {
  const t = useT()
  return (
    <button
      type="button"
      className={styles.modelName}
      title={`${name}\n${t(kind === 'checkpoint' ? 'info.filterModel' : 'info.filterLora')}`}
      onClick={() => filterByModel(kind, name)}
      data-testid={`reader-${kind}-name`}
    >
      {shortModelName(name)}
    </button>
  )
}

function hashOf(list: NamedHash[], name: string): string | null {
  const want = modelFilterValue(name).toLowerCase()
  return list.find((h) => modelFilterValue(h.name).toLowerCase() === want)?.hash ?? null
}

/** The checkpoint, each LoRA (weight, hash) and embedding; a name filters the library, Civitai searches by hash or name. */
export function ModelsBlock({ view }: { view: ReaderView }) {
  const t = useTT()
  const { gen, hashes, info } = view
  if (!gen.model && gen.loras.length === 0 && hashes.embeddings.length === 0) return null
  const modelHash = info.modelHash ?? hashes.model
  return (
    <Fold id="models" label={t('reader.models')}>
      <dl className={styles.models}>
        {gen.model && (
          <div className={styles.modelRow}>
            <dt className={styles.subLabel}>{t('reader.checkpoint')}</dt>
            <dd>
              <ModelName kind="checkpoint" name={gen.model} />
              {modelHash ? <HashLink hash={modelHash} /> : <CivitaiLink query={shortModelName(gen.model)} />}
            </dd>
          </div>
        )}
        {gen.loras.map((name) => {
          const weight = info.loraWeight(name) ?? promptLoraWeight(view.prompt, name)
          const hash = hashOf(hashes.loras, name)
          return (
            <div key={name} className={styles.modelRow} data-testid="reader-lora">
              <dt className={styles.subLabel}>LoRA</dt>
              <dd>
                <ModelName kind="lora" name={name} />
                {weight && <span className={`${styles.weight} mono`}>{weight}</span>}
                {hash ? <HashLink hash={hash} /> : <CivitaiLink query={shortModelName(name)} />}
              </dd>
            </div>
          )
        })}
        {hashes.embeddings.map((e) => (
          <div key={e.name} className={styles.modelRow}>
            <dt className={styles.subLabel}>{t('reader.embedding')}</dt>
            <dd>
              <span className={styles.plainName}>{e.name}</span>
              <HashLink hash={e.hash} />
            </dd>
          </div>
        ))}
      </dl>
    </Fold>
  )
}

const PARAM_ROWS: [ToolKey, (v: ReaderView) => string | null][] = [
  ['reader.param.seed', (v) => v.gen.seed],
  ['reader.param.steps', (v) => v.gen.steps],
  ['reader.param.cfg', (v) => v.gen.cfg],
  ['reader.param.sampler', (v) => v.gen.sampler],
  ['reader.param.scheduler', (v) => v.gen.scheduler],
  ['reader.param.size', (v) => v.gen.size],
  ['reader.param.denoise', (v) => v.gen.denoise],
]

/** Every parameter the file records: the main ones by name, then the rest as the parser named them. */
export function ParamsBlock({ view }: { view: ReaderView }) {
  const t = useTT()
  const main = PARAM_ROWS.flatMap(([key, read]) => {
    const value = read(view)
    return value ? [[t(key), value] as const] : []
  })
  const rows = [...main, ...view.gen.extra.map(([k, v]) => [k.replace(/_/g, ' '), v] as const)]
  if (rows.length === 0) return null
  return (
    <Fold id="params" label={t('reader.params')} count={rows.length}>
      <dl className={styles.params}>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">
              <button type="button" className={styles.paramValue} title={t('reader.clickToCopy')} onClick={() => void copyText(v)}>
                {v}
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </Fold>
  )
}

export const GROUP_LABEL: Record<TagGroupId, MessageKey> = {
  appearance: 'lib.copy.group.appearance',
  clothing: 'lib.copy.group.clothing',
  pose: 'lib.copy.group.pose',
  scenery: 'lib.copy.group.scenery',
  style: 'lib.copy.group.style',
  qualityMeta: 'lib.copy.group.qualityMeta',
  unclassified: 'lib.copy.group.unclassified',
}

/** The library shows images carrying all these tags (earlier tag filters give way). */
export function findTagsInLibrary(tags: readonly string[], group: string): void {
  const s = useApp.getState()
  const tokens = tags.map((tag) => `tag:${tokenValue(tag.trim().replace(/\s+/g, '_'))}`)
  s.setQueryText(replaceTokens(s.queryText, isAnyOf(isKey('tag'), isKey('-tag')), tokens))
  if (s.page !== 'library') s.setPage('library')
  useToasts.getState().push(tt('reader.found', { group, n: tags.length }), 'info')
}

/** The tags by category, each group with Copy and Find in library. */
export function TagGroupsBlock({ groups, total, fromPrompt, categories }: { groups: GroupedTags | null; total: number; fromPrompt: boolean; categories: Categories }) {
  const t = useT()
  const r = useTT()
  if (total === 0) return null
  return (
    <Fold id="tags" label={r('reader.tags')} count={total}>
      <p className={styles.muted}>{r(fromPrompt ? 'reader.tagsFromPrompt' : 'reader.tagsFromLibrary')}</p>
      {!groups ? (
        <p className={styles.muted}>{t('lib.menu.loading')}</p>
      ) : (
        <ul className={styles.groups}>
          {TAG_GROUPS.filter(({ id }) => groups[id].length > 0).map(({ id }) => {
            const list = groups[id]
            const label = t(GROUP_LABEL[id])
            return (
              <li key={id} className={styles.group} data-testid={`reader-group-${id}`}>
                <header className={styles.groupHead}>
                  <span className={styles.subLabel}>
                    {label} <span className="mono">{list.length}</span>
                  </span>
                  <CopyButton text={list.join(', ')} compact />
                  <button type="button" className={styles.textButton} onClick={() => findTagsInLibrary(list, label)} title={r('reader.findHint')} data-testid="reader-find">
                    {r('reader.find')}
                  </button>
                </header>
                <div className={styles.chips}>
                  {list.map((tag) => (
                    <span key={tag} className={`chip cat-${categories?.get(tagKey(tag)) ?? 'unknown'}`}>
                      {tag.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Fold>
  )
}
