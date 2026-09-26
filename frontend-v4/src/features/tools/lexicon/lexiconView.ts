import { create } from 'zustand'
import type { LexTab } from './lexiconQuery'
import type { LexSort } from './lexiconRows'

// What 词库 shows: the tab and the order are remembered (this browser only);
// the find text and the category choice last while the app is open.

const KEY = 'sd-v4-lexicon'
const TABS: readonly LexTab[] = ['tags', 'prompts', 'loras', 'checkpoints']

interface LexiconView {
  tab: LexTab
  sort: LexSort
  find: string
  /** Tags tab: one category, or every one (null). */
  category: string | null
}

function load(): Pick<LexiconView, 'tab' | 'sort'> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LexiconView> | null
    const tab = TABS.find((t) => t === raw?.tab) ?? 'tags'
    return { tab, sort: raw?.sort === 'name' ? 'name' : 'count' }
  } catch {
    return { tab: 'tags', sort: 'count' }
  }
}

export const useLexiconView = create<LexiconView>(() => ({ ...load(), find: '', category: null }))

export function setLexiconView(patch: Partial<LexiconView>): void {
  useLexiconView.setState(patch)
  const { tab, sort } = useLexiconView.getState()
  try {
    localStorage.setItem(KEY, JSON.stringify({ tab, sort }))
  } catch {
    // storage blocked: remembered until the page closes
  }
}

export const LEX_TABS = TABS
