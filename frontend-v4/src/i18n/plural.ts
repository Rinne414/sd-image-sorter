// English counts read right when the count is 1: "{n} images are too small"
// is written "1 image is too small". The packs keep one plural sentence; when
// a count is exactly 1, format() writes the noun that follows it (maybe after
// one modifier, "{n} folder images") and a verb right after it ("are", "have")
// in the singular. i18n/packs.test.ts holds every English count in the packs
// to these lists. Chinese has no plural and never matches.

/** Nouns that follow a count, with their singular. */
export const PLURALS: Readonly<Record<string, string>> = {
  images: 'image',
  records: 'record',
  tags: 'tag',
  captions: 'caption',
  tokens: 'token',
  stars: 'star',
  pairs: 'pair',
  groups: 'group',
  words: 'word',
  times: 'time',
  steps: 'step',
  rounds: 'round',
  originals: 'original',
  models: 'model',
  megapixels: 'megapixel',
  folders: 'folder',
  threads: 'thread',
  notes: 'note',
  frames: 'frame',
  issues: 'issue',
  duplicates: 'duplicate',
  details: 'detail',
  conflicts: 'conflict',
  categories: 'category',
  batches: 'batch',
  artists: 'artist',
  areas: 'area',
  epochs: 'epoch',
  files: 'file',
  requests: 'request',
  posts: 'post',
  favorites: 'favorite',
  collections: 'collection',
  libraries: 'library',
  presets: 'preset',
  rules: 'rule',
  sets: 'set',
  results: 'result',
  names: 'name',
  entries: 'entry',
  boxes: 'box',
  copies: 'copy',
  masks: 'mask',
  jobs: 'job',
  matches: 'match',
}

/** Words that may stand between a count and its noun ("{n} folder images"). */
export const MODIFIERS: ReadonlySet<string> = new Set([
  'folder',
  'image',
  'old',
  'more',
  'new',
  'edited',
  'hand-edited',
  'untagged',
  'uncensored',
  'selected',
  'scored',
  'picked',
  'generated',
  'extra',
  'common',
  'other',
  'library',
  'clearable',
])

/** Verbs right after a counted subject, with their singular. */
export const VERBS: Readonly<Record<string, string>> = {
  are: 'is',
  were: 'was',
  have: 'has',
  do: 'does',
  look: 'looks',
  spell: 'spells',
  share: 'shares',
  match: 'matches',
  belong: 'belongs',
  use: 'uses',
}

/** Words that may sit between the counted subject and its verb ("{n} already have", "{n} more are", "the {n} that have"). */
const LINKS = ['that', 'which', 'who']
const ADVERBS = ['already', 'now', 'still', 'just', 'also', 'more']

const word = (w: string) => w.replace(/[-]/g, '\\-')
const NOUN = `(?:(${[...MODIFIERS].map(word).join('|')}) )?(${Object.keys(PLURALS).join('|')})`
const VERB = `(?: (${LINKS.join('|')}))?(?: (${ADVERBS.join('|')}))? (${Object.keys(VERBS).join('|')})\\b`
const COUNTED = new RegExp(`\\{(\\w+)\\}(?: ${NOUN}\\b)?(?:${VERB})?`, 'g')

/** The template with every count that is exactly 1 followed by singular words ("{n} images are" -> "{n} image is"). */
export function singularize(template: string, params: Record<string, string | number>): string {
  return template.replace(COUNTED, (match, key: string, mod?: string, noun?: string, link?: string, adverb?: string, verb?: string) => {
    if (String(params[key]) !== '1' || (!noun && !verb)) return match
    const parts = [`{${key}}`]
    if (noun) parts.push(...(mod ? [mod] : []), PLURALS[noun] ?? noun)
    if (verb) parts.push(...[link, adverb].filter((w): w is string => !!w), VERBS[verb] ?? verb)
    return parts.join(' ')
  })
}
