// Three features that were only partly in V Opus: the tag blacklist's ready
// lists, "leave out what is already sorted" in Sort, and sorting the batch
// queue into groups (with saved profiles). Spread into zh-CN.ts; every key here
// must exist in en.partialsb.ts (the type enforces it). Keys start with 'partialsb.'.
export const zhCNPartialsB = {
  // tag dialog: ready lists for the blacklist box
  'partialsb.bl.group': '黑名单常用词表',
  'partialsb.bl.quality': '+ 质量词（masterpiece、score_* 等）',
  'partialsb.bl.qualityTip': '把常见的质量词（masterpiece、score_9_up 等）加进黑名单，已有的不会重复',
  'partialsb.bl.meta': '+ 元信息（签名、水印、jpeg_artifacts 等）',
  'partialsb.bl.metaTip': '把签名、水印、画面本身的标记（单色、草图、打码等）加进黑名单，已有的不会重复',
  'partialsb.bl.clear': '清空',

  // Sort: already-sorted pictures
  'partialsb.sorted.leaveOut': '不分已经分过的图',
  'partialsb.sorted.tip': '自动分拣或之前的手动分拣已经复制或移动过的图，这次先不分',
  'partialsb.sorted.counting': '正在数有多少已经分过…',
  'partialsb.sorted.none': '这些图还都没分过。',
  'partialsb.sorted.left': '已分过 {n} / {total}，这次不分',
  'partialsb.sorted.included': '已分过 {n} / {total}，这次也会再分一遍',
  'partialsb.sorted.allDone': '这些图都已经分过了。想再分一遍，请先关掉“不分已经分过的图”。',

  // queue sort: the menu
  'partialsb.sort.button': '排序',
  'partialsb.sort.working': '正在排序…',
  'partialsb.sort.tip': '把队列按分级、美学评分、分辨率或你保存的方案分组排好',
  'partialsb.sort.heading': '自动排序',
  'partialsb.sort.rating': '按分级分组',
  'partialsb.sort.aesthetic': '按美学评分分组',
  'partialsb.sort.resolution': '按分辨率分组',
  'partialsb.sort.tooFew': '队列里至少要有两张图才能排序。',
  'partialsb.sort.changed': '排序时队列变了，没有改动顺序。请再排一次。',
  'partialsb.sort.done': '已按“{name}”排好。',
  'partialsb.sort.already': '队列已经是“{name}”的顺序。',
  'partialsb.sort.failed': '排序失败：{reason}',

  // queue sort: the groups
  'partialsb.group.general': '普通',
  'partialsb.group.sensitive': '敏感',
  'partialsb.group.questionable': '可疑',
  'partialsb.group.explicit': '露骨',
  'partialsb.group.unrated': '未分级',
  'partialsb.group.great': '很好（7 分及以上）',
  'partialsb.group.good': '不错（5 到 7 分）',
  'partialsb.group.low': '偏低（5 分以下）',
  'partialsb.group.unscored': '没有评分',
  'partialsb.group.hd': '大图（长边 1920 及以上）',
  'partialsb.group.sd': '小图（长边 1920 以下）',
  'partialsb.group.unknown': '尺寸未知',
  'partialsb.group.unsorted': '没有归入任何组',

  // queue sort: the Order step's marks
  'partialsb.legend.title': '排序：{name}',
  'partialsb.legend.clear': '隐藏分组',

  // saved profiles
  'partialsb.profile.heading': '我的方案',
  'partialsb.profile.none': '还没有保存的方案',
  'partialsb.profile.manage': '管理方案…',
  'partialsb.profile.title': '排序方案',
  'partialsb.profile.help': '一个方案是一组按顺序排列的规则。每张图归入它符合的第一条规则；都不符合的放在最后一组。条件的写法和图库搜索一样。',
  'partialsb.profile.pick': '选择方案',
  'partialsb.profile.new': '新建方案',
  'partialsb.profile.delete': '删除方案',
  'partialsb.profile.name': '方案名称',
  'partialsb.profile.defaultName': '我的方案',
  'partialsb.profile.ruleName': '分组 {n}',
  'partialsb.profile.ruleLabel': '第 {n} 条规则的分组名',
  'partialsb.profile.tone': '分组颜色',
  'partialsb.profile.condition': '第 {n} 条规则的条件',
  'partialsb.profile.conditionHint': '条件，如 tag:cat rating:general；留空表示所有图',
  'partialsb.profile.removeRule': '删除第 {n} 条规则',
  'partialsb.profile.addRule': '添加规则',
  'partialsb.profile.rest': '都不符合的图会放在最后。',
  'partialsb.profile.save': '保存',
  'partialsb.profile.apply': '保存并排序',
  'partialsb.profile.unsaved': '有改动还没保存',
  'partialsb.profile.unsavedWarn': '有改动还没保存。再点一次“放弃改动”会直接关闭。',
  'partialsb.profile.discard': '放弃改动',

  // group colours
  'partialsb.tone.gray': '灰色',
  'partialsb.tone.green': '绿色',
  'partialsb.tone.gold': '暖色',
  'partialsb.tone.red': '红色',
  'partialsb.tone.light': '浅色',
} as const
