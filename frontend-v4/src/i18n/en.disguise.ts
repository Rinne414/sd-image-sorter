import type { zhCNDisguise } from './zh-CN.disguise'

// English for the Privacy cover-picture disguise; must have every key of zh-CN.disguise.ts.
export const enDisguise: Record<keyof typeof zhCNDisguise, string> = {
  // the mode
  'disguise.mode': 'Chat disguise',
  'disguise.mode.hint': 'Puts a harmless cover on the picture: the chat list shows the cover, and opening it shows the real one.',
  'disguise.what': 'The cover is what a chat list shows; the real picture appears when someone opens it. Results are written to a folder on this computer, can be pasted into a chat as files, and can be restored.',
  'disguise.local': 'Pictures are made by the program on this computer; nothing goes online.',
  'disguise.emptyHint': 'Library images: pick them, then More → Send to tool → Privacy scramble, or right-click one. Disguises are made by the program on this computer; pictures are never uploaded anywhere.',

  // the cover
  'disguise.cover': 'Cover',
  'disguise.cover.default': 'Default cover',
  'disguise.cover.mosaic': 'Auto mosaic of the same picture',
  'disguise.cover.text': 'Text card',
  'disguise.cover.blur': 'Blurred picture',
  'disguise.cover.upload': 'A picture I choose',
  'disguise.cover.noDefault': 'No default cover yet',
  'disguise.cover.setDefault': 'Set default cover…',
  'disguise.cover.clearDefault': 'Remove',
  'disguise.cover.choose': 'Choose picture…',
  'disguise.cover.useAsDefault': 'Use as default cover',
  'disguise.cover.defaultAlt': 'Default cover',
  'disguise.cover.uploadAlt': 'The chosen cover',
  'disguise.cover.textLabel': 'Text on the card',
  'disguise.cover.textPlaceholder': 'Open to view',
  'disguise.cover.cardColor': 'Card colour',
  'disguise.cover.textColor': 'Text colour',
  'disguise.cover.mosaicNote': 'Uses the detector settings of the Censor page, on library images only. A picture where nothing is found is marked so you can pick another cover.',
  'disguise.cover.blurNote': 'The cover is the picture itself, blurred.',
  'disguise.cover.defaultSaved': 'Default cover saved',
  'disguise.cover.defaultFailed': 'Could not save the default cover: {reason}',
  'disguise.cover.defaultRemoved': 'Default cover removed',
  'disguise.cover.pickFirst': 'Choose a cover picture first.',

  // packing, size, saving
  'disguise.pack': 'Pack all pictures into one file (they play in turn when opened)',
  'disguise.seconds': 'Seconds per picture',
  'disguise.packFormat': 'Make',
  'disguise.packFormat.disguise': 'A disguise (animated PNG)',
  'disguise.packFormat.gif': 'A looping GIF (no cover)',
  'disguise.scrub': 'Remove prompts and info hidden in the pictures',
  'disguise.scrub.hint': 'The made file carries no generation details.',
  'disguise.maxSide': 'Longest side (px, 0 = original size)',
  'disguise.folder': 'Save to folder',
  'disguise.folder.placeholder': 'Empty = the disguise folder in the program’s data',
  'disguise.folder.choose': 'Choose…',
  'disguise.folder.chooseTitle': 'Where to save the disguise pictures',
  'disguise.folder.chooseOk': 'Save here',

  // the buttons above the queue, and the run
  'disguise.make': 'Make disguise',
  'disguise.make.hint': 'Makes a disguise of every picture in the queue with the settings on the left and writes it to the save folder. Always starts from the original.',
  'disguise.restore': 'Restore',
  'disguise.restore.hint': 'Brings the real picture back out of each disguise in the queue; anything that is not a disguise is marked.',
  'disguise.running.make': 'Making {done}/{total}…',
  'disguise.running.restore': 'Restoring {done}/{total}…',
  'disguise.summary.made': 'Made {n} disguise images, saved in {folder}.',
  'disguise.summary.pack': 'Packed {n} pictures into one file, {name}, saved in {folder}.',
  'disguise.summary.gif': 'Made one looping GIF from {n} pictures, {name}, saved in {folder}.',
  'disguise.summary.waiting': '{n} pictures need a cover.',
  'disguise.summary.failed': '{n} failed; the reason is under each picture.',
  'disguise.summary.restored': 'Restored {done}/{total} pictures; download or copy them from their cards.',
  'disguise.summary.stopped': 'Stopped after the current picture: {done}/{total} done.',
  'disguise.summary.none': 'No disguise image was made.',

  // one image in the queue
  'disguise.item.done': 'Disguised · {width}×{height} · {size}',
  'disguise.item.saved': 'Saved: {path}',
  'disguise.item.needsCover': 'Needs a cover: {reason}',
  'disguise.item.packed': 'In the packed file',
  'disguise.item.restored': 'Restored · the real picture inside',
  'disguise.item.cover': 'Cover',
  'disguise.item.copy.hint': 'Copy the finished file, to paste into a chat window',
  'disguise.item.reveal': 'Show in folder',
  'disguise.item.reveal.hint': 'Opens the save folder with this file selected; dragging it into a chat window works too',
  'disguise.item.noResult': 'Not made yet',

  // why a picture needs another cover
  'disguise.reason.nothing_detected': 'nothing to mosaic was found',
  'disguise.reason.detector_unavailable': 'the censor detector is not ready (download its model in Model Center)',
  'disguise.reason.not_in_library': 'auto mosaic works on library images only',
  'disguise.reason.no_default_cover': 'no default cover is set',
  'disguise.reason.no_upload': 'no cover picture was chosen',
  'disguise.reason.unknown': 'unknown reason ({reason})',

  // the bar and the pack card
  'disguise.bar.needsCover': '{n} pictures need a cover ({reasons})',
  'disguise.bar.redoFailed': 'Use the default cover for these',
  'disguise.bar.redoAll': 'Use the default cover for all',
  'disguise.pack.info': '{name} · {frames} pictures · {width}×{height} · {size}',
  'disguise.pack.saved': 'Saved: {path}',
  'disguise.pack.copy': 'Copy file',
  'disguise.pack.download': 'Download',
  'disguise.pack.coverAlt': 'Cover of the packed file',
  'disguise.copyAll': 'Copy all as files',

  // copy and reveal
  'disguise.copied': 'Copied as files. Paste into the chat window.',
  'disguise.copyUnsupported': 'This computer cannot copy files from here. Use “Show in folder” and drag the file into the chat window.',
  'disguise.copyFailed': 'Could not copy: another program is using the clipboard. Close it and try again.',
  'disguise.revealFailed': 'Could not open the folder: {reason}',
  'disguise.download.failed': 'Could not download: {reason}',

  // problems
  'disguise.err.notDisguise': 'This is not a disguise image.',
  'disguise.err.damaged': 'The hidden picture is damaged and cannot be read.',
  'disguise.err.tooLarge': 'This picture is too large to process safely.',
  'disguise.err.unreadable': 'This picture cannot be read.',
  'disguise.err.libraryGone': 'This picture is no longer in the library.',
  'disguise.err.folder': 'The save folder cannot be used: {detail}',
  'disguise.err.generic': 'Could not process this picture ({detail})',
}
