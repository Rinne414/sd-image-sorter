import { JobProblem, processImage, toJpeg } from './process'
import type { WorkerReply, WorkerRequest } from './protocol'

// The privacy worker: scrambling a 40 MP image takes seconds, so it never runs
// on the page's thread. One job at a time; the page stops a job by ending the
// worker (workerClient.ts).

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, job } = event.data
  let reply: WorkerReply
  try {
    const value = job.kind === 'process' ? await processImage(job) : await toJpeg(job)
    reply = { id, ok: true, value }
  } catch (error) {
    const problem = error instanceof JobProblem ? error.problem : 'encode'
    reply = { id, ok: false, problem, detail: String((error as Error)?.message ?? error) }
  }
  self.postMessage(reply)
}
