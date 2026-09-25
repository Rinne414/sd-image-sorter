import { create } from 'zustand'
import type { Raster } from './raster'

// The picture as the editor shows it now, for what reads it (the histogram,
// "show changes"). `version` goes up whenever the pixels changed.

interface PixelsState {
  imageId: number | null
  result: Raster | null
  original: Raster | null
  version: number
}

export const useCanvasPixels = create<PixelsState>(() => ({ imageId: null, result: null, original: null, version: 0 }))

export function publishPixels(imageId: number, result: Raster, original: Raster): void {
  useCanvasPixels.setState((s) => ({ imageId, result, original, version: s.version + 1 }))
}
