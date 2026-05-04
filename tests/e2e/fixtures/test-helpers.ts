import { test as base, expect, Page, APIRequestContext } from '@playwright/test'
import fsSync from 'node:fs'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
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

const backendPythonCandidates = process.platform === 'win32'
  ? [
      path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
      path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
      'python',
    ]
  : [
      path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
      'python3',
      'python',
      path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
    ]

const backendPython = process.env.PW_BACKEND_PYTHON
  || backendPythonCandidates.find((candidate) => commandExists(candidate))
  || backendPythonCandidates[0]

/**
 * Test fixtures for SD Image Sorter E2E tests
 */

// Test image types
export interface TestImage {
  id?: number
  path: string
  filename: string
  generator: string
  prompt?: string
  tags?: string[]
}

// Test data fixture
export interface TestFixtures {
  testImagesDir: string
  testOutputDir: string
  testDatabasePath: string
  apiClient: APIRequestContext
}

// Extend base test with fixtures
export const test = base.extend<TestFixtures>({
  // Create temporary test images directory
  testImagesDir: async ({}, use) => {
    const tempDir = path.join(process.cwd(), '.tmp_e2e_images')
    await fs.mkdir(tempDir, { recursive: true })

    await use(tempDir)

    // Cleanup after tests
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  },

  // Create temporary output directory
  testOutputDir: async ({}, use) => {
    const tempDir = path.join(process.cwd(), '.tmp_e2e_output')
    await fs.mkdir(tempDir, { recursive: true })

    await use(tempDir)

    // Cleanup after tests
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  },

  // Test database path
  testDatabasePath: async ({}, use) => {
    const dbPath = path.join(process.cwd(), '.tmp_e2e_images.db')
    await use(dbPath)

    // Cleanup
    try {
      await fs.unlink(dbPath)
    } catch {
      // Ignore cleanup errors
    }
  },

  // API client for direct API calls
  apiClient: async ({ playwright }, use) => {
    const client = await playwright.request.newContext({
      baseURL: process.env.BASE_URL || 'http://127.0.0.1:8000',
    })
    await use(client)
    await client.dispose()
  },
})

/**
 * Helper to create test images with metadata
 */
export async function createTestImage(
  dir: string,
  filename: string,
  options: {
    width?: number
    height?: number
    color?: string
    generator?: 'comfyui' | 'nai' | 'webui' | 'forge' | 'unknown'
    prompt?: string
    negativePrompt?: string
    checkpoint?: string
  } = {}
): Promise<string> {
  const {
    width = 512,
    height = 512,
    color = 'blue',
    generator = 'unknown',
    prompt = 'test image',
    negativePrompt = '',
    checkpoint = 'test_model.safetensors',
  } = options

  const filePath = path.join(dir, filename)

  // Create a simple PNG with Pillow via Python
  const pythonScript = `
import sys
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import json

img = Image.new('RGB', (${width}, ${height}), color='${color}')

# Add metadata based on generator type
metadata = PngInfo()

if '${generator}' == 'comfyui':
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 12345,
                "steps": 20,
                "cfg": 7.5,
            }
        },
        "2": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "${checkpoint}"}
        },
        "3_prompt": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "${prompt.replace(/"/g, '\\"')}"}
        },
        "4_prompt": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "${negativePrompt.replace(/"/g, '\\"')}"}
        }
    }
    metadata.add_text("prompt", json.dumps(workflow))
elif '${generator}' == 'nai':
    comment = json.dumps({
        "prompt": "${prompt.replace(/"/g, '\\"')}",
        "uc": "${negativePrompt.replace(/"/g, '\\"')}",
        "steps": 28,
    })
    metadata.add_text("Comment", comment)
    metadata.add_text("Software", "NovelAI")
elif '${generator}' in ['webui', 'forge']:
    params = """${prompt}
Negative prompt: ${negativePrompt}
Steps: 30, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 12345, Size: ${width}x${height}, Model: ${checkpoint}${generator == 'forge' ? ', Forge version: 0.1.0' : ''}"""
    metadata.add_text("parameters", params)

img.save(r'${filePath.replace(/\\/g, '\\\\')}', pnginfo=metadata if '${generator}' != 'unknown' else None)
print('Created:', r'${filePath.replace(/\\/g, '\\\\')}')
`

  const scriptPath = path.join(dir, `_create_${filename}.py`)
  await fs.writeFile(scriptPath, pythonScript)

  try {
    await execFileAsync(backendPython, [scriptPath], {
      cwd: repoRoot,
      timeout: 10000,
    })
  } catch (error) {
    console.error('Failed to create test image:', error)
    throw error
  } finally {
    await fs.unlink(scriptPath).catch(() => {})
  }

  return filePath
}

/**
 * Helper to wait for scan completion
 */
export async function waitForScan(page: Page, timeout = 30000): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const progress = await page.locator('#scan-progress').textContent().catch(() => null)

    if (progress?.includes('completed') || progress?.includes('finished')) {
      return
    }

    if (progress?.includes('error') || progress?.includes('failed')) {
      throw new Error(`Scan failed: ${progress}`)
    }

    await page.waitForTimeout(500)
  }

  throw new Error('Scan timeout')
}

/**
 * Helper to wait for tagging completion
 */
export async function waitForTagging(page: Page, timeout = 60000): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const progress = await page.locator('#tag-progress').textContent().catch(() => null)

    if (progress?.includes('completed') || progress?.includes('finished')) {
      return
    }

    if (progress?.includes('error') || progress?.includes('failed')) {
      throw new Error(`Tagging failed: ${progress}`)
    }

    await page.waitForTimeout(500)
  }

  throw new Error('Tagging timeout')
}

/**
 * Helper to clear database via API
 */
export async function clearGallery(apiClient: APIRequestContext): Promise<void> {
  await apiClient.delete('/api/clear-gallery')
}

/**
 * Helper to scan a folder via API
 */
export async function scanFolder(
  apiClient: APIRequestContext,
  folderPath: string
): Promise<{ status: string }> {
  const response = await apiClient.post('/api/scan', {
    data: { folder_path: folderPath },
  })
  return response.json()
}

/**
 * Helper to get scan progress
 */
export async function getScanProgress(
  apiClient: APIRequestContext
): Promise<{ status: string; current: number; total: number }> {
  const response = await apiClient.get('/api/scan/progress')
  return response.json()
}

/**
 * Helper to get images via API
 */
export async function getImages(
  apiClient: APIRequestContext,
  filters: Record<string, string> = {}
): Promise<{ images: TestImage[]; total: number }> {
  const params = new URLSearchParams(filters)
  const response = await apiClient.get(`/api/images?${params}`)
  return response.json()
}

export { expect }
