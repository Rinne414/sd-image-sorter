// 词库 (features/tools/lexicon). Read through lexiconText.ts; every key here
// must exist in en.lexicon.ts (the type enforces it).
export const zhCNLexicon = {
  'lex.what': '图库里用到的每个标签、提示词、LoRA 和模型，以及多少张图用到它。点一项就放进图库搜索，再点一次拿掉。',

  // tabs and the controls above the list
  'lex.tab.tags': '标签',
  'lex.tab.prompts': '提示词',
  'lex.tab.loras': 'LoRA',
  'lex.tab.checkpoints': '模型',
  'lex.find': '找名字',
  'lex.find.placeholder': '名字里的字（下划线和空格一样）',
  'lex.sort': '排序',
  'lex.sort.count': '按图片数',
  'lex.sort.name': '按名字 A–Z',
  'lex.cat.filter': '分类',
  'lex.cat.all': '全部分类',
  'lex.cat.unknown': '未分类',

  // the list
  'lex.col.name': '名字',
  'lex.col.category': '分类',
  'lex.col.images': '图片数',
  'lex.shown': '显示 {shown} / {total} 项',
  'lex.total': '共 {n} 项',
  'lex.images': '{n} 张',
  'lex.row.add': '点一下放进图库搜索',
  'lex.row.remove': '已在图库搜索里，点一下拿掉',
  'lex.row.category': '{name} 的分类',
  'lex.loading': '正在读取…',
  'lex.loadFailed': '读不到：{reason}',
  'lex.noMatch': '没有名字里带“{q}”的项。',
  'lex.noCategory': '这个分类里没有标签。',
  'lex.empty.tags': '还没有标签。先给图打标签，这里就会有。',
  'lex.empty.prompts': '还没有提示词。导入带生成信息的图之后就会有。',
  'lex.empty.loras': '还没有用过 LoRA 的图。',
  'lex.empty.checkpoints': '还没有记录了模型的图。',

  // changing a tag's category
  'lex.recat.done': '已把 {name} 改到“{category}”',
  'lex.recat.failed': '没能改分类：{reason}',
  'lex.recat.hint': '改了分类，提示词助手的随机组合和标签颜色都跟着变。',

  // the library search, on the right
  'lex.query.title': '图库搜索',
  'lex.query.empty': '还是空的：点左边的一项放进来。',
  'lex.query.count': '{n} 张图符合',
  'lex.query.counting': '正在数…',
  'lex.query.scoped': '只算左栏选的范围',
  'lex.query.view': '在图库中查看',
  'lex.query.clear': '清空搜索',
  'lex.query.hint': '同一类的两项（两个 LoRA、两个模型）是“其中之一”；标签按图库现在的匹配方式（全部都有，或其中之一）。',
}
