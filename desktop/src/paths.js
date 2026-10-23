'use strict';

/**
 * Pure helpers for finding and starting the backend. No Electron imports, so
 * they run under `node --test` (desktop/test/paths.test.js).
 */

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const DEFAULT_PORT = 8487;
const PORT_TRIES = 20;
const APP_ROOT_SEARCH_DEPTH = 6;

/** Walk up from each start folder to the first one that holds backend/main.py. */
function findAppRoot(startDirs, exists) {
    for (const start of startDirs.filter(Boolean)) {
        let dir = path.resolve(start);
        for (let depth = 0; depth <= APP_ROOT_SEARCH_DEPTH; depth += 1) {
            if (exists(path.join(dir, 'backend', 'main.py'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null;
}

/**
 * The Python that runs the backend: the portable package's own interpreter
 * first, then the venv run.bat / run.sh made. `override` (env
 * SD_IMAGE_SORTER_PYTHON) wins when it exists.
 */
function resolvePython(appRoot, platform, exists, override) {
    if (override && exists(override)) return { python: override, kind: 'override' };
    const candidates = platform === 'win32'
        ? [
            { python: path.join(appRoot, 'python', 'python.exe'), kind: 'portable' },
            { python: path.join(appRoot, 'backend', 'venv', 'Scripts', 'python.exe'), kind: 'venv' },
        ]
        : [
            { python: path.join(appRoot, 'python', 'bin', 'python3'), kind: 'portable' },
            { python: path.join(appRoot, 'backend', 'venv', 'bin', 'python'), kind: 'venv' },
        ];
    return candidates.find((candidate) => exists(candidate.python)) || null;
}

const MODEL_DIRS = {
    SD_IMAGE_SORTER_WD14_MODEL_DIR: 'wd14-tagger',
    SD_IMAGE_SORTER_YOLO_MODEL_DIR: 'yolo',
    SD_IMAGE_SORTER_CLIP_MODEL_DIR: 'clip',
    SD_IMAGE_SORTER_ARTIST_MODEL_DIR: 'artist',
    SD_IMAGE_SORTER_SAM3_MODEL_DIR: 'sam3',
    SD_IMAGE_SORTER_NUDENET_MODEL_DIR: 'nudenet',
    SD_IMAGE_SORTER_TORIIGATE_MODEL_DIR: 'toriigate',
    SD_IMAGE_SORTER_FLORENCE2_MODEL_DIR: 'florence2',
    SD_IMAGE_SORTER_LUCIDA_MODEL_DIR: 'lucida',
    SD_IMAGE_SORTER_CL_TAGGER_V2_MODEL_DIR: 'cl-tagger-v2',
};

/** The package-local folders run-portable.bat / run.bat set; values already set win. */
function packageDirs(appRoot, baseEnv) {
    const dataDir = baseEnv.SD_IMAGE_SORTER_DATA_DIR || path.join(appRoot, 'data');
    const modelsDir = path.join(dataDir, 'models');
    const cacheDir = baseEnv.SD_IMAGE_SORTER_CACHE_DIR || path.join(dataDir, 'cache');
    const dirs = {
        SD_IMAGE_SORTER_DATA_DIR: dataDir,
        SD_IMAGE_SORTER_CONFIG_DIR: path.join(dataDir, 'config'),
        SD_IMAGE_SORTER_STATE_DIR: path.join(dataDir, 'state'),
        SD_IMAGE_SORTER_TMP_DIR: path.join(dataDir, 'tmp'),
        SD_IMAGE_SORTER_UPDATE_DIR: path.join(appRoot, 'update'),
        SD_IMAGE_SORTER_THUMBNAIL_DIR: path.join(dataDir, 'thumbnails'),
        SD_IMAGE_SORTER_DB_PATH: path.join(dataDir, 'images.db'),
        SD_IMAGE_SORTER_FAVORITES_PATH: path.join(dataDir, 'favorites'),
        SD_IMAGE_SORTER_CACHE_DIR: cacheDir,
    };
    for (const [key, folder] of Object.entries(MODEL_DIRS)) dirs[key] = path.join(modelsDir, folder);
    const resolved = {};
    for (const [key, value] of Object.entries(dirs)) resolved[key] = baseEnv[key] || value;
    return resolved;
}

/** Environment for the backend child: the launcher's folders plus the shell's switches. */
function buildBackendEnv({ appRoot, python, platform, baseEnv, port, parentPid }) {
    const dirs = packageDirs(appRoot, baseEnv);
    const dataDir = dirs.SD_IMAGE_SORTER_DATA_DIR;
    const env = {
        ...baseEnv,
        ...dirs,
        HF_HOME: baseEnv.HF_HOME || path.join(dataDir, 'hf'),
        TORCH_HOME: baseEnv.TORCH_HOME || path.join(dataDir, 'torch'),
        XDG_CACHE_HOME: baseEnv.XDG_CACHE_HOME || dirs.SD_IMAGE_SORTER_CACHE_DIR,
        PIP_CACHE_DIR: baseEnv.PIP_CACHE_DIR || path.join(dataDir, 'pip-cache'),
        TEMP: dirs.SD_IMAGE_SORTER_TMP_DIR,
        TMP: dirs.SD_IMAGE_SORTER_TMP_DIR,
        SD_IMAGE_SORTER_LAUNCHER: 'desktop',
        SD_IMAGE_SORTER_RESTART_LOOP: '1',
        // The backend stops itself when this process ends (backend/desktop_lifeline.py).
        SD_IMAGE_SORTER_PARENT_PID: String(parentPid),
        SD_IMAGE_SORTER_OPEN_BROWSER: '0',
        SD_IMAGE_SORTER_PORT: String(port),
        PYTHONNOUSERSITE: '1',
        PYTHONUNBUFFERED: '1',
    };
    if (python.kind === 'portable' && platform === 'win32') {
        const pyDir = path.dirname(python.python);
        const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
        env[pathKey] = [pyDir, path.join(pyDir, 'Scripts'), path.join(pyDir, 'Lib', 'site-packages'), baseEnv[pathKey] || '']
            .join(path.delimiter);
    }
    return env;
}

/** Folders the backend expects to exist before it starts. */
function foldersToCreate(env) {
    return [
        'SD_IMAGE_SORTER_DATA_DIR', 'SD_IMAGE_SORTER_CONFIG_DIR', 'SD_IMAGE_SORTER_STATE_DIR',
        'SD_IMAGE_SORTER_TMP_DIR', 'SD_IMAGE_SORTER_CACHE_DIR', 'SD_IMAGE_SORTER_THUMBNAIL_DIR',
        'SD_IMAGE_SORTER_FAVORITES_PATH',
    ].map((key) => env[key]).filter(Boolean);
}

/** Ports to look at, preferred first: an SD_IMAGE_SORTER_PORT setting, else 8487. */
function candidatePorts(envPort) {
    const preferred = Number.parseInt(envPort, 10);
    const first = Number.isInteger(preferred) && preferred > 0 && preferred < 65536 ? preferred : DEFAULT_PORT;
    return Array.from({ length: PORT_TRIES }, (_, index) => first + index).filter((port) => port < 65536);
}

/**
 * Decide what to do from probes of the candidate ports, in order:
 * probe = { port, state: 'sorter' | 'free' | 'other' }.
 * The first port that already serves SD Image Sorter is attached to (it was
 * started by run.bat or another launcher, so it is never stopped by the
 * shell); otherwise the backend is started on the first free port.
 */
function planBackend(probes) {
    const first = probes[0];
    if (first && first.state === 'sorter') return { action: 'attach', port: first.port };
    const free = probes.find((probe) => probe.state === 'free');
    if (free) return { action: 'start', port: free.port };
    const sorter = probes.find((probe) => probe.state === 'sorter');
    if (sorter) return { action: 'attach', port: sorter.port };
    return { action: 'none', port: null };
}

/** True when a /api/updates/boot-id reply comes from SD Image Sorter. */
function looksLikeSorter(status, body) {
    return status === 200 && Boolean(body) && typeof body.boot_id === 'string' && body.boot_id.length > 0;
}

/** Absolute paths of existing files for a drag, each once, in the order given. */
function cleanDragPaths(paths, isFile, platform = process.platform) {
    if (!Array.isArray(paths)) return [];
    const seen = new Set();
    const result = [];
    for (const raw of paths) {
        if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw)) continue;
        const resolved = path.resolve(raw);
        const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key) || !isFile(resolved)) continue;
        seen.add(key);
        result.push(resolved);
    }
    return result;
}

function backendUrl(port) {
    return `http://127.0.0.1:${port}`;
}

/** Same-origin check for IPC senders and navigation: only our own backend page. */
function isBackendUrl(url, port) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === Number(port);
    } catch {
        return false;
    }
}

/**
 * True only for the shell's own bundled start-up page (query and hash allowed):
 * any other file: URL is a dropped or linked file and must not get shell powers.
 */
function isStatusPageUrl(url, statusPagePath, platform = process.platform) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
        const actual = path.resolve(fileURLToPath(parsed));
        const expected = path.resolve(statusPagePath);
        return platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    } catch {
        return false;
    }
}

module.exports = {
    DEFAULT_PORT,
    backendUrl,
    buildBackendEnv,
    candidatePorts,
    cleanDragPaths,
    findAppRoot,
    foldersToCreate,
    isBackendUrl,
    isStatusPageUrl,
    looksLikeSorter,
    planBackend,
    resolvePython,
};
