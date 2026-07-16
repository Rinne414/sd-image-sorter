import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildShardDescriptors,
  finishFailedRun,
  finishSuccessfulRun,
  formatMergedSummary,
  prepareRunDirectories,
  publishSuccessfulArtifacts,
  readShardFailedTestIds,
  resolveCoverageRunId,
  resolveRunPaths,
  resolveShardCount,
  runShardedPlaywright,
  shouldShardFullRun,
} from './playwright-shards.mjs'
import {
  buildPlaywrightChildEnv,
  buildPlaywrightReportEnv,
} from './playwright-env.mjs'
import {
  enterPlaywrightWorkspaceLock,
  requireWorkspaceLockRuntimeCompatibility,
  resolveWorkspaceLockPython,
  WORKSPACE_LOCK_CAPABILITY_ENV,
  WORKSPACE_LOCK_HOLDER_PID_ENV,
  WORKSPACE_LOCK_RUN_ID_ENV,
  WORKSPACE_LOCK_SCOPE,
} from './playwright-workspace-lock.mjs'

const requireFromTest = createRequire(import.meta.url)
const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const e2eRoot = path.resolve(scriptsDir, '..')
const { extract: extractZip } = requireFromTest(
  path.join(e2eRoot, 'node_modules', 'playwright-core', 'lib', 'zipBundle.js'),
)
const repoRoot = path.resolve(e2eRoot, '..', '..')
const spacedRepoRoot = path.join(path.parse(repoRoot).root, 'fixture workspace with spaces', 'sd-image-sorter')
const spacedE2eRoot = path.join(spacedRepoRoot, 'tests', 'e2e')
const runPlaywrightPath = path.join(scriptsDir, 'run-playwright.mjs')
const playwrightCliPath = path.join(e2eRoot, 'node_modules', 'playwright', 'cli.js')
const projectConfigPath = path.join(e2eRoot, 'playwright.config.ts')
const playwrightTestModuleUrl = pathToFileURL(
  path.join(e2eRoot, 'node_modules', '@playwright', 'test', 'index.mjs'),
).href
const backendPythonPath = process.platform === 'win32'
  ? path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe')
  : path.join(repoRoot, 'backend', 'venv', 'bin', 'python')
const fakeParentCredentialName = 'PW_FAKE_PARENT_CREDENTIAL'
const fakeParentCredentialValue = 'fake-playwright-parent-credential-value'
const fakeProviderCredentialName = 'SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY'
const fakeProviderCredentialValue = 'fake-playwright-provider-credential-value'

function makeTempRepo(t) {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sorter-playwright-runner-'))
  t.after(() => fs.rmSync(tempRepo, { recursive: true, force: true }))
  return tempRepo
}

async function readFirstChildLine(child, timeoutMs) {
  if (!child.stdout) throw new Error('Child stdout pipe is required')
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for child readiness`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      const newlineIndex = buffered.indexOf('\n')
      if (newlineIndex === -1) return
      const line = buffered.slice(0, newlineIndex).trim()
      cleanup()
      resolve(line)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`Child exited ${String(code)} before publishing readiness`))
    }
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function closeChildInputAndWait(child, timeoutMs) {
  if (child.exitCode !== null) return
  const exitPromise = once(child, 'exit')
  if (child.stdin && !child.stdin.destroyed) child.stdin.end()
  let timeout
  try {
    await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          child.kill()
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for child exit`))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function reserveProbePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Could not reserve a localhost port for the environment probe.')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function collectFilePaths(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name)
    return entry.isDirectory() ? collectFilePaths(entryPath) : [entryPath]
  })
}

function collectFileBuffers(root) {
  return collectFilePaths(root).map((filePath) => fs.readFileSync(filePath))
}

function buildSyntheticParentEnv(overrides) {
  const safeBaseline = buildPlaywrightChildEnv({
    ...process.env,
    PW_ENABLE_EXTERNAL_INTEGRATIONS: '0',
  }, process.platform)
  return {
    ...safeBaseline,
    ...overrides,
  }
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

test('coverage run identity accepts a CI-provided value and validates local fallback inputs', () => {
  assert.equal(resolveCoverageRunId({ PW_COVERAGE_RUN_ID: 'ci-fixture-run' }, 123, 456), 'ci-fixture-run')
  assert.equal(resolveCoverageRunId({}, 123, 456), '456-123')
  assert.throws(
    () => resolveCoverageRunId({ PW_COVERAGE_RUN_ID: '../escaped' }, 123, 456),
    /PW_COVERAGE_RUN_ID must match/,
  )
})

test('workspace lock rejects Windows/WSL filesystem boundary mixing', () => {
  assert.throws(
    () => requireWorkspaceLockRuntimeCompatibility(
      { WSL_DISTRO_NAME: 'Ubuntu' },
      '/mnt/l/sd-image-sorter',
      'linux',
    ),
    /WSL on a Windows-mounted workspace/,
  )
  assert.throws(
    () => requireWorkspaceLockRuntimeCompatibility(
      {},
      '\\\\wsl.localhost\\Ubuntu\\home\\user\\sd-image-sorter',
      'win32',
    ),
    /Windows on a WSL filesystem workspace/,
  )
  assert.doesNotThrow(() => requireWorkspaceLockRuntimeCompatibility(
    { WSL_DISTRO_NAME: 'Ubuntu' },
    '/home/user/sd-image-sorter',
    'linux',
  ))
  assert.doesNotThrow(() => requireWorkspaceLockRuntimeCompatibility(
    {},
    'L:\\sd-image-sorter',
    'win32',
  ))
})

test('workspace lock Python must use the same OS lock family as Node', () => {
  const oppositePlatform = process.platform === 'win32' ? 'linux' : 'win32'
  const environment = {
    ...process.env,
    PW_BACKEND_PYTHON: backendPythonPath,
  }

  assert.equal(
    resolveWorkspaceLockPython(environment, repoRoot, process.platform),
    backendPythonPath,
  )
  assert.throws(
    () => resolveWorkspaceLockPython(environment, repoRoot, oppositePlatform),
    /Python runtime.*OS lock family.*Node platform/,
  )
})

test('workspace lock broker rejects overlap, verifies inheritance, and admits a successor', async (t) => {
  const tempRepo = makeTempRepo(t)
  const scriptsRoot = path.join(tempRepo, 'scripts')
  fs.mkdirSync(scriptsRoot, { recursive: true })
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'workspace_lock.py'),
    path.join(scriptsRoot, 'workspace_lock.py'),
  )
  const probePath = path.join(tempRepo, 'lock-probe.mjs')
  const probeMarkerPath = path.join(tempRepo, 'probe-entered.txt')
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(probeMarkerPath)}, 'entered', 'utf8')\n`,
    'utf8',
  )
  const lockPath = path.join(tempRepo, '.tmp', 'run-ci.lock')
  const runId = 'fixture-overlap-run'
  const capability = 'fixture-inherited-capability-value-00000000'
  const holderScript = `
import json
import os
import sys
from pathlib import Path
from scripts import workspace_lock

owner = workspace_lock.create_lock_owner(
    workspace_lock.CANONICAL_WORKSPACE_LOCK_SCOPE,
    os.getpid(),
    sys.argv[2],
    sys.argv[3],
)
with workspace_lock.exclusive_workspace_lock(Path(sys.argv[1]), owner, "fixture workspace"):
    print(json.dumps(owner), flush=True)
    sys.stdin.readline()
`
  const holder = spawn(
    backendPythonPath,
    ['-c', holderScript, lockPath, runId, capability],
    {
      cwd: tempRepo,
      env: buildSyntheticParentEnv({ PW_BACKEND_PYTHON: backendPythonPath }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  t.after(() => closeChildInputAndWait(holder, 10_000))
  const holderOwner = JSON.parse(await readFirstChildLine(holder, 10_000))
  assert.equal(holderOwner.runId, runId)
  assert.equal(Number.isSafeInteger(holderOwner.holderPid), true)

  const inheritedEnvironment = buildSyntheticParentEnv({
    PW_BACKEND_PYTHON: backendPythonPath,
    [WORKSPACE_LOCK_CAPABILITY_ENV]: capability,
    [WORKSPACE_LOCK_HOLDER_PID_ENV]: String(holderOwner.holderPid),
    [WORKSPACE_LOCK_RUN_ID_ENV]: runId,
  })
  const inheritedResult = enterPlaywrightWorkspaceLock({
    args: ['test'],
    environment: inheritedEnvironment,
    platform: process.platform,
    repoRoot: tempRepo,
    runId,
    wrapperPath: probePath,
  })
  assert.deepEqual(inheritedResult, { delegated: false, status: 0 })

  const wrongCapability = 'wrong-inherited-capability-value-000000000'
  assert.throws(
    () => enterPlaywrightWorkspaceLock({
      args: ['test'],
      environment: {
        ...inheritedEnvironment,
        [WORKSPACE_LOCK_CAPABILITY_ENV]: wrongCapability,
      },
      platform: process.platform,
      repoRoot: tempRepo,
      runId,
      wrapperPath: probePath,
    }),
    (error) => error instanceof Error
      && /owner mismatch/.test(error.message)
      && !error.message.includes(wrongCapability),
  )
  assert.throws(
    () => enterPlaywrightWorkspaceLock({
      args: ['test'],
      environment: {
        PW_BACKEND_PYTHON: backendPythonPath,
        [WORKSPACE_LOCK_RUN_ID_ENV]: runId,
      },
      platform: process.platform,
      repoRoot: tempRepo,
      runId,
      wrapperPath: probePath,
    }),
    /environment is incomplete/,
  )

  const contenderResult = enterPlaywrightWorkspaceLock({
    args: ['test'],
    environment: buildSyntheticParentEnv({ PW_BACKEND_PYTHON: backendPythonPath }),
    platform: process.platform,
    repoRoot: tempRepo,
    runId: 'fixture-contender-run',
    wrapperPath: probePath,
  })
  assert.deepEqual(contenderResult, { delegated: true, status: 1 })
  assert.equal(fs.existsSync(probeMarkerPath), false)

  await closeChildInputAndWait(holder, 10_000)
  assert.equal(holder.exitCode, 0)

  const successorResult = enterPlaywrightWorkspaceLock({
    args: ['test'],
    environment: buildSyntheticParentEnv({ PW_BACKEND_PYTHON: backendPythonPath }),
    platform: process.platform,
    repoRoot: tempRepo,
    runId: 'fixture-successor-run',
    wrapperPath: probePath,
  })
  assert.deepEqual(successorResult, { delegated: true, status: 0 })
  assert.equal(fs.readFileSync(probeMarkerPath, 'utf8'), 'entered')
})

test('child environment keeps runtime controls and drops unrelated, Python, CUDA, and provider inputs', () => {
  const childEnv = buildPlaywrightChildEnv({
    PATH: 'fixture-path',
    HOME: '/fixture/home',
    WSL_DISTRO_NAME: 'FixtureLinux',
    WSL_INTEROP: '/run/WSL/fixture.sock',
    PW_WEB_SERVER_PORT: '19087',
    PW_COVERAGE_RUN_ID: 'ci-fixture-run',
    [WORKSPACE_LOCK_CAPABILITY_ENV]: 'fixture-lock-capability-must-not-propagate',
    [WORKSPACE_LOCK_HOLDER_PID_ENV]: '1234',
    [WORKSPACE_LOCK_RUN_ID_ENV]: 'ci-fixture-run',
    PYTHONPATH: '/untrusted/python/modules',
    PYTHONHOME: '/untrusted/python/home',
    CUDA_VISIBLE_DEVICES: '0',
    OPENAI_API_KEY: 'fake-openai-key',
    HTTP_PROXY: 'http://fake-proxy.invalid',
    [fakeProviderCredentialName]: fakeProviderCredentialValue,
    [fakeParentCredentialName]: fakeParentCredentialValue,
  }, 'linux')

  assert.deepEqual(childEnv, {
    PATH: 'fixture-path',
    HOME: '/fixture/home',
    WSL_DISTRO_NAME: 'FixtureLinux',
    WSL_INTEROP: '/run/WSL/fixture.sock',
    PW_WEB_SERVER_PORT: '19087',
    PW_COVERAGE_RUN_ID: 'ci-fixture-run',
    PW_ENV_ISOLATION_ACTIVE: '1',
  })
  assert.equal(Object.hasOwn(childEnv, WORKSPACE_LOCK_CAPABILITY_ENV), false)
  assert.equal(Object.hasOwn(childEnv, WORKSPACE_LOCK_HOLDER_PID_ENV), false)
  assert.equal(Object.hasOwn(childEnv, WORKSPACE_LOCK_RUN_ID_ENV), false)
})

test('external integration inputs require explicit opt-in and never widen to generic provider keys', () => {
  const parentEnv = {
    PATH: 'fixture-path',
    PW_ENABLE_EXTERNAL_INTEGRATIONS: '1',
    HTTP_PROXY: 'http://fake-proxy.invalid',
    HF_TOKEN: 'fake-hugging-face-token',
    SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY: 'fake-translation-key',
    OPENAI_API_KEY: 'fake-openai-key',
    SystemRoot: 'C:\\should-not-enter-posix',
  }

  assert.deepEqual(buildPlaywrightChildEnv(parentEnv, 'linux'), {
    PATH: 'fixture-path',
    PW_ENABLE_EXTERNAL_INTEGRATIONS: '1',
    HTTP_PROXY: 'http://fake-proxy.invalid',
    HF_TOKEN: 'fake-hugging-face-token',
    SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY: 'fake-translation-key',
    PW_ENV_ISOLATION_ACTIVE: '1',
  })
  assert.throws(
    () => buildPlaywrightChildEnv({ PW_ENABLE_EXTERNAL_INTEGRATIONS: 'yes' }, 'linux'),
    /PW_ENABLE_EXTERNAL_INTEGRATIONS must be "0" or "1"/,
  )
})

test('report merge environment always strips external integration credentials', () => {
  assert.deepEqual(buildPlaywrightReportEnv({
    PATH: 'fixture-path',
    PLAYWRIGHT_HTML_OUTPUT_DIR: '/fixture/report',
    PW_ENABLE_EXTERNAL_INTEGRATIONS: '1',
    HTTP_PROXY: 'http://fake-proxy.invalid',
    HF_TOKEN: 'fake-hugging-face-token',
    SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY: 'fake-translation-key',
  }, 'linux'), {
    PATH: 'fixture-path',
    PLAYWRIGHT_HTML_OUTPUT_DIR: '/fixture/report',
    PW_ENV_ISOLATION_ACTIVE: '1',
  })
})

test('wrapper warns that external integration failure artifacts are sensitive', () => {
  const result = spawnSync(process.execPath, [runPlaywrightPath, '--help'], {
    cwd: e2eRoot,
    encoding: 'utf8',
    env: buildSyntheticParentEnv({
      PLAYWRIGHT_SKIP_LOCAL_RUNTIME_BOOTSTRAP: '1',
      PW_ENABLE_EXTERNAL_INTEGRATIONS: '1',
      [fakeProviderCredentialName]: fakeProviderCredentialValue,
    }),
    timeout: 30_000,
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, /External integrations are enabled.*failure logs and artifacts as sensitive/i)
  assert.equal(output.includes(fakeProviderCredentialValue), false)
})

test('Windows environment matching is case-insensitive without adding blocked values', () => {
  const childEnv = buildPlaywrightChildEnv({
    Path: 'C:\\fixture',
    SystemRoot: 'C:\\Windows',
    pw_disable_sharding: '1',
    pw_web_server_port: '19087',
    LD_LIBRARY_PATH: '/should-not-enter-windows',
    [fakeParentCredentialName]: fakeParentCredentialValue,
  }, 'win32')
  assert.deepEqual(childEnv, {
    PATH: 'C:\\fixture',
    SYSTEMROOT: 'C:\\Windows',
    PW_DISABLE_SHARDING: '1',
    PW_WEB_SERVER_PORT: '19087',
    PW_ENV_ISOLATION_ACTIVE: '1',
  })
  assert.equal(shouldShardFullRun(['test'], childEnv), false)
})

test('project config fails closed when the supported wrapper isolation marker is missing', () => {
  const directCliEnv = buildPlaywrightChildEnv(process.env, process.platform)
  delete directCliEnv.PW_ENV_ISOLATION_ACTIVE
  directCliEnv[fakeParentCredentialName] = fakeParentCredentialValue
  const result = spawnSync(
    process.execPath,
    [playwrightCliPath, 'test', '--list', '--config', projectConfigPath],
    {
      cwd: e2eRoot,
      encoding: 'utf8',
      env: directCliEnv,
      timeout: 30_000,
    },
  )

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 1)
  const output = `${result.stdout}\n${result.stderr}`
  assert.match(output, /Playwright environment isolation is not active/)
  assert.equal(output.includes(fakeParentCredentialValue), false)
})

test('each shard owns a port, backend data root, blob, result directory, and click ledger', () => {
  const undefinedArtifact = path.join(repoRoot, 'undefined')
  assert.equal(fs.existsSync(undefinedArtifact), false)

  const descriptors = buildShardDescriptors({
    args: ['test'],
    baseEnv: {
      PATH: 'fixture-path',
      PW_REUSE_SERVER: '1',
      PW_WEB_SERVER_PORT: '19087',
      PW_ENABLE_EXTERNAL_INTEGRATIONS: '1',
      [fakeProviderCredentialName]: fakeProviderCredentialValue,
      [fakeParentCredentialName]: fakeParentCredentialValue,
    },
    e2eRoot: spacedE2eRoot,
    platform: process.platform,
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
  assert.ok(descriptors.every((descriptor) => !(fakeParentCredentialName in descriptor.env)))
  assert.ok(
    descriptors.every(
      (descriptor) => descriptor.env[fakeProviderCredentialName] === fakeProviderCredentialValue,
    ),
  )
  assert.ok(descriptors.every((descriptor) => descriptor.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.includes('fixture workspace with spaces')))
  assert.ok(descriptors.every((descriptor) => !descriptor.env.PLAYWRIGHT_BLOB_OUTPUT_FILE.includes(`${path.sep}undefined${path.sep}`)))
  assert.equal(fs.existsSync(undefinedArtifact), false)
})

test('wrapper excludes unrelated and provider credentials by default from web server and retained failure artifacts', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sorter-playwright-env-probe-'))
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  const artifactRoot = path.join(tempRoot, 'artifacts')
  const configPath = path.join(tempRoot, 'playwright.config.mjs')
  const serverPath = path.join(tempRoot, 'probe-server.mjs')
  const specPath = path.join(tempRoot, 'probe.spec.mjs')
  const port = await reserveProbePort()

  fs.writeFileSync(serverPath, `import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const artifactRoot = process.env.PW_RUN_ARTIFACT_DIR
const port = Number(process.env.PW_WEB_SERVER_PORT)
if (!artifactRoot) throw new Error('PW_RUN_ARTIFACT_DIR is required for the environment probe server.')
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PW_WEB_SERVER_PORT must be a valid port for the environment probe server.')
}
const state = {
  sentinelValue: process.env[${JSON.stringify(fakeParentCredentialName)}] ?? null,
  providerCredentialValue: process.env[${JSON.stringify(fakeProviderCredentialName)}] ?? null,
  pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
}
fs.mkdirSync(artifactRoot, { recursive: true })
fs.writeFileSync(path.join(artifactRoot, 'web-server-env.json'), JSON.stringify(state), 'utf8')
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(state))
})
server.listen(port, '127.0.0.1')
`, 'utf8')

  fs.writeFileSync(configPath, `import path from 'node:path'
import { defineConfig } from ${JSON.stringify(playwrightTestModuleUrl)}

const artifactRoot = process.env.PW_RUN_ARTIFACT_DIR
const port = Number(process.env.PW_WEB_SERVER_PORT)
if (!artifactRoot) throw new Error('PW_RUN_ARTIFACT_DIR is required for the environment probe config.')
export default defineConfig({
  testDir: ${JSON.stringify(tempRoot)},
  outputDir: path.join(artifactRoot, 'test-results'),
  reporter: [
    ['json', { outputFile: path.join(artifactRoot, 'report.json') }],
    ['blob', { outputFile: path.join(artifactRoot, 'blob.zip') }],
  ],
  use: {
    baseURL: \`http://127.0.0.1:\${port}\`,
    trace: 'on',
  },
  webServer: {
    command: ${JSON.stringify(`"${process.execPath}" "${serverPath}"`)},
    url: \`http://127.0.0.1:\${port}\`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
`, 'utf8')

  fs.writeFileSync(specPath, `import { expect, test } from ${JSON.stringify(playwrightTestModuleUrl)}

test('environment isolation probe', async ({ page }) => {
  const response = await page.goto('/probe')
  expect(response?.ok()).toBe(true)
  if (!response) throw new Error('Environment probe navigation returned no response.')
  const state = await response.json()
  expect(state.sentinelValue).toBe(null)
  expect(state.providerCredentialValue).toBe(null)
  expect(state.pathPresent).toBe(true)
  throw new Error('Intentional probe failure retains trace and reporter artifacts.')
})
`, 'utf8')

  const result = spawnSync(
    process.execPath,
    [runPlaywrightPath, 'test', '--config', configPath, '--workers=1'],
    {
      cwd: e2eRoot,
      encoding: 'utf8',
      env: buildSyntheticParentEnv({
        [fakeParentCredentialName]: fakeParentCredentialValue,
        [fakeProviderCredentialName]: fakeProviderCredentialValue,
        PW_DISABLE_SHARDING: '1',
        PWTEST_BLOB_DO_NOT_REMOVE: '1',
        PW_RUN_ARTIFACT_DIR: artifactRoot,
        PW_TEST_OUTPUT_DIR: path.join(artifactRoot, 'test-results'),
        PW_WEB_SERVER_PORT: String(port),
      }),
      timeout: 120_000,
    },
  )

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 1, result.stderr || result.stdout)
  const serverStatePath = path.join(artifactRoot, 'web-server-env.json')
  assert.equal(fs.existsSync(serverStatePath), true, result.stderr || result.stdout)
  const reportPath = path.join(artifactRoot, 'report.json')
  assert.equal(fs.existsSync(reportPath), true)
  const reportText = fs.readFileSync(reportPath, 'utf8')
  assert.match(reportText, /Intentional probe failure retains trace and reporter artifacts/)
  const blobPath = path.join(artifactRoot, 'blob.zip')
  assert.equal(fs.existsSync(blobPath), true)
  const blobExtractRoot = path.join(artifactRoot, 'blob-extracted')
  await extractZip(blobPath, { dir: blobExtractRoot })
  const blobEntryPaths = collectFilePaths(blobExtractRoot)
  const nestedArchives = blobEntryPaths
    .filter((filePath) => path.extname(filePath).toLowerCase() === '.zip')
  assert.ok(
    nestedArchives.length > 0,
    `Expected the blob report to contain a trace archive, found: ${blobEntryPaths.join(', ')}`,
  )
  for (const [index, archivePath] of nestedArchives.entries()) {
    await extractZip(archivePath, { dir: path.join(artifactRoot, `trace-extracted-${index + 1}`) })
  }
  const extractedArtifactPaths = collectFilePaths(artifactRoot)
  assert.ok(
    extractedArtifactPaths.some((filePath) => path.extname(filePath) === '.trace'),
    `Expected an extracted .trace payload, found: ${extractedArtifactPaths.join(', ')}`,
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(serverStatePath, 'utf8')), {
    sentinelValue: null,
    providerCredentialValue: null,
    pathPresent: true,
  })
  assert.equal(result.stdout.includes(fakeParentCredentialValue), false)
  assert.equal(result.stderr.includes(fakeParentCredentialValue), false)
  assert.equal(result.stdout.includes(fakeProviderCredentialValue), false)
  assert.equal(result.stderr.includes(fakeProviderCredentialValue), false)
  const forbiddenBuffers = [fakeParentCredentialValue, fakeProviderCredentialValue]
    .map((value) => Buffer.from(value))
  assert.ok(
    collectFileBuffers(artifactRoot).every(
      (contents) => forbiddenBuffers.every((forbidden) => !contents.includes(forbidden)),
    ),
  )
})

test('merged summary states total, passed, failed, skipped, and flaky counts', () => {
  assert.equal(
    formatMergedSummary({ expected: 477, flaky: 0, skipped: 3, unexpected: 0 }),
    '480 total: 477 passed, 0 failed, 3 skipped, 0 flaky',
  )
})

test('preparing a sharded run invalidates stale canonical coverage state and creates isolated directories', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  fs.mkdirSync(path.dirname(paths.canonicalLastRunPath), { recursive: true })
  fs.writeFileSync(paths.canonicalLastRunPath, '{"status":"passed","failedTests":[]}\n')
  const staleCanonicalFiles = [
    'click-coverage-run.json',
    'click-coverage.json',
    'control-inventory.json',
    'js-coverage-unused.json',
    'untested-controls.json',
  ].map((name) => path.join(paths.artifactsRoot, name))
  for (const filePath of staleCanonicalFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'stale')
  }
  const staleCanonicalLedger = path.join(paths.artifactsRoot, 'click-coverage')
  fs.mkdirSync(staleCanonicalLedger, { recursive: true })
  fs.writeFileSync(path.join(staleCanonicalLedger, 'raw-worker-0.jsonl'), 'stale')
  fs.mkdirSync(paths.cleanupRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.cleanupRoot, 'previous-success.txt'), 'stale')
  fs.mkdirSync(paths.runRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.runRoot, 'stale.txt'), 'stale')

  prepareRunDirectories(paths)

  assert.equal(fs.existsSync(paths.canonicalLastRunPath), false)
  assert.ok(staleCanonicalFiles.every((filePath) => !fs.existsSync(filePath)))
  assert.equal(fs.existsSync(staleCanonicalLedger), false)
  assert.equal(fs.existsSync(paths.cleanupParentRoot), false)
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
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.writeFileSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl'), '{"key":"fixture"}\n')

  finishFailedRun(paths, 'fixture-run', ['test-b', 'test-a', 'test-b'])

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'failed',
    failedTests: ['test-a', 'test-b'],
    runId: 'fixture-run',
  })
  assert.equal(fs.existsSync(path.join(paths.runRoot, 'failure.txt')), true)
  assert.equal(fs.existsSync(path.join(paths.runRoot, 'control-inventory.json')), true)
  assert.equal(fs.existsSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl')), true)
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.canonicalClickLedgerRoot), false)
})

test('failed sharded orchestration retains run diagnostics without canonical coverage publication', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  fs.mkdirSync(paths.canonicalClickLedgerRoot, { recursive: true })
  fs.writeFileSync(paths.canonicalCoverageRunPath, '{"schemaVersion":1,"runId":"stale-run"}\n')
  fs.writeFileSync(path.join(paths.canonicalClickLedgerRoot, 'raw-worker-0.jsonl'), 'stale')
  const fakePlaywrightCli = path.join(tempRepo, 'fake-playwright.mjs')
  fs.writeFileSync(fakePlaywrightCli, `import fs from 'node:fs'
import path from 'node:path'

const outputRoot = process.env.PW_TEST_OUTPUT_DIR
const runRoot = process.env.PW_RUN_ARTIFACT_DIR
const shardIndex = process.env.PW_SHARD_INDEX
if (!outputRoot || !runRoot || !shardIndex) {
  throw new Error('Fake shard requires output, artifact, and shard identity inputs.')
}
fs.mkdirSync(outputRoot, { recursive: true })
fs.writeFileSync(
  path.join(outputRoot, '.last-run.json'),
  JSON.stringify({ status: 'failed', failedTests: [\`failure-\${shardIndex}\`] }),
  'utf8',
)
fs.writeFileSync(path.join(runRoot, \`failure-\${shardIndex}.txt\`), 'diagnostic', 'utf8')
process.exitCode = 1
`, 'utf8')

  const status = await runShardedPlaywright({
    args: ['test'],
    baseEnv: buildSyntheticParentEnv({}),
    e2eRoot: tempRepo,
    platform: process.platform,
    playwrightCli: fakePlaywrightCli,
    ports: [19087, 19187],
    repoRoot: tempRepo,
    runId: 'fixture-run',
    shardCount: 2,
    verifyRuntimeReleased: async () => {},
  })

  assert.equal(status, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'failed',
    failedTests: ['failure-1', 'failure-2'],
    runId: 'fixture-run',
  })
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'failure-1.txt'), 'utf8'), 'diagnostic')
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'failure-2.txt'), 'utf8'), 'diagnostic')
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.canonicalClickLedgerRoot), false)
})

test('successful terminal state stages duplicate run artifacts for deferred cleanup', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.mkdirSync(paths.dataRoot, { recursive: true })
  fs.mkdirSync(paths.fixtureRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.runRoot, 'published-copy.txt'), 'duplicate')

  await finishSuccessfulRun(paths, 'fixture-run', async () => {})

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'passed',
    failedTests: [],
    runId: 'fixture-run',
  })
  assert.equal(fs.existsSync(paths.runRoot), false)
  assert.equal(fs.existsSync(paths.cleanupRoot), true)
  assert.equal(fs.existsSync(paths.dataRoot), false)
  assert.equal(fs.existsSync(paths.fixtureRoot), false)
})

test('successful run finalizes matching coverage identity as the last publication step', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(paths.jsonPath, '{"stats":{}}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'js-coverage-unused.json'), '{"unused":[]}\n')
  fs.writeFileSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl'), '{"key":"fixture"}\n')
  fs.mkdirSync(paths.htmlRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.htmlRoot, 'index.html'), 'fixture report')

  publishSuccessfulArtifacts(paths, 'fixture-run')
  await finishSuccessfulRun(paths, 'fixture-run', async () => {})

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(paths.artifactsRoot, 'click-coverage-run.json'), 'utf8')),
    { schemaVersion: 1, runId: 'fixture-run' },
  )
  assert.equal(
    fs.readFileSync(path.join(paths.canonicalClickLedgerRoot, 'raw-worker-0.jsonl'), 'utf8'),
    '{"key":"fixture"}\n',
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'passed',
    failedTests: [],
    runId: 'fixture-run',
  })
  assert.equal(fs.existsSync(paths.runRoot), false)
  assert.equal(fs.existsSync(paths.cleanupRoot), true)
})

test('runtime release failure prevents terminal success and coverage identity publication', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(path.join(paths.runRoot, 'diagnostic.txt'), 'retained')

  await assert.rejects(
    () => finishSuccessfulRun(paths, 'fixture-run', async () => {
      throw new Error('synthetic shard ports remain in use')
    }),
    /synthetic shard ports remain in use/,
  )

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.canonicalLastRunPath, 'utf8')), {
    status: 'failed',
    failedTests: [],
    runId: 'fixture-run',
  })
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.runRoot), true)
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'diagnostic.txt'), 'utf8'), 'retained')
})

test('terminal publication failure keeps diagnostics and never publishes coverage identity', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(paths.jsonPath, '{"stats":{}}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'js-coverage-unused.json'), '{"unused":[]}\n')
  fs.writeFileSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl'), '{"key":"fixture"}\n')
  fs.mkdirSync(paths.htmlRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.htmlRoot, 'index.html'), 'fixture report')
  publishSuccessfulArtifacts(paths, 'fixture-run')
  fs.mkdirSync(path.dirname(path.dirname(paths.canonicalLastRunPath)), { recursive: true })
  fs.writeFileSync(path.dirname(paths.canonicalLastRunPath), 'blocks terminal status directory')

  await assert.rejects(
    () => finishSuccessfulRun(paths, 'fixture-run', async () => {}),
    /EEXIST|ENOTDIR/,
  )
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.runRoot), true)
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'control-inventory.json'), 'utf8'), '{"controls":[]}\n')
})

test('cleanup staging failure keeps diagnostics and never publishes coverage identity', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(paths.jsonPath, '{"stats":{}}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'js-coverage-unused.json'), '{"unused":[]}\n')
  fs.writeFileSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl'), '{"key":"fixture"}\n')
  fs.mkdirSync(paths.htmlRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.htmlRoot, 'index.html'), 'fixture report')
  publishSuccessfulArtifacts(paths, 'fixture-run')
  fs.mkdirSync(paths.cleanupRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.cleanupRoot, 'collision.txt'), 'blocks cleanup staging')

  await assert.rejects(
    () => finishSuccessfulRun(paths, 'fixture-run', async () => {}),
    /Deferred Playwright cleanup path already exists/,
  )
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.runRoot), true)
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'control-inventory.json'), 'utf8'), '{"controls":[]}\n')
})

test('coverage marker publication failure restores the diagnostic run root', async (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(paths.jsonPath, '{"stats":{}}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'js-coverage-unused.json'), '{"unused":[]}\n')
  fs.writeFileSync(path.join(paths.clickLedgerRoot, 'raw-worker-0.jsonl'), '{"key":"fixture"}\n')
  fs.mkdirSync(paths.htmlRoot, { recursive: true })
  fs.writeFileSync(path.join(paths.htmlRoot, 'index.html'), 'fixture report')
  publishSuccessfulArtifacts(paths, 'fixture-run')
  fs.mkdirSync(paths.canonicalCoverageRunPath)

  await assert.rejects(
    () => finishSuccessfulRun(paths, 'fixture-run', async () => {}),
    /EISDIR|EPERM/,
  )
  assert.equal(fs.existsSync(paths.runRoot), true)
  assert.equal(fs.existsSync(paths.cleanupRoot), false)
  assert.equal(fs.statSync(paths.canonicalCoverageRunPath).isDirectory(), true)
  assert.equal(fs.readFileSync(path.join(paths.runRoot, 'control-inventory.json'), 'utf8'), '{"controls":[]}\n')
})

test('incomplete successful publication fails without publishing a coverage identity', (t) => {
  const tempRepo = makeTempRepo(t)
  const paths = resolveRunPaths(tempRepo, 'fixture-run')
  prepareRunDirectories(paths)
  fs.writeFileSync(paths.jsonPath, '{"stats":{}}\n')
  fs.writeFileSync(path.join(paths.runRoot, 'control-inventory.json'), '{"controls":[]}\n')
  fs.mkdirSync(paths.htmlRoot, { recursive: true })

  assert.throws(
    () => publishSuccessfulArtifacts(paths, 'fixture-run'),
    /Required Playwright artifact is missing.*js-coverage-unused\.json/,
  )
  assert.equal(fs.existsSync(paths.canonicalCoverageRunPath), false)
  assert.equal(fs.existsSync(paths.runRoot), true)
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
