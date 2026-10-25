import type { zhCNPixai } from './zh-CN.pixai'

export const enPixai: Record<keyof typeof zhCNPixai, string> = {
  'tagger.note.pixaiV10': 'Knows far more characters and series, weak at artist styles; about 10× slower than SwinV2 and needs about 8.3 GB of free GPU memory',
  'tagging.pixaiPick': 'Best PixAI',
  'tagger.cpuShort': '{model} on the CPU needs about {need_gb} GB of free memory and {free_gb} GB is free. Close programs you are not using (for example ComfyUI), or tag with a lighter model such as SwinV2.',
  'tagger.cpuShort.gpuBusy': 'Another program is using the GPU memory {model} needs, so it would run on the CPU, where it needs about {need_gb} GB of free memory; {free_gb} GB is free. Close programs you are not using (for example ComfyUI), or tag with a lighter model such as SwinV2.',
  'tagger.cpuShort.gpuStartFailed': 'The GPU could not start {model}, so it would run on the CPU, where it needs about {need_gb} GB of free memory; {free_gb} GB is free. Close programs you are not using (for example ComfyUI), or tag with a lighter model such as SwinV2.',
  'tagger.cpuShort.gpuStopped': 'The GPU stopped running {model} (often another program took its memory), so it would go on on the CPU, where it needs about {need_gb} GB of free memory; {free_gb} GB is free. The pictures tagged so far are kept. Close programs you are not using (for example ComfyUI), or tag with a lighter model such as SwinV2.',
  'jobs.stoppedBecause': 'Stopped: {reason}',
}
