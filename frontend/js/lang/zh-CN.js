/**
 * SD Image Sorter - Simplified Chinese (简体中文) Language Pack
 *
 * Technical terms kept in English: ONNX, YOLO, CLIP, WD14, ComfyUI,
 * NovelAI, WebUI, Forge, LoRA, CFG, Sampler, img2img, NudeNet, etc.
 *
 * Key naming convention matches en.js exactly.
 */

window.I18nLang_zhCN = {

    // ========================
    // Navigation
    // ========================
    'nav.gallery': '图库',
    'nav.autosep': '自动分类',
    'nav.manual': '手动排序',
    'nav.censor': '马赛克编辑',
    'nav.similar': '相似图片',
    'nav.promptlab': '提示词工坊',
    'nav.artist': '画师识别',
    'nav.experimental': '实验性',
    'nav.navigation': '导航',

    // ========================
    // Brand / App Title
    // ========================
    'brand.name': 'SD 图片管理器',

    // ========================
    // Nav Actions (top bar buttons)
    // ========================
    'action.scan': '扫描文件夹',
    'action.tag': '标记图片',
    'action.library': '标签库',
    'action.help': '帮助',
    'action.clearGallery': '清空图库',

    // ========================
    // Gallery View
    // ========================
    'gallery.imageCount': '{count} 张图片',
    'gallery.noImages': '暂无图片',
    'gallery.scanPrompt': '扫描文件夹以开始管理您的 AI 生成图片',
    'gallery.loading': '正在加载图片...',
    'gallery.loadMore': '加载更多',
    'gallery.random': '随机',
    'gallery.selectImages': '选择图片',
    'gallery.editFilters': '编辑筛选',
    'gallery.filters': '筛选',

    // Generator tabs (technical names kept in English)
    'generator.all': '全部',
    'generator.nai': 'NovelAI',
    'generator.comfyui': 'ComfyUI',
    'generator.forge': 'Forge',
    'generator.webui': 'WebUI',
    'generator.unknown': '未知',

    // Sort options
    'sort.newest': '最新',
    'sort.oldest': '最早',
    'sort.nameAsc': '文件名 (A-Z)',
    'sort.nameDesc': '文件名 (Z-A)',
    'sort.generator': '生成器',
    'sort.promptLength': '提示词长度',
    'sort.tagCount': '标签数量',
    'sort.rating': '分级 (NSFW 优先)',
    'sort.characterCount': '角色数量',
    'sort.fileSize': '文件最大',
    'sort.fileSizeAsc': '文件最小',
    'sort.random': '随机',

    // View modes
    'view.grid': '网格视图',
    'view.large': '大图视图',
    'view.waterfall': '瀑布流视图',

    // ========================
    // Filters
    // ========================
    'filter.title': '筛选器',
    'filter.filterImages': '筛选图片',
    'filter.description': '在一个窗口里同时设置来源、分级、标签、提示词、Checkpoint 和 LoRA 筛选。',
    'filter.generators': '生成器',
    'filter.ratings': '分级',
    'filter.tags': '标签',
    'filter.checkpoints': 'Checkpoints',
    'filter.loras': 'LoRAs',
    'filter.prompt': '提示词',
    'filter.promptSearch': '提示词搜索',
    'filter.artist': '画师',
    'filter.dimensions': '尺寸与比例',
    'filter.clearAll': '清除所有筛选',
    'filter.apply': '应用筛选',
    'filter.reset': '重置全部',
    'filter.browseLibrary': '浏览标签库',
    'filter.searchTags': '搜索标签...',
    'filter.searchPrompts': '搜索提示词...',
    'filter.searchCheckpoints': '搜索 Checkpoints...',
    'filter.searchLoras': '搜索 LoRAs...',
    'filter.any': '任意',
    'filter.square': '正方形',
    'filter.landscape': '横版',
    'filter.portrait': '竖版',
    'filter.quickChoices': '快速选择',
    'filter.quickChoicesHelp': '先从生成器和分级开始筛选。',
    'filter.imageSize': '图片尺寸',
    'filter.imageSizeHelp': '按宽度、高度或纵横比例缩小结果范围。',
    'filter.searchAndRefine': '搜索与细化',
    'filter.searchAndRefineHelp': '先添加标签或提示词，再用下方模型列表进一步缩小范围。',
    'filter.widthMin': '最小宽度',
    'filter.widthMax': '最大宽度',
    'filter.heightMin': '最小高度',
    'filter.heightMax': '最大高度',
    'filter.criteria': '筛选条件',
    'filter.imagesToSort': '筛选要排序的图片',
    'filter.footerHint': '应用筛选后会立即刷新图库结果。',
    'filter.noCheckpoints': '暂时还没有 Checkpoints。',
    'filter.noLoras': '暂时还没有 LoRAs。',
    'filter.failedLoadCheckpoints': '加载 Checkpoints 失败。',
    'filter.failedLoadLoras': '加载 LoRAs 失败。',
    'filter.summaryReady': '当前已启用 {count} 组筛选条件。',
    'filter.summaryIdle': '还没有额外限制。现在应用即可保持当前图库范围。',
    'filter.summaryHintActive': '提示：先保持较宽范围，再逐步添加标签、提示词、尺寸、Checkpoint 或 LoRA。',
    'filter.summaryHintIdle': '提示：想要更小、更精准的结果列表时，可以加入标签、提示词或尺寸条件。',

    // ========================
    // Auto-Separate View
    // ========================
    'autosep.title': '自动分类图片',
    'autosep.description': '将匹配筛选条件的图片自动移动到新文件夹。',
    'autosep.destination': '目标文件夹',
    'autosep.preview': '预览',
    'autosep.previewBtn': '预览结果',
    'autosep.moveBtn': '移动图片',
    'autosep.willMove': '{count} 张图片将被移动',
    'autosep.previewEmpty': '点击「预览结果」查看匹配的图片。',
    'autosep.previewHint': '预览仅显示部分匹配结果。',
    'autosep.noDestination': '请指定目标文件夹',
    'autosep.noMatchingImages': '没有匹配当前筛选条件的图片',

    // ========================
    // Manual Sort View
    // ========================
    'manual.title': '手动排序模式',
    'manual.description': '设置文件夹目标，然后开始排序！',
    'manual.startSorting': '开始排序',
    'manual.keyboardRequired': '需要键盘',
    'manual.keyboardMsg': '手动排序模式使用 WASD 键进行快速分类。请使用带键盘的设备以获得最佳体验。',
    'manual.returnToGallery': '返回图库',
    'manual.sorted': '已排序',
    'manual.skipped': '已跳过',
    'manual.progress': '进度',
    'manual.remaining': '剩余',
    'manual.speed': '速度',
    'manual.exit': '退出',
    'manual.skip': '跳过（保持原位）',
    'manual.minimap': '缩略图',
    'manual.current': '当前',
    'manual.pending': '待处理',
    'manual.progressHint': '空格跳过 \u2022 Z 撤销 \u2022 ESC 退出',
    'manual.noImages': '没有匹配当前筛选条件的图片',
    'manual.configureFolder': '请至少配置一个目标文件夹',
    'manual.resume': '恢复',
    'manual.discard': '丢弃',
    'manual.unfinishedSession': '检测到未完成的排序：',
    'manual.imagesRemaining': '剩余 {count} 张图片',
    'manual.folderPath': '{key} 键对应的文件夹路径',
    'manual.folderPathHint': '输入目标文件夹路径。\n示例：D:\\sorted\\folder-name',

    // Keyboard legend
    'manual.keyboardOps': '键盘操作',
    'manual.keyW': '上方文件夹',
    'manual.keyA': '左方文件夹',
    'manual.keyS': '下方文件夹',
    'manual.keyD': '右方文件夹',
    'manual.keyZ': '撤销上一步',
    'manual.keySpace': '跳过',

    // ========================
    // Censor Edit View
    // ========================
    'censor.queue': '处理队列',
    'censor.queueSubtitle': '拖拽排序 \u2022 点击编辑',
    'censor.noImages': '未选择图片',
    'censor.selectFromGallery': '从图库中选择',
    'censor.brush': '画笔',
    'censor.pen': '钢笔',
    'censor.eraser': '橡皮擦',
    'censor.clone': '克隆',
    'censor.undo': '撤销',
    'censor.reset': '重置',
    'censor.settings': '设置与工具',
    'censor.detection': '自动检测',
    'censor.detectionModel': '检测模型',
    'censor.legacyYolo': 'Legacy YOLO（默认）',
    'censor.nudenet': 'NudeNet v3',
    'censor.both': '两者（NudeNet + Legacy）',
    'censor.detect': '检测',
    'censor.brushCensor': '画笔与遮挡',
    'censor.brushSize': '画笔大小',
    'censor.blockSize': '块大小',
    'censor.penColor': '画笔颜色',
    'censor.opacity': '不透明度',
    'censor.output': '输出与保存',
    'censor.saveAll': '保存所有已处理',
    'censor.batchRename': '批量重命名',
    'censor.clearQueue': '清空队列',
    'censor.noImageSelected': '未选择图片',
    'censor.selectToEdit': '从队列中选择一张图片进行编辑',
    'censor.processing': '处理中...',
    'censor.arrowsNav': '方向键导航',
    'censor.brushSizeKeys': '[ ] 调整画笔',
    'censor.ctrlScrollZoom': 'Ctrl+滚轮缩放',
    'censor.detectCurrent': "'D' 检测当前",
    'censor.mosaic': '马赛克',
    'censor.blur': '模糊',
    'censor.black': '黑色遮挡',
    'censor.white': '白色遮挡',

    // Auto-Detect Modal
    'censor.autoDetectSettings': '自动检测设置',
    'censor.autoDetectDesc': '配置 AI 检测并自动应用遮挡。',
    'censor.yoloModelPath': 'YOLO 模型路径',
    'censor.confidenceThreshold': '置信度阈值',
    'censor.targetRegions': '目标区域',
    'censor.detectCurrentBtn': '检测当前',
    'censor.detectAll': '检测全部',

    // ========================
    // Similar Images View
    // ========================
    'similar.title': '相似图片',
    'similar.generateEmbed': '生成嵌入向量',
    'similar.search': '搜索',
    'similar.duplicates': '查重',
    'similar.searchById': '按 ID 搜索',
    'similar.upload': '上传图片',
    'similar.findDuplicates': '查找重复',
    'similar.threshold': '相似度阈值',
    'similar.searchEmpty': '输入图片 ID 或上传图片来查找相似图片。',
    'similar.duplicatesEmpty': '点击「查找重复」扫描重复图片。',
    'similar.needMoreEmbeddings': '至少需要 {count} 张已建立 embedding 的图片，查重才有意义。',

    // Similar Images Guide
    'similar.guideTitle': '相似图片指南',
    'similar.guideDesc': '使用 AI 在图库中查找视觉上相似的图片。',
    'similar.guideStep1Title': '生成嵌入向量',
    'similar.guideStep1': '为所有图片创建视觉指纹（首次需下载约 200MB 模型）',
    'similar.guideStep2Title': '按 ID 搜索',
    'similar.guideStep2': '输入图库中的图片 ID',
    'similar.guideStep3Title': '上传搜索',
    'similar.guideStep3': '拖放任意图片来查找相似图片',
    'similar.guideStep4Title': '查重',
    'similar.guideStep4': '在图库中查找近似重复的图片',

    // ========================
    // Prompt Lab View
    // ========================
    'promptlab.categories': '标签分类',
    'promptlab.searchTags': '搜索标签...',
    'promptlab.slots': '提示词槽位',
    'promptlab.randomize': '随机生成',
    'promptlab.clear': '清除',
    'promptlab.output': '生成的提示词',
    'promptlab.generate': '生成',
    'promptlab.copy': '复制',
    'promptlab.validate': '验证',
    'promptlab.useInGallery': '在图库中使用',
    'promptlab.presets': '预设',
    'promptlab.savePreset': '保存',
    'promptlab.noPresets': '暂无保存的预设。',
    'promptlab.noPresetsDetailed': '暂无保存的预设。先配置当前内容，再保存为预设。',
    'promptlab.outputPlaceholder': '点击「生成」或「随机生成」来创建提示词...',
    'promptlab.tagSet': '标签集',
    'promptlab.selectTagSet': '-- 选择标签集 --',
    'promptlab.applyTagSet': '应用',
    'promptlab.loadingCategories': '正在加载分类...',
    'promptlab.loadingSlots': '正在加载槽位...',
    'promptlab.categoriesUnavailable': '没有加载到分类，请检查后端连接。',
    'promptlab.loadCategoriesFirst': '请先加载分类',

    // Prompt Lab Guide
    'promptlab.guideTitle': '提示词工坊指南',
    'promptlab.guideDesc': '通过智能标签选择生成随机提示词。',
    'promptlab.guideStep1Title': '随机生成',
    'promptlab.guideStep1': '通过智能标签选择生成随机提示词',
    'promptlab.guideStep2Title': '标签集',
    'promptlab.guideStep2': '应用预建的服装组合',
    'promptlab.guideStep3Title': '锁定槽位',
    'promptlab.guideStep3': '在随机化时保留特定标签',
    'promptlab.guideStep4Title': '排除规则',
    'promptlab.guideStep4': '自动防止冲突标签',

    // ========================
    // Artist ID View
    // ========================
    'artist.experimental': '实验性功能——模型可用性和结果质量可能有所不同。',
    'artist.totalImages': '总图片数',
    'artist.identified': '已识别',
    'artist.undefined': '未定义',
    'artist.artistsFound': '已发现画师',
    'artist.modelSettings': '模型设置',
    'artist.modelSource': '模型来源',
    'artist.huggingface': 'HuggingFace（已配置）',
    'artist.modelscope': 'ModelScope 镜像',
    'artist.localModel': '本地检查点',
    'artist.localModelPath': '本地检查点路径',
    'artist.confidenceThreshold': '置信度阈值',
    'artist.belowThreshold': '低于此值 = "未定义"',
    'artist.identification': '识别',
    'artist.identifyAll': '识别所有图片',
    'artist.identifySelected': '识别选中图片',
    'artist.starting': '正在启动...',
    'artist.actions': '操作',
    'artist.refreshStats': '刷新统计',
    'artist.clearPredictions': '清除所有预测',
    'artist.topArtists': '热门画师',
    'artist.details': '画师详情',
    'artist.selectArtist': '选择画师查看其作品。',
    'artist.noArtists': '暂无已识别的画师。',
    'artist.noArtistsHint': '点击「识别所有图片」开始。',
    'artist.grid': '网格',
    'artist.list': '列表',

    // ========================
    // Image Detail Modal
    // ========================
    'modal.prev': '上一张',
    'modal.next': '下一张',
    'modal.viewAsSD': '查看 SD 格式',
    'modal.viewAsNAI': '查看 NAI 格式',
    'modal.viewOriginal': '查看原始格式',
    'modal.noPrompt': '无提示词',
    'modal.copyPrompt': '复制提示词',
    'modal.copyNegative': '复制反向提示词',
    'modal.copyTags': '复制标签',
    'modal.copyParams': '复制参数',
    'modal.copyAll': '复制全部',
    'modal.reparse': '重新解析',
    'modal.generator': '生成器',
    'modal.size': '尺寸',
    'modal.checkpoint': 'Checkpoint',
    'modal.img2img': 'img2img',
    'modal.loadingDetails': '正在加载详情\u2026',
    'modal.loras': 'LoRAs',
    'modal.prompt': '提示词',
    'modal.promptOriginal': '提示词（原始）',
    'modal.negativePrompt': '反向提示词',
    'modal.characterPrompts': '角色提示词',
    'modal.genParams': '生成参数',
    'modal.img2imgDetails': 'img2img 详情',
    'modal.promptNodes': '提示词节点',
    'modal.tags': '标签',
    'modal.showMore': '显示更多',
    'modal.showLess': '收起',

    // ========================
    // Scan Modal
    // ========================
    'modal.scanFolder': '扫描文件夹',
    'modal.folderPath': '文件夹路径',
    'modal.includeSubfolders': '包含子文件夹',
    'modal.cancel': '取消',
    'modal.startScan': '开始扫描',
    'modal.scanStarting': '正在启动...',

    // ========================
    // Tag Modal
    // ========================
    'modal.tagTitle': '使用 WD14 标记图片',
    'modal.tagDescription': '使用 WD14 标记器自动为图片添加动漫/插画标签。',
    'modal.tagModel': '模型',
    'modal.tagBestQuality': '最佳质量',
    'modal.tagCustomModel': '自定义本地模型...',
    'modal.tagCustomModelPath': '自定义模型路径 (.onnx)',
    'modal.tagCustomModelPathHelper': '本地 .onnx 模型文件的路径',
    'modal.tagTagsCsvPath': '标签 CSV 路径',
    'modal.tagTagsCsvHelper': '使用自定义模型时必须提供',
    'modal.tagGeneralThreshold': '通用标签阈值',
    'modal.tagCharacterThreshold': '角色标签阈值',
    'modal.tagRetagAll': '重新标记已标记的图片？',
    'modal.tagUseGpu': '使用 GPU 加速（更快但占用更多显存）',
    'modal.tagUseGpuHelper': '取消勾选以仅使用 CPU（较慢但不会卡死系统）',
    'modal.tagLoadingModel': '正在加载模型...',
    'modal.tagExport': '导出标签',
    'modal.tagImport': '导入标签',
    'modal.tagCancel': '取消',
    'modal.tagStart': '开始标记',

    // ========================
    // Analytics Modal
    // ========================
    'modal.analytics': '图片分析',
    'modal.topCheckpoints': '热门 Checkpoints',
    'modal.topLoras': '热门 LoRAs',
    'modal.topTags': '热门标签',

    // ========================
    // Export Modal
    // ========================
    'modal.exportPrompts': '导出提示词',
    'modal.imagesSelected': '已选择 {count} 张图片',
    'modal.exportTagsAlt': '改为导出标签',
    'modal.copyToClipboard': '复制到剪贴板',

    // ========================
    // Confirm Modal
    // ========================
    'modal.confirm': '确定吗？',
    'modal.confirmAction': '此操作无法撤销。',
    'modal.yes': '确认执行',

    // ========================
    // Input Modal
    // ========================
    'modal.enterValue': '输入值',
    'modal.ok': '确定',

    // ========================
    // Selection FAB
    // ========================
    'selection.count': '已选择 {count} 项',
    'selection.selectAll': '全选',
    'selection.exportPrompts': '导出提示词',
    'selection.exportTags': '导出标签',
    'selection.exportTagsToFiles': '导出标签到文件',
    'selection.censorEdit': '马赛克编辑',
    'selection.deselectAll': '取消全选',

    // ========================
    // Batch Tag Export Modal
    // ========================
    'batchExport.title': '导出标签到文件',
    'batchExport.outputFolder': '输出文件夹',
    'batchExport.outputFolderHelper': '每张图片将创建一个同名的 .txt 文件',
    'batchExport.tagPrefix': '标签前缀（可选）',
    'batchExport.tagPrefixHelper': '在每个标签文件开头添加的文本',
    'batchExport.tagBlacklist': '标签黑名单（可选）',
    'batchExport.tagBlacklistHelper': '要排除的标签，用逗号分隔',
    'batchExport.exporting': '正在导出...',
    'batchExport.cancel': '取消',
    'batchExport.exportFiles': '导出文件',

    // ========================
    // Rename Modal
    // ========================
    'rename.title': '批量重命名图片',
    'rename.description': '为队列中的所有图片设置命名规则',
    'rename.useOriginal': '使用原始文件名',
    'rename.useOriginalHelper': '保留原始文件名而非顺序编号',
    'rename.baseName': '基础名称',
    'rename.baseNameHelper': '所有图片的基础名称',
    'rename.startingNumber': '起始编号',
    'rename.startingNumberHelper': '图片将从此编号开始顺序编号',
    'rename.preview': '预览',
    'rename.andSoOn': '...以此类推',
    'rename.cancel': '取消',
    'rename.apply': '应用重命名',

    // ========================
    // Save Options Modal
    // ========================
    'save.title': '保存选项',
    'save.description': '保存前配置输出设置',
    'save.outputFolder': '输出文件夹',
    'save.outputFolderHelper': '已处理图片的保存位置',
    'save.metadataHandling': '元数据处理',
    'save.metadataStrip': '清除所有元数据（推荐分享时使用）',
    'save.metadataKeep': '保留原始元数据',
    'save.metadataMinimal': '仅保留基本信息（尺寸、格式）',
    'save.metadataHelper': '选择如何处理图片元数据/EXIF 数据',
    'save.outputFormat': '输出格式',
    'save.formatPng': 'PNG（无损，文件较大）',
    'save.formatWebp': 'WebP（文件较小，画质良好）',
    'save.formatHelper': '选择输出图片格式',
    'save.cancel': '取消',
    'save.saveAll': '保存所有图片',

    // ========================
    // Model Selection Modal
    // ========================
    'modelSelect.title': '选择模型',
    'modelSelect.search': '搜索模型...',
    'modelSelect.cancel': '取消',
    'modelSelect.apply': '应用选择',

    // ========================
    // Tags Library Modal
    // ========================
    'library.title': '标签与提示词库',
    'library.description': '浏览所有已发现的标签及其使用频率',
    'library.tags': '标签',
    'library.prompts': '提示词',
    'library.sortFrequency': '排序：频率',
    'library.sortAlpha': '排序：A-Z',
    'library.search': '搜索标签或提示词...',
    'library.loading': '加载中...',
    'library.loadingTags': '正在加载标签库…',
    'library.loadingPrompts': '正在加载提示词库…',
    'library.tagsFound': '已发现 {count} 个唯一标签',
    'library.promptsFound': '已发现 {count} 条唯一提示词',
    'library.loadTagsFailed': '加载标签库失败',
    'library.loadPromptsFailed': '加载提示词库失败',
    'library.close': '关闭',

    // ========================
    // Common / Shared
    // ========================
    'common.all': '全部',
    'common.none': '无',
    'common.browse': '浏览',
    'common.close': '关闭',
    'common.save': '保存',
    'common.delete': '删除',
    'common.export': '导出',
    'common.import': '导入',
    'common.settings': '设置',
    'common.loading': '加载中...',
    'common.error': '错误',
    'common.success': '成功',
    'common.copied': '已复制到剪贴板！',
    'common.images': '张图片',

    // ========================
    // Toast Messages
    // ========================
    'toast.scanComplete': '扫描完成！共发现 {count} 张图片。',
    'toast.scanFailed': '扫描失败：{error}',
    'toast.tagComplete': '标记完成！共标记 {count} 张图片。',
    'toast.tagFailed': '标记失败：{error}',
    'toast.moved': '成功移动 {count} 张图片。',
    'toast.moveFailed': '移动失败：{error}',
    'toast.copied': '已复制到剪贴板！',
    'toast.saved': '保存成功！',
    'toast.saveFailed': '保存失败：{error}',
    'toast.sortComplete': '排序会话完成！',
    'toast.noImagesMatch': '没有匹配当前筛选条件的图片',
    'toast.configureFolder': '请至少配置一个目标文件夹',
    'toast.deletedDb': '图库数据库已清空。',

    // ========================
    // Error Messages
    // ========================
    'error.invalidRequest': '无效请求。请检查输入后重试。',
    'error.authRequired': '需要认证。请刷新页面。',
    'error.accessDenied': '拒绝访问。您没有此操作的权限。',
    'error.notFound': '未找到请求的资源。',
    'error.conflict': '此操作与已有操作冲突。请稍候重试。',
    'error.invalidData': '提供的数据无效。请检查输入。',
    'error.tooMany': '请求过于频繁。请稍候再试。',
    'error.server': '服务器错误。请稍后重试或检查日志。',
    'error.unavailable': '服务器暂时不可用。请重试。',
    'error.serviceDown': '服务不可用。服务器可能正在启动。',
    'error.requestFailed': '请求失败（{status}）。请重试。',
    'error.invalidServerData': '服务器返回了无效数据。请重试。',

    // ========================
    // Language Toggle
    // ========================
    'lang.toggle': 'EN',
    'lang.current': '中文',
    'lang.switchLabel': '切换语言'
};
