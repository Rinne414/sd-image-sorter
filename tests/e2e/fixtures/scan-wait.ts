import { expect, type APIRequestContext } from '@playwright/test'

/**
 * Start a scan of `folder` and wait until that run is over.
 *
 * Any open page acknowledges a finished manual scan, and acknowledging resets
 * the progress to the default idle state with run_id 0
 * (backend/services/sorting/state.py, _set_scan_progress_idle_locked). In a
 * parallel run another spec's page can do that before this poll sees "done",
 * so waiting for "done" alone, or for an idle state carrying this run's id,
 * flaked (2026-11-08). The run is already going when the POST returns, so
 * idle afterwards, or a later run, means this run is over.
 */
export async function scanAndWait(request: APIRequestContext, folder: string, timeout = 60_000): Promise<number> {
  const runId = await startScan(request, folder, timeout)
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    const progressRun = Number(progress.run_id)
    if (progress.status === 'idle' || progressRun > runId) return 'over'
    if (progress.status === 'done' && progressRun === runId) return 'over'
    return String(progress.status || '')
  }, { timeout }).toBe('over')
  return runId
}

/**
 * Another worker's scan may be running: the server answers 409 "Scan already
 * in progress" until it ends, so wait for it and start ours then. Any other
 * refusal fails (shown as the poll's last value).
 */
async function startScan(request: APIRequestContext, folder: string, timeout: number): Promise<number> {
  let runId = 0
  await expect.poll(async () => {
    const response = await request.post('/api/scan', { data: { folder_path: folder, recursive: true } })
    if (response.ok()) {
      runId = Number((await response.json()).run_id)
      return 'started'
    }
    const reason = `${response.status()} ${await response.text()}`
    return response.status() === 409 && reason.includes('already in progress') ? 'busy' : reason
  }, { timeout, intervals: [250, 500, 1000] }).toBe('started')
  return runId
}
