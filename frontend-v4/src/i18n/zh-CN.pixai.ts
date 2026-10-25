// PixAI Tagger v1.0 in the tag panel (D47): its note and the badge that marks
// it as the recommended PixAI choice where it is not the app default (on a
// 12 GB+ NVIDIA GPU it is, and shows Recommended instead). Spread into
// zh-CN.ts; every key here must exist in en.pixai.ts (the type enforces it).
// Also the tagger's refusal to run on the CPU without enough free memory
// (features/jobs/taggerRefusal.ts) and the job line that carries it.
export const zhCNPixai = {
  'tagger.note.pixaiV10': '认得的角色和作品多很多，画师画风偏弱；比 SwinV2 慢约 10 倍，需要约 8.3 GB 空闲显存',
  'tagging.pixaiPick': 'PixAI 首选',
  'tagger.cpuShort': '{model} 用 CPU 跑需要约 {need_gb} GB 空闲内存，现在只有 {free_gb} GB。请关掉不用的程序（例如 ComfyUI），或改用较轻的模型，例如 SwinV2。',
  'tagger.cpuShort.gpuBusy': '另一个程序占着 {model} 需要的显存，只能改用 CPU；CPU 上需要约 {need_gb} GB 空闲内存，现在只有 {free_gb} GB。请关掉不用的程序（例如 ComfyUI），或改用较轻的模型，例如 SwinV2。',
  'tagger.cpuShort.gpuStartFailed': '显卡没能启动 {model}，只能改用 CPU；CPU 上需要约 {need_gb} GB 空闲内存，现在只有 {free_gb} GB。请关掉不用的程序（例如 ComfyUI），或改用较轻的模型，例如 SwinV2。',
  'tagger.cpuShort.gpuStopped': '显卡中途停止运行 {model}（常是别的程序占走了显存），只能改用 CPU；CPU 上需要约 {need_gb} GB 空闲内存，现在只有 {free_gb} GB。已经打好的标签都保留了。请关掉不用的程序（例如 ComfyUI），或改用较轻的模型，例如 SwinV2。',
  'jobs.stoppedBecause': '已停下：{reason}',
}
