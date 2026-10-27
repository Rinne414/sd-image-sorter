import { useEffect, useState } from 'react'
import { useImageDetail } from '../../api/queries'
import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { openPicture } from './MapLightbox'
import { useMap } from './mapStore'
import { NearCard } from './NearCard'
import styles from './Side.module.css'
import { SPACE_WHAT } from './status'

const PREVIEW_SIZE = 512
/** The name is read once the pointer rests on a dot (not for every dot it crosses). */
const NAME_DELAY_MS = 150

/** What this map does, the picture under the pointer, the nearest pictures of a picture, and how to read the map. */
export function SidePanel() {
  const t = useT()
  const space = useMap((s) => s.space)
  return (
    <aside className={styles.side} data-testid="stylemap-side">
      <p className={styles.what} data-testid="stylemap-space-what">
        {t(SPACE_WHAT[space])}
      </p>
      <Preview />
      <NearCard />
      <details className={styles.help}>
        <summary>{t('stylemap.help.title')}</summary>
        <ul>
          <li>{t('stylemap.help.rotate')}</li>
          <li>{t('stylemap.help.click')}</li>
          <li>{t('stylemap.help.pick')}</li>
          <li>{t('stylemap.help.near')}</li>
          <li>{t('stylemap.help.members')}</li>
          <li>{t('stylemap.help.landmarks')}</li>
        </ul>
      </details>
    </aside>
  )
}

function Preview() {
  const t = useT()
  const preview = useMap((s) => s.preview)
  const named = useSettled(preview?.id ?? null)
  const detail = useImageDetail(named)
  const name = named !== null && named === preview?.id ? detail.data?.image.filename : undefined
  return (
    <div className={styles.preview} data-testid="stylemap-preview">
      <div className={styles.previewBox}>
        {preview ? (
          <button type="button" className={styles.previewOpen} onClick={() => void openPicture(preview.id, preview.members)} title={t('stylemap.preview.open')}>
            <img src={thumbnailUrl(preview.id, PREVIEW_SIZE)} alt="" data-testid="stylemap-preview-img" data-id={preview.id} />
          </button>
        ) : (
          <span className={styles.previewHint}>{t('stylemap.preview.hint')}</span>
        )}
      </div>
      {preview && (
        <div className={styles.previewName} title={name ?? undefined}>
          {name ?? `#${preview.id}`}
        </div>
      )}
      {preview && preview.members > 1 && <div className={styles.previewMembers}>{t('stylemap.preview.members', { n: preview.members })}</div>}
    </div>
  )
}

function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), NAME_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [value])
  return settled
}
