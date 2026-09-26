import { describe, expect, test } from 'vitest'
import { diagnosticLines, gb, systemFacts } from './systemFacts'

describe('systemFacts', () => {
  test('a CUDA card: its name, VRAM used of total, memory free of total', () => {
    const facts = systemFacts({
      gpu_name: 'NVIDIA GeForce RTX 3090',
      torch_cuda_available: true,
      gpu_vram_total_mb: 24576,
      gpu_vram_available_mb: 20480,
      total_ram_gb: 63.9,
      available_ram_gb: 40.25,
      cpu_count: 24,
      os_platform: 'Windows',
    })
    expect(facts).toEqual({
      gpu: 'NVIDIA GeForce RTX 3090',
      aiGpu: true,
      vram: { used: '4.0 GB', total: '24.0 GB' },
      ram: { free: '40.3 GB', total: '63.9 GB' },
      cpu: 24,
      os: 'Windows',
    })
  })

  test('no CUDA: the cards Windows lists, and the AI runs on the processor', () => {
    const facts = systemFacts({ gpu_devices: [{ name: 'Intel(R) UHD Graphics' }, { name: null }], torch_cuda_available: false, onnx_providers: ['CPUExecutionProvider'] })
    expect(facts.gpu).toBe('Intel(R) UHD Graphics')
    expect(facts.aiGpu).toBe(false)
    expect(facts.vram).toBeNull()
    expect(facts.ram).toBeNull()
  })

  test('ONNX Runtime with CUDA counts as a card the AI can use', () => {
    expect(systemFacts({ gpu_name: null, onnx_providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'] }).aiGpu).toBe(true)
  })

  test('gb', () => {
    expect(gb(0)).toBe('0.0 GB')
    expect(gb(12.345)).toBe('12.3 GB')
  })
})

describe('diagnosticLines', () => {
  test('hardware, the update check and the window, for the copied bundle', () => {
    const facts = systemFacts({ gpu_name: 'RTX 3090', torch_cuda_available: true, gpu_vram_total_mb: 24576, gpu_vram_available_mb: 20480, total_ram_gb: 64, available_ram_gb: 40, cpu_count: 24, os_platform: 'Windows' })
    expect(diagnosticLines(facts, 'latest', { width: 1366, height: 768, zoom: 1, agent: 'Chrome/140' })).toEqual([
      'Interface: V4',
      'GPU: RTX 3090 (AI can use it)',
      'VRAM: 4.0 GB used of 24.0 GB',
      'RAM: 40.0 GB free of 64.0 GB',
      'CPU threads: 24',
      'OS: Windows',
      'Update check: latest',
      'Window: 1366x768 at 100%',
      'Browser: Chrome/140',
    ])
  })

  test('unknown hardware is said so, not skipped', () => {
    expect(diagnosticLines(null, 'unchecked', { width: 1920, height: 1080, zoom: 1.15, agent: 'x' })).toEqual([
      'Interface: V4',
      'Hardware: unavailable',
      'Update check: unchecked',
      'Window: 1920x1080 at 115%',
      'Browser: x',
    ])
  })
})
