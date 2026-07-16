import { expect, type Page, type Response } from '@playwright/test'

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type ManualScanIdentity = Readonly<{
  run_id: number
  source: 'manual'
}>

export type ManualScanTerminal = ManualScanIdentity & Readonly<{
  message: string
  status: 'cancelled' | 'done' | 'error'
}>

export type ManualScanTerminalObserver = Readonly<{
  stop: () => void
  waitForTerminal: (timeoutMs: number) => Promise<ManualScanTerminal>
}>

type ScanObservation =
  | Readonly<{ kind: 'start'; value: ManualScanIdentity }>
  | Readonly<{ kind: 'terminal'; value: ManualScanTerminal }>

const TERMINAL_SCAN_STATUSES = new Set(['cancelled', 'done', 'error'])

function requireJsonObject(value: JsonValue, context: string): { [key: string]: JsonValue } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must return a JSON object`)
  }
  return value
}

function requirePositiveRunId(payload: { [key: string]: JsonValue }, context: string): number {
  const runId = payload.run_id
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new TypeError(`${context} returned invalid run_id=${String(runId)}`)
  }
  return runId
}

function requireManualSource(payload: { [key: string]: JsonValue }, context: string): 'manual' {
  if (payload.source !== 'manual') {
    throw new TypeError(`${context} returned invalid source=${String(payload.source)}`)
  }
  return 'manual'
}

function parseJsonBody(body: string, context: string): { [key: string]: JsonValue } {
  let parsed: JsonValue
  try {
    parsed = JSON.parse(body) as JsonValue
  } catch {
    throw new SyntaxError(`${context} returned invalid JSON: ${body}`)
  }
  return requireJsonObject(parsed, context)
}

async function readScanObservation(response: Response): Promise<ScanObservation | null> {
  const request = response.request()
  const method = request.method()
  const pathname = new URL(response.url()).pathname
  const isStart = method === 'POST' && pathname === '/api/scan'
  const isProgress = method === 'GET' && pathname === '/api/scan/progress'
  if (!isStart && !isProgress) return null

  const body = await response.text()
  const context = isStart ? 'Manual scan start' : 'Manual scan progress'
  if (!response.ok()) {
    throw new Error(`${context} failed with HTTP ${response.status()}: ${body}`)
  }
  const payload = parseJsonBody(body, context)
  const status = payload.status
  if (typeof status !== 'string') {
    throw new TypeError(`${context} returned invalid status=${String(status)}`)
  }

  if (isStart) {
    if (status !== 'started') {
      throw new Error(`${context} returned unexpected status=${status}: ${body}`)
    }
    return Object.freeze({
      kind: 'start',
      value: Object.freeze({
        run_id: requirePositiveRunId(payload, context),
        source: requireManualSource(payload, context),
      }),
    })
  }

  if (!TERMINAL_SCAN_STATUSES.has(status)) return null
  const message = typeof payload.message === 'string' ? payload.message : ''
  return Object.freeze({
    kind: 'terminal',
    value: Object.freeze({
      run_id: requirePositiveRunId(payload, context),
      source: requireManualSource(payload, context),
      status: status as ManualScanTerminal['status'],
      message,
    }),
  })
}

function normalizeObserverError(error: object | string): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function observeManualScanTerminal(page: Page): ManualScanTerminalObserver {
  let startIdentity: ManualScanIdentity | null = null
  let terminalResponses: readonly ManualScanTerminal[] = Object.freeze([])
  let observerError: Error | null = null
  let stopped = false

  const onResponse = (response: Response): void => {
    void readScanObservation(response)
      .then((observation) => {
        if (stopped || !observation) return
        if (observation.kind === 'start') {
          if (startIdentity) {
            observerError = new Error(
              `Observed more than one manual scan start: ${startIdentity.run_id} and ${observation.value.run_id}`,
            )
            return
          }
          startIdentity = observation.value
          return
        }
        terminalResponses = Object.freeze([...terminalResponses, observation.value])
      })
      .catch((error: object | string) => {
        if (!stopped) observerError = normalizeObserverError(error)
      })
  }

  page.on('response', onResponse)

  return Object.freeze({
    stop(): void {
      stopped = true
      page.off('response', onResponse)
    },

    async waitForTerminal(timeoutMs: number): Promise<ManualScanTerminal> {
      let matchingTerminal: ManualScanTerminal | null = null
      await expect.poll(() => {
        if (observerError) return 'observer_error'
        if (!startIdentity) return 'waiting_for_start'
        matchingTerminal = terminalResponses.find((terminal) => (
          terminal.run_id === startIdentity?.run_id
          && terminal.source === startIdentity.source
        )) ?? null
        return matchingTerminal?.status ?? 'waiting_for_terminal'
      }, { timeout: timeoutMs }).toMatch(/^(cancelled|done|error|observer_error)$/)

      if (observerError) throw observerError
      if (!startIdentity) {
        throw new Error('Manual scan terminal arrived without a matching start response')
      }
      if (!matchingTerminal) {
        throw new Error(`Manual scan ${startIdentity.run_id}/${startIdentity.source} produced no terminal response`)
      }
      return matchingTerminal
    },
  })
}
