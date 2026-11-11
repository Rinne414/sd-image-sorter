import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext } from '@playwright/test'

import { scanAndWait } from './scan-wait'
import { createTestImage } from './test-helpers'

/**
 * Put `count` pictures of the spec's own into the main library.
 *
 * Specs share one library, and some empty it (library-auto-refresh,
 * scan-gallery-refresh). A spec that needs pictures on screen, or that enters
 * the library from the Home page (an empty library opens the import dialog
 * there), seeds its own in beforeAll instead of relying on what an earlier
 * spec left behind. Scanning the same folder again adds nothing.
 */
export async function seedPictures(request: APIRequestContext, name: string, count = 1): Promise<string> {
  const folder = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', name)
  fs.mkdirSync(folder, { recursive: true })
  for (let n = 0; n < count; n += 1) {
    await createTestImage(folder, `${name}-seed-${n}.png`, { generator: 'nai', prompt: `seed picture ${n}` })
  }
  await scanAndWait(request, folder)
  return folder
}
