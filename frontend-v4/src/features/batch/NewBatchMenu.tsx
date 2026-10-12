import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import menuStyles from '../../ui/Menu.module.css'
import { deleteTemplate, useBatchTemplates } from './batchApi'
import { askNewBatch } from './dialogStore'
import styles from './NewBatchMenu.module.css'
import { BATCH_KINDS, kindLabel } from './labels'

/** "New batch ▾" on the Batch page: a built-in kind or one of my templates (which can be deleted here). */
export function NewBatchMenu() {
  const t = useT()
  const templates = useBatchTemplates()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))
  const mine = templates.data?.templates ?? []

  const choose = (run: () => void) => {
    setOpen(false)
    run()
  }

  return (
    <div className={menuStyles.wrap} ref={ref}>
      <button
        type="button"
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="new-batch"
      >
        {t('batch.list.new')}
        <span className={menuStyles.caret} aria-hidden>
          <Icon name="caret" size={13} />
        </span>
      </button>
      {open && (
        <ul className={menuStyles.menu} data-align="right" role="menu">
          <li role="presentation" className={menuStyles.group}>
            {t('batch.menu.builtin')}
          </li>
          {BATCH_KINDS.map((kind) => (
            <li key={kind}>
              <button type="button" role="menuitem" onClick={() => choose(() => askNewBatch(kind, [], 'page'))}>
                <span className={menuStyles.check} aria-hidden />
                <span className={menuStyles.itemLabel}>{t(`batch.menu.new.${kind}`)}</span>
              </button>
            </li>
          ))}
          <li role="presentation" className={menuStyles.group} data-divider>
            {t('batch.menu.templates')}
          </li>
          {mine.length === 0 && <li className={styles.empty}>{t('batch.menu.noTemplates')}</li>}
          {mine.map((tpl) => (
            <li key={tpl.id} className={styles.row}>
              <button type="button" role="menuitem" onClick={() => choose(() => askNewBatch(tpl.kind, [], 'page', tpl))}>
                <span className={menuStyles.check} aria-hidden />
                <span className={menuStyles.itemLabel}>{tpl.name}</span>
                <kbd>{kindLabel(tpl.kind, t)}</kbd>
              </button>
              <button
                type="button"
                className={styles.remove}
                aria-label={t('batch.menu.deleteTemplate', { name: tpl.name })}
                title={t('batch.menu.deleteTemplate', { name: tpl.name })}
                onClick={() => void deleteTemplate(tpl)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
