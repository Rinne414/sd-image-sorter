import type { TagCategory } from '../../../api/types'
import { useT } from '../../../i18n'
import { toParameterText } from '../../../lib/meta'
import type { PromptFormat } from '../../../lib/promptFormat'
import { TAG_GROUPS, type GroupedTags } from '../../../lib/tagGroups'
import { Menu, type MenuItem } from '../../../ui/Menu'
import { CopyButton } from '../../card/CardParts'
import { PromptText } from '../../card/PromptText'
import { NoParamsNote } from '../../info/CardInfo'
import { copyAndSay } from '../../library/fileActions'
import { useTT, type ToolKey } from '../toolText'
import { Fold } from './Fold'
import styles from './Reader.module.css'
import { GROUP_LABEL } from './ReaderBlocks'
import type { ReaderView } from './readerAdapter'

type Categories = Map<string, TagCategory> | undefined

/** The prompt and negative in the chosen syntax (original, SD, NovelAI). */
export interface ShownPrompt {
  prompt: string
  negative: string
  /** The prompt as SD writes it, for "Copy as SD text". */
  sdPrompt: string
  sdNegative: string
}

const FORMATS: [PromptFormat, ToolKey][] = [
  ['original', 'reader.format.original'],
  ['sd', 'reader.format.sd'],
  ['nai', 'reader.format.nai'],
]

function FormatSwitch({ value, onChange }: { value: PromptFormat; onChange: (f: PromptFormat) => void }) {
  const t = useTT()
  return (
    <span className={styles.segment} role="group" aria-label={t('reader.format')} title={t('reader.formatHint')}>
      {FORMATS.map(([f, key]) => (
        <button key={f} type="button" aria-pressed={value === f} onClick={() => onChange(f)} data-testid={`reader-format-${f}`}>
          {t(key)}
        </button>
      ))}
    </span>
  )
}

/** "Copy ▾": the prompt, negative, settings, SD text, everything, and the tags by category. */
function CopyMenu({ view, shown, tags, groups }: { view: ReaderView; shown: ShownPrompt; tags: string[]; groups: GroupedTags | null }) {
  const t = useT()
  const r = useTT()
  const items: MenuItem[] = []
  const add = (id: string, label: string, value: string, extra: Partial<MenuItem> = {}) => {
    if (value) items.push({ id, label, onSelect: () => void copyAndSay(value, { text: label }), ...extra })
  }
  const settings = toParameterText(null, null, view.gen)
  add('prompt', r('reader.copy.prompt'), shown.prompt)
  add('negative', r('reader.copy.negative'), shown.negative)
  add('settings', r('reader.copy.settings'), settings)
  add('sd', r('reader.copy.sd'), toParameterText(shown.sdPrompt || null, shown.sdNegative || null, view.gen))
  add('all', r('reader.copy.all'), toParameterText(shown.prompt || null, shown.negative || null, view.gen))
  if (tags.length > 0) {
    const group = t('lib.copy.byCategory')
    add('tags', t('lib.copy.allTags'), tags.join(', '), { group, divider: true, hint: String(tags.length) })
    for (const { id } of TAG_GROUPS) {
      const list = groups?.[id] ?? []
      add(`group-${id}`, t(GROUP_LABEL[id]), list.join(', '), { hint: String(list.length) })
    }
  }
  return <Menu label={t('card.copy')} items={items} align="right" testId="reader-copy-menu" />
}

interface Props {
  view: ReaderView
  shown: ShownPrompt
  format: PromptFormat
  onFormat: (f: PromptFormat) => void
  categories: Categories
  tags: string[]
  groups: GroupedTags | null
  pasted: boolean
}

export function PromptBlock({ view, shown, format, onFormat, categories, tags, groups, pasted }: Props) {
  const t = useTT()
  const converted = format !== 'original' && view.sourceFormat !== 'unknown' && view.sourceFormat !== format
  const hasText = !!(view.prompt || view.gen.characters.length)
  const actions = (
    <span className={styles.foldActions}>
      {view.prompt && <FormatSwitch value={format} onChange={onFormat} />}
      <CopyMenu view={view} shown={shown} tags={tags} groups={groups} />
    </span>
  )
  return (
    <>
      <Fold id="prompt" label={t('reader.prompt')} actions={actions}>
        {view.prompt ? (
          <>
            <PromptText text={shown.prompt} categories={categories} />
            {converted && <p className={styles.muted}>{t('reader.convertedNote', { from: t(view.sourceFormat === 'nai' ? 'reader.format.nai' : 'reader.format.sd') })}</p>}
          </>
        ) : pasted ? (
          <p className={styles.note} data-testid="reader-no-params">{t('reader.pastedNoParams')}</p>
        ) : (
          !hasText && <NoParamsNote generator={view.generator} />
        )}
      </Fold>
      {shown.negative && (
        <Fold id="negative" label={t('reader.negative')} actions={<CopyButton text={shown.negative} compact />}>
          <p className={styles.negativeText}>{shown.negative}</p>
        </Fold>
      )}
    </>
  )
}
