import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildShardDescriptors,
  finishFailedRun,
  finishSuccessfulRun,
  formatMergedSummary,
  prepareRunDirectories,
  readShardFailedTestIds,
  resolveRunPaths,
  resolveShardCount,
  shouldShardFullRun,
} from './playwright-shards.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const e2eRoot = path.resolve(scriptsDir, '..')
const repoRoot = path.resolve(e2eRoot, '..', '..')
const spacedRepoRoot = path.join(path.parse(repoRoot).root, 'fixture workspace with spaces', 'sd-image-sorter')
const spacedE2eRoot = path.join(spacedRepoRoot, 'tests', 'e2e')

function makeTempRepo(t) {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sorter-playwright-runner-'))
  t.after(() => fs.rmSync(tempRepo, { recursive: true, force: true }))
  return tempRepo
}

test('plain full test command shards unless an external server or opt-out is explicit', () => {
  assert.equal(shouldShardFullRun(['test'], {}), true)
  assert.equal(shouldShardFullRun(['test', 'specs/smoke.spec.ts'], {}), false)
  assert.equal(shouldShardFullRun(['test'], { BASE_URL: 'http://127.0.0.1:8487' }), false)
  assert.equal(shouldShardFullRun(['test'], { SD_IMAGE_SORTER_PORT: '8487' }), false)
  assert.equal(shouldShardFullRun(['test'], { PW_DISABLE_SHARDING: '1' }), false)
})

test('shard count is bounded and rejects invalid configuration', () => {
  assert.equal(resolveShardCount({}), 4)
  assert.equal(resolveShardCount({ PW_SHARD_COUNT: '3' }), 3)
  assert.throws(() => resolveShardCount({ PW_SHARD_COUNT: '0' }), /between 1 and 8/)
  assert.throws(() => resolveShardCount({ PW_SHARD_COUNT: 'not-a-number' }), /integer/)
})

test('each shard owns a port, backend data root, blob, result directory, and click ledger', () => {
  const undefinedArtifact = path.join(repoRoot, 'undefined')
  assert.equal(fs.existsSync(undefinedArtifact), false)

  const descriptors = buildShardDescriptors({
    args: ['test'],
    baseEnv: { PATH: 'fixture-path', PW_REUSE_SERVER: '1', PW_WEB_SERVER_PORT: '19087' },
    e2eRoot: spacedE2eRoot,
    ports: [19087, 19187, 19287, 19387],
    repoRoot: spacedRepoRoot,
    runId: 'fixture-run',
    shardCount: 4,
  })

  assert.equal(descriptors.length, 4)
  assert.deepEqual(descriptors.map((descriptor) => descriptor.args.slice(-3)), [
    ['--shard=1/4', '--workers=1', '--reporter=blob'],
    ['--shard=2/4', '--workers=1', '--reporter=blob'],
    ['--shard=3/4', '--workers=1', '--reporter=blob'],
    ['--shard=4/4', '--workers=1', '--reporter=blob'],
  ])
  assert.deepEqual(descriptors.map((descriptor) => descriptor.env.PW_WEB_SERVER_PORT), [
    '19087',
    '19187',
    '19287',
    '19387',
  ])
  assert.equal(new Set(descriptors.map((descriptor) => descriptor.env.PLAYWRIGHT_BLOB_OUTPUT_FILE)).size, 4)
  assert.equal(new Set(descriptors.map((descriptor) => descriptor.env.PW_E2E_FIXTURE_ROOT)).size, 4)
  assert.equal(new Set(descriptors.map((descriptor) => descriptor.env.PW_E2E_DATA_ROOT)).size, 4)
  assert.equal(new Set(descriptors.map((descriptor) => descriptor.env.PW_TEST_OUTPUT_DIR)).size, 4)
  assert.deepEqual(descriptors.map((descriptor) => descriptor.env.PW_SHARD_INDEX), ['1', '2', '3', '4'])
  assert.ok(descriptors.every((descriptor) => descriptor.env.PW_COVERAGE_LEDGER_OWNER === 'runner'))
  assert.ok(descriptors.every((descriptor) => descriptor.env.PW_REUSE_SERVER === '0'))
  assert.ok(descriptors.every((descriptor) => descriptor.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.includes('fixture workspace with spaces')))
  assert.ok(descriptors.every((descriptor) => !descriptor.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.includes(`${path.sep}undefined${path.sep}`)))
  assert.equal(fs.existsSync(undefinedArtifact), false)
})

test('merged summary states total, passed, failed, skipped, and flaky counts', () => {
  assert.equal(
    formatMergedSummary({ expected: 477, flaky: 0, skipped: 3, unexpected: 0 }),
    '480 total: 477 passed, 0 failed, 3 skipped, 0 flaky',
  )
})

test('preparing a sharded run removes stale canonical status and creates isolated directories', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  fs.mkdirSync(path.dirname(paths.canonicalLastRunPath), { recursive: true })
  fs.writeFileSync(paths.canonicalLastRunPath, '{"status":"passed","failedTests":[]}\n')
  fs.mkdirSync(paths.runRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.runRoot, 'stale.txt'), 'stale')

  prepareRunDirectories(paths)

  assert.equal(fs.existsSync(paths.canonicalLastRunPath), false)
  assert.equal(fs.existsSync(path.join(paths.runRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(paths.blobRoot), true)
  assert.equal(fs.existsSync(paths.clickLedgerRoot), true)
  assert.equal(fs.existsSync(paths.testOutputRoot), true)
})

test('failed terminal state is current, deterministic, and preserves diagnostic artifacts', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(path.join(paths.runRoot, 'failure.txt'), 'diagnostic')

  finishFailedRun(paths, 'fixture-run', ['test-b', 'test-a', 'test-b'])

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'failed',
    failedTests: ['test-a', 'test-b'],
  })
  assert.equal(fs.existsSync(path.join(paths.runRoot, 'failure.txt')), true)
})

test('successful terminal state removes duplicate run artifacts only after cleanup', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.mkdirSync(paths.dataRoot, { recursive: true })
  fs.mkdirSync(paths.fixtureRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.runRoot, 'published-copy.txt'), 'duplicate')

  finishSuccessfulRun(paths, 'fixture-run')

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'passed',
    failedTests: [],
  })
  assert.equal(fs.existsSync(paths.runRoot), false)
  assert.equal(fs.existsSync(paths.dataRoot), false)
  assert.equal(fs.existsSync(paths.fixtureRoot), false)
})

test('terminal state rejects invalid external result data', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)

  assert.throws(
    () => finishFailedRun(paths, 'fixture-run', ['valid-id', 7]),
    /failedTests must contain only non-empty strings/,
  )
})

test('shard terminal files aggregate failures and validate required external fields', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  const shardOneStatus = path.join(paths.testOutputRoot, 'shard-1', '.last-run.json')
  const shardTwoStatus = path.join(paths.testOutputRoot, 'shard-2', '.last-run.json')
  fs.mkdirSync(path.dirname(shardOneStatus), { recursive: true })
  fs.mkdirSync(path.dirname(shardTwoStatus), { recursive: true })
  fs.writeFileSync(shardOneStatus, '{"status":"failed","failedTests":["test-b","test-a"]}\n')
  fs.writeFileSync(shardTwoStatus, '{"status":"passed","failedTests":[],"ignored":"value"}\n')

  assert.deepEqual(readShardFailedTestIds(paths, 2), ['test-a', 'test-b'])

  fs.writeFileSync(shardTwoStatus, '{"status":"failed"}\n')
  assert.throws(
    () => readShardFailedTestIds(paths, 2),
    new RegExp(`missing required fields: ${shardTwoStatus.replaceAll('\\', '\\\\')}`),
  )
})
