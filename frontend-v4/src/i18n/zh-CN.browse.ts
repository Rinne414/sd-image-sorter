// Browsing the library: per-library search, the folder tree, match modes in
// the search line and the filter panel, empty states, coming back to the same
// place in the grid, and screen-reader labels. Spread into zh-CN.ts; every
// key here must exist in en.browse.ts (the type enforces it).
export const zhCNBrowse = {
  'qop.any': '任一',
  'qop.contains': '包含',
  'searchWarn.anyTagAlone': '“任一”标签要单独用：把其他标签也写进 | 里',
  'searchHelp.tagAny': '有其中任何一个标签就算，用 | 隔开。整条搜索只能有这一组，不能再另外要求别的标签。',
  'searchHelp.promptContains': '提示词里含有这段文字就算，可以是更长的词的一部分。写了 * 之后，所有提示词条件都按“包含”来找。',

  'browse.filter.tags': '标签',
  'browse.filter.tagsAdd': '加标签，回车确定',
  'browse.filter.tagAll': '全部都要',
  'browse.filter.tagAny': '有任一个就行',
  'browse.filter.prompt': '提示词',
  'browse.filter.promptAdd': '加提示词，回车确定',
  'browse.filter.promptExact': '整个词',
  'browse.filter.promptContains': '包含这段文字',

  'browse.folder.inside': '{name} 里的文件夹',

  'browse.empty.title': '这个图库还没有图片',
  'browse.empty.hint': '导入一个文件夹，或者把图片拖进窗口。',
  'browse.empty.import': '导入图片…',
  'browse.noMatch.hint': '换个关键词，或者清除筛选，看这个图库里的全部图片。',
  'browse.noMatch.clear': '清除筛选',

  'browse.grid.label': '图片',
  'browse.tile.label': '第 {n} 张，共 {total} 张：{name}',
  'browse.tile.labelOpen': '第 {n} 张：{name}',
  'browse.tile.stars': '{n} 星',
  'browse.tile.favorite': '已收藏',
  'browse.tile.picked': '已挑选',
  'browse.tile.sep': '，',

  'browse.resume.back': '回到了上次看到的位置',
  'browse.resume.top': '回到顶部',

  'browse.skip': '跳到主要内容',
}
