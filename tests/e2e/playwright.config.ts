import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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
    storageState: './storage/onboarding-complete.json',
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
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
