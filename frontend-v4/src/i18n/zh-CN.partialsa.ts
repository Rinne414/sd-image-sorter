// Features finished after the first port: colour analysis pause and hide, hiding the unreadable
// files line, metadata repair in Settings, the empty censor step, the tool cards on Home, the sort
// sound and focus mode in Settings, and the sort preview switch. Spread into zh-CN.ts; every key here
// must exist in en.partialsa.ts (the type enforces it). Keys start with 'partialsa.'.
export const zhCNPartialsA = {
  // ---- colour analysis, live in the library status
  'partialsa.colors.running': '正在分析色彩：{done} / {total}',
  'partialsa.colors.paused': '色彩分析已暂停：{done} / {total}',
  'partialsa.colors.pause': '暂停',
  'partialsa.colors.resume': '继续',
  'partialsa.colors.hide': '隐藏',
  'partialsa.colors.hideTitle': '隐藏这一行，分析仍在后台继续，进度看「任务」',
  'partialsa.colors.pausedItem': '已暂停',

  // ---- unreadable files line: hide for now
  'partialsa.unreadable.hide': '暂时隐藏',
  'partialsa.unreadable.hideTitle': '先不显示；打不开的文件数量变了，或者重新打开程序，会再出现',
  'partialsa.unreadable.hidden': '已隐藏。打不开的文件数量变了会再出现；「图库报告」里随时能看到。',

  // ---- Settings › Library: repair prompts and text
  'partialsa.repair.title': '修复提示词与文字',
  'partialsa.repair.hint': '把图片里的提示词和文字重新读一遍。不会移动或改名任何文件，只更新程序里记下的文字；做多久都在「任务」里看得到，随时可以停止，已处理的保留。',
  'partialsa.repair.recover.title': '找回缺失的文字',
  'partialsa.repair.recover.body': '为没有提示词、也没有说明文字的图片再找一次：先用导入时存下的原始信息，再读文件本身和同名的 .txt、.json 说明。',
  'partialsa.repair.recover.count': '现在有 {n} 张图片没有文字',
  'partialsa.repair.recover.nothing': '每张图片都有文字了，不需要找回。',
  'partialsa.repair.comfy.title': '重新读取 ComfyUI 提示词',
  'partialsa.repair.comfy.body': '把全部 ComfyUI 图片的提示词用现在的读取方式再读一遍，不管之前有没有。只有读出来不一样的才会改写；标签、评分和说明文字都不动。读取方式升级后用它。',
  'partialsa.repair.comfy.count': '图库里有 {n} 张 ComfyUI 图片',
  'partialsa.repair.comfy.nothing': '图库里没有 ComfyUI 图片。',
  'partialsa.repair.counting': '正在统计…',
  'partialsa.repair.countFailed': '没能统计数量，仍可开始。',
  'partialsa.repair.start': '开始',
  'partialsa.repair.running': '进行中…',
  'partialsa.repair.last': '上一次',
  'partialsa.repair.result.recover': '找回了 {recovered} 条提示词和 {captions} 条说明文字；还有 {still} 张没有文字。',
  'partialsa.repair.result.comfy': '{changed} 张读出了不同的提示词，{unchanged} 张本来就对，{kept} 张现在读不出提示词、保持原样，{missing} 个文件找不到。',
  'partialsa.repair.result.stopped': '已停止，已处理的保留。',
  'partialsa.repair.result.failed': '没有完成：{reason}',
  'partialsa.repair.comfy.running': '正在重新读取 ComfyUI 提示词：{n} 张',
  'partialsa.repair.comfy.done': '重新读取完成：{n} 张提示词有变化',

  // ---- a censor step with no images
  'partialsa.censorEmpty.open': '从图库添加图片',

  // ---- Home: tool cards
  'partialsa.home.tools': '工具',
  'partialsa.home.reader.body': '拖进一张图，看它的提示词和参数',
  'partialsa.home.privacy.body': '上传前把图混淆，之后还能还原',
  'partialsa.home.similar.title': '找相似图',
  'partialsa.home.similar.body': '选一张图，找出长得像的',
  'partialsa.home.dups.title': '查重复图',
  'partialsa.home.dups.body': '看近乎一样的图，决定留哪张',
  'partialsa.home.models.body': '下载和管理 AI 模型',
  'partialsa.home.all.title': '全部功能',
  'partialsa.home.all.body': '按 Ctrl K，搜索程序能做的每件事',

  // ---- Settings: sort sound and focus mode
  'partialsa.opt.on': '开',
  'partialsa.opt.off': '关',
  'partialsa.sound.title': '分拣时的声音',
  'partialsa.sound.hint': '图片分到某处时响一声。分拣页上的同名选项是同一个设置。',
  'partialsa.focus.title': '分拣时的专注模式',
  'partialsa.focus.hint': '分拣时隐藏顶栏，只留分拣；按 Esc 退出。分拣页上的同名选项是同一个设置。',

  // ---- Sort by condition: the preview switch
  'partialsa.preview.auto': '规则一改就自动预览',
  'partialsa.preview.autoHint': '图库很大、预览很慢时可以关掉，需要时再点「显示预览」。',
  'partialsa.preview.show': '显示预览',
  'partialsa.palette.showUnreadable': '重新显示无法读取的文件那一行',
  'partialsa.palette.pauseColors': '暂停颜色分析',
  'partialsa.palette.resumeColors': '继续颜色分析',
} as const
