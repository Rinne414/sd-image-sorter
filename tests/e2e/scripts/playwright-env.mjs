const ENV_ISOLATION_MARKER = 'PW_ENV_ISOLATION_ACTIVE'
const EXTERNAL_INTEGRATION_FLAG = 'PW_ENABLE_EXTERNAL_INTEGRATIONS'

const COMMON_RUNTIME_ENV_NAMES = Object.freeze([
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'DEBUG',
  'DEBUG_COLORS',
  'CI',
  'PYTHONUTF8',
  'PYTHONIOENCODING',
  'PYTHONUNBUFFERED',
])

const WINDOWS_RUNTIME_ENV_NAMES = Object.freeze([
  'USERNAME',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMDRIVE',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
])

const POSIX_RUNTIME_ENV_NAMES = Object.freeze([
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LD_LIBRARY_PATH',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'PULSE_SERVER',
])

const WSL_RUNTIME_ENV_NAMES = Object.freeze([
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
  'WSLENV',
  'WSL_UTF8',
])

const PLAYWRIGHT_ENV_NAMES = Object.freeze([
  ENV_ISOLATION_MARKER,
  EXTERNAL_INTEGRATION_FLAG,
  'BASE_URL',
  'PLAYWRIGHT_BLOB_OUTPUT_FILE',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_FORCE_TTY',
  'PLAYWRIGHT_HTML_OPEN',
  'PLAYWRIGHT_HTML_OUTPUT_DIR',
  'PLAYWRIGHT_JSON_OUTPUT_FILE',
  'PLAYWRIGHT_LOCAL_RUNTIME_ROOT',
  'PLAYWRIGHT_SOCKETS_DIR',
  'PLAYWRIGHT_SKIP_LOCAL_RUNTIME_BOOTSTRAP',
  'PWDEBUG',
  'PWPAUSE',
  'PWTEST_BLOB_DO_NOT_REMOVE',
  'PW_BACKEND_PYTHON',
  'PW_BROWSER_CHANNEL',
  'PW_COVERAGE_LEDGER_OWNER',
  'PW_DISABLE_SHARDING',
  'PW_E2E_DATA_ROOT',
  'PW_E2E_FIXTURE_ROOT',
  'PW_REUSE_SERVER',
  'PW_RUNNER_DEBUG',
  'PW_RUN_ARTIFACT_DIR',
  'PW_SHARD_COUNT',
  'PW_SHARD_INDEX',
  'PW_TEST_HTML_REPORT_OPEN',
  'PW_TEST_OUTPUT_DIR',
  'PW_TEST_REPORTER',
  'PW_WEB_SERVER_PORT',
  'SD_IMAGE_SORTER_DOWNLOAD_CHUNK_DELAY_MS',
  'SD_IMAGE_SORTER_PORT',
  'SD_LAZY_QA_COPY_DEST',
  'SD_LAZY_QA_FIRST_IMAGE',
  'SD_LAZY_QA_FRONTEND',
  'SD_TEST_MANUAL_SORT_TARGET',
  'SD_TEST_MOVE_TARGET',
])

const EXTERNAL_INTEGRATION_ENV_NAMES = Object.freeze([
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'HF_ENDPOINT',
  'HF_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'HUGGING_FACE_HUB_TOKEN',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'REQUESTS_CA_BUNDLE',
  'SD_IMAGE_SORTER_TRANSLATE_BING_KEY',
  'SD_IMAGE_SORTER_TRANSLATE_BING_REGION',
  'SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY',
  'SD_IMAGE_SORTER_TRANSLATE_CUSTOM_KEY_HEADER',
  'SD_IMAGE_SORTER_TRANSLATE_CUSTOM_URL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
])

function requireEnvironment(environment, fieldName) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError(`${fieldName} must be an environment object`)
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`${fieldName}.${name} must be a string when set`)
    }
  }
  return environment
}

function requirePlatform(platform) {
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError('platform must be a non-empty string')
  }
  return platform
}

function normalizedName(name, platform) {
  return platform === 'win32' ? name.toUpperCase() : name
}

function readEnvironmentValue(environment, name, platform) {
  const normalizedTarget = normalizedName(name, platform)
  const entry = Object.entries(environment).find(
    ([candidate]) => normalizedName(candidate, platform) === normalizedTarget,
  )
  return entry?.[1]
}

function uniqueAllowedNames(names, platform) {
  const seen = new Set()
  return names.filter((name) => {
    const normalized = normalizedName(name, platform)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function externalIntegrationsEnabled(environment, platform) {
  const value = readEnvironmentValue(environment, EXTERNAL_INTEGRATION_FLAG, platform)
  if (value === undefined || value === '' || value === '0') return false
  if (value === '1') return true
  throw new TypeError(
    `${EXTERNAL_INTEGRATION_FLAG} must be "0" or "1" when set, received ${JSON.stringify(value)}`,
  )
}

export function buildPlaywrightChildEnv(parentEnvironment, platform) {
  const environment = requireEnvironment(parentEnvironment, 'parentEnvironment')
  const currentPlatform = requirePlatform(platform)
  const isWindows = currentPlatform === 'win32'
  const isWsl = currentPlatform === 'linux'
    && readEnvironmentValue(environment, 'WSL_DISTRO_NAME', currentPlatform) !== undefined
  const allowedNames = [
    ...COMMON_RUNTIME_ENV_NAMES,
    ...(isWindows ? WINDOWS_RUNTIME_ENV_NAMES : POSIX_RUNTIME_ENV_NAMES),
    ...(isWsl ? [...WINDOWS_RUNTIME_ENV_NAMES, ...WSL_RUNTIME_ENV_NAMES] : []),
    ...PLAYWRIGHT_ENV_NAMES,
    ...(externalIntegrationsEnabled(environment, currentPlatform)
      ? EXTERNAL_INTEGRATION_ENV_NAMES
      : []),
  ]
  const childEnvironment = Object.fromEntries(
    uniqueAllowedNames(allowedNames, currentPlatform).flatMap((name) => {
      const value = readEnvironmentValue(environment, name, currentPlatform)
      return value === undefined ? [] : [[name, value]]
    }),
  )
  return {
    ...childEnvironment,
    [ENV_ISOLATION_MARKER]: '1',
  }
}

export function buildPlaywrightReportEnv(parentEnvironment, platform) {
  const environment = requireEnvironment(parentEnvironment, 'parentEnvironment')
  const currentPlatform = requirePlatform(platform)
  const externalFlagName = normalizedName(EXTERNAL_INTEGRATION_FLAG, currentPlatform)
  const reportParentEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => normalizedName(name, currentPlatform) !== externalFlagName,
    ),
  )
  return buildPlaywrightChildEnv(reportParentEnvironment, currentPlatform)
}
