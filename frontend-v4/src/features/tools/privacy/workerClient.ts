import type { Encoded, JpegJob, ProcessJob, Processed, WorkerProblem, WorkerReply, WorkerRequest } from './protocol'

// The page's side of the privacy worker. Two workers ("lanes"): one runs
// Protect all / Restore all and can be stopped, the other makes JPEGs for
// downloads and the ZIP, so a download never waits behind (or is cancelled
// with) a long run. A lane's worker starts on first use and stays (it keeps
// the last scramble curve, so a batch of one size is quicker). Stopping ends
// it outright, so even a 40 MP image stops at once.

export class WorkerFailure extends Error {
  readonly problem: WorkerProblem
  constructor(problem: WorkerProblem, detail: string) {
    super(detail)
    this.name = 'WorkerFailure'
    this.problem = problem
  }
}

export class Stopped extends Error {
  constructor() {
    super('stopped')
    this.name = 'Stopped'
  }
}

interface Pending {
  resolve: (value: Processed | Encoded) => void
  reject: (error: Error) => void
}

class Lane {
  private worker: Worker | null = null
  private nextId = 0
  private readonly pending = new Map<number, Pending>()

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      const waiting = this.pending.get(reply.id)
      if (!waiting) return
      this.pending.delete(reply.id)
      if (reply.ok) waiting.resolve(reply.value)
      else waiting.reject(new WorkerFailure(reply.problem, reply.detail))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      this.stop(new WorkerFailure('encode', event.message || 'worker error'))
    }
    this.worker = worker
    return worker
  }

  call(job: ProcessJob | JpegJob): Promise<Processed | Encoded> {
    const id = ++this.nextId
    const worker = this.start()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const request: WorkerRequest = { id, job }
      worker.postMessage(request)
    })
  }

  /** End the worker now; whatever it was doing rejects with Stopped (or `reason`). */
  stop(reason: Error = new Stopped()): void {
    this.worker?.terminate()
    this.worker = null
    for (const waiting of this.pending.values()) waiting.reject(reason)
    this.pending.clear()
  }
}

const runLane = new Lane()
const sideLane = new Lane()

export const runProcess = (job: Omit<ProcessJob, 'kind'>): Promise<Processed> => runLane.call({ kind: 'process', ...job }) as Promise<Processed>

/** Stop the image being protected or restored, at once. */
export const stopProcessing = (): void => runLane.stop()

export const runJpeg = (source: Blob): Promise<Encoded> => sideLane.call({ kind: 'jpeg', source }) as Promise<Encoded>
