import { useT, type MessageKey } from '../../../../i18n'
import { usePL, type PlKey } from '../plText'

// Names for the tag pool's categories and the backend's rule names.

/** The categories the app colours and names; anything else is a category the user made. */
const KNOWN = ['quality', 'meta', 'rating', 'character', 'body', 'outfit', 'expression', 'pose', 'action', 'angle', 'background', 'style', 'artist'] as const

export const isKnownCategory = (cat: string) => cat === 'unknown' || (KNOWN as readonly string[]).includes(cat)

export function useCategoryLabel() {
  const t = useT()
  return (cat: string): string => {
    if (cat === 'unknown') return t('lib.copy.group.unclassified')
    return (KNOWN as readonly string[]).includes(cat) ? t(`dataset.cat.${cat}` as MessageKey) : cat
  }
}

/** Built-in rules have code names (and three are the backend's English sentences): each gets a readable one. */
const RULE_NAMES: Record<string, PlKey> = {
  back_view_excludes_face: 'pl.rule.back_view_excludes_face',
  facing_away_excludes_face: 'pl.rule.facing_away_excludes_face',
  closed_eyes_excludes_eye_color: 'pl.rule.closed_eyes_excludes_eye_color',
  nude_excludes_outfit: 'pl.rule.nude_excludes_outfit',
  monochrome_excludes_colors: 'pl.rule.monochrome_excludes_colors',
  solo_excludes_interaction: 'pl.rule.solo_excludes_interaction',
  'Character count': 'pl.rule.characterCount',
  'Solo means one character': 'pl.rule.soloOne',
  'Solo versus solo focus': 'pl.rule.soloFocus',
}

export function useRuleName() {
  const p = usePL()
  return (name: string): string => {
    const key = RULE_NAMES[name]
    return key ? p(key) : name
  }
}

/** The built-in tag sets' names (the backend's are English); a set the user made keeps its own. */
const SET_NAMES: Record<string, PlKey> = {
  'School Uniform (Sailor)': 'pl.set.sailor',
  'School Uniform (Blazer)': 'pl.set.blazer',
  'Bikini': 'pl.set.bikini',
  'Maid Outfit': 'pl.set.maid',
  'Chinese Dress': 'pl.set.chineseDress',
  'Kimono': 'pl.set.kimono',
  'Casual (Summer)': 'pl.set.summer',
  'Lingerie': 'pl.set.lingerie',
  'Nude': 'pl.set.nude',
  'Witch': 'pl.set.witch',
}

export function useSetName() {
  const p = usePL()
  return (set: { id: number | string; name: string }): string => {
    const key = typeof set.id === 'string' && set.id.startsWith('builtin-') ? SET_NAMES[set.name] : undefined
    return key ? p(key) : set.name
  }
}
