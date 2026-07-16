#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  resolveCoverageRunId,
  resolveShardCount,
  runShardedPlaywright,
  shouldShardFullRun,
} from './playwright-shards.mjs'
import { buildPlaywrightChildEnv } from './playwright-env.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const e2eRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(e2eRoot, '..', '..')
const playwrightCli = path.join(e2eRoot, 'node_modules', 'playwright', 'cli.js')
const requiredLibs = [
  'libnspr4.so',
  'libnss3.so',
  'libnssutil3.so',
  'libsmime3.so',
  'libasound.so.2',
]

const debPrefixes = [
  'libnspr4_',
  'libnss3_',
  'libasound2t64_',
]

const debSearchDirs = [
  path.join(repoRoot, '.tools'),
  path.join(repoRoot, '.tools', 'local-libs'),
]

const defaultPlaywrightPorts = [19087, 19187, 19287, 19387, 19487, 19587, 19687, 19787]

function fileExists(candidate) {
  try {
    return fs.existsSync(candidate)
  } catch {
    return false
  }
}

function resolveRuntimeRoot(environment) {
  return environment.PLAYWRIGHT_LOCAL_RUNTIME_ROOT
    ? path.resolve(environment.PLAYWRIGHT_LOCAL_RUNTIME_ROOT)
    : path.join(repoRoot, '.tools', 'local-libs', 'playwright-runtime')
}

function resolveRuntimeLibDirs(runtimeRoot) {
  return [
    path.join(runtimeRoot, 'usr', 'lib', 'x86_64-linux-gnu'),
    path.join(runtimeRoot, 'lib', 'x86_64-linux-gnu'),
  ]
}

function systemHasRequiredLibs(environment) {
  const result = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', env: environment })
  if (result.status !== 0 || !result.stdout) {
    return false
  }

  return requiredLibs.every((lib) => result.stdout.includes(lib))
}

function runtimeHasRequiredLibs(runtimeLibDirs) {
  return requiredLibs.every((lib) =>
    runtimeLibDirs.some((dir) => fileExists(path.join(dir, lib))),
  )
}

function findDebFile(prefix) {
  for (const dir of debSearchDirs) {
    if (!fileExists(dir)) {
      continue
    }

    const match = fs.readdirSync(dir)
      .find((entry) => entry.startsWith(prefix) && entry.endsWith('.deb'))
    if (match) {
      return path.join(dir, match)
    }
  }

  return null
}

function ensureLocalRuntimeLibs(environment) {
  if (process.platform !== 'linux' || environment.PLAYWRIGHT_SKIP_LOCAL_RUNTIME_BOOTSTRAP === '1') {
    return []
  }

  const runtimeRoot = resolveRuntimeRoot(environment)
  const runtimeLibDirs = resolveRuntimeLibDirs(runtimeRoot)

  if (runtimeHasRequiredLibs(runtimeLibDirs)) {
    return runtimeLibDirs.filter(fileExists)
  }

  if (systemHasRequiredLibs(environment)) {
    return []
  }

  const missingDebs = debPrefixes
    .map((prefix) => findDebFile(prefix))
    .filter((candidate) => !candidate)

  if (missingDebs.length > 0) {
    console.error(
      '[playwright-runtime] Missing local runtime packages. Expected .deb archives for:',
      debPrefixes.join(', '),
    )
    process.exit(1)
  }

  fs.mkdirSync(runtimeRoot, { recursive: true })
  for (const prefix of debPrefixes) {
    const debPath = findDebFile(prefix)
    const result = spawnSync('dpkg-deb', ['-x', debPath, runtimeRoot], {
      env: environment,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }

  if (!runtimeHasRequiredLibs(runtimeLibDirs)) {
    console.error('[playwright-runtime] Extracted local runtime packages but required shared libraries are still missing.')
    process.exit(1)
  }

  return runtimeLibDirs.filter(fileExists)
}

function buildEnv(parentEnvironment, platform) {
  const env = buildPlaywrightChildEnv(parentEnvironment, platform)
  const localLibDirs = ensureLocalRuntimeLibs(env)
  if (localLibDirs.length === 0) {
    return env
  }

  const current = env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(path.delimiter).filter(Boolean) : []
  env.LD_LIBRARY_PATH = [...localLibDirs, ...current].join(path.delimiter)
  return env
}

function canAutoAssignServerPort(command, args, environment) {
  if (environment.PW_WEB_SERVER_PORT || environment.SD_IMAGE_SORTER_PORT || environment.BASE_URL) {
    return false
  }

  if (command === 'test') {
    return true
  }

  if (command === 'codegen') {
    return args.length === 1 || !args.some((arg) => /^https?:\/\//i.test(arg))
  }

  return false
}

async function tryListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Could not determine an ephemeral localhost port for Playwright.')))
        return
      }

      server.close(() => resolve(address.port))
    })
  })
}
function parsePort(value, fieldName) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${fieldName} must be an integer between 1 and 65535, received ${String(value)}`)
  }
  return port
}

async function assignServerPorts(env, count) {
  const candidates = []
  if (env.PW_WEB_SERVER_PORT) {
    candidates.push(parsePort(env.PW_WEB_SERVER_PORT, 'PW_WEB_SERVER_PORT'))
  }
  candidates.push(...defaultPlaywrightPorts)

  const ports = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue
    }
    seen.add(candidate)
    if (await tryListen(candidate)) {
      ports.push(candidate)
      if (ports.length === count) {
        return ports
      }
    }
  }

  while (ports.length < count) {
    const candidate = await reserveEphemeralPort()
    if (!seen.has(candidate)) {
      seen.add(candidate)
      ports.push(candidate)
    }
  }
  return ports
}

async function waitForPortsReleased(ports, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const released = await Promise.all(ports.map((port) => tryListen(port)))
    if (released.every(Boolean)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const stillListening = []
  for (const port of ports) {
    if (!(await tryListen(port))) {
      stillListening.push(port)
    }
  }
  throw new Error(
    `Playwright shard cleanup left listening ports after ${timeoutMs}ms: ${stillListening.join(', ')}`,
  )
}

async function assignServerPort(env, args) {
  const [command] = args
  if (!canAutoAssignServerPort(command, args, env)) {
    return { env, args }
  }

  for (const port of defaultPlaywrightPorts) {
    if (await tryListen(port)) {
      const nextEnv = { ...env, PW_WEB_SERVER_PORT: String(port) }
      const nextArgs = [...args]
      if (command === 'codegen' && nextArgs.length === 1) {
        nextArgs.push(`http://127.0.0.1:${port}`)
      }
      console.error(`[playwright-runtime] Using localhost port ${port}.`)
      return { env: nextEnv, args: nextArgs }
    }
  }

  const fallbackPort = await reserveEphemeralPort()
  const nextEnv = { ...env, PW_WEB_SERVER_PORT: String(fallbackPort) }
  const nextArgs = [...args]
  if (command === 'codegen' && nextArgs.length === 1) {
    nextArgs.push(`http://127.0.0.1:${fallbackPort}`)
  }
  console.error(`[playwright-runtime] Using fallback localhost port ${fallbackPort}.`)
  return { env: nextEnv, args: nextArgs }
}

async function main() {
  if (!fileExists(playwrightCli)) {
    console.error(`[playwright-runtime] Playwright CLI not found: ${playwrightCli}`)
    process.exit(1)
  }

  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('[playwright-runtime] Missing Playwright CLI arguments.')
    process.exit(1)
  }

  const baseEnv = buildEnv(process.env, process.platform)
  if (baseEnv.PW_ENABLE_EXTERNAL_INTEGRATIONS === '1') {
    console.warn(
      '[playwright-runtime] External integrations are enabled; use isolated credentials and treat failure logs and artifacts as sensitive.',
    )
  }
  if (shouldShardFullRun(args, baseEnv)) {
    const shardCount = resolveShardCount(baseEnv)
    if (shardCount > 1) {
      const ports = await assignServerPorts(baseEnv, shardCount)
      const runId = resolveCoverageRunId(baseEnv, process.pid, Date.now())
      try {
        const status = await runShardedPlaywright({
          args,
          baseEnv,
          e2eRoot,
          playwrightCli,
          ports,
          repoRoot,
          runId,
          shardCount,
          platform: process.platform,
        })
        process.exitCode = status
      } finally {
        await waitForPortsReleased(ports, 10_000, 100)
        console.error(`[playwright-runtime] Released shard ports: ${ports.join(', ')}.`)
      }
      return
    }
  }
  const { env, args: resolvedArgs } = await assignServerPort(baseEnv, args)

  const result = spawnSync(process.execPath, [playwrightCli, ...resolvedArgs], {
    cwd: e2eRoot,
    env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
