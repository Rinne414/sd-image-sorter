import { defineConfig, devices } from '@playwright/test'

/**
 * E2E Test Configuration for SD Image Sorter
 *
 * Tests run against the local FastAPI server on localhost:8001
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
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8001',
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
    command: '..\\..\\backend\\venv\\Scripts\\python.exe ..\\..\\backend\\main.py --port 8001',
    url: 'http://127.0.0.1:8001',
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
