import type { zhCNGenerator } from './zh-CN.generator'

export const enGenerator: Record<keyof typeof zhCNGenerator, string> = {
  // entrances
  'generator.action': 'Send to generator…',
  'generator.palette': 'Send this picture to a generator',
  'generator.button': 'Send to generator',
  'generator.buttonTip': 'Copy WebUI or NovelAI parameters, copy or save the ComfyUI workflow, or run it again in ComfyUI',

  // the dialog
  'generator.title': 'Send to generator',
  'generator.loading': 'Reading the recipe…',
  'generator.loadFailed': "Could not read this picture's recipe: {reason}",
  'generator.fromStored': 'The picture file was not found: this is the copy kept in the library.',
  'generator.nothing':
    'This picture records no generation details, so there is nothing to send back. Pictures made by WebUI, Forge, NovelAI or ComfyUI usually carry them.',
  'generator.previewLabel': 'Text that will be copied',
  'generator.noPrompt': 'This picture has no prompt to copy',
  'generator.nothingToCopy': 'Nothing to copy for this picture',
  'generator.copyFailed': 'Could not copy: the browser did not let the program write to the clipboard.',

  'generator.webui.title': 'WebUI / Forge',
  'generator.webui.lead': 'Prompt, negative prompt and settings, in the text WebUI and Forge read back with the arrow under Generate.',
  'generator.webui.copy': 'Copy parameters',
  'generator.webui.copied': 'WebUI parameters copied. Paste into the prompt box, then press the arrow under Generate (Read generation parameters).',

  'generator.nai.title': 'NovelAI',
  'generator.nai.lead': "Prompt and undesired content in NovelAI's weight syntax ({ } and n::), with the undesired content labelled.",
  'generator.nai.copy': 'Copy prompt + undesired',
  'generator.nai.copied': 'NovelAI prompt and undesired content copied.',

  // ComfyUI
  'generator.comfy.title': 'ComfyUI',
  'generator.comfy.none': 'No ComfyUI recipe in this picture. Use the copy buttons above.',
  'generator.comfy.full': 'The picture holds the full workflow and the recipe to run it.',
  'generator.comfy.runOnly':
    'The picture holds only the recipe to run, not the workflow as drawn on the canvas. Save it as .json and drop the file on ComfyUI, or run it right here.',
  'generator.comfy.workflowOnly': 'The picture holds the workflow as drawn on the canvas but no recipe to run: it can be copied or saved, not run again.',
  'generator.comfy.seeds': 'Seed fields in the recipe: {n}',
  'generator.comfy.copyWorkflow': 'Copy workflow',
  'generator.comfy.copyWorkflowTip': 'Paste onto the ComfyUI canvas with Ctrl+V',
  'generator.comfy.workflowCopied': 'Workflow copied. Click the ComfyUI canvas and press Ctrl+V.',
  'generator.comfy.saveWorkflow': 'Save .json',
  'generator.comfy.saveWorkflowTip': 'Save into the workflows output folder; drop the file on ComfyUI to load it',
  'generator.comfy.saving': 'Saving…',
  'generator.comfy.workflowSaved': 'Saved {name} in {folder}',

  'generator.run.label': 'Run again',
  'generator.run.seed': 'Seed',
  'generator.run.seedNew': 'New seed',
  'generator.run.seedSame': 'Same seed',
  'generator.run.button': 'Run in ComfyUI',
  'generator.run.tip': 'Queue this recipe on {url}',
  'generator.run.sending': 'Sending to {url}…',
  'generator.run.queuedNew': 'Queued in ComfyUI at {address} with a new seed. Seed fields changed: {count}.',
  'generator.run.queuedSame': 'Queued in ComfyUI at {address} with the same seed.',
  'generator.run.needsRecipe': 'This picture has no recipe to run, so it cannot be run again.',

  // the address
  'generator.address.title': 'ComfyUI address',
  'generator.address.body': "Run in ComfyUI sends a picture's recipe to this address. Leave it empty for the default address.",
  'generator.address.label': 'ComfyUI address',
  'generator.address.reset': 'Use the default',
  'generator.address.resetTip': 'Clear it and use the default address {url}',
  'generator.address.using': 'Using {url}',
  'generator.address.saved': 'ComfyUI address saved',
  'generator.address.loadFailed': 'Could not read the ComfyUI address: {reason}',
  'generator.address.refused': 'Not saved: {reason}',

  // what the program says when ComfyUI or the picture does not cooperate
  'generator.err.addressSpaces': 'The ComfyUI address cannot contain spaces.',
  'generator.err.addressScheme': 'The ComfyUI address must start with http:// or https://.',
  'generator.err.addressNoHost': 'The ComfyUI address needs a host, for example http://127.0.0.1:8188.',
  'generator.err.addressExtras': 'Write the ComfyUI address without a user name, ? or #.',
  'generator.err.addressHost':
    'The host in the ComfyUI address is not valid: use localhost, an IP address such as 127.0.0.1, or a computer name.',
  'generator.err.addressPort': 'The port in the ComfyUI address is not a number from 1 to 65535.',
  'generator.err.addressPath': 'The path in the ComfyUI address has characters an address cannot hold.',
  'generator.err.badAddress': 'The ComfyUI address in the settings cannot be used: {reason}',
  'generator.err.unreachable': 'ComfyUI is not reachable at {address}. Start ComfyUI, or check the address above.',
  'generator.err.timeout': 'ComfyUI at {address} did not answer in time. It may be busy; try again.',
  'generator.err.rejected': 'ComfyUI at {address} did not queue this recipe: {reason}',
  'generator.err.redirect': 'ComfyUI at {address} sent this request on to {location}; it was not followed. Check the address above.',
  'generator.err.badAnswer': 'The program at {address} answered, but not like ComfyUI. Check the address above.',
  'generator.err.noRecipeSave': 'This picture has no ComfyUI workflow to save.',
  'generator.err.noRecipeRun': 'This picture has no ComfyUI recipe to run. Its prompt can still be copied.',
  'generator.err.imageGone': 'This picture is no longer in the library.',
  'generator.err.writeFailed': 'Could not save the workflow: {reason}',
  'generator.err.settingFailed': 'The setting could not be saved: {reason}',
  'generator.err.other': 'That did not work: {reason}',
}
