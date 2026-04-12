/**
 * SD Image Sorter - English Language Pack
 *
 * Key naming convention: section.subsection.detail
 * Use {param} for interpolated values, e.g. '{count} images'
 */

window.I18nLang_en = {

    // ========================
    // Navigation
    // ========================
    'nav.gallery': 'Gallery',
    'nav.autosep': 'Auto-Separate',
    'nav.manual': 'Manual Sort',
    'nav.censor': 'Censored Edit',
    'nav.similar': 'Similar',
    'nav.promptlab': 'Prompt Lab',
    'nav.artist': 'Artist ID',
    'nav.experimental': 'Experimental',
    'nav.navigation': 'Navigation',

    // ========================
    // Brand / App Title
    // ========================
    'brand.name': 'SD Image Sorter',

    // ========================
    // Nav Actions (top bar buttons)
    // ========================
    'action.scan': 'Scan Folder',
    'action.tag': 'Tag Images',
    'action.library': 'Library',
    'action.help': 'Help',
    'action.clearGallery': 'Clear Gallery',

    // ========================
    // Gallery View
    // ========================
    'gallery.imageCount': '{count} images',
    'gallery.noImages': 'No Images Loaded',
    'gallery.scanPrompt': 'Scan a folder to start managing your AI-generated images',
    'gallery.loading': 'Loading images...',
    'gallery.loadMore': 'Load More Images',
    'gallery.random': 'Random',
    'gallery.selectImages': 'Select Images',
    'gallery.editFilters': 'Edit Filters',
    'gallery.filters': 'Filters',

    // Generator tabs
    'generator.all': 'All',
    'generator.nai': 'NovelAI',
    'generator.comfyui': 'ComfyUI',
    'generator.forge': 'Forge',
    'generator.webui': 'WebUI',
    'generator.unknown': 'Unknown',

    // Sort options
    'sort.newest': 'Newest',
    'sort.oldest': 'Oldest',
    'sort.nameAsc': 'Name (A-Z)',
    'sort.nameDesc': 'Name (Z-A)',
    'sort.generator': 'Generator',
    'sort.promptLength': 'Prompt Length',
    'sort.tagCount': 'Most Tags',
    'sort.rating': 'Rating (NSFW first)',
    'sort.characterCount': 'Characters',
    'sort.fileSize': 'Largest File',
    'sort.fileSizeAsc': 'Smallest File',
    'sort.random': 'Random',

    // View modes
    'view.grid': 'Grid view',
    'view.large': 'Large view',
    'view.waterfall': 'Waterfall view',

    // ========================
    // Filters
    // ========================
    'filter.title': 'Filters',
    'filter.filterImages': 'Filter Images',
    'filter.description': 'Choose source, rating, tag, prompt, checkpoint, and LoRA filters in one place.',
    'filter.generators': 'Generators',
    'filter.ratings': 'Ratings',
    'filter.tags': 'Tags',
    'filter.checkpoints': 'Checkpoints',
    'filter.loras': 'Loras',
    'filter.prompt': 'Prompt',
    'filter.promptSearch': 'Prompt Search',
    'filter.artist': 'Artist',
    'filter.dimensions': 'Dimensions & Aspect',
    'filter.clearAll': 'Clear All Filters',
    'filter.apply': 'Apply Filters',
    'filter.reset': 'Reset All',
    'filter.browseLibrary': 'Browse Library',
    'filter.searchTags': 'Search tags to add...',
    'filter.searchPrompts': 'Type to search prompts...',
    'filter.searchCheckpoints': 'Search checkpoints...',
    'filter.searchLoras': 'Search loras...',
    'filter.any': 'Any',
    'filter.square': 'Square',
    'filter.landscape': 'Landscape',
    'filter.portrait': 'Portrait',
    'filter.quickChoices': 'Quick Choices',
    'filter.quickChoicesHelp': 'Start with generator and rating filters.',
    'filter.imageSize': 'Image Size',
    'filter.imageSizeHelp': 'Narrow results by width, height, or aspect ratio.',
    'filter.searchAndRefine': 'Search & Refine',
    'filter.searchAndRefineHelp': 'Add tags or prompts, then narrow the result with models below.',
    'filter.widthMin': 'Min width',
    'filter.widthMax': 'Max width',
    'filter.heightMin': 'Min height',
    'filter.heightMax': 'Max height',
    'filter.criteria': 'Filter Criteria',
    'filter.imagesToSort': 'Filter Images to Sort',
    'filter.footerHint': 'Apply filters to refresh the gallery results.',
    'filter.noCheckpoints': 'No checkpoints found yet.',
    'filter.noLoras': 'No LoRAs found yet.',
    'filter.failedLoadCheckpoints': 'Failed to load checkpoints.',
    'filter.failedLoadLoras': 'Failed to load LoRAs.',
    'filter.summaryReady': '{count} filter groups are active.',
    'filter.summaryIdle': 'No extra limits selected yet. Apply now to keep the current gallery scope.',
    'filter.summaryHintActive': 'Tip: start broad, then add tags or prompts before tightening size, checkpoint, or LoRA filters.',
    'filter.summaryHintIdle': 'Tip: use tags, prompts, or dimensions when you want a smaller and more targeted result list.',

    // ========================
    // Auto-Separate View
    // ========================
    'autosep.title': 'Auto-Separate Images',
    'autosep.description': 'Move images matching your filters to a new folder automatically.',
    'autosep.destination': 'Destination Folder',
    'autosep.preview': 'Preview',
    'autosep.previewBtn': 'Preview Results',
    'autosep.moveBtn': 'Move Images',
    'autosep.willMove': '{count} images will be moved',
    'autosep.previewEmpty': 'Click "Preview Results" to review matching images before moving them.',
    'autosep.previewHint': 'Preview shows the first few matches only.',
    'autosep.noDestination': 'Please specify a destination folder',
    'autosep.noMatchingImages': 'No images match current filters',

    // ========================
    // Manual Sort View
    // ========================
    'manual.title': 'Manual Sort Mode',
    'manual.description': 'Configure your folder destinations and start sorting!',
    'manual.startSorting': 'Start Sorting',
    'manual.keyboardRequired': 'Keyboard Required',
    'manual.keyboardMsg': 'Manual Sort mode uses WASD keys for quick sorting. Please use a device with a keyboard for the best experience.',
    'manual.returnToGallery': 'Return to Gallery',
    'manual.sorted': 'Sorted',
    'manual.skipped': 'Skipped',
    'manual.progress': 'Progress',
    'manual.remaining': 'Remaining',
    'manual.speed': 'Speed',
    'manual.exit': 'Exit',
    'manual.skip': 'Skip (keep in place)',
    'manual.minimap': 'Minimap',
    'manual.current': 'Current',
    'manual.pending': 'Pending',
    'manual.progressHint': 'SPACE to skip \u2022 Z to undo \u2022 ESC to exit',
    'manual.noImages': 'No images to sort with current filters',
    'manual.configureFolder': 'Please configure at least one destination folder',
    'manual.resume': 'Resume',
    'manual.discard': 'Discard',
    'manual.unfinishedSession': 'Unfinished session detected:',
    'manual.imagesRemaining': '{count} images remaining',
    'manual.folderPath': 'Folder Path for {key}',
    'manual.folderPathHint': 'Enter the destination folder path.\nExample: D:\\sorted\\folder-name',

    // Keyboard legend
    'manual.keyboardOps': 'Keyboard Controls',
    'manual.keyW': 'Top folder',
    'manual.keyA': 'Left folder',
    'manual.keyS': 'Bottom folder',
    'manual.keyD': 'Right folder',
    'manual.keyZ': 'Undo last',
    'manual.keySpace': 'Skip',

    // ========================
    // Censor Edit View
    // ========================
    'censor.queue': 'Processing Queue',
    'censor.queueSubtitle': 'Click to edit \u2022 Ctrl/Shift multi-select',
    'censor.moveTop': 'Top',
    'censor.moveUp': 'Up',
    'censor.moveDown': 'Down',
    'censor.moveBottom': 'Bottom',
    'censor.selectAll': 'All',
    'censor.deselectAll': 'None',
    'censor.queueManager': 'Queue Manager',
    'censor.queueManagerDescription': 'Use the large queue window for selecting, searching, and reordering big batches.',
    'censor.queueManagerSearch': 'Search filenames...',
    'censor.queueManagerShowSelected': 'Show selected only',
    'censor.queueFilterPlaceholder': 'Filter by filename...',
    'censor.queueColumnIndex': '#',
    'censor.queueColumnPreview': 'Preview',
    'censor.queueColumnFilename': 'Filename',
    'censor.queueColumnStatus': 'Status',
    'censor.moveToPosition': 'Move To Position',
    'censor.queueManagerSummary': '{selected} selected • {visible}/{total} visible',
    'censor.queueManagerEmpty': 'No queue items match the current filter.',
    'censor.queueManagerLoaded': 'Loaded {filename} into the editor.',
    'censor.noImages': 'No images selected',
    'censor.selectFromGallery': 'Select from Gallery',
    'censor.brush': 'Brush',
    'censor.pen': 'Pen',
    'censor.eraser': 'Eraser',
    'censor.clone': 'Clone',
    'censor.undo': 'Undo',
    'censor.reset': 'Reset',
    'censor.showChanges': 'Diff',
    'censor.settings': 'Settings & Tools',
    'censor.detection': 'Auto-Detection',
    'censor.detectionModel': 'Detection Model',
    'censor.legacyYolo': 'Local YOLO Files',
    'censor.nudenet': 'NudeNet v3',
    'censor.installedYoloModel': 'Installed YOLO Model',
    'censor.showAdvancedModels': 'Show advanced local seg models (YOLO26 / generic YOLOv8)',
    'censor.advancedModelsHelp': 'Leave this off unless you intentionally want fixed-class segmentation experiments.',
    'censor.yoloModelPathHelp': 'Normal users can leave this empty. It is only for custom experiments.',
    'censor.both': 'Recommended: Both (NudeNet + privacy YOLO)',
    'censor.detect': 'Detect',
    'censor.brushCensor': 'Brush & Censor',
    'censor.brushSize': 'Brush Size',
    'censor.blockSize': 'Block Size',
    'censor.penColor': 'Pen Color',
    'censor.opacity': 'Opacity',
    'censor.output': 'Output & Save',
    'censor.saveAll': 'Save All Processed',
    'censor.batchRename': 'Batch Rename',
    'censor.clearQueue': 'Clear Queue',
    'censor.noImageSelected': 'No image selected',
    'censor.selectToEdit': 'Select an image from the queue to edit',
    'censor.processing': 'Processing...',
    'censor.arrowsNav': 'Arrows Navigate',
    'censor.brushSizeKeys': '[ ] Brush Size',
    'censor.ctrlScrollZoom': 'Ctrl+Scroll Zoom',
    'censor.detectCurrent': "'D' Detect Current",
    'censor.mosaic': 'Mosaic',
    'censor.blur': 'Blur',
    'censor.black': 'Black',
    'censor.white': 'White',

    // Auto-Detect Modal
    'censor.autoDetectSettings': 'Auto-Detect Settings',
    'censor.autoDetectDesc': 'Configure AI detection and apply censoring automatically.',
    'censor.yoloModelPath': 'YOLO Model Path',
    'censor.confidenceThreshold': 'Confidence Threshold',
    'censor.targetRegions': 'Quick Privacy Targets',
    'censor.modelCapabilities': 'Model Capabilities',
    'censor.targetRegionHelp': 'These quick privacy targets work for Wenaka / NudeNet families. They do not control generic YOLO26 / YOLOv8 object classes.',
    'censor.regionBreasts': 'Breasts',
    'censor.regionPussy': 'Pussy',
    'censor.regionDick': 'Dick',
    'censor.regionAnus': 'Anus',
    'censor.regionButtocks': 'Buttocks',
    'censor.regionCum': 'Cum',
    'censor.advancedPrecision': 'SAM3 Text Precision (Pro)',
    'censor.textPromptPlaceholder': 'e.g. exposed breasts, face, tattoo, hand',
    'censor.textPromptHelp': 'Type a prompt here for SAM3. Execution still needs a CUDA-ready SAM3 runtime.',
    'censor.segmentText': 'Segment by Text',
    'censor.detectCurrentBtn': 'Detect Current',
    'censor.detectAll': 'Detect All',
    'censor.quickAutoCensor': 'Quick Auto Censor',
    'censor.quickAutoCensorHelp': 'Use Wenaka / NudeNet for the normal privacy workflow.',
    'censor.advancedSettings': 'Advanced Settings',
    'censor.advancedModelPicker': 'Advanced Local Model Picker',
    'censor.advancedModelPickerHelp': 'Only use this when you intentionally want YOLO26 / generic YOLOv8 experiments.',
    'censor.proSegmentation': 'Pro Segmentation',
    'censor.proSegmentationHelp': 'Use SAM3 for text-guided precision masks when the runtime is ready.',

    // ========================
    // Similar Images View
    // ========================
    'similar.title': 'Similar Images',
    'similar.generateEmbed': 'Generate Embeddings',
    'similar.search': 'Search',
    'similar.duplicates': 'Duplicates',
    'similar.searchById': 'Search by ID',
    'similar.upload': 'Upload Image',
    'similar.findDuplicates': 'Find Duplicates',
    'similar.threshold': 'Similarity Threshold',
    'similar.searchThreshold': 'Threshold:',
    'similar.searchEmpty': 'Enter an image ID or upload an image to find similar images.',
    'similar.duplicatesEmpty': 'Click "Find Duplicates" to scan for duplicate images.',
    'similar.needMoreEmbeddings': 'Need at least {count} embedded images before duplicate search is meaningful.',

    // Similar Images Guide
    'similar.guideTitle': 'Similar Images Guide',
    'similar.guideDesc': 'Find visually similar images in your library using AI.',
    'similar.guideStep1Title': 'Generate Embeddings',
    'similar.guideStep1': 'Creates visual fingerprints for all images and builds the local search index',
    'similar.guideStep2Title': 'Search by ID',
    'similar.guideStep2': 'Enter an image ID from your gallery',
    'similar.guideStep3Title': 'Upload Search',
    'similar.guideStep3': 'Drag & drop any image to find similar ones',
    'similar.guideStep4Title': 'Duplicates',
    'similar.guideStep4': 'Find near-duplicate images in your library',

    // ========================
    // Prompt Lab View
    // ========================
    'promptlab.categories': 'Tag Categories',
    'promptlab.searchTags': 'Search tags...',
    'promptlab.slots': 'Prompt Slots',
    'promptlab.randomize': 'Randomize',
    'promptlab.clear': 'Clear',
    'promptlab.output': 'Generated Prompt',
    'promptlab.generate': 'Generate',
    'promptlab.copy': 'Copy',
    'promptlab.validate': 'Validate',
    'promptlab.useInGallery': 'Use in Gallery',
    'promptlab.presets': 'Presets',
    'promptlab.savePreset': 'Save',
    'promptlab.noPresets': 'No presets saved yet.',
    'promptlab.noPresetsDetailed': 'No saved presets. Save your current configuration as a preset.',
    'promptlab.outputPlaceholder': 'Click Generate or Randomize to create a prompt...',
    'promptlab.tagSet': 'Tag Set',
    'promptlab.selectTagSet': '-- Select Tag Set --',
    'promptlab.applyTagSet': 'Apply',
    'promptlab.loadingCategories': 'Loading categories...',
    'promptlab.loadingSlots': 'Loading slots...',
    'promptlab.categoriesUnavailable': 'No categories loaded. Check backend connection.',
    'promptlab.loadCategoriesFirst': 'Load categories first',

    // Prompt Lab Guide
    'promptlab.guideTitle': 'Prompt Lab Guide',
    'promptlab.guideDesc': 'Generate random prompts with intelligent tag selection.',
    'promptlab.guideStep1Title': 'Randomize',
    'promptlab.guideStep1': 'Generate a random prompt with smart tag selection',
    'promptlab.guideStep2Title': 'Tag Sets',
    'promptlab.guideStep2': 'Apply pre-built outfit combinations',
    'promptlab.guideStep3Title': 'Lock Slots',
    'promptlab.guideStep3': 'Keep specific tags during randomization',
    'promptlab.guideStep4Title': 'Exclusions',
    'promptlab.guideStep4': 'Auto-prevent conflicting tags',

    // ========================
    // Artist ID View
    // ========================
    'artist.experimental': 'Experimental feature \u2014 model availability and result quality may vary.',
    'artist.totalImages': 'Total Images',
    'artist.identified': 'Identified',
    'artist.undefined': 'Undefined',
    'artist.artistsFound': 'Artists Found',
    'artist.modelSettings': 'Model Settings',
    'artist.modelSource': 'Model Source',
    'artist.huggingface': 'HuggingFace (Kaloscope2.0)',
    'artist.modelscope': 'ModelScope Mirror',
    'artist.localModel': 'Local Checkpoint',
    'artist.localModelPath': 'Local Checkpoint Path',
    'artist.confidenceThreshold': 'Confidence Threshold',
    'artist.belowThreshold': 'Below this = "undefined". Kaloscope usually works best around 0.02-0.08.',
    'artist.identification': 'Identification',
    'artist.identifyAll': 'Identify All Images',
    'artist.identifySelected': 'Identify Selected',
    'artist.starting': 'Starting...',
    'artist.actions': 'Actions',
    'artist.refreshStats': 'Refresh Stats',
    'artist.clearPredictions': 'Clear All Predictions',
    'artist.topArtists': 'Top Artists',
    'artist.details': 'Artist Details',
    'artist.selectArtist': 'Select an artist to view their images.',
    'artist.noArtists': 'No artists identified yet.',
    'artist.noArtistsHint': 'Click "Identify All Images" to start.',
    'artist.grid': 'Grid',
    'artist.list': 'List',

    // ========================
    // Image Detail Modal
    // ========================
    'modal.prev': 'Prev',
    'modal.next': 'Next',
    'modal.viewAsSD': 'View as SD',
    'modal.viewAsNAI': 'View as NAI',
    'modal.viewOriginal': 'View Original',
    'modal.noPrompt': 'No prompt',
    'modal.copyPrompt': 'Copy Prompt',
    'modal.copyNegative': 'Copy Negative',
    'modal.copyTags': 'Copy Tags',
    'modal.copyParams': 'Copy Params',
    'modal.copyAll': 'Copy All',
    'modal.reparse': 'Reparse',
    'modal.generator': 'Generator',
    'modal.size': 'Size',
    'modal.checkpoint': 'Checkpoint',
    'modal.img2img': 'img2img',
    'modal.loadingDetails': 'Loading details\u2026',
    'modal.loras': 'LoRAs',
    'modal.prompt': 'Prompt',
    'modal.promptOriginal': 'Prompt (Original)',
    'modal.negativePrompt': 'Negative Prompt',
    'modal.characterPrompts': 'Character Prompts',
    'modal.genParams': 'Generation Parameters',
    'modal.img2imgDetails': 'img2img Details',
    'modal.promptNodes': 'Prompt Nodes',
    'modal.tags': 'Tags',
    'modal.showMore': 'Show More',
    'modal.showLess': 'Show Less',
    'modal.aiCaption': 'AI Caption',
    'modal.captionCopied': 'Caption copied',

    // ========================
    // Scan Modal
    // ========================
    'modal.scanFolder': 'Scan Folder',
    'modal.folderPath': 'Folder Path',
    'modal.includeSubfolders': 'Include subfolders',
    'modal.cancel': 'Cancel',
    'modal.startScan': 'Start Scan',
    'modal.scanStarting': 'Starting...',

    // ========================
    // Tag Modal
    // ========================
    'modal.tagTitle': 'Tag Images with WD14',
    'modal.tagDescription': 'Choose a model, tune thresholds only when the model uses them, then start. Advanced override is optional.',
    'modal.tagModel': 'Model',
    'modal.tagModelSnapshot': 'Model Snapshot',
    'modal.tagRuntimePlan': 'Runtime Plan',
    'modal.tagAdvancedOverride': 'Advanced Override',
    'modal.tagAdvancedHint': 'Optional. Most runs do not need this.',
    'modal.tagRuntimeChunk': 'Runtime chunk size',
    'modal.tagBestQuality': 'Best Quality',
    'modal.tagCustomModel': 'Custom Local Model...',
    'modal.tagCustomModelPath': 'Custom Model Path (.onnx)',
    'modal.tagCustomModelPathHelper': 'Path to your local .onnx model file',
    'modal.tagTagsCsvPath': 'Tags CSV Path',
    'modal.tagTagsCsvHelper': 'Required when using custom model',
    'modal.tagGeneralThreshold': 'General Tag Threshold',
    'modal.tagCharacterThreshold': 'Character Tag Threshold',
    'modal.tagThresholdNotUsedTitle': 'This model does not use WD14 thresholds.',
    'modal.tagThresholdNotUsedBody': 'ToriiGate generates tags directly. There is nothing to tune here, so just start the run.',
    'modal.tagRetagAll': 'Re-tag already tagged images?',
    'modal.tagUseGpu': 'Use GPU acceleration (faster but uses more VRAM)',
    'modal.tagUseGpuHelper': 'Uncheck to use CPU only (slower but won\'t freeze system)',
    'modal.tagLoadingModel': 'Loading model...',
    'modal.tagExport': 'Export Tags',
    'modal.tagImport': 'Import Tags',
    'modal.tagCancel': 'Cancel',
    'modal.tagStart': 'Start Tagging',

    // ========================
    // Analytics Modal
    // ========================
    'modal.analytics': 'Image Analytics',
    'modal.topCheckpoints': 'Top Checkpoints',
    'modal.topLoras': 'Top Loras',
    'modal.topTags': 'Top Tags',

    // ========================
    // Export Modal
    // ========================
    'modal.exportPrompts': 'Export Prompts',
    'modal.imagesSelected': '{count} images selected',
    'modal.exportTagsAlt': 'Export Tags Instead',
    'modal.copyToClipboard': 'Copy to Clipboard',

    // ========================
    // Confirm Modal
    // ========================
    'modal.confirm': 'Are you sure?',
    'modal.confirmAction': 'This action cannot be undone.',
    'modal.yes': 'Yes, proceed',

    // ========================
    // Input Modal
    // ========================
    'modal.enterValue': 'Enter Value',
    'modal.ok': 'OK',

    // ========================
    // Selection FAB
    // ========================
    'selection.panelTitle': 'Batch Actions',
    'selection.count': '{count} items selected',
    'selection.emptyHint': 'Selection mode is on. Pick images or use Select All.',
    'selection.doneSelecting': 'Done Selecting',
    'selection.selectAll': 'Select All',
    'selection.exportPrompts': 'Export Prompts',
    'selection.exportTags': 'Export Tags',
    'selection.exportTagsToFiles': 'Export Tags to Files',
    'selection.censorEdit': 'Censor Edit',
    'selection.deselectAll': 'Deselect All',

    // ========================
    // Batch Tag Export Modal
    // ========================
    'batchExport.title': 'Export Tags to Files',
    'batchExport.outputFolder': 'Output Folder',
    'batchExport.outputFolderHelper': 'Each image will create a .txt file with the same name',
    'batchExport.tagPrefix': 'Tag Prefix (optional)',
    'batchExport.tagPrefixHelper': 'Text to add at the beginning of each tag file',
    'batchExport.tagBlacklist': 'Tag Blacklist (optional)',
    'batchExport.tagBlacklistHelper': 'Comma-separated list of tags to exclude from export',
    'batchExport.exporting': 'Exporting...',
    'batchExport.cancel': 'Cancel',
    'batchExport.exportFiles': 'Export Files',

    // ========================
    // Rename Modal
    // ========================
    'rename.title': 'Batch Rename Images',
    'rename.description': 'Set naming pattern for all queued images',
    'rename.useOriginal': 'Use Original Filename',
    'rename.useOriginalHelper': 'Keep original names instead of sequential numbering',
    'rename.onlySelected': 'Rename selected queue items only',
    'rename.onlySelectedHelper': 'If nothing is selected, the whole queue will be renamed.',
    'rename.baseName': 'Base Name',
    'rename.baseNamePlaceholder': 'Image',
    'rename.baseNameHelper': 'Base name for all images',
    'rename.startingNumber': 'Starting Number',
    'rename.startingNumberHelper': 'Images will be numbered sequentially from this number',
    'rename.preview': 'Preview',
    'rename.previewSummary': 'Previewing the first few files.',
    'rename.currentName': 'Current',
    'rename.newName': 'New name',
    'rename.andSoOn': '...and so on',
    'rename.cancel': 'Cancel',
    'rename.apply': 'Apply Rename',

    // ========================
    // Save Options Modal
    // ========================
    'save.title': 'Save Options',
    'save.description': 'Configure output settings before saving all images',
    'save.outputFolder': 'Output Folder',
    'save.outputFolderHelper': 'Folder where processed images will be saved',
    'save.metadataHandling': 'Metadata Handling',
    'save.metadataStrip': 'Strip All Metadata (Recommended for sharing)',
    'save.metadataKeep': 'Keep Original Metadata',
    'save.metadataMinimal': 'Keep Only Basic Info (dimensions, format)',
    'save.metadataHelper': 'Choose how to handle image metadata/EXIF data',
    'save.outputFormat': 'Output Format',
    'save.formatPng': 'PNG (Lossless, larger file)',
    'save.formatJpg': 'JPG (Smaller file, widely compatible)',
    'save.formatWebp': 'WebP (Smaller file, good quality)',
    'save.formatHelper': 'Choose the output image format',
    'save.cancel': 'Cancel',
    'save.saveAll': 'Save All Images',

    // ========================
    // Model Selection Modal
    // ========================
    'modelSelect.title': 'Select Models',
    'modelSelect.search': 'Search models...',
    'modelSelect.cancel': 'Cancel',
    'modelSelect.apply': 'Apply Selection',

    // ========================
    // Tags Library Modal
    // ========================
    'library.title': 'Tags & Prompts Library',
    'library.description': 'Browse all discovered tags with their frequencies',
    'library.tags': 'Tags',
    'library.prompts': 'Prompts',
    'library.sortFrequency': 'Sort: Frequency',
    'library.sortAlpha': 'Sort: A-Z',
    'library.search': 'Search tags or prompts...',
    'library.loading': 'Loading...',
    'library.loadingTags': 'Loading tag library…',
    'library.loadingPrompts': 'Loading prompt library…',
    'library.tagsFound': '{count} unique tags found',
    'library.promptsFound': '{count} unique prompts found',
    'library.loadTagsFailed': 'Failed to load tag library',
    'library.loadPromptsFailed': 'Failed to load prompt library',
    'library.close': 'Close',

    // ========================
    // Common / Shared
    // ========================
    'common.all': 'All',
    'common.none': 'None',
    'common.browse': 'Browse',
    'common.close': 'Close',
    'common.filter': 'Filter',
    'common.move': 'Move',
    'common.current': 'Current',
    'common.selected': 'Selected',
    'common.processed': 'Processed',
    'common.ready': 'Ready',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.export': 'Export',
    'common.import': 'Import',
    'common.settings': 'Settings',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.success': 'Success',
    'common.copied': 'Copied to clipboard!',
    'common.images': 'images',
    'common.top': 'Top',
    'common.up': 'Up',
    'common.down': 'Down',
    'common.bottom': 'Bottom',

    // Folder Browser
    'folderBrowser.loading': 'Loading folders...',
    'folderBrowser.empty': 'No subfolders found',
    'folderBrowser.computer': 'Computer',
    'folderBrowser.up': 'Up',
    'folderBrowser.upTitle': 'Go to parent folder',
    'folderBrowser.cancel': 'Cancel',
    'folderBrowser.close': 'Close',
    'folderBrowser.select': 'Select This Folder',
    'folderBrowser.errorPrefix': 'Error: ',

    // ========================
    // Toast Messages
    // ========================
    'toast.scanComplete': 'Scan complete! {count} images found.',
    'toast.scanFailed': 'Scan failed: {error}',
    'toast.tagComplete': 'Tagging complete! {count} images tagged.',
    'toast.tagFailed': 'Tagging failed: {error}',
    'toast.moved': '{count} images moved successfully.',
    'toast.moveFailed': 'Move failed: {error}',
    'toast.copied': 'Copied to clipboard!',
    'toast.saved': 'Saved successfully!',
    'toast.saveFailed': 'Save failed: {error}',
    'toast.sortComplete': 'Sorting session complete!',
    'toast.noImagesMatch': 'No images match current filters',
    'toast.configureFolder': 'Please configure at least one destination folder',
    'toast.deletedDb': 'Gallery database cleared.',

    // ========================
    // Error Messages
    // ========================
    'error.invalidRequest': 'Invalid request. Please check your input and try again.',
    'error.authRequired': 'Authentication required. Please refresh the page.',
    'error.accessDenied': 'Access denied. You do not have permission for this action.',
    'error.notFound': 'The requested resource was not found.',
    'error.conflict': 'This operation conflicts with an existing one. Please wait and try again.',
    'error.invalidData': 'Invalid data provided. Please check your input.',
    'error.tooMany': 'Too many requests. Please wait a moment and try again.',
    'error.server': 'Server error. Please try again later or check the logs.',
    'error.unavailable': 'Server is temporarily unavailable. Please try again.',
    'error.serviceDown': 'Service unavailable. The server may be starting up.',
    'error.requestFailed': 'Request failed ({status}). Please try again.',
    'error.invalidServerData': 'Server returned invalid data. Please try again.',

    // ========================
    // Language Toggle
    // ========================
    'lang.toggle': '\u4E2D\u6587',
    'lang.current': 'EN',
    'lang.switchLabel': 'Switch language',

    // ========================
    // Scan Validation Feedback
    // ========================
    'scan.invalidChars': 'Path contains invalid characters',
    'scan.checkingPath': 'Checking path...',
    'scan.folderFound': 'Folder found',
    'scan.folderNotFound': 'Folder not found',
    'scan.waitingForUpdate': 'Scan · waiting for first update...',
    'scan.autoTagLabel': 'Auto-tag after scan',

    // ========================
    // Tagging Progress
    // ========================
    'tag.preparingGpu': 'Preparing model on GPU...',
    'tag.preparingCpu': 'Preparing model on CPU...',
    'tag.preparingMaxQuality': 'Preparing Max Quality model in protected CPU Safe Mode...',
    'tag.running': 'Tagging...',
    'tag.startTagging': 'Start Tagging',
    'tag.cancelTagging': 'Cancel Tagging',
    'tag.cancellingAfterCurrent': 'Cancelling after current image...',

    // ========================
    // Embedding
    // ========================
    'embedding.preparing': 'Preparing embeddings...',
    'embedding.noPending': 'No pending images to embed.',

    // ========================
    // Artist Identification (additional)
    // ========================
    'artist.loadStatsFailed': 'Failed to load stats',
    'artist.runtimeUnavailable': 'Artist runtime status could not be loaded.',

    // ========================
    // Auto-Separate (additional)
    // ========================
    'autosep.previewEmptyInitial': 'No preview yet. Click "Preview Results" to inspect matching images.',

    // ========================
    // Batch Rename (additional)
    // ========================
    'censor.renamePattern': 'Rename Pattern',
    'censor.renameTokensHelp': 'Tokens: {original} = original name, {n} = number, {n:04d} = padded, {date} = date, {time} = time',
    'censor.renamePreview': 'Preview',

    // ========================
    // System / Hardware
    // ========================
    'system.detectedHardware': 'Detected Hardware',
    'system.recommendedBatchSize': 'Recommended Batch Size',
    'system.gpuName': 'GPU',
    'system.totalRam': 'Total RAM',
    'system.noGpuDetected': 'No GPU detected',

    // ========================
    // Tagger Model Descriptions
    // ========================
    'tagger.descDefault': 'Balanced default. Good speed, good quality, and solid stability.',
    'tagger.descSummaryFormat': '{summary} Q{quality}/5 \u2022 S{speed}/5 \u2022 Stable {stability}/5.{bestFor}{runtimeNote}',
    'tagger.bestForPrefix': ' Best for: {bestFor}.',

    // Tagger Runtime Descriptions
    'tagger.runtimeAdaptiveMax': 'Adaptive max-throughput mode is active. The app pushes GPU speed first, then falls back only if the run becomes unstable.',
    'tagger.runtimeCustomGpu': 'Custom model on GPU. Faster when it works, but less predictable than CPU Safe Mode.',
    'tagger.runtimeCustomCpu': 'Custom model on CPU Safe Mode. Finish one stable run first, then try GPU only if needed.',
    'tagger.runtimeRiskyGpu': 'Risky GPU override is active. This is not the stable default for this model.',
    'tagger.runtimeAdaptiveGpu': 'Adaptive GPU mode is active. The app is already using the recommended fast path for this hardware.',
    'tagger.runtimeCpuSafe': 'CPU Safe Mode is active. Slower, but safer when VRAM is tight or other AI tools are already running.',

    // Tagger Model Snapshot
    'tagger.customSubtitle': 'Custom local ONNX model. The app cannot infer its schema or stability in advance.',
    'tagger.customBadge': 'Custom',
    'tagger.onnxOnlyBadge': 'ONNX only',
    'tagger.schemaUnknownBadge': 'Schema unknown',
    'tagger.customNote': 'Start from one stable run first. Raise chunk size only after that.',
    'tagger.defaultSummary': 'WD14 tagger model',
    'tagger.defaultNote': 'The selected model decides quality, tag density, and hardware pressure.',

    // Tagger syncTaggerModelUi strings
    'tagger.customModelHelp': 'Custom ONNX model. Start with CPU Safe Mode first.',
    'tagger.highRiskSuffix': ' This hardware profile is marked high-risk for long GPU runs, so CPU is the safe default.',
    'tagger.recommendedChunkSuffix': ' Recommended chunk: {chunk}.',
    'tagger.catalogOnlyDetail': 'This entry stays in the catalog so the planned integration is visible, but the current tagger runtime cannot execute it.',
    'tagger.toriiGateGpuDetail': 'ToriiGate uses the multimodal PyTorch CUDA path. WD14 thresholds do not apply here.',
    'tagger.toriiGateCpuDetail': 'ToriiGate can run on CPU, but it is much slower than CUDA. WD14 thresholds do not apply here.',
    'tagger.customGpuAvailDetail': 'The final provider is decided when the custom ONNX session is created. GPU is available, but model stability still decides the final path.',
    'tagger.customCpuOnlyDetail': 'CUDAExecutionProvider is not available for the ONNX runtime path right now, so a custom model run will stay on CPU.',
    'tagger.cudaAvailDetail': 'CUDAExecutionProvider is available on this machine. If the session loads cleanly, the run should stay on GPU.',
    'tagger.cpuOnlyDetail': 'The current ONNX runtime probe does not expose CUDAExecutionProvider, so this run will stay on CPU.',
    'tagger.chipCatalogOnly': 'Catalog Only',
    'tagger.chipGpuTarget': 'GPU Target',
    'tagger.chipCpuTarget': 'CPU Target',
    'tagger.chipVlmNeeded': 'VLM Backend Needed',
    'tagger.chipPytorchCuda': 'PyTorch CUDA',
    'tagger.chipPytorchCpu': 'PyTorch CPU',
    'tagger.chipCpuRuntime': 'CPU Runtime',

    // Tagger GPU help strings
    'tagger.gpuHelpToriiGateGpu': 'ToriiGate is using the multimodal PyTorch backend on GPU. Keep chunk size small.',
    'tagger.gpuHelpToriiGateCpu': 'ToriiGate is using the multimodal PyTorch backend on CPU. This is valid but much slower than CUDA.',
    'tagger.gpuHelpAdaptive': 'Adaptive runtime is active for this model. The app prefers GPU throughput and falls back only if the run becomes unstable.',
    'tagger.gpuHelpCustomCpu': 'CPU Safe Mode is active for the custom model. Keep it here until you have one stable run.',
    'tagger.gpuHelpHighRiskCpu': 'CPU Safe Mode is active because this hardware profile is marked high-risk for long GPU tagging runs.',
    'tagger.gpuHelpCpuSafe': 'CPU Safe Mode is active. Use this when VRAM is tight or other AI tools are already running.',
    'tagger.gpuHelpRiskyOverride': 'High-risk GPU override is active. You will be asked to confirm before this run starts.',
    'tagger.gpuHelpAdaptiveNote': 'Adaptive runtime is active. {note}',
    'tagger.gpuHelpRecommendedNote': 'Recommended GPU mode is active. {note}',
    'tagger.gpuHelpRecommendedDefault': 'Recommended GPU mode is active for this model. Switch to CPU Safe Mode only if you need extra stability.',

    // Tagger advanced hint strings
    'tagger.advHintStressTest': 'Optional. Change this only if you are stress-testing.',
    'tagger.advHintHighRisk': 'Optional. This machine is marked high-risk for long GPU tagging.',
    'tagger.advHintCustom': 'Optional. Leave this alone until your custom model finishes one stable CPU run.',
    'tagger.advHintRecommended': 'Optional. The recommended mode is already active.',
    'tagger.advHintDefault': 'Optional. Change this only when troubleshooting or tuning.',

    // Tagger runtime chunk help strings
    'tagger.chunkHelpRecommended': 'Recommended chunk size: {chunk}. Leave this alone unless you are deliberately tuning throughput.',
    'tagger.chunkHelpAdaptive': 'This model already uses adaptive runtime limits. Only change chunk size if you are stress-testing.',
    'tagger.chunkHelpToriiGateGpu': 'ToriiGate uses the multimodal PyTorch backend. Keep chunk size small, usually 1-2.',
    'tagger.chunkHelpToriiGateCpu': 'ToriiGate on CPU should stay at chunk size 1.',
    'tagger.chunkHelpOverGpu': 'You chose {chosen}, above the recommended {recommended}. Expect higher VRAM pressure and more crash risk.',
    'tagger.chunkHelpOverCpu': 'You chose {chosen}, above the recommended {recommended}. This may help throughput, but it raises RAM pressure.',
    'tagger.chunkHelpRiskyGpu': 'This controls true WD14 batching where supported. Risky GPU mode still needs confirmation.',
    'tagger.chunkHelpCustom': 'Custom models may or may not support true batching. Start from the recommended value.',
    'tagger.chunkHelpHighRisk': 'This machine is marked high-risk for long GPU tagging. Leave the recommended chunk size alone.',
    'tagger.chunkHelpDefault': 'This controls the true WD14 batch size when the selected model supports dynamic batching.',

    // Tagger disabled model strings
    'tagger.disabledNotRunnable': '{model} is not runnable in the current build.',
    'tagger.disabledFallback': 'Use one of the ONNX taggers above for now.',
    'tagger.modelUnavailable': 'This model is currently unavailable in the app runtime.',
    'tagger.modelNotStartable': 'This model cannot be started in the current build.',
    'tagger.modelListedFuture': 'This model is listed for future integration but is not runnable in the current build.',

    // Tagger status chip
    'tagger.statusChipDefault': 'Auto Runtime',

    // Tagger toast messages
    'tagger.toastMaxQualityCpuSafe': 'Max Quality now runs in protected CPU Safe Mode inside the app.',
    'tagger.toastAutoSafeMode': 'This model was switched to CPU Safe Mode to avoid crashes.',

    // Tagger confirm risky GPU run
    'tagger.confirmCustomModel': 'custom model',
    'tagger.confirmModelFocus': 'Model focus: {bestFor}.',
    'tagger.confirmSpeedNotStability': 'This setup is optimized for maximum speed, not maximum stability.',
    'tagger.confirmCrashProne': '{model} on GPU is the most crash-prone tagger setup.',
    'tagger.confirmRecommendCpu': 'Recommended: switch to CPU Safe Mode first.',
    'tagger.confirmContinueRisky': 'Continue with risky GPU mode anyway?',
    'tagger.confirmRiskyTitle': 'Risky GPU Tagger Run',

    // Tagger progress
    'tagger.progressPreparing': 'Preparing tagger...',
    'tagger.progressTagging': '{current}/{total} ({tagged} tagged{errorSuffix}, ~{eta} remaining)',
    'tagger.progressTaggingNoEta': '{current}/{total} ({tagged} tagged{errorSuffix})',
    'tagger.progressErrorSuffix': ', {errors} failed',
    'tagger.progressCancelling': 'Cancelling... {current}/{total}',
    'tagger.progressCancelled': 'Tagging cancelled',
    'tagger.progressResuming': 'Resuming tagging progress...',
    'tagger.errorCheckingProgress': 'Error checking tag progress',
    'tagger.cancellingAfterCurrent': 'Cancelling after current image...',
    'tagger.minimizedToBackground': 'Tagging continues in the background. Use the progress bar to stop or check details.',
    'tagger.runInBackground': 'Run in Background',
    'tagger.bgStop': 'Stop',
    'tagger.bgStopTitle': 'Stop tagging',
    'tagger.bgDetails': 'Details',
    'tagger.bgDetailsTitle': 'Open tagger modal'

};
