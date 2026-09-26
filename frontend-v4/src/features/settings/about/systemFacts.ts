import type { SystemInfo } from './types'

// This computer's hardware, as the About tab shows it and as the copied
// diagnostics state it. Pure.

export interface SystemFacts {
  /** The card's name, or the cards Windows lists; null when none was found. */
  gpu: string | null
  /** The AI can run on it (PyTorch or ONNX Runtime sees CUDA). */
  aiGpu: boolean
  vram: { used: string; total: string } | null
  ram: { free: string; total: string } | null
  cpu: number | null
  os: string | null
}

export const gb = (value: number) => `${value.toFixed(1)} GB`

const MB_PER_GB = 1024

export function systemFacts(info: SystemInfo): SystemFacts {
  const listed = (info.gpu_devices ?? []).map((d) => d.name).filter((name): name is string => Boolean(name))
  const total = info.gpu_vram_total_mb
  const free = info.gpu_vram_available_mb
  return {
    gpu: info.gpu_name || listed.join(' / ') || null,
    aiGpu: info.torch_cuda_available === true || (info.onnx_providers ?? []).includes('CUDAExecutionProvider'),
    vram: total ? { used: gb((total - (free ?? total)) / MB_PER_GB), total: gb(total / MB_PER_GB) } : null,
    ram: info.total_ram_gb ? { free: gb(info.available_ram_gb ?? 0), total: gb(info.total_ram_gb) } : null,
    cpu: info.cpu_count ?? null,
    os: info.os_platform ?? null,
  }
}

export interface WindowFacts {
  width: number
  height: number
  zoom: number
  agent: string
}

/** Lines for the copied diagnostics (English, like the rest of the bundle: it is read by the developer). */
export function diagnosticLines(facts: SystemFacts | null, update: string, win: WindowFacts): string[] {
  const hardware = facts
    ? [
        `GPU: ${facts.gpu ?? 'none found'}${facts.aiGpu ? ' (AI can use it)' : ' (AI runs on the CPU)'}`,
        ...(facts.vram ? [`VRAM: ${facts.vram.used} used of ${facts.vram.total}`] : []),
        ...(facts.ram ? [`RAM: ${facts.ram.free} free of ${facts.ram.total}`] : []),
        ...(facts.cpu ? [`CPU threads: ${facts.cpu}`] : []),
        ...(facts.os ? [`OS: ${facts.os}`] : []),
      ]
    : ['Hardware: unavailable']
  return [
    'Interface: V4',
    ...hardware,
    `Update check: ${update}`,
    `Window: ${win.width}x${win.height} at ${Math.round(win.zoom * 100)}%`,
    `Browser: ${win.agent}`,
  ]
}
