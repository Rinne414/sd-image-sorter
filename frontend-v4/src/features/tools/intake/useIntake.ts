import { useEffect, useRef, useState } from 'react'
import type { ToolId } from '../../../lib/route'
import { isTypingTarget } from '../../../lib/format'
import { useApp } from '../../../state/store'
import { claimFileDrops } from '../../../ui/dropClaim'
import { layerCount } from '../../../ui/layers'
import { firstImage, pastedImage, type IntakeOrigin } from './intakeFiles'

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

/** The tool's page is the one on screen and nothing is open over it. */
const isOnTop = (tool: ToolId) => {
  const s = useApp.getState()
  return s.page === 'tools' && s.toolId === tool && layerCount() === 0
}

/**
 * While a tool's page is shown, an image dropped anywhere on the window or
 * pasted with Ctrl+V (outside a text field) goes to it; the Library import
 * stands aside. Returns whether files are being dragged over the window.
 */
export function useIntake(tool: ToolId, onFile: (file: File, origin: IntakeOrigin) => void): boolean {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const take = useRef(onFile)
  useEffect(() => {
    take.current = onFile
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
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const file = firstImage(e.dataTransfer.files)
      if (file && isOnTop(tool)) take.current(file, 'drop')
    }
    const paste = (e: ClipboardEvent) => {
      if (!isOnTop(tool) || isTypingTarget(e.target)) return
      const file = pastedImage(e.clipboardData)
      if (!file) return
      e.preventDefault()
      take.current(file, 'paste')
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
