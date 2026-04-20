import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const defaultPort = process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || '19087'
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${defaultPort}`
const basePort = Number(new URL(baseURL).port || defaultPort)
const repoRoot = path.resolve(__dirname, '..', '..')
const backendPython = process.env.PW_BACKEND_PYTHON || [
  path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
].find((candidate) => fs.existsSync(candidate)) || path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe')
const backendMain = path.join(repoRoot, 'backend', 'main.py')
const webServerCommand = `"${backendPython}" "${backendMain}" --port ${basePort}`

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
