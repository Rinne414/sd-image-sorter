import { useMemo, useState } from 'react'
import { useCategories } from '../../../api/queries'
import type { ImageDetailResponse } from '../../../api/types'
import { convertPrompt, type PromptFormat } from '../../../lib/promptFormat'
import { promptTagKeys, segmentPrompt, tagKey } from '../../../lib/prompt'
import { groupTags } from '../../../lib/tagGroups'
import { CivitaiResources, OtherModels, PromptNodes, SidecarCaption } from '../../info/CardInfo'
import { ColorBody, PixelHistogram, PixelPalette } from '../../info/ColorSection'
import colorStyles from '../../info/ColorSection.module.css'
import { useTT } from '../toolText'
import { Fold, setFold, useFoldOpen } from './Fold'
import { MetadataEditor, type EditorSource } from './MetadataEditor'
import { PromptBlock, type ShownPrompt } from './PromptBlock'
import styles from './Reader.module.css'
import { CharactersBlock, ModelsBlock, ParamsBlock, TagGroupsBlock } from './ReaderBlocks'
import type { ReaderView } from './readerAdapter'

// The right column of the Reader: every section of one image's generation
// details, then the editor.

/** The tags shown by category: the library's own for a library image, else the prompt's. */
function readerTags(prompt: string, detail: ImageDetailResponse | null): { tags: string[]; fromPrompt: boolean } {
  const own = (detail?.tags ?? [])
    .filter((tg) => tg.category !== 'rating')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map((tg) => tg.tag)
  if (own.length > 0) return { tags: own, fromPrompt: false }
  const fromPrompt = segmentPrompt(prompt).flatMap((seg) => (seg.kind === 'tag' ? [seg.text] : []))
  return { tags: [...new Set(fromPrompt)], fromPrompt: true }
}

function useShownPrompt(view: ReaderView, format: PromptFormat): { shown: ShownPrompt; convert: (text: string) => string } {
  return useMemo(() => {
    const convert = (text: string) => convertPrompt(text, view.sourceFormat, format)
    const toSd = (text: string) => convertPrompt(text, view.sourceFormat, 'sd')
    return {
      convert,
      shown: { prompt: convert(view.prompt), negative: convert(view.negative), sdPrompt: toSd(view.prompt), sdNegative: toSd(view.negative) },
    }
  }, [view, format])
}

function Workflow({ view }: { view: ReaderView }) {
  const nodesOpen = useFoldOpen('nodes', false)
  const modelsOpen = useFoldOpen('otherModels', false)
  return (
    <>
      {view.info.civitai.length > 0 && <CivitaiResources list={view.info.civitai} />}
      {view.info.nodes.length > 0 && <PromptNodes nodes={view.info.nodes} open={nodesOpen} onToggle={(open) => setFold('nodes', open)} />}
      {view.info.otherModels.length > 0 && <OtherModels groups={view.info.otherModels} open={modelsOpen} onToggle={(open) => setFold('otherModels', open)} />}
    </>
  )
}

interface Props {
  view: ReaderView
  detail: ImageDetailResponse | null
  /** The picture's address, for the histogram of a file brought in. */
  pixels: { src: string; key: string } | null
  pasted: boolean
  editor: EditorSource | null
}

export function ReaderInfo({ view, detail, pixels, pasted, editor }: Props) {
  const t = useTT()
  const [format, setFormat] = useState<PromptFormat>('original')
  const { shown, convert } = useShownPrompt(view, format)
  const { tags, fromPrompt } = useMemo(() => readerTags(view.prompt, detail), [view.prompt, detail])
  const keys = useMemo(() => {
    const all = promptTagKeys(segmentPrompt(view.prompt))
    for (const c of view.gen.characters) all.push(...promptTagKeys(segmentPrompt(c.prompt)))
    for (const tag of tags) all.push(tagKey(tag))
    return [...new Set(all)]
  }, [view, tags])
  const categories = useCategories(keys)
  const groups = useMemo(() => (categories.data ? groupTags(tags, (tag) => categories.data.get(tagKey(tag))) : null), [tags, categories.data])

  return (
    <>
      <PromptBlock view={view} shown={shown} format={format} onFormat={setFormat} categories={categories.data} tags={tags} groups={groups} pasted={pasted} />
      <CharactersBlock view={view} convert={convert} categories={categories.data} />
      <ModelsBlock view={view} />
      <ParamsBlock view={view} />
      <TagGroupsBlock groups={groups} total={tags.length} fromPrompt={fromPrompt} categories={categories.data} />
      <Workflow view={view} />
      {view.sidecar && <SidecarCaption text={view.sidecar} />}
      <Fold id="colors" label={t('reader.colors')} openByDefault={false}>
        {detail ? <ColorBody id={detail.image.id} image={detail.image} /> : pixels && (
          <div className={colorStyles.body}>
            <PixelHistogram src={pixels.src} cacheKey={['reader-bins', pixels.key]} />
            <PixelPalette src={pixels.src} cacheKey={['reader-palette', pixels.key]} />
            <p className={styles.muted}>{t('reader.colorsUpload')}</p>
          </div>
        )}
      </Fold>
      {editor && <MetadataEditor view={view} source={editor} />}
    </>
  )
}
