import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { PageBoundary } from '../../ui/PageBoundary'
import { PageHead } from '../../ui/PageHead'
import { useBack } from '../settings/useBack'
import { PlannedTool } from './PlannedTool'
import styles from './ToolPage.module.css'
import { toolById } from './registry'

/** A tool as a page (#/tools/<tool>): its own page once built, until then what it is for and where it works today. */
export function ToolPage() {
  const t = useT()
  const id = useApp((s) => s.toolId)
  const back = useBack()
  const tool = toolById(id)
  const Page = tool.ready ? tool.page : undefined

  return (
    <section className={styles.page} data-testid="tool-page" data-tool={id}>
      <PageHead backLabel={back.label} onBack={back.go} title={t(tool.label)} testId="tool-back" />
      {/* A built tool lays out and scrolls its own page; the placeholder gets the page margins. */}
      <main className={Page ? styles.tool : styles.content}>
        {Page ? (
          <PageBoundary key={id}>
            <Page />
          </PageBoundary>
        ) : (
          <PlannedTool what={tool.what} note="tools.planned" testId="tool-planned" />
        )}
      </main>
    </section>
  )
}
