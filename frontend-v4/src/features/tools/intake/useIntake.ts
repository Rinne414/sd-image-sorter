import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolId } from '../../../lib/route'
import { isTypingTarget } from '../../../lib/format'
import { useApp } from '../../../state/store'
import { claimFileDrops } from '../../../ui/dropClaim'
import { layerCount } from '../../../ui/layers'
import { imagesOf, pastedImages, TOOL_RESULT_DRAG, type IntakeOrigin } from './intakeFiles'

const typesOf = (e: DragEvent) => (e.dataTransfer ? [...e.dataTransfer.types] : [])
/** The tool's own result being dragged out: it may not land back on the page. */
const isOwnResult = (e: DragEvent) => typesOf(e).includes(TOOL_RESULT_DRAG)
const hasFiles = (e: DragEvent) => typesOf(e).includes('Files') && !isOwnResult(e)

/** The tool's page is the one on screen and nothing is open over it. */
const isOnTop = (tool: ToolId) => {
  const s = useApp.getState()
  return s.page === 'tools' && s.toolId === tool && layerCount() === 0
}

type OnFiles = (files: File[], origin: IntakeOrigin) => void

/**
 * While a tool's page is shown, images dropped anywhere on the window or
 * pasted with Ctrl+V (outside a text field) go to it; the Library import
 * stands aside. Returns whether files are being dragged over the window.
 */
export function useIntakeFiles(tool: ToolId, onFiles: OnFiles): boolean {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const take = useRef(onFiles)
  useEffect(() => {
    take.current = onFiles
  })

  useEffect(() => {
    const release = claimFileDrops()
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current += 1
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const dragOver = (e: DragEvent) => {
      if (isOwnResult(e) && e.dataTransfer) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'none'
      } else if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const files = imagesOf(e.dataTransfer.files)
      if (files.length && isOnTop(tool)) take.current(files, 'drop')
    }
    const paste = (e: ClipboardEvent) => {
      if (!isOnTop(tool) || isTypingTarget(e.target)) return
      const files = pastedImages(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      take.current(files, 'paste')
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', dragOver)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      release()
      depth.current = 0
      setOver(false)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', dragOver)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [tool])

  return over
}

/** The same for a tool that takes one image: the first one dropped or pasted. */
export function useIntake(tool: ToolId, onFile: (file: File, origin: IntakeOrigin) => void): boolean {
  const take = useRef(onFile)
  useEffect(() => {
    take.current = onFile
  })
  const first = useCallback<OnFiles>((files, origin) => {
    const file = files[0]
    if (file) take.current(file, origin)
  }, [])
  return useIntakeFiles(tool, first)
}
