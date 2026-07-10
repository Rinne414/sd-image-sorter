import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '../fixtures/click-ledger'

/**
 * Duplicate Cleanup workflow (v3.5.0 Tier 1): whole-library near-dup GROUP
 * scan (bulk background job) + review modal with suggested keepers.
 * Deletion reuses the trash pipeline — the UI test mocks it and asserts the
 * exact ids sent, so nothing real is ever trashed.
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

/** 3 near-identical embeddings + 1 unrelated; returns the inserted ids. */
function resetFixture(): number[] {
  const script = `
import json
import shutil
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-dup-cleanup"
shutil.rmtree(root, ignore_errors=True)
root.mkdir(parents=True, exist_ok=True)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
vecs = []
base = np.zeros(8, dtype=np.float32); base[0] = 1.0
n1 = base.copy(); n1[1] = 0.01
n2 = base.copy(); n2[2] = 0.012
other = np.zeros(8, dtype=np.float32); other[5] = 1.0
vecs = [base, n1, n2, other]
ratings = [5, 0, 0, 0]

ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    cur.execute("DELETE FROM images WHERE filename LIKE 'v350-dup-%'")
    for index, (vec, rating) in enumerate(zip(vecs, ratings), start=1):
        filename = f"v350-dup-{index}.png"
        image_path = (root / filename).resolve()
        Image.new("RGB", (64, 64), color=(30 * index, 120, 90)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, width, height, file_size, source_size,
                source_mtime_ns, is_readable, metadata_status, created_at,
                user_rating, embedding
            ) VALUES (?, ?, 'unknown', 64, 64, ?, ?, ?, 1, 'complete', CURRENT_TIMESTAMP, ?, ?)
            """,
            (
                str(image_path), filename,
                image_path.stat().st_size, image_path.stat().st_size,
                image_path.stat().st_mtime_ns, rating,
                vec.astype(np.float32).tobytes(),
            ),
        )
        ids.append(cur.lastrowid)
    conn.commit()
print(json.dumps(ids))
`
  return JSON.parse(runBackendScript(script)) as number[]
}

function cleanupFixture() {
  const script = `
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    conn.execute("DELETE FROM images WHERE filename LIKE 'v350-dup-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-dup-cleanup", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

let fixtureIds: number[] = []

test.beforeAll(() => {
  fixtureIds = resetFixture()
  expect(fixtureIds.length).toBe(4)
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

test('scan API clusters the library into groups with a rating-first keeper', async ({ request }) => {
  const start = await request.post('/api/duplicates/scan', { data: { threshold: 0.95 } })
  expect(start.ok()).toBe(true)
  const { job_id: jobId } = await start.json()
  expect(jobId).toBeTruthy()

  // Second start while running (or just-finished) either 409s or succeeds —
  // poll the job to completion first, then assert the persisted groups.
  await expect.poll(async () => {
    const job = await (await request.get(`/api/bulk-jobs/${jobId}`)).json()
    return job.status
  }, { timeout: 30_000 }).toBe('done')

  const groups = await (await request.get('/api/duplicates/groups')).json()
  expect(groups.available).toBe(true)
  expect(groups.summary.group_count).toBeGreaterThanOrEqual(1)

  const fixtureGroup = groups.groups.find((g: any) =>
    g.members.some((m: any) => m.id === fixtureIds[0]))
  expect(fixtureGroup).toBeTruthy()
  const memberIds = fixtureGroup.members.map((m: any) => m.id).sort()
  expect(memberIds).toEqual(fixtureIds.slice(0, 3).sort())
  // The 5-star image keeps, despite equal resolutions.
  expect(fixtureGroup.members[0].id).toBe(fixtureIds[0])
  expect(fixtureGroup.members[0].suggested_keep).toBe(true)
})

test('review modal renders groups; keep-best sends exactly the losers to the trash pipeline', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()

  // Open via the nav Tools menu entry.
  await page.locator('#nav-tools-toggle').click()
  await page.locator('#nav-tools-dup-cleaner').click()
  await expect(page.locator('#dup-cleaner-modal.visible')).toBeVisible()

  const group = page.locator('.dup-group', {
    has: page.locator(`input[data-image-id="${fixtureIds[0]}"]`),
  })
  await expect(group).toBeVisible({ timeout: 10_000 })

  // Keeper badge on the 5-star member; losers pre-checked.
  const keeper = group.locator('.dup-member.is-keeper')
  await expect(keeper).toHaveCount(1)
  await expect(keeper.locator('input.dup-member-check')).not.toBeChecked()
  await expect(group.locator('input.dup-member-check:checked')).toHaveCount(2)

  // Mock the delete endpoint — assert ids, never actually trash.
  let deleteBody: any = null
  await page.route('**/api/images/delete-selected', async (route) => {
    deleteBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deleted: deleteBody.image_ids.length, errors: [] }),
    })
  })
  page.on('dialog', (dialog) => dialog.accept())

  await group.getByText('Keep best, trash rest').click()
  await expect.poll(() => deleteBody).not.toBe(null)
  expect(deleteBody.confirm_delete_files).toBe(true)
  expect(deleteBody.image_ids.sort()).toEqual(fixtureIds.slice(1, 3).sort())
  // The reviewed group leaves the list after the (mocked) delete.
  await expect(group).toHaveCount(0)
})

test('Escape closes the cleanup modal without leaving the gallery', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => (window as any).DupCleaner.open())
  await expect(page.locator('#dup-cleaner-modal.visible')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#dup-cleaner-modal.visible')).toHaveCount(0)
  await expect(page.locator('#view-gallery')).toBeVisible()
})
