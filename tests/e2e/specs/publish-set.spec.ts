import fsSync from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { expect, test } from '../fixtures/click-ledger'
import { PY_DELETE_IMAGES } from '../fixtures/e2e-db'

/**
 * Publish Set API (v3.5.0 Tier 1 — Pixiv 成套發布): censored-variant pairing
 * ({stem}_censored.*) and sequential export (01.png, 02.png, … + caption.txt).
 *
 * The fixture creates real files under .tmp/ and real library rows; exports
 * land in .tmp/ too, so nothing outside the repo is touched.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const fixtureRoot = path.join(repoRoot, '.tmp', 'v350-publish')

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

const SECRET = 'masterpiece, publish secret 51f3'

/**
 * 3 originals in the library; pub-2 gets a censored sibling on disk only.
 * pub-4 carries generation info (NovelAI-style text chunks) for the
 * metadata and Censor Edit hand-over tests.
 */
function resetFixture(): { ids: number[], metaId: number } {
  const script = `
${PY_DELETE_IMAGES}
import json
import shutil
import sqlite3
from pathlib import Path

from PIL import Image, PngImagePlugin

repo_root = Path(${JSON.stringify(repoRoot)})
root = repo_root / ".tmp" / "v350-publish"
shutil.rmtree(root, ignore_errors=True)
(root / "src").mkdir(parents=True, exist_ok=True)

db_path = Path(${JSON.stringify(runtimeDatabasePath)})
ids = []
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    delete_images(cur, "filename LIKE 'v350-pub-%'")
    for index in (1, 2, 3):
        filename = f"v350-pub-{index}.png"
        image_path = (root / "src" / filename).resolve()
        Image.new("RGB", (64, 48), color=(40 * index, 90, 130)).save(image_path)
        cur.execute(
            """
            INSERT INTO images (
                path, filename, generator, width, height, file_size, source_size,
                source_mtime_ns, is_readable, metadata_status, created_at, user_rating
            ) VALUES (?, ?, 'unknown', 64, 48, ?, ?, ?, 1, 'complete', CURRENT_TIMESTAMP, 0)
            """,
            (
                str(image_path), filename,
                image_path.stat().st_size, image_path.stat().st_size,
                image_path.stat().st_mtime_ns,
            ),
        )
        ids.append(cur.lastrowid)
    meta_path = (root / "src" / "v350-pub-4.png").resolve()
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", ${JSON.stringify(SECRET)} + " Steps: 28, Seed: 7")
    info.add_text("Software", "NovelAI")
    info.add_itxt("Comment", '{"prompt": "' + ${JSON.stringify(SECRET)} + '"}')
    Image.new("RGB", (64, 48), color=(200, 120, 60)).save(meta_path, pnginfo=info)
    cur.execute(
        """
        INSERT INTO images (
            path, filename, generator, width, height, file_size, source_size,
            source_mtime_ns, is_readable, metadata_status, created_at, user_rating
        ) VALUES (?, ?, 'novelai', 64, 48, ?, ?, ?, 1, 'complete', CURRENT_TIMESTAMP, 0)
        """,
        (
            str(meta_path), "v350-pub-4.png",
            meta_path.stat().st_size, meta_path.stat().st_size,
            meta_path.stat().st_mtime_ns,
        ),
    )
    meta_id = cur.lastrowid
    conn.commit()

# Censored sibling for pub-2: disk-only (NOT indexed) — exercises the
# same-directory probe rather than the library-filename fallback.
censored = root / "src" / "v350-pub-2_censored.png"
Image.new("RGB", (64, 48), color=(0, 0, 0)).save(censored)
print(json.dumps({"ids": ids, "metaId": meta_id}))
`
  return JSON.parse(runBackendScript(script)) as { ids: number[], metaId: number }
}

type ImageReport = { pixels: string, corner: number[], infoKeys: string[], hasSecret: boolean }

/** Decode an exported file: pixel digest, one pixel, metadata keys, raw prompt text. */
function inspectImage(filePath: string): ImageReport {
  const script = `
import hashlib
import json
from pathlib import Path

from PIL import Image

path = Path(${JSON.stringify(filePath)})
with Image.open(path) as image:
    rgb = image.convert("RGB")
    print(json.dumps({
        "pixels": hashlib.sha256(rgb.tobytes()).hexdigest(),
        "corner": list(rgb.getpixel((5, 5))),
        "infoKeys": sorted(str(key) for key in image.info),
        "hasSecret": ${JSON.stringify(SECRET)}.encode() in path.read_bytes(),
    }))
`
  return JSON.parse(runBackendScript(script)) as ImageReport
}

function cleanupFixture() {
  const script = `
${PY_DELETE_IMAGES}
import shutil
import sqlite3
from pathlib import Path

repo_root = Path(${JSON.stringify(repoRoot)})
db_path = Path(${JSON.stringify(runtimeDatabasePath)})
with sqlite3.connect(db_path) as conn:
    delete_images(conn, "filename LIKE 'v350-pub-%'")
    conn.commit()
shutil.rmtree(repo_root / ".tmp" / "v350-publish", ignore_errors=True)
print("ok")
`
  runBackendScript(script)
}

let fixtureIds: number[] = []
let metaId = 0

test.beforeAll(() => {
  const fixture = resetFixture()
  fixtureIds = fixture.ids
  metaId = fixture.metaId
  expect(fixtureIds.length).toBe(3)
})

test.afterAll(() => {
  cleanupFixture()
})

test('API pairs the censored sibling and exports sequential names + caption', async ({ request }) => {
  const pairs = await (await request.post('/api/publish/censor-pairs', {
    data: { image_ids: fixtureIds },
  })).json()
  expect(pairs.total).toBe(3)
  expect(pairs.found_count).toBe(1)
  const byId = new Map(pairs.pairs.map((entry: any) => [entry.image_id, entry]))
  expect((byId.get(fixtureIds[1]) as any).found).toBe(true)
  expect((byId.get(fixtureIds[1]) as any).censored_source).toBe('disk')
  expect((byId.get(fixtureIds[1]) as any).censored_filename).toBe('v350-pub-2_censored.png')
  expect((byId.get(fixtureIds[0]) as any).found).toBe(false)

  // Export in a custom order: 3rd, 1st, then 2nd as its censored variant.
  const outDir = path.join(fixtureRoot, 'out-api')
  const result = await (await request.post('/api/publish/export', {
    data: {
      items: [
        { image_id: fixtureIds[2] },
        { image_id: fixtureIds[0] },
        { image_id: fixtureIds[1], use_censored: true },
      ],
      output_folder: outDir,
      caption_text: 'publish-set e2e caption',
    },
  })).json()
  expect(result.success).toBe(true)
  expect(result.exported.map((entry: any) => entry.output_name)).toEqual(['01.png', '02.png', '03.png'])
  expect(result.exported[2].used_censored).toBe(true)
  expect(result.caption_file).toBe('caption.txt')
  expect(result.metadata_option).toBe('strip')

  const censoredSource = path.join(fixtureRoot, 'src', 'v350-pub-2_censored.png')
  expect(inspectImage(path.join(outDir, '03.png')).pixels).toBe(inspectImage(censoredSource).pixels)
  expect(fsSync.readFileSync(path.join(outDir, 'caption.txt'), 'utf8')).toBe('publish-set e2e caption\n')
})

test('API export removes generation info by default and keeps it only when asked', async ({ request }) => {
  const source = path.join(fixtureRoot, 'src', 'v350-pub-4.png')
  expect(inspectImage(source).hasSecret).toBe(true)

  const stripDir = path.join(fixtureRoot, 'out-api-strip')
  const stripped = await (await request.post('/api/publish/export', {
    data: { items: [{ image_id: metaId, use_censored: false }], output_folder: stripDir },
  })).json()
  expect(stripped.success).toBe(true)
  const strippedReport = inspectImage(path.join(stripDir, '01.png'))
  expect(strippedReport.hasSecret).toBe(false)
  expect(strippedReport.infoKeys).not.toContain('parameters')
  expect(strippedReport.infoKeys).not.toContain('Comment')
  expect(strippedReport.pixels).toBe(inspectImage(source).pixels)

  const keepDir = path.join(fixtureRoot, 'out-api-keep')
  const kept = await (await request.post('/api/publish/export', {
    data: { items: [{ image_id: metaId }], output_folder: keepDir, metadata_option: 'keep' },
  })).json()
  expect(kept.success).toBe(true)
  expect(fsSync.readFileSync(path.join(keepDir, '01.png')).equals(fsSync.readFileSync(source))).toBe(true)
})
