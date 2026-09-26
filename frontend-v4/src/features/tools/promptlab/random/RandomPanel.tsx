import { CategoryBrowser } from './CategoryBrowser'
import { Presets } from './Presets'
import styles from './Random.module.css'
import { usePool, usePresets, useRules, useTagSets } from './randomApi'
import { Rules } from './Rules'
import { RunPanel } from './RunPanel'
import { SlotList } from './SlotList'
import { TagSets } from './TagSets'

// 随机: the tag pool on the left; on the right generating (and the prompts it
// wrote) and the slots, then tag sets, presets and exclusion rules.

export function RandomPanel() {
  const pool = usePool()
  const sets = useTagSets()
  const rules = useRules()
  const presets = usePresets()
  const ruleList = rules.data ?? []
  return (
    <div className={styles.random} data-testid="pl-random">
      <CategoryBrowser pool={pool.data} loading={pool.isPending} error={pool.isError ? pool.error.message : null} />
      <div className={styles.work}>
        <RunPanel pool={pool.data} rules={ruleList} sets={sets.data ?? []} />
        <SlotList pool={pool.data ?? {}} rules={ruleList} />
        <div className={styles.wide}>
          <TagSets sets={sets.data ?? []} categories={Object.keys(pool.data ?? {})} />
        </div>
        <Presets presets={presets.data ?? []} />
        <Rules rules={ruleList} />
      </div>
    </div>
  )
}
