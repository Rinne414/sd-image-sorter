import { useEffect } from 'react'
import { adoptRunningJobs, pollJobs, useJobs } from './jobs'
import { isFinished } from './progress'

const POLL_MS = 600

let adopted = false

/** Polls unfinished jobs while there are any; on start-up, picks up jobs already running. */
export function JobsRunner() {
  const active = useJobs((s) => s.jobs.some((j) => !isFinished(j.progress.status)))

  useEffect(() => {
    if (adopted) return
    adopted = true
    void adoptRunningJobs()
  }, [])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void pollJobs(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [active])

  return null
}
