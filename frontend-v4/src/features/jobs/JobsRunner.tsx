import { useEffect } from 'react'
import { resumeModelDownloads } from './installResume'
import { adoptRunningJobs, pollJobs, useJobs } from './jobs'
import { isFinished } from './progress'
import { watchTitle } from './titleBadge'

const POLL_MS = 600

let adopted = false

/** Polls unfinished jobs while there are any; on start-up, picks up jobs already running. */
export function JobsRunner() {
  const active = useJobs((s) => s.jobs.some((j) => !isFinished(j.progress.status)))

  useEffect(() => {
    if (adopted) return
    adopted = true
    void adoptRunningJobs().then(resumeModelDownloads) // 5d: model downloads left for after a restart
  }, [])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void pollJobs(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [active])

  // A job that ends while the tab is in the background shows in the tab title.
  useEffect(() => watchTitle((listener) => useJobs.subscribe((s, prev) => listener(s.jobs, prev.jobs))), [])

  return null
}
