// Encodes pixels to PNG off the page's thread (lib/encodePng.ts sends the
// work). On the page, OffscreenCanvas.convertToBlob waits for idle time, and
// Chromium starts it only after about a second when the page has none: busy,
// in a background tab, or without a window. Here it runs at once.

interface EncodeRequest {
  id: number
  width: number
  height: number
  data: ArrayBuffer
}

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { id, width, height, data } = event.data
  try {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d canvas')
    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    self.postMessage({ id, ok: true, blob })
  } catch (error) {
    self.postMessage({ id, ok: false, detail: String((error as Error)?.message ?? error) })
  }
}
