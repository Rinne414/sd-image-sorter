import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolId } from '../../../lib/route'
import { isTypingTarget } from '../../../lib/format'
import { inspectTransfer } from '../../../lib/localPicture'
import { useApp } from '../../../state/store'
import { claimFileDrops } from '../../../ui/dropClaim'
import { layerCount } from '../../../ui/layers'
import { TOOL_RESULT_DRAG, withName, type IntakeOrigin } from './intakeFiles'
import { takePictures, tellMissing, type TakenHow } from './localIntake'

const TEXT_TYPES = ['text/uri-list', 'text/html', 'text/plain']

const typesOf = (e: DragEvent) => (e.dataTransfer ? [...e.dataTransfer.types] : [])
/** The tool's own result being dragged out: it may not land back on the page. */
const isOwnResult = (e: DragEvent) => typesOf(e).includes(TOOL_RESULT_DRAG)
const hasFiles = (e: DragEvent) => typesOf(e).includes('Files') && !isOwnResult(e)
/** A drag with no file but text: a chat app (QQ) drags a picture out as its file:// location. */
const hasText = (e: DragEvent) => !isOwnResult(e) && !typesOf(e).includes('Files') && typesOf(e).some((t) => TEXT_TYPES.includes(t))

/** The tool's page is the one on screen and nothing is open over it. */
const isOnTop = (tool: ToolId) => {
  const s = useApp.getState()
  return s.page === 'tools' && s.toolId === tool && layerCount() === 0
}

type OnFiles = (files: File[], origin: IntakeOrigin) => void

/**
 * A picture read from disk by its location is the original file, so it comes
 * in as a drop (a pasted one is a re-encoded copy that may have lost details).
 */
const originOf = (how: TakenHow, handed: IntakeOrigin): IntakeOrigin => (how === 'location' ? 'drop' : handed)

/**
 * While a tool's page is shown, images dropped anywhere on the window or
 * pasted with Ctrl+V (outside a text field) go to it; the Library import
 * stands aside. A drop or paste that carries a picture's file location (QQ
 * and other chat apps) is read from disk; one with no usable picture is
 * answered with what was missing. `many` = all of them, not just the first.
 * Returns whether files are being dragged over the window.
 */
export function useIntakeFiles(tool: ToolId, onFiles: OnFiles, many = true): boolean {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const take = useRef(onFiles)
  useEffect(() => {
    take.current = onFiles
  })

  useEffect(() => {
    const release = claimFileDrops()
    // A drag that started on this page (selected text, a link) is not an intake.
    let dragFromPage = false
    const started = () => {
      dragFromPage = true
    }
    const ended = () => {
      dragFromPage = false
    }
    const outsideText = (e: DragEvent) => !dragFromPage && hasText(e) && !isTypingTarget(e.target)
    const wanted = (e: DragEvent) => hasFiles(e) || outsideText(e)
    const enter = (e: DragEvent) => {
      if (!wanted(e)) return
      depth.current += 1
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!wanted(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const dragOver = (e: DragEvent) => {
      if (isOwnResult(e) && e.dataTransfer) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'none'
      } else if (wanted(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!wanted(e) || !e.dataTransfer) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      if (!isOnTop(tool)) return
      const taken = takePictures(inspectTransfer(e.dataTransfer), (files, how) => take.current(files, originOf(how, 'drop')), { many })
      if (taken.reason) tellMissing(taken.reason, false)
    }
    const paste = (e: ClipboardEvent) => {
      if (!isOnTop(tool) || isTypingTarget(e.target)) return
      e.preventDefault()
      // The original file at a copied picture's location beats the pasted bitmap.
      const taken = takePictures(
        inspectTransfer(e.clipboardData),
        (files, how) => take.current(how === 'location' ? files : files.map(withName), originOf(how, 'paste')),
        { many, preferLocation: true },
      )
      if (taken.reason) tellMissing(taken.reason, true)
    }
    window.addEventListener('dragstart', started)
    window.addEventListener('dragend', ended)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', dragOver)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      release()
      depth.current = 0
      setOver(false)
      window.removeEventListener('dragstart', started)
      window.removeEventListener('dragend', ended)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', dragOver)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [tool, many])

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
  return useIntakeFiles(tool, first, false)
}
