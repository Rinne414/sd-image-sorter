import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Menu, type MenuItem } from '../../ui/Menu'
import { useToasts } from '../../ui/toasts'
import { quickCensor } from '../censor/quickCensor'
import { useSelectionDialog } from '../selection/dialogs'
import { TOOLS } from './registry'

/** The images "打码…" and "批量改标签…" act on: the picks, else the image being looked at. */
function targetIds(): number[] {
  const s = useApp.getState()
  if (s.selection.length > 0) return [...s.selection]
  return s.inspectedId !== null ? [s.inspectedId] : []
}

/** Top bar "工具 ▾": every tool, then censoring and tag editing for the picked or open image. */
export function ToolsMenu() {
  const t = useT()
  const page = useApp((s) => s.page)
  const picks = useApp((s) => s.selection.length)

  const onImages = (run: (ids: number[]) => void) => () => {
    const ids = targetIds()
    if (ids.length === 0) useToasts.getState().push(t('tools.pickFirst'))
    else run(ids)
  }

  const items: MenuItem[] = [
    ...TOOLS.map((tool) => ({ id: `tool-${tool.id}`, label: t(tool.label), onSelect: () => useApp.getState().openTool(tool.id) })),
    {
      id: 'censor',
      label: picks > 1 ? t('tools.censorMany', { n: picks }) : t('tools.censor'),
      divider: true,
      onSelect: onImages((ids) => void quickCensor(ids)),
    },
    {
      id: 'edit-tags',
      label: picks > 1 ? t('tools.editTagsMany', { n: picks }) : t('tools.editTags'),
      onSelect: onImages((ids) => useSelectionDialog.getState().showFor('edit-tags', ids, ids.length)),
    },
  ]

  return <Menu label={t('tools.menu')} title={t('tools.menuTitle')} items={items} align="right" current={page === 'tools'} testId="tools-menu" />
}
