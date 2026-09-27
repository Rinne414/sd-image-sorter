import { expect, test } from '../fixtures/click-ledger'

/**
 * Privacy obfuscation queue (V3.5 #22).
 *
 * - Pressing Protect twice scrambled the first result a second time. Protect
 *   now always starts from the original file, so the second result equals
 *   the first; Restore undoes this queue's own Protect (twice is still one
 *   undo), else restores the file as loaded.
 * - The ZIP download set no UTF-8 flag, so Chinese file names showed up
 *   garbled in Windows Explorer; both headers now carry general purpose
 *   bit 11.
 */

test.describe.configure({ mode: 'serial' })

async function openApp(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && Boolean((window as any).ImageObfuscator && (window as any).ObfuscateEngine))
}

test('protecting twice gives the same result as protecting once', async ({ page }) => {
  await openApp(page)

  const same = await page.evaluate(async () => {
    const obfuscator = (window as any).ImageObfuscator
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const ctx = canvas.getContext('2d')!
    for (let x = 0; x < 48; x += 1) {
      ctx.fillStyle = `rgb(${x * 5}, ${(x * 11) % 255}, ${255 - x * 5})`
      ctx.fillRect(x, 0, 1, 32)
    }
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const password = document.getElementById('obfuscate-password') as HTMLInputElement | null
    if (password) password.value = 'twice'
    const preserve = document.getElementById('obfuscate-preserve-metadata') as HTMLInputElement | null
    if (preserve) preserve.checked = false
    obfuscator._clearQueue()
    obfuscator._addFiles([new File([blob], 'twice.png', { type: 'image/png' })])

    const pixels = async (result: Blob) => {
      const bitmap = await createImageBitmap(result)
      const probe = document.createElement('canvas')
      probe.width = bitmap.width
      probe.height = bitmap.height
      const probeCtx = probe.getContext('2d')!
      probeCtx.drawImage(bitmap, 0, 0)
      return Array.from(probeCtx.getImageData(0, 0, bitmap.width, bitmap.height).data).join(',')
    }
    await obfuscator._processAll('encode')
    const first = await pixels(obfuscator._queue[0].resultBlob)
    await obfuscator._processAll('encode')
    const second = await pixels(obfuscator._queue[0].resultBlob)
    return { same: first === second, status: obfuscator._queue[0].status }
  })

  expect(same.status).toBe('done')
  expect(same.same).toBe(true)
})

test('the ZIP marks its file names as UTF-8', async ({ page }) => {
  await openApp(page)

  const flags = await page.evaluate(async () => {
    const zip: Blob = (window as any).ImageObfuscator._createZipBlob([
      { name: '混淆_图片.png', data: new Uint8Array([1, 2, 3]) },
    ])
    const bytes = new DataView(await zip.arrayBuffer())
    const nameLength = bytes.getUint16(26, true)
    const centralOffset = 30 + nameLength + 3
    return {
      local: bytes.getUint16(6, true),
      centralSignature: bytes.getUint32(centralOffset, true),
      central: bytes.getUint16(centralOffset + 8, true),
    }
  })

  expect(flags.centralSignature).toBe(0x02014b50)
  expect(flags.local & 0x0800).toBe(0x0800)
  expect(flags.central & 0x0800).toBe(0x0800)
})

test('restoring twice after protecting still gives back the original', async ({ page }) => {
  await openApp(page)

  const result = await page.evaluate(async () => {
    const obfuscator = (window as any).ImageObfuscator
    const canvas = document.createElement('canvas')
    canvas.width = 40
    canvas.height = 24
    const ctx = canvas.getContext('2d')!
    for (let y = 0; y < 24; y += 1) {
      ctx.fillStyle = `rgb(${y * 9}, 90, ${255 - y * 9})`
      ctx.fillRect(0, y, 40, 1)
    }
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const password = document.getElementById('obfuscate-password') as HTMLInputElement | null
    if (password) password.value = 'round-trip'
    const preserve = document.getElementById('obfuscate-preserve-metadata') as HTMLInputElement | null
    if (preserve) preserve.checked = false
    obfuscator._clearQueue()
    obfuscator._addFiles([new File([blob], 'round.png', { type: 'image/png' })])

    const pixels = async (source: Blob) => {
      const bitmap = await createImageBitmap(source)
      const probe = document.createElement('canvas')
      probe.width = bitmap.width
      probe.height = bitmap.height
      const probeCtx = probe.getContext('2d')!
      probeCtx.drawImage(bitmap, 0, 0)
      return Array.from(probeCtx.getImageData(0, 0, bitmap.width, bitmap.height).data).join(',')
    }
    const original = await pixels(blob)
    await obfuscator._processAll('encode')
    await obfuscator._processAll('decode')
    const once = await pixels(obfuscator._queue[0].resultBlob)
    await obfuscator._processAll('decode')
    const twice = await pixels(obfuscator._queue[0].resultBlob)
    return { onceMatches: once === original, twiceMatches: twice === original }
  })

  expect(result).toEqual({ onceMatches: true, twiceMatches: true })
})
