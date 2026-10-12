import type { zhCNBrowse } from './zh-CN.browse'

export const enBrowse: Record<keyof typeof zhCNBrowse, string> = {
  'qop.any': 'any of',
  'qop.contains': 'contains',
  'searchWarn.anyTagAlone': '"Any of" tags work on their own: put the other tags in the | list too',
  'searchHelp.tagAny': 'Images with at least one of these tags, separated by |. One such list per search, with no other required tags.',
  'searchHelp.promptContains': 'The prompt contains this text, also inside longer words. With a * every prompt condition matches this way.',

  'browse.filter.tags': 'Tags',
  'browse.filter.tagsAdd': 'Add tags, press Enter',
  'browse.filter.tagAll': 'All of them',
  'browse.filter.tagAny': 'Any of them',
  'browse.filter.prompt': 'Prompt',
  'browse.filter.promptAdd': 'Add prompt words, press Enter',
  'browse.filter.promptExact': 'Whole words',
  'browse.filter.promptContains': 'Contains the text',

  'browse.folder.inside': '{name}: folders inside',

  'browse.empty.title': 'This library has no images yet',
  'browse.empty.hint': 'Import a folder, or drop images onto the window.',
  'browse.empty.import': 'Import images…',
  'browse.noMatch.hint': 'Try other words, or clear the filters to see every image in this library.',
  'browse.noMatch.clear': 'Clear filters',

  'browse.grid.label': 'Images',
  'browse.tile.label': 'Image {n} of {total}: {name}',
  'browse.tile.labelOpen': 'Image {n}: {name}',
  'browse.tile.stars': '{n} stars',
  'browse.tile.favorite': 'favourite',
  'browse.tile.picked': 'picked',
  'browse.tile.sep': ', ',

  'browse.resume.back': 'Back where you left off',
  'browse.resume.top': 'Back to top',

  'browse.skip': 'Skip to main content',
}
