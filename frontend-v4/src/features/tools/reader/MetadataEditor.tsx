import { useEffect, useMemo, useState } from 'react'
import { useTT, type ToolKey } from '../toolText'
import { Fold } from './Fold'
import styles from './Reader.module.css'
import { changedFields, fieldProblem, fieldsOf, formatOf, payloadOf, samePath, type MetaFields } from './metadataForm'
import type { ReaderView } from './readerAdapter'
import { SaveBox, type SaveTarget } from './SaveBox'
import { OverwriteDialog } from './SaveParts'
import { overwriteOriginal, saveCopy, type Saved } from './saveFlows'

// Edit the nine generation fields and save them into a new image; a library
// image can also be written back into its own file (confirmed, undoable once).

export interface EditorSource {
  /** What saving reads from: the library file, or the upload's kept copy. */
  sourcePath: string
  /** The name a copy is called after. */
  name: string
  /** A library image can be overwritten. */
  library: { id: number; path: string } | null
}

const TEXT_FIELDS: [keyof MetaFields, ToolKey][] = [
  ['seed', 'reader.edit.seed'],
  ['model', 'reader.edit.model'],
  ['sampler', 'reader.edit.sampler'],
  ['steps', 'reader.edit.steps'],
  ['cfg', 'reader.edit.cfg'],
  ['size', 'reader.edit.size'],
]

type Problem = 'steps' | 'cfg' | null

function Fields({ fields, set, problem }: { fields: MetaFields; set: (k: keyof MetaFields, v: string) => void; problem: Problem }) {
  const t = useTT()
  const input = (k: keyof MetaFields, label: ToolKey) => (
    <label key={k} className={styles.field}>
      <span>{t(label)}</span>
      <input value={fields[k]} onChange={(e) => set(k, e.target.value)} spellCheck={false} aria-invalid={problem === k || undefined} data-testid={`reader-edit-${k}`} />
    </label>
  )
  return (
    <>
      <label className={styles.field}>
        <span>{t('reader.edit.prompt')}</span>
        <textarea rows={4} value={fields.prompt} onChange={(e) => set('prompt', e.target.value)} data-testid="reader-edit-prompt" />
      </label>
      <label className={styles.field}>
        <span>{t('reader.edit.negative')}</span>
        <textarea rows={2} value={fields.negative} onChange={(e) => set('negative', e.target.value)} data-testid="reader-edit-negative" />
      </label>
      <div className={styles.fieldGrid}>{TEXT_FIELDS.map(([k, label]) => input(k, label))}</div>
      {input('loras', 'reader.edit.loras')}
      {problem && (
        <p className={styles.problem} role="alert">
          {t(problem === 'steps' ? 'reader.edit.badSteps' : 'reader.edit.badCfg')}
        </p>
      )}
    </>
  )
}

/** Writing into the library image's own file, kept apart from the everyday save. */
function OverwriteBox({ canWrite, changed, busy, onAsk }: { canWrite: boolean; changed: boolean; busy: boolean; onAsk: () => void }) {
  const t = useTT()
  return (
    <div className={styles.dangerBox}>
      <p className={styles.muted}>{t(canWrite ? 'reader.edit.overwriteLead' : 'reader.edit.overwriteNoFormat')}</p>
      <button type="button" className="btn btn-danger" onClick={onAsk} disabled={busy || !canWrite || !changed} title={canWrite && !changed ? t('reader.edit.overwriteNothing') : undefined} data-testid="reader-overwrite">
        {t('reader.edit.overwrite')}
      </button>
    </div>
  )
}

export function MetadataEditor({ view, source }: { view: ReaderView; source: EditorSource }) {
  const t = useTT()
  const original = useMemo(() => fieldsOf(view), [view])
  const [fields, setFields] = useState<MetaFields>(original)
  const [problem, setProblem] = useState<Problem>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [asking, setAsking] = useState(false)
  // The file was re-read (after a save or an undo): the form starts from what it now says.
  useEffect(() => setFields(original), [original])

  const changed = changedFields(original, fields)
  const library = source.library
  const libraryFormat = library ? formatOf(library.path) : null
  const set = (k: keyof MetaFields, v: string) => {
    setFields((f) => ({ ...f, [k]: v }))
    setProblem(null)
  }
  const checked = (): boolean => {
    const p = fieldProblem(fields)
    setProblem(p)
    return p === null
  }
  const run = async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await work()
    } finally {
      setBusy(false)
    }
  }
  const saveAsNew = async ({ outputPath, format, replace }: SaveTarget): Promise<'exists' | 'done' | 'failed'> => {
    if (!checked()) return 'failed'
    if (library && samePath(outputPath, library.path)) {
      setAsking(true)
      return 'done'
    }
    const done = await run(() => saveCopy({ sourcePath: source.sourcePath, outputPath, format, metadata: payloadOf(fields), overwrite: replace }))
    if (done === 'exists') return 'exists'
    if (done) setSaved(done)
    return done ? 'done' : 'failed'
  }
  const overwrite = async () => {
    if (!library || !libraryFormat) return
    const done = await run(() => overwriteOriginal({ id: library.id, path: library.path, format: libraryFormat }, payloadOf(fields), payloadOf(original)))
    if (done) setSaved(done)
  }

  return (
    <Fold id="editor" label={t('reader.edit')} openByDefault={false}>
      <div className={styles.editor} data-testid="reader-editor-form">
        <Fields fields={fields} set={set} problem={problem} />
        <div className={styles.editorRow}>
          <button type="button" className="btn btn-ghost" onClick={() => setFields(original)} disabled={changed.length === 0}>
            {t('reader.edit.reset')}
          </button>
          <span className={styles.muted}>{changed.length ? t('reader.edit.changed', { n: changed.length }) : t('reader.edit.unchanged')}</span>
        </div>
        <SaveBox name={source.name} libraryPath={library?.path ?? null} busy={busy} saved={saved} onSave={saveAsNew} />
        {library && <OverwriteBox canWrite={!!libraryFormat} changed={changed.length > 0} busy={busy} onAsk={() => checked() && setAsking(true)} />}
      </div>
      {asking && library && (
        <OverwriteDialog
          name={source.name}
          format={libraryFormat}
          changed={changed.length}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            void overwrite()
          }}
        />
      )}
    </Fold>
  )
}
