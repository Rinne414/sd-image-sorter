import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const WORKSPACE_LOCK_SCOPE = 'ci-playwright-canonical'
export const WORKSPACE_LOCK_CAPABILITY_ENV = 'PW_WORKSPACE_LOCK_CAPABILITY'
export const WORKSPACE_LOCK_HOLDER_PID_ENV = 'PW_WORKSPACE_LOCK_HOLDER_PID'
export const WORKSPACE_LOCK_RUN_ID_ENV = 'PW_WORKSPACE_LOCK_RUN_ID'

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }
  return value
}

export function requireWorkspaceLockRuntimeCompatibility(environment, repoRoot, platform) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object')
  }
  requireNonEmptyString(repoRoot, 'repoRoot')
  requireNonEmptyString(platform, 'platform')
  const normalizedRoot = repoRoot.replaceAll('\\', '/')
  const isWsl = Boolean(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP)
  if (platform === 'linux' && isWsl && /^\/mnt\/[A-Za-z]\//.test(normalizedRoot)) {
    throw new Error(
      'Playwright cannot provide one coherent OS lock from WSL on a Windows-mounted workspace. '
      + 'Run the test command from Windows, or move the repository to the WSL filesystem and use WSL-native Python and Node.',
    )
  }
  if (platform === 'win32' && /^\/\/(?:wsl\$|wsl\.localhost)\//i.test(normalizedRoot)) {
    throw new Error(
      'Playwright cannot provide one coherent OS lock from Windows on a WSL filesystem workspace. '
      + 'Run the test command inside that WSL distribution with native Python and Node.',
    )
  }
}

function commandExists(candidate, environment, platform) {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return fs.existsSync(candidate)
  }
  const lookupCommand = platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(lookupCommand, [candidate], {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  return result.status === 0 && result.stdout.trim().length > 0
}

function readPythonOsName(candidate, environment) {
  const result = spawnSync(
    candidate,
    ['-c', 'import os, sys; sys.stdout.write(os.name)'],
    {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  if (result.error) {
    throw new Error(
      `Python runtime probe failed to start: interpreter=${candidate}, error=${result.error.message}`,
      { cause: result.error },
    )
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' && result.stderr.trim()
      ? result.stderr.trim()
      : 'no diagnostic output'
    throw new Error(
      `Python runtime probe failed: interpreter=${candidate}, exit=${String(result.status)}, stderr=${detail}`,
    )
  }
  const osName = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  if (osName !== 'nt' && osName !== 'posix') {
    throw new Error(
      `Python runtime probe returned unsupported os.name: interpreter=${candidate}, os.name=${JSON.stringify(osName)}`,
    )
  }
  return osName
}

function requireCompatiblePythonLockFamily(candidate, environment, platform) {
  const osName = readPythonOsName(candidate, environment)
  const expectedOsName = platform === 'win32' ? 'nt' : 'posix'
  if (osName !== expectedOsName) {
    throw new Error(
      `Python runtime ${candidate} has an incompatible OS lock family for Node platform ${platform}: `
      + `expected os.name=${expectedOsName}, received os.name=${osName}.`,
    )
  }
}

export function resolveWorkspaceLockPython(environment, repoRoot, platform) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object')
  }
  requireNonEmptyString(repoRoot, 'repoRoot')
  requireNonEmptyString(platform, 'platform')
  const configured = environment.PW_BACKEND_PYTHON
  if (configured !== undefined) {
    requireNonEmptyString(configured, 'PW_BACKEND_PYTHON')
    if (!commandExists(configured, environment, platform)) {
      throw new Error(`PW_BACKEND_PYTHON does not exist or is not executable: ${configured}`)
    }
    requireCompatiblePythonLockFamily(configured, environment, platform)
    return configured
  }
  const candidates = platform === 'win32'
    ? [
        path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
        path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
        'python',
      ]
    : [
        path.join(repoRoot, 'backend', 'venv', 'bin', 'python'),
        'python3',
        'python',
      ]
  const failures = []
  for (const candidate of candidates) {
    if (!commandExists(candidate, environment, platform)) continue
    try {
      requireCompatiblePythonLockFamily(candidate, environment, platform)
      return candidate
    } catch (error) {
      if (!(error instanceof Error)) throw error
      failures.push(error.message)
    }
  }
  const checkedDetail = failures.length > 0 ? ` Checked runtimes: ${failures.join(' | ')}` : ''
  throw new Error(
    `No Python runtime with a compatible OS lock family is available for Node platform ${platform}. `
    + 'Create backend/venv or set PW_BACKEND_PYTHON to a platform-native interpreter.'
    + checkedDetail,
  )
}

function parsePositiveProcessId(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new TypeError(`${fieldName} must be an ASCII positive integer`)
  }
  const processId = Number(value)
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new RangeError(`${fieldName} must be a positive safe integer`)
  }
  return processId
}

function formatBrokerFailure(action, result) {
  const status = Number.isInteger(result.status) ? result.status : 'unknown'
  const detail = typeof result.stderr === 'string' && result.stderr.trim()
    ? result.stderr.trim()
    : typeof result.error?.message === 'string'
      ? result.error.message
      : 'no diagnostic output'
  return `workspace lock ${action} failed with exit ${status}: ${detail}`
}

function inheritedLockValues(environment) {
  const capability = environment[WORKSPACE_LOCK_CAPABILITY_ENV]
  const holderPid = environment[WORKSPACE_LOCK_HOLDER_PID_ENV]
  const runId = environment[WORKSPACE_LOCK_RUN_ID_ENV]
  const presentCount = [capability, holderPid, runId].filter((value) => value !== undefined).length
  if (presentCount === 0) return null
  if (presentCount !== 3) {
    throw new Error(
      'Inherited workspace lock environment is incomplete; capability, holder PID, and run ID are all required.',
    )
  }
  requireNonEmptyString(capability, WORKSPACE_LOCK_CAPABILITY_ENV)
  requireNonEmptyString(runId, WORKSPACE_LOCK_RUN_ID_ENV)
  return {
    capability,
    holderPid: parsePositiveProcessId(holderPid, WORKSPACE_LOCK_HOLDER_PID_ENV),
    runId,
  }
}

export function enterPlaywrightWorkspaceLock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('workspace lock input must be an object')
  }
  const {
    args,
    environment,
    platform,
    repoRoot,
    runId,
    wrapperPath,
  } = input
  if (!Array.isArray(args) || args.some((part) => typeof part !== 'string')) {
    throw new TypeError('args must be a string array')
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object')
  }
  requireNonEmptyString(platform, 'platform')
  requireNonEmptyString(repoRoot, 'repoRoot')
  requireNonEmptyString(runId, 'runId')
  requireNonEmptyString(wrapperPath, 'wrapperPath')
  requireWorkspaceLockRuntimeCompatibility(environment, repoRoot, platform)
  const python = resolveWorkspaceLockPython(environment, repoRoot, platform)
  const helperPath = path.join(repoRoot, 'scripts', 'workspace_lock.py')
  const lockPath = path.join(repoRoot, '.tmp', 'run-ci.lock')
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Workspace lock helper is missing: ${helperPath}`)
  }
  const inherited = inheritedLockValues(environment)
  if (inherited) {
    if (inherited.runId !== runId) {
      throw new Error(
        `Inherited workspace lock run ID does not match this test command: ${inherited.runId} != ${runId}`,
      )
    }
    const result = spawnSync(python, [
      helperPath,
      'verify',
      '--lock-path', lockPath,
      '--scope', WORKSPACE_LOCK_SCOPE,
      '--run-id', runId,
      '--holder-pid', String(inherited.holderPid),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (result.status !== 0) throw new Error(formatBrokerFailure('verification', result))
    return { delegated: false, status: 0 }
  }
  const result = spawnSync(python, [
    helperPath,
    'run',
    '--lock-path', lockPath,
    '--scope', WORKSPACE_LOCK_SCOPE,
    '--run-id', runId,
    '--',
    process.execPath,
    wrapperPath,
    ...args,
  ], {
    cwd: repoRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(formatBrokerFailure('delegation', result), { cause: result.error })
  return { delegated: true, status: Number.isInteger(result.status) ? result.status : 1 }
}
