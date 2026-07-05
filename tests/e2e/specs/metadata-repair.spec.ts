import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

/**
 * Metadata L3 (v3.5.0): raw-envelope retention + "Re-parse Missing Prompts".
 *
 * Fixture rows exercise both triage paths without any real image files:
 *  - one missing-prompt row with a stored raw envelope (file long gone) —
 *    must be recovered purely from the DB (used_raw)
 *  - one missing-prompt row with neither raw nor file — must be counted as
 *    missing_source and left untouched
 * The UI test verifies the Dataset Audit hero exposes the re-parse button
 * while missing-prompt rows exist.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fsSync.existsSync(candidate)
  }
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookupCommand, [candidate], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0
  } catch {
    return false
  }
}

const backendPythonCandidates = process.platform === 'win32' ? [
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python',
] : [
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
  'python3',
  'python',
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
]

const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => commandExists(candidate))
  || backendPythonCandidates[0]
const runtimeDatabasePath = process.env.SD_IMAGE_SORTER_DB_PATH
  || path.join(repoRoot, 'data', 'images.db')

function runBackendScript(script: string): string {
  return execFileSync(backendPython, ['-X', 'utf8', '-c', script], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).toString('utf8').trim()
}

/** Inserts the two fixture rows; returns [recoverableId, missingSourceId]. */
function resetFixture(): number[] {
  const script = `
import gzip
import json
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(runtimeDatabasePath)})

graph = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "meinamix_v11.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, e2e raw replay, masterpiece", "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, lowres", "clip": ["1", 1]}},
    "4": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    "5": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
                                                "scheduler": "normal", "denoise": 1.0, "model": ["1", 0],
                                                "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
}
raw = gzip.compress(json.dumps({"prompt": json.dumps(graph)}).encode("utf-8"))

ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-meta-%'")
    cur.execute(
        """
        INSERT INTO images (path, filename, generator, prompt, width, height, file_size,
                            is_readable, metadata_status, created_at, raw_metadata_gz)
        VALUES (?, 'v350-meta-raw.png', 'comfyui', NULL, 512, 512, 1000, 1, 'complete', CURRENT_TIMESTAMP, ?)
        """,
        ("C:/definitely/not/real/v350-meta-raw.png", raw),
    )
    ids.append(cur.lastrowid)
    cur.execute(
        """
        INSERT INTO images (path, filename, generator, prompt, width, height, file_size,
                            is_readable, metadata_status, created_at)
        VALUES (?, 'v350-meta-gone.png', 'comfyui', NULL, 512, 512, 1000, 1, 'complete', CURRENT_TIMESTAMP)
        """,
        ("C:/definitely/not/real/v350-meta-gone.png",),
    )
    ids.append(cur.lastrowid)
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function readFixtureRows(): Array<{ id: number, prompt: string | null, has_raw: number }> {
  const script = `
import json
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, prompt, CASE WHEN raw_metadata_gz IS NOT NULL THEN 1 ELSE 0 END AS has_raw"
        " FROM images WHERE filename LIKE 'v350-meta-%' ORDER BY id"
    ).fetchall()
print(json.dumps([dict(row) for row in rows]))
`
  return JSON.parse(runBackendScript(script))
}

function cleanupFixture() {
  const script = `
import sqlite3
from pathlib import Path

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    conn.execute("DELETE FROM images WHERE filename LIKE 'v350-meta-%'")
    conn.commit()
print("ok")
`
  runBackendScript(script)
}

let fixtureIds: number[] = []

test.beforeAll(() => {
  fixtureIds = resetFixture()
  expect(fixtureIds.length).toBe(2)
})

test.afterAll(() => {
  cleanupFixture()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

test('health endpoint counts missing prompts and stored raw envelopes', async ({ request }) => {
  const response = await request.get('/api/metadata/health')
  expect(response.ok()).toBeTruthy()
  const health = await response.json()
  expect(health.totals.missing_prompt).toBeGreaterThanOrEqual(2)
  expect(health.totals.with_raw).toBeGreaterThanOrEqual(1)
  const comfy = (health.generators as Array<{ generator: string, missing_prompt: number }>)
    .find((item) => item.generator === 'comfyui')
  expect(comfy).toBeTruthy()
  expect(comfy!.missing_prompt).toBeGreaterThanOrEqual(2)
})

test('reparse job recovers the raw-envelope row and flags the sourceless row', async ({ request }) => {
  const start = await request.post('/api/metadata/reparse', { data: { scope: 'missing_prompt' } })
  expect(start.ok()).toBeTruthy()
  const { job_id: jobId } = await start.json()
  expect(jobId).toBeTruthy()

  let job: Record<string, unknown> | null = null
  await expect.poll(async () => {
    const poll = await request.get(`/api/bulk-jobs/${jobId}`)
    if (!poll.ok()) return 'poll-failed'
    job = await poll.json()
    return job ? String(job.status) : 'missing'
  }, { timeout: 60_000, intervals: [500, 1000] }).toBe('done')

  const result = (job!.result ?? {}) as Record<string, number>
  expect(result.recovered).toBeGreaterThanOrEqual(1)
  expect(result.used_raw).toBeGreaterThanOrEqual(1)
  expect(result.missing_source).toBeGreaterThanOrEqual(1)

  const rows = readFixtureRows()
  const recovered = rows.find((row) => row.id === fixtureIds[0])
  const sourceless = rows.find((row) => row.id === fixtureIds[1])
  expect(recovered?.prompt ?? '').toContain('e2e raw replay')
  expect(recovered?.has_raw).toBe(0)
  expect(sourceless?.prompt ?? null).toBeNull()

  const statusResponse = await request.get('/api/metadata/reparse-status')
  expect(statusResponse.ok()).toBeTruthy()
  const status = await statusResponse.json()
  expect(status.active).toBe(false)
})

test('dataset audit hero shows the re-parse button while prompts are missing', async ({ page }) => {
  // The previous test recovered one fixture row; the sourceless one still
  // counts as missing, so the button must be visible.
  await page.goto('/')
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal')).toBeVisible()

  const auditSection = page.locator('#audit-section')
  await auditSection.locator('summary').click()
  await expect(auditSection).toHaveAttribute('open', '')

  const reparseButton = page.locator('#btn-metadata-reparse')
  await expect(reparseButton).toBeVisible({ timeout: 15_000 })
  await expect(reparseButton).toBeEnabled()
})
