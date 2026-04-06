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
    'censor.queueSubtitle': 'Click to edit \u2022 Ctrl/Shift multi-select \u2022 Use Top/Bottom or Alt+Home/End for big queues',
    'censor.moveTop': 'Top',
    'censor.moveUp': 'Up',
    'censor.moveDown': 'Down',
    'censor.moveBottom': 'Bottom',
    'censor.noImages': 'No images selected',
    'censor.selectFromGallery': 'Select from Gallery',
    'censor.brush': 'Brush',
    'censor.pen': 'Pen',
    'censor.eraser': 'Eraser',
    'censor.clone': 'Clone',
    'censor.undo': 'Undo',
    'censor.reset': 'Reset',
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
    'censor.advancedPrecision': 'SAM3 Text Precision (Pro)',
    'censor.textPromptPlaceholder': 'e.g. exposed breasts, face, tattoo, hand',
    'censor.textPromptHelp': 'Type a prompt here for SAM3. Execution still needs a CUDA-ready SAM3 runtime.',
    'censor.segmentText': 'Segment by Text',
    'censor.detectCurrentBtn': 'Detect Current',
    'censor.detectAll': 'Detect All',
    'censor.quickAutoCensor': 'Quick Auto Censor',
    'censor.quickAutoCensorHelp': 'Use Wenaka / NudeNet for the normal privacy workflow.',
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
    'modal.tagDescription': 'Uses WD14 tagger to automatically tag your images with anime/illustration tags.',
    'modal.tagModel': 'Model',
    'modal.tagBestQuality': 'Best Quality',
    'modal.tagCustomModel': 'Custom Local Model...',
    'modal.tagCustomModelPath': 'Custom Model Path (.onnx)',
    'modal.tagCustomModelPathHelper': 'Path to your local .onnx model file',
    'modal.tagTagsCsvPath': 'Tags CSV Path',
    'modal.tagTagsCsvHelper': 'Required when using custom model',
    'modal.tagGeneralThreshold': 'General Tag Threshold',
    'modal.tagCharacterThreshold': 'Character Tag Threshold',
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
    'rename.baseName': 'Base Name',
    'rename.baseNameHelper': 'Base name for all images',
    'rename.startingNumber': 'Starting Number',
    'rename.startingNumberHelper': 'Images will be numbered sequentially from this number',
    'rename.preview': 'Preview',
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
    'lang.switchLabel': 'Switch language'
};
