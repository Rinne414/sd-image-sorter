import { useRef, useState, type DragEvent } from 'react'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { withClip } from './clip'
import { showUpload, useSimilar } from './similarStore'

// Search by image: an image file dropped on the query bar, or picked with
// the button or Ctrl K. The drop zone carries data-own-drop, so the library's
// drop-to-import stands aside while a file is over it.

const IMAGE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i

export const isImageFile = (f: File) => f.type.startsWith('image/') || IMAGE.test(f.name)

/** Rank the library against this file (downloading CLIP first when needed). */
export function searchByFile(file: File): void {
  void withClip(() => showUpload(file))
}

let picker: HTMLInputElement | null = null

/** Ask for an image file, then search by it. */
export function pickImageFile(): void {
  // In the document, so every browser opens its file chooser for it; one at a time.
  picker?.remove()
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.hidden = true
  input.onchange = () => {
    const file = input.files?.[0]
    input.remove()
    if (file) searchByFile(file)
  }
  document.body.append(input)
  picker = input
  input.click()
}

/** Search by a sentence (downloading CLIP first when needed). */
export function searchByText(text: string): void {
  const q = text.trim()
  if (q) void withClip(() => useSimilar.getState().show({ kind: 'text', text: q }))
}

const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')

/** Props that make an element a drop zone for search by image, and whether a file is over it. */
export function useImageDrop() {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const props = {
    'data-own-drop': '',
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current += 1
      setOver(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const file = [...e.dataTransfer.files].find(isImageFile)
      if (file) searchByFile(file)
      else useToasts.getState().push(tr('sim.dropNotImage'), 'error')
    },
  }
  return { over, props }
}
