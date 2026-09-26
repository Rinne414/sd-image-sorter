import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { PageBoundary } from '../../ui/PageBoundary'
import { PageHead } from '../../ui/PageHead'
import { useBack } from '../settings/useBack'
import styles from './ToolPage.module.css'
import { toolById } from './registry'

/** A tool as a page (#/tools/<tool>). */
export function ToolPage() {
  const t = useT()
  const id = useApp((s) => s.toolId)
  const back = useBack()
  const tool = toolById(id)
  const Page = tool.page

  return (
    <section className={styles.page} data-testid="tool-page" data-tool={id}>
      <PageHead backLabel={back.label} onBack={back.go} title={t(tool.label)} testId="tool-back" />
      {/* A tool lays out and scrolls its own page. */}
      <main className={styles.tool}>
        <PageBoundary key={id}>
          <Page />
        </PageBoundary>
      </main>
    </section>
  )
}
