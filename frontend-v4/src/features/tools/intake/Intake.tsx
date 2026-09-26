import { useRef } from 'react'
import { useToasts } from '../../../ui/toasts'
import { tt, useTT, type ToolKey } from '../toolText'
import styles from './Intake.module.css'
import { firstImage, readClipboardImage, type IntakeOrigin } from './intakeFiles'

type OnFile = (file: File, origin: IntakeOrigin) => void

/** Paste from the clipboard by button; a browser that will not hand it over is told to use Ctrl+V. */
async function pasteByButton(onFile: OnFile): Promise<void> {
  try {
    const file = await readClipboardImage()
    if (file) onFile(file, 'paste')
    else useToasts.getState().push(tt('intake.noImageInClipboard'), 'info')
  } catch {
    useToasts.getState().push(tt('intake.pasteBlocked'), 'info')
  }
}

/** "Choose image…" and "Paste": the two ways in besides dropping. */
export function IntakeButtons({ onFile, primary = false }: { onFile: OnFile; primary?: boolean }) {
  const t = useTT()
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        data-testid="intake-file"
        onChange={(e) => {
          const file = firstImage(e.currentTarget.files)
          e.currentTarget.value = ''
          if (file) onFile(file, 'pick')
        }}
      />
      <button type="button" className={primary ? 'btn btn-primary' : 'btn'} onClick={() => input.current?.click()} data-testid="intake-pick">
        {t('intake.pick')}
      </button>
      <button type="button" className="btn" onClick={() => void pasteByButton(onFile)} title={t('intake.pasteHint')} data-testid="intake-paste">
        {t('intake.paste')} <kbd>Ctrl V</kbd>
      </button>
    </>
  )
}

/** Nothing loaded yet: where an image goes, and the three ways to bring one. */
export function IntakeZone({ onFile, lead, hint }: { onFile: OnFile; lead: ToolKey; hint: ToolKey }) {
  const t = useTT()
  return (
    <section className={styles.zone} data-testid="intake-zone">
      <div className={styles.frame} aria-hidden />
      <p className={styles.lead}>{t(lead)}</p>
      <div className={styles.buttons}>
        <IntakeButtons onFile={onFile} primary />
      </div>
      <p className={styles.hint}>{t(hint)}</p>
    </section>
  )
}

/** Shown while files are dragged over the window. */
export function DropOverlay({ label }: { label: ToolKey }) {
  const t = useTT()
  return (
    <div className={styles.overlay} aria-hidden data-testid="intake-drop-overlay">
      <p className={styles.overlayText}>{t(label)}</p>
    </div>
  )
}
