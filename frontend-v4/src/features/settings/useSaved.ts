import { useEffect, useRef, useState } from 'react'

const SAVED_MS = 2400

/** Which setting was just changed, for a moment ("已保存" beside it). */
export function useSaved<T extends string>(): [T | null, (which: T) => void] {
  const [saved, setSaved] = useState<T | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const mark = (which: T) => {
    setSaved(which)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSaved(null), SAVED_MS)
  }
  return [saved, mark]
}
