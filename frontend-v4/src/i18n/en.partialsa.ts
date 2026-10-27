import type { zhCNPartialsA } from './zh-CN.partialsa'

export const enPartialsA: Record<keyof typeof zhCNPartialsA, string> = {
  // ---- colour analysis, live in the library status
  'partialsa.colors.running': 'Analysing colours: {done} of {total}',
  'partialsa.colors.paused': 'Colour analysis paused: {done} of {total}',
  'partialsa.colors.pause': 'Pause',
  'partialsa.colors.resume': 'Resume',
  'partialsa.colors.hide': 'Hide',
  'partialsa.colors.hideTitle': 'Hide this line. The analysis keeps running; follow it in Jobs.',
  'partialsa.colors.pausedItem': 'Paused',

  // ---- unreadable files line: hide for now
  'partialsa.unreadable.hide': 'Hide for now',
  'partialsa.unreadable.hideTitle': 'Hidden until the number of unreadable files changes or you reopen the program',
  'partialsa.unreadable.hidden': 'Hidden. It comes back if the number of unreadable files changes; the library report always lists them.',

  // ---- Settings › Library: repair prompts and text
  'partialsa.repair.title': 'Repair prompts and text',
  'partialsa.repair.hint': 'Read the prompts and text of your images again. No file is moved or renamed; only the text the program stored changes. A run shows in Jobs, can be stopped any time, and keeps what it finished.',
  'partialsa.repair.recover.title': 'Recover missing text',
  'partialsa.repair.recover.body': 'Look again for the prompt or caption of images that have neither: first in what was stored when they were imported, then in the file itself and its .txt or .json caption.',
  'partialsa.repair.recover.count': '{n} images have no text yet',
  'partialsa.repair.recover.nothing': 'Every image has text, so there is nothing to recover.',
  'partialsa.repair.comfy.title': 'Read ComfyUI prompts again',
  'partialsa.repair.comfy.body': 'Read the prompt of every ComfyUI image again from its file with the current reader, whether or not one is stored. Only prompts that come out different are rewritten; tags, scores and captions stay. Use it after the reader has been improved.',
  'partialsa.repair.comfy.count': 'ComfyUI images in this library: {n}',
  'partialsa.repair.comfy.nothing': 'There are no ComfyUI images in this library.',
  'partialsa.repair.counting': 'Counting…',
  'partialsa.repair.countFailed': 'Could not count them; you can still start.',
  'partialsa.repair.start': 'Start',
  'partialsa.repair.running': 'Running…',
  'partialsa.repair.last': 'Last run',
  'partialsa.repair.result.recover': 'Recovered {recovered} prompts and {captions} captions; {still} images still have no text.',
  'partialsa.repair.result.comfy': '{changed} got a different prompt, {unchanged} were already right, {kept} left as they were because the file no longer gives a prompt, {missing} files not found.',
  'partialsa.repair.result.stopped': 'Stopped. What was finished is kept.',
  'partialsa.repair.result.failed': 'It did not finish: {reason}',
  'partialsa.repair.comfy.running': 'Reading ComfyUI prompts again: {n} images',
  'partialsa.repair.comfy.done': 'Read again: {n} prompts changed',

  // ---- a censor step with no images
  'partialsa.censorEmpty.open': 'Add images from the Library',

  // ---- Home: tool cards
  'partialsa.home.tools': 'Tools',
  'partialsa.home.reader.body': 'Drop in an image to read its prompt and settings',
  'partialsa.home.privacy.body': 'Scramble images before you upload them, and restore them later',
  'partialsa.home.similar.title': 'Find similar',
  'partialsa.home.similar.body': 'Pick a picture and see the ones that look like it',
  'partialsa.home.dups.title': 'Find duplicates',
  'partialsa.home.dups.body': 'Review near-identical pictures and choose which to keep',
  'partialsa.home.models.body': 'Download and manage the AI models',
  'partialsa.home.all.title': 'All features',
  'partialsa.home.all.body': 'Press Ctrl K to search everything the program can do',

  // ---- Settings: sort sound and focus mode
  'partialsa.opt.on': 'On',
  'partialsa.opt.off': 'Off',
  'partialsa.sound.title': 'Sound while sorting',
  'partialsa.sound.hint': 'A short sound when an image goes somewhere. The same option on the Sort page is this setting.',
  'partialsa.focus.title': 'Focus mode while sorting',
  'partialsa.focus.hint': 'Hide the top bar while sorting and keep only the sort; Esc leaves. The same option on the Sort page is this setting.',

  // ---- Sort by condition: the preview switch
  'partialsa.preview.auto': 'Preview automatically when the rule changes',
  'partialsa.preview.autoHint': 'Turn it off if the library is large and the preview is slow; use Show preview when you want it.',
  'partialsa.preview.show': 'Show preview',
}
