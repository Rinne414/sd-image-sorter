// English counts read right when the count is 1: "{n} images are too small"
// is written "1 image is too small". The packs keep one plural sentence; when
// a count is exactly 1, format() writes the noun that follows it (maybe after
// one modifier, "{n} folder images") and a verb right after it ("are", "have")
// in the singular. i18n/packs.test.ts holds every English count in the packs
// to these lists. Chinese has no plural and never matches.

/** Nouns that follow a count, with their singular. */
export const PLURALS: Readonly<Record<string, string>> = {
  images: 'image',
  sources: 'source',
  conditions: 'condition',
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
  pictures: 'picture',
  videos: 'video',
  filters: 'filter',
  items: 'item',
  previews: 'preview',
  errors: 'error',
  warnings: 'warning',
  seconds: 'second',
  minutes: 'minute',
  grades: 'grade',
  comparisons: 'comparison',
  sections: 'section',
  prompts: 'prompt',
  blockers: 'blocker',
  regions: 'region',
  variants: 'variant',
  suggestions: 'suggestion',
  problems: 'problem',
  packages: 'package',
  edits: 'edit',
  detections: 'detection',
  candidates: 'candidate',
  GIFs: 'GIF',
  outliers: 'outlier',
  findings: 'finding',
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
  'indexed',
  'matching',
  'filter',
  'unique',
  'flagged',
  'duplicate',
  'redundant',
  'censored',
  'queued',
  'ready-made',
  'gallery',
  'moved',
  'sidecar',
  'noise',
  'local',
  'dataset',
  'unreadable',
  'middle',
  'near-identical',
  'scan',
  'original',
  'unconfirmed',
  'detection',
  'matched',
  'queue',
  'category',
  'existing',
  'trait',
  'disguise',
  'missing',
  'suspected',
  'filtered',
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
  need: 'needs',
  stop: 'stops',
  lack: 'lacks',
}

/** Words that may sit between the counted subject and its verb ("{n} already have", "{n} more are", "the {n} that have"). */
const LINKS = ['that', 'which', 'who']
const ADVERBS = ['already', 'now', 'still', 'just', 'also', 'more']
/**
 * A count after one of these is not the subject ("Caption edits for {n} images
 * were cleared"): its verb stays, unless a link word ties the verb to the
 * counted noun ("for {n} images that were not exported").
 */
const PREPOSITION_BEFORE = /\b(?:for|of|with|from|on|in|into|to|by|at|about|than|after|before|across|per|between|among)\s+(?:the\s+|all\s+|these\s+)?$/i

const word = (w: string) => w.replace(/[-]/g, '\\-')
const NOUN = `(?:(${[...MODIFIERS].map(word).join('|')}) )?(${Object.keys(PLURALS).join('|')})`
const VERB = `(?: (${LINKS.join('|')}))?(?: (${ADVERBS.join('|')}))? (${Object.keys(VERBS).join('|')})\\b`
const COUNTED = new RegExp(`\\{(\\w+)\\}(?: ${NOUN}\\b)?(?:${VERB})?`, 'g')

/** The template with every count that is exactly 1 followed by singular words ("{n} images are" -> "{n} image is"). */
export function singularize(template: string, params: Record<string, string | number>): string {
  return template.replace(COUNTED, (match, key: string, mod: string | undefined, noun: string | undefined, link: string | undefined, adverb: string | undefined, verb: string | undefined, offset: number) => {
    if (String(params[key]) !== '1' || (!noun && !verb)) return match
    const parts = [`{${key}}`]
    if (noun) parts.push(...(mod ? [mod] : []), PLURALS[noun] ?? noun)
    if (verb) {
      const isSubject = !!link || !PREPOSITION_BEFORE.test(template.slice(0, offset))
      parts.push(...[link, adverb].filter((w): w is string => !!w), isSubject ? (VERBS[verb] ?? verb) : verb)
    }
    return parts.join(' ')
  })
}
