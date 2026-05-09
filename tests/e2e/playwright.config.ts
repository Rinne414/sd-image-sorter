import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const defaultPort = process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${defaultPort}`
const basePort = Number(new URL(baseURL).port || defaultPort)
const repoRoot = path.resolve(__dirname, '..', '..')
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

function commandExists(candidate: string): boolean {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fs.existsSync(candidate)
  }

  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(lookupCommand, [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch {
    return false
  }
}

const backendPython = process.env.PW_BACKEND_PYTHON || backendPythonCandidates.find((candidate) => commandExists(candidate)) || backendPythonCandidates[0]
const backendMain = path.join(repoRoot, 'backend', 'main.py')

function isWindowsExecutable(candidate: string): boolean {
  return candidate.toLowerCase().endsWith('.exe')
}

function toWindowsPathForWsl(candidate: string): string {
  if (process.platform !== 'linux') {
    return candidate
  }

  try {
    return execFileSync('wslpath', ['-w', candidate], { encoding: 'utf8' }).trim()
  } catch {
    return candidate
  }
}

const backendMainForPython = isWindowsExecutable(backendPython) ? toWindowsPathForWsl(backendMain) : backendMain
const webServerCommand = `"${backendPython}" "${backendMainForPython}" --port ${basePort}`
const localRuntimeRoot = process.env.PLAYWRIGHT_LOCAL_RUNTIME_ROOT
  ? path.resolve(process.env.PLAYWRIGHT_LOCAL_RUNTIME_ROOT)
  : path.join(repoRoot, '.tools', 'local-libs', 'playwright-runtime')
const localRuntimeLibDirs = [
  path.join(localRuntimeRoot, 'usr', 'lib', 'x86_64-linux-gnu'),
  path.join(localRuntimeRoot, 'lib', 'x86_64-linux-gnu'),
].filter((candidate) => fs.existsSync(candidate))
const localRuntimeLdPath = localRuntimeLibDirs.length
  ? [localRuntimeLibDirs.join(path.delimiter), process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(path.delimiter)
  : process.env.LD_LIBRARY_PATH
const e2eFixtureRoot = path.join(repoRoot, '.tmp', 'e2e-model-fixtures')
const e2eDataDir = path.join(repoRoot, '.tmp', `e2e-data-${basePort}`)
const e2eDatabasePath = path.join(e2eDataDir, 'images.db')
const e2eStubModulesDir = path.join(e2eFixtureRoot, 'python-stubs')

process.env.SD_IMAGE_SORTER_DATA_DIR = process.env.SD_IMAGE_SORTER_DATA_DIR || e2eDataDir
process.env.SD_IMAGE_SORTER_DB_PATH = process.env.SD_IMAGE_SORTER_DB_PATH || e2eDatabasePath

function ensureFile(filePath: string, size: number, fill: string) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size === size) {
    return
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.alloc(size, fill))
}

function ensureZip(zipPath: string, sourceDir: string) {
  const marker = path.join(sourceDir, 'lsnet_model', 'lsnet_artist.py')
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, 'class LSnetArtist: pass\n')
    fs.writeFileSync(path.join(sourceDir, 'lsnet_model', '__init__.py'), '')
  }
  const pythonZipPath = isWindowsExecutable(backendPython) ? toWindowsPathForWsl(zipPath) : zipPath
  const pythonSourceDir = isWindowsExecutable(backendPython) ? toWindowsPathForWsl(sourceDir) : sourceDir
  const result = spawnSync(backendPython, ['-c', `import shutil
from pathlib import Path
zip_path = Path(${JSON.stringify(pythonZipPath)})
source_dir = Path(${JSON.stringify(pythonSourceDir)})
zip_path.parent.mkdir(parents=True, exist_ok=True)
if not zip_path.exists():
    archive = shutil.make_archive(str(zip_path.with_suffix('')), 'zip', source_dir.parent, source_dir.name)
    Path(archive).replace(zip_path)
`], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to create model fixture zip')
  }
}

function writeStubModule(relativePath: string, contents: string) {
  const filePath = path.join(e2eStubModulesDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function writeStubPackageMetadata(packageName: string, version: string) {
  const normalizedName = packageName.replace(/[-.]+/g, '_')
  const distInfoDir = path.join(e2eStubModulesDir, `${normalizedName}-${version}.dist-info`)
  fs.mkdirSync(distInfoDir, { recursive: true })
  fs.writeFileSync(
    path.join(distInfoDir, 'METADATA'),
    `Metadata-Version: 2.1\nName: ${packageName}\nVersion: ${version}\n`
  )
}

fs.mkdirSync(e2eFixtureRoot, { recursive: true })
const artistRuntimeZip = path.join(e2eFixtureRoot, 'comfyui-lsnet-runtime.zip')
const artistRuntimeSource = path.join(e2eFixtureRoot, 'comfyui-lsnet-runtime-source')
const artistCheckpoint = path.join(e2eFixtureRoot, 'best_checkpoint.pth')
const artistMapping = path.join(e2eFixtureRoot, 'class_mapping.csv')
const sam3Checkpoint = path.join(e2eFixtureRoot, 'sam3-model.safetensors')
ensureZip(artistRuntimeZip, artistRuntimeSource)
ensureFile(artistCheckpoint, 32 * 1024 * 1024, 'k')
fs.writeFileSync(artistMapping, 'artist_id,artist_name\n0,fixture_artist\n')
ensureFile(sam3Checkpoint, 32 * 1024 * 1024, 's')
writeStubModule('torch.py', `__version__ = '2.9.0+cu128'\nclass version:\n    cuda = '12.8'\nclass cuda:\n    @staticmethod\n    def is_available():\n        return True\n`)
writeStubModule('transformers.py', `__version__ = '5.9.0'\n`)
writeStubModule('safetensors.py', `__version__ = '0.7.0'\n`)
writeStubModule('timm.py', '')
writeStubModule('sam3/__init__.py', '')
writeStubModule('einops.py', '')
writeStubModule('hydra.py', '')
writeStubModule('omegaconf.py', '')
writeStubModule('pycocotools/__init__.py', '')
writeStubModule('decord.py', '')
writeStubModule('iopath/__init__.py', '')
writeStubModule('cv2.py', '')
writeStubPackageMetadata('torch', '2.9.0')
writeStubPackageMetadata('transformers', '5.9.0')
writeStubPackageMetadata('timm', '1.0.0')
writeStubPackageMetadata('safetensors', '0.7.0')

const onboardingStorageState = {
  cookies: [],
  origins: [
    {
      origin: new URL(baseURL).origin,
      localStorage: [
        {
          name: 'sd-image-sorter-onboarding-completed',
          value: JSON.stringify({ version: 1, completed: true, completedAt: '2026-04-08T00:00:00.000Z' }),
        },
      ],
    },
  ],
}

/**
 * E2E Test Configuration for SD Image Sorter
 *
 * Tests run against the local FastAPI server on a configurable localhost port.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false, // Sequential execution for state-dependent tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1, // Single worker to avoid state conflicts
  reporter: [
    ['html', { outputFolder: '../../artifacts/playwright-report' }],
    ['json', { outputFile: '../../artifacts/playwright-results.json' }],
    ['list'],
  ],
  use: {
    baseURL,
    storageState: onboardingStorageState,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: baseURL,
    env: {
      ...process.env,
      ...(localRuntimeLdPath ? { LD_LIBRARY_PATH: localRuntimeLdPath } : {}),
      PYTHONPATH: [e2eStubModulesDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      SD_IMAGE_SORTER_DATA_DIR: e2eDataDir,
      SD_IMAGE_SORTER_DB_PATH: e2eDatabasePath,
      SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY: '1',
      SD_IMAGE_SORTER_ARTIST_RUNTIME_ZIP_URL: pathToFileURL(artistRuntimeZip).href,
      SD_IMAGE_SORTER_ARTIST_CHECKPOINT_URL: pathToFileURL(artistCheckpoint).href,
      SD_IMAGE_SORTER_ARTIST_CLASS_MAPPING_URL: pathToFileURL(artistMapping).href,
      SD_IMAGE_SORTER_SAM3_URLS: pathToFileURL(sam3Checkpoint).href,
      // Opt-in so model_service.urlopen_with_ua accepts file:// URLs from
      // the fixtures above. The flag is namespaced _TEST_ so production
      // never picks it up.
      SD_IMAGE_SORTER_TEST_ALLOW_FILE_DOWNLOADS: '1',
      SD_IMAGE_SORTER_DOWNLOAD_CHUNK_DELAY_MS: process.env.SD_IMAGE_SORTER_DOWNLOAD_CHUNK_DELAY_MS || '80',
      // Keep full UI/API/database tagging coverage deterministic in CI without
      // downloading or loading 500MB+ WD14 ONNX files. Production never sets this.
      SD_IMAGE_SORTER_E2E_FAKE_TAGGER: '1',
      // Keep artist identification UI/API/persistence coverage deterministic
      // without loading the experimental Kaloscope runtime during Playwright.
      SD_IMAGE_SORTER_E2E_FAKE_ARTIST: '1',
    },
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
