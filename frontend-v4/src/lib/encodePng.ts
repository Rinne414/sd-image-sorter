// PNG encoding for saves (the censored copy, a training mask), done by one
// worker (lib/pngWorker.ts) so a save never waits for the page's idle time.
// The worker starts on first use and stays; if it fails, waiting saves fail
// with the reason and the next one starts a new worker.

/** RGBA pixels, 4 bytes per pixel, straight alpha. */
export interface PixelsToEncode {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray<ArrayBuffer>
}

type Reply = { id: number; ok: true; blob: Blob } | { id: number; ok: false; detail: string }

interface Waiting {
  resolve: (blob: Blob) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, Waiting>()

function failAll(error: Error): void {
  for (const w of waiting.values()) w.reject(error)
  waiting.clear()
}

function start(): Worker {
  if (worker) return worker
  const started = new Worker(new URL('./pngWorker.ts', import.meta.url), { type: 'module' })
  started.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data
    const w = waiting.get(reply.id)
    if (!w) return
    waiting.delete(reply.id)
    if (reply.ok) w.resolve(reply.blob)
    else w.reject(new Error(reply.detail))
  }
  const fail = (message: string) => {
    started.terminate()
    if (worker === started) worker = null
    failAll(new Error(message))
  }
  started.onerror = (event) => {
    event.preventDefault()
    fail(event.message || 'PNG worker failed')
  }
  // A reply that cannot be read would leave its save waiting forever.
  started.onmessageerror = () => fail('PNG worker reply could not be read')
  worker = started
  return started
}

/**
 * The pixels as PNG bytes. `transfer`: hand the buffer to the worker instead
 * of copying it (the caller must not use `pixels.data` afterwards).
 */
export function encodePng(pixels: PixelsToEncode, { transfer = false } = {}): Promise<Blob> {
  const id = ++nextId
  const target = start()
  const { data } = pixels
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
  const buffer = transfer && whole ? data.buffer : data.slice().buffer
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    target.postMessage({ id, width: pixels.width, height: pixels.height, data: buffer }, [buffer])
  })
}
