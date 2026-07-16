import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import {
  buildPlaywrightChildEnv,
  buildPlaywrightReportEnv,
} from './playwright-env.mjs'

const DEFAULT_SHARD_COUNT = 4
const MAX_SHARD_COUNT = 8

function requireInteger(value, fieldName) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${fieldName} must be an integer, received ${String(value)}`)
  }
  return value
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }
  return value
}

export function shouldShardFullRun(args, env) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== 'test') return false
  if (env.PW_DISABLE_SHARDING === '1') return false
  return !env.BASE_URL && !env.SD_IMAGE_SORTER_PORT
}

export function resolveShardCount(env) {
  const raw = env.PW_SHARD_COUNT
  if (raw === undefined || raw === '') return DEFAULT_SHARD_COUNT
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`PW_SHARD_COUNT must be an integer, received ${raw}`)
  }
  const count = Number(raw)
  if (count < 1 || count > MAX_SHARD_COUNT) {
    throw new RangeError(`PW_SHARD_COUNT must be between 1 and ${MAX_SHARD_COUNT}, received ${raw}`)
  }
  return count
}

export function resolveRunPaths(repoRoot, runId) {
  requireNonEmptyString(repoRoot, 'repoRoot')
  requireNonEmptyString(runId, 'runId')
  const artifactsRoot = path.join(repoRoot, 'artifacts')
  const runRoot = path.join(artifactsRoot, 'playwright-runs', runId)
  return {
    artifactsRoot,
    blobRoot: path.join(runRoot, 'blob-reports'),
    canonicalLastRunPath: path.join(repoRoot, 'tests', 'e2e', 'test-results', '.last-run.json'),
    clickLedgerRoot: path.join(runRoot, 'click-coverage'),
    dataRoot: path.join(repoRoot, '.tmp', 'e2e-data-sharded', runId),
    fixtureRoot: path.join(repoRoot, '.tmp', 'e2e-model-fixtures-sharded', runId),
    htmlRoot: path.join(runRoot, 'playwright-report'),
    jsonPath: path.join(runRoot, 'playwright-results.json'),
    runRoot,
    testOutputRoot: path.join(runRoot, 'test-results'),
  }
}

export function buildShardDescriptors(input) {
  const { args, baseEnv, e2eRoot, platform, ports, repoRoot, runId, shardCount } = input
  requireNonEmptyString(e2eRoot, 'e2eRoot')
  requireNonEmptyString(platform, 'platform')
  requireNonEmptyString(repoRoot, 'repoRoot')
  requireNonEmptyString(runId, 'runId')
  requireInteger(shardCount, 'shardCount')
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('args must be a non-empty string array')
  }
  if (!Array.isArray(ports) || ports.length !== shardCount) {
    throw new RangeError(`ports must contain exactly ${shardCount} entries`)
  }

  const paths = resolveRunPaths(repoRoot, runId)
  const childBaseEnv = buildPlaywrightChildEnv(baseEnv, platform)
  return ports.map((port, index) => {
    requireInteger(port, `ports[${index}]`)
    const shardIndex = index + 1
    return {
      args: [...args, `--shard=${shardIndex}/${shardCount}`, '--workers=1', '--reporter=blob'],
      env: {
        ...childBaseEnv,
        PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(paths.blobRoot, `shard-${shardIndex}.zip`),
        PWTEST_BLOB_DO_NOT_REMOVE: '1',
        PW_COVERAGE_LEDGER_OWNER: 'runner',
        PW_E2E_FIXTURE_ROOT: path.join(paths.fixtureRoot, `shard-${shardIndex}`),
        PW_E2E_DATA_ROOT: path.join(paths.dataRoot, `shard-${shardIndex}`),
        PW_REUSE_SERVER: '0',
        PW_RUN_ARTIFACT_DIR: paths.runRoot,
        PW_SHARD_COUNT: String(shardCount),
        PW_SHARD_INDEX: String(shardIndex),
        PW_TEST_OUTPUT_DIR: path.join(paths.testOutputRoot, `shard-${shardIndex}`),
        PW_WEB_SERVER_PORT: String(port),
      },
      index: shardIndex,
      port,
    }
  })
}

export function formatMergedSummary(stats) {
  const expected = requireInteger(stats.expected, 'stats.expected')
  const unexpected = requireInteger(stats.unexpected, 'stats.unexpected')
  const skipped = requireInteger(stats.skipped, 'stats.skipped')
  const flaky = requireInteger(stats.flaky, 'stats.flaky')
  const total = expected + unexpected + skipped + flaky
  return `${total} total: ${expected} passed, ${unexpected} failed, ${skipped} skipped, ${flaky} flaky`
}

export function prepareRunDirectories(paths) {
  fs.rmSync(paths.canonicalLastRunPath, { force: true })
  fs.rmSync(paths.runRoot, { recursive: true, force: true })
  fs.mkdirSync(paths.blobRoot, { recursive: true })
  fs.mkdirSync(paths.clickLedgerRoot, { recursive: true })
  fs.mkdirSync(paths.testOutputRoot, { recursive: true })
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function startShardProcess(descriptor, playwrightCli, e2eRoot, children) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, ...descriptor.args], {
      cwd: e2eRoot,
      detached: process.platform !== 'win32',
      env: descriptor.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    })
    children.add(child)
    child.once('error', (error) => {
      children.delete(child)
      reject(new Error(`Playwright shard ${descriptor.index} failed to start: ${error.message}`, { cause: error }))
    })
    child.once('exit', (code, signal) => {
      children.delete(child)
      resolve({ code: code ?? 1, index: descriptor.index, signal })
    })
  })
}

async function runShardProcesses(descriptors, playwrightCli, e2eRoot) {
  const children = new Set()
  let interruptedSignal = null
  const stopForSignal = (signal) => {
    interruptedSignal = signal
    for (const child of children) terminateProcessTree(child)
  }
  const onSigInt = () => stopForSignal('SIGINT')
  const onSigTerm = () => stopForSignal('SIGTERM')
  process.once('SIGINT', onSigInt)
  process.once('SIGTERM', onSigTerm)
  try {
    const results = await Promise.all(
      descriptors.map((descriptor) => startShardProcess(descriptor, playwrightCli, e2eRoot, children)),
    )
    return { interruptedSignal, results }
  } catch (error) {
    for (const child of children) terminateProcessTree(child)
    throw error
  } finally {
    process.removeListener('SIGINT', onSigInt)
    process.removeListener('SIGTERM', onSigTerm)
  }
}

function mergeBlobReports(baseEnv, e2eRoot, paths, playwrightCli, platform) {
  const childBaseEnv = buildPlaywrightReportEnv(baseEnv, platform)
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'merge-reports', paths.blobRoot, '--reporter=json,html'],
    {
      cwd: e2eRoot,
      env: {
        ...childBaseEnv,
        PLAYWRIGHT_HTML_OPEN: 'never',
        PLAYWRIGHT_HTML_OUTPUT_DIR: paths.htmlRoot,
        PLAYWRIGHT_JSON_OUTPUT_FILE: paths.jsonPath,
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  if (result.error) {
    throw new Error(`Failed to merge Playwright shard reports: ${result.error.message}`, { cause: result.error })
  }
  return result.status ?? 1
}

function readMergedStats(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Merged Playwright JSON report was not created: ${jsonPath}`)
  }
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  if (!report || typeof report !== 'object' || !report.stats || typeof report.stats !== 'object') {
    throw new TypeError(`Merged Playwright JSON report is missing the required stats object: ${jsonPath}`)
  }
  formatMergedSummary(report.stats)
  return report.stats
}

function replaceFile(source, target, runId) {
  if (!fs.existsSync(source)) throw new Error(`Required Playwright artifact is missing: ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const staging = `${target}.${runId}.tmp`
  fs.rmSync(staging, { force: true })
  fs.copyFileSync(source, staging)
  fs.rmSync(target, { force: true })
  fs.renameSync(staging, target)
}

function replaceDirectory(source, target, runId) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required Playwright artifact directory is missing: ${source}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const staging = `${target}.${runId}.tmp`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(source, staging, { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(staging, target)
}

function publishSuccessfulArtifacts(paths, runId) {
  replaceFile(paths.jsonPath, path.join(paths.artifactsRoot, 'playwright-results.json'), runId)
  replaceFile(
    path.join(paths.runRoot, 'control-inventory.json'),
    path.join(paths.artifactsRoot, 'control-inventory.json'),
    runId,
  )
  replaceFile(
    path.join(paths.runRoot, 'js-coverage-unused.json'),
    path.join(paths.artifactsRoot, 'js-coverage-unused.json'),
    runId,
  )
  replaceDirectory(paths.htmlRoot, path.join(paths.artifactsRoot, 'playwright-report'), runId)
  replaceDirectory(paths.clickLedgerRoot, path.join(paths.artifactsRoot, 'click-coverage'), runId)
}

export function cleanupSuccessfulShardArtifacts(paths) {
  fs.rmSync(paths.runRoot, { recursive: true, force: true })
  fs.rmSync(paths.dataRoot, { recursive: true, force: true })
  fs.rmSync(paths.fixtureRoot, { recursive: true, force: true })
  for (const parent of [path.dirname(paths.dataRoot), path.dirname(paths.fixtureRoot)]) {
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
  }
}

function normalizeFailedTestIds(failedTests) {
  if (
    !Array.isArray(failedTests)
    || failedTests.some((testId) => typeof testId !== 'string' || testId.trim().length === 0)
  ) {
    throw new TypeError('failedTests must contain only non-empty strings')
  }
  return [...new Set(failedTests)].sort()
}

function publishTerminalRunStatus(paths, runId, status, failedTests) {
  requireNonEmptyString(runId, 'runId')
  if (status !== 'passed' && status !== 'failed') {
    throw new TypeError(`status must be "passed" or "failed", received ${String(status)}`)
  }
  const normalizedFailedTests = normalizeFailedTestIds(failedTests)
  if (status === 'passed' && normalizedFailedTests.length !== 0) {
    throw new TypeError('passed terminal status cannot contain failed test ids')
  }
  const stagingPath = `${paths.canonicalLastRunPath}.${runId}.tmp`
  fs.mkdirSync(path.dirname(paths.canonicalLastRunPath), { recursive: true })
  fs.rmSync(stagingPath, { force: true })
  fs.writeFileSync(
    stagingPath,
    `${JSON.stringify({ status, failedTests: normalizedFailedTests }, null, 2)}\n`,
    'utf8',
  )
  fs.rmSync(paths.canonicalLastRunPath, { force: true })
  fs.renameSync(stagingPath, paths.canonicalLastRunPath)
}

export function readShardFailedTestIds(paths, shardCount) {
  requireInteger(shardCount, 'shardCount')
  const failedTests = []
  for (let shardIndex = 1; shardIndex <= shardCount; shardIndex += 1) {
    const statusPath = path.join(paths.testOutputRoot, `shard-${shardIndex}`, '.last-run.json')
    if (!fs.existsSync(statusPath)) continue
    let status
    try {
      status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
    } catch (error) {
      throw new SyntaxError(`Shard terminal status is invalid JSON in ${statusPath}: ${error.message}`, {
        cause: error,
      })
    }
    if (
      !status
      || typeof status !== 'object'
      || !Object.hasOwn(status, 'status')
      || !Object.hasOwn(status, 'failedTests')
    ) {
      throw new TypeError(`Shard terminal status is missing required fields: ${statusPath}`)
    }
    if (status.status !== 'passed' && status.status !== 'failed') {
      throw new TypeError(`Shard terminal status is invalid in ${statusPath}: ${String(status.status)}`)
    }
    let shardFailedTests
    try {
      shardFailedTests = normalizeFailedTestIds(status.failedTests)
    } catch (error) {
      throw new TypeError(`Shard terminal status is invalid in ${statusPath}: ${error.message}`, {
        cause: error,
      })
    }
    if (status.status === 'passed' && shardFailedTests.length !== 0) {
      throw new TypeError(`Passed shard terminal status contains failures: ${statusPath}`)
    }
    failedTests.push(...shardFailedTests)
  }
  return normalizeFailedTestIds(failedTests)
}

export function finishFailedRun(paths, runId, failedTests) {
  publishTerminalRunStatus(paths, runId, 'failed', failedTests)
}

export function finishSuccessfulRun(paths, runId) {
  cleanupSuccessfulShardArtifacts(paths)
  publishTerminalRunStatus(paths, runId, 'passed', [])
}

function finishFailedRunFromShards(paths, runId, shardCount) {
  finishFailedRun(paths, runId, readShardFailedTestIds(paths, shardCount))
}

export async function runShardedPlaywright(input) {
  const { args, baseEnv, e2eRoot, platform, playwrightCli, ports, repoRoot, runId, shardCount } = input
  const paths = resolveRunPaths(repoRoot, runId)
  prepareRunDirectories(paths)
  try {
    const descriptors = buildShardDescriptors({
      args,
      baseEnv,
      e2eRoot,
      platform,
      ports,
      repoRoot,
      runId,
      shardCount,
    })
    console.error(
      `[playwright-runtime] Running ${shardCount} isolated desktop shards on ports ${ports.join(', ')}.`,
    )
    const { interruptedSignal, results } = await runShardProcesses(descriptors, playwrightCli, e2eRoot)
    const blobCount = fs.readdirSync(paths.blobRoot).filter((name) => name.endsWith('.zip')).length
    if (blobCount !== shardCount) {
      console.error(
        `[playwright-runtime] Expected ${shardCount} blob reports, found ${blobCount}: ${paths.blobRoot}`,
      )
      finishFailedRunFromShards(paths, runId, shardCount)
      console.error(`[playwright-runtime] Failure artifacts: ${paths.runRoot}`)
      return 1
    }
    const mergeStatus = mergeBlobReports(baseEnv, e2eRoot, paths, playwrightCli, platform)
    if (mergeStatus !== 0) {
      finishFailedRunFromShards(paths, runId, shardCount)
      console.error(`[playwright-runtime] Failure artifacts: ${paths.runRoot}`)
      return mergeStatus
    }
    const stats = readMergedStats(paths.jsonPath)
    console.error(`[playwright-runtime] ${formatMergedSummary(stats)}`)
    const shardFailed = results.some((result) => result.code !== 0)
    if (interruptedSignal || shardFailed || stats.unexpected !== 0) {
      for (const result of results.filter((entry) => entry.code !== 0)) {
        console.error(
          `[playwright-runtime] Shard ${result.index} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}.`,
        )
      }
      finishFailedRunFromShards(paths, runId, shardCount)
      console.error(`[playwright-runtime] Failure artifacts: ${paths.runRoot}`)
      return 1
    }
    publishSuccessfulArtifacts(paths, runId)
    finishSuccessfulRun(paths, runId)
    console.error(`[playwright-runtime] Published artifacts: ${paths.artifactsRoot}`)
    return 0
  } catch (error) {
    try {
      finishFailedRunFromShards(paths, runId, shardCount)
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        `Playwright shard run failed and terminal status publication also failed: ${paths.runRoot}`,
      )
    }
    console.error(`[playwright-runtime] Failure artifacts: ${paths.runRoot}`)
    throw error
  }
}
