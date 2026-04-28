#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const e2eRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(e2eRoot, '..', '..')
const playwrightCli = path.join(e2eRoot, 'node_modules', 'playwright', 'cli.js')
const runtimeRoot = process.env.PLAYWRIGHT_LOCAL_RUNTIME_ROOT
  ? path.resolve(process.env.PLAYWRIGHT_LOCAL_RUNTIME_ROOT)
  : path.join(repoRoot, '.tools', 'local-libs', 'playwright-runtime')

const requiredLibs = [
  'libnspr4.so',
  'libnss3.so',
  'libnssutil3.so',
  'libsmime3.so',
  'libasound.so.2',
]

const runtimeLibDirs = [
  path.join(runtimeRoot, 'usr', 'lib', 'x86_64-linux-gnu'),
  path.join(runtimeRoot, 'lib', 'x86_64-linux-gnu'),
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

const defaultPlaywrightPorts = [19087, 19187, 19287]

function fileExists(candidate) {
  try {
    return fs.existsSync(candidate)
  } catch {
    return false
  }
}

function systemHasRequiredLibs() {
  const result = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) {
    return false
  }

  return requiredLibs.every((lib) => result.stdout.includes(lib))
}

function runtimeHasRequiredLibs() {
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

function ensureLocalRuntimeLibs() {
  if (process.platform !== 'linux' || process.env.PLAYWRIGHT_SKIP_LOCAL_RUNTIME_BOOTSTRAP === '1') {
    return []
  }

  if (runtimeHasRequiredLibs()) {
    return runtimeLibDirs.filter(fileExists)
  }

  if (systemHasRequiredLibs()) {
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
    const result = spawnSync('dpkg-deb', ['-x', debPath, runtimeRoot], { stdio: 'inherit' })
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }

  if (!runtimeHasRequiredLibs()) {
    console.error('[playwright-runtime] Extracted local runtime packages but required shared libraries are still missing.')
    process.exit(1)
  }

  return runtimeLibDirs.filter(fileExists)
}

function buildEnv() {
  const env = { ...process.env }
  const localLibDirs = ensureLocalRuntimeLibs()
  if (localLibDirs.length === 0) {
    return env
  }

  const current = env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(path.delimiter).filter(Boolean) : []
  env.LD_LIBRARY_PATH = [...localLibDirs, ...current].join(path.delimiter)
  return env
}

function canAutoAssignServerPort(command, args) {
  if (process.env.PW_WEB_SERVER_PORT || process.env.SD_IMAGE_SORTER_PORT || process.env.BASE_URL) {
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

async function assignServerPort(env, args) {
  const [command] = args
  if (!canAutoAssignServerPort(command, args)) {
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

  const baseEnv = buildEnv()
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
