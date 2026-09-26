import type { CompatMode } from './engine/password'

// Messages between the page and the privacy worker (worker.ts).

export type Direction = 'encode' | 'decode'

export interface ProcessJob {
  kind: 'process'
  direction: Direction
  source: Blob
  password: string
  compat: CompatMode
  keepInfo: boolean
  legacyInfo: boolean
}

/** A result re-encoded as JPEG (Simple mode's download). */
export interface JpegJob {
  kind: 'jpeg'
  source: Blob
}

export type WorkerJob = ProcessJob | JpegJob

export interface Processed {
  blob: Blob
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  /** How many generation-detail chunks were carried over. */
  carried: number
  /** CRC-32 of the file, for the ZIP. */
  crc: number
}

export interface Encoded {
  blob: Blob
  crc: number
}

/** Why a job failed: the page words it. */
export type WorkerProblem = 'decode' | 'too-small' | 'encode'

export type WorkerReply =
  | { id: number; ok: true; value: Processed | Encoded }
  | { id: number; ok: false; problem: WorkerProblem; detail: string }

export interface WorkerRequest {
  id: number
  job: WorkerJob
}
