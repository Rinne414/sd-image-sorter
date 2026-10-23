'use strict';

/**
 * The backend child process: attach to a running SD Image Sorter, or start
 * one with the package's own Python (no PowerShell or cmd in between).
 *
 * The child gets SD_IMAGE_SORTER_PARENT_PID=<this process>. When the shell
 * exits for any reason (Quit, a crash, Task Manager) the backend notices and
 * shuts itself down gracefully (backend/desktop_lifeline.py), so Quit only
 * has to exit the shell. Exit code 75 means "restart me" (after an update
 * or a feature install), as in run-portable.bat.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
    backendUrl, buildBackendEnv, candidatePorts, foldersToCreate, looksLikeSorter, planBackend, resolvePython,
} = require('./paths');

const PROBE_TIMEOUT_MS = 1500;
const READY_TIMEOUT_MS = 180000;
const READY_POLL_MS = 400;
const RESTART_EXIT_CODE = 75;

function portIsFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '127.0.0.1');
    });
}

async function fetchJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    return { status: response.status, body };
}

async function probePort(port) {
    try {
        const { status, body } = await fetchJson(`${backendUrl(port)}/api/updates/boot-id`, PROBE_TIMEOUT_MS);
        if (looksLikeSorter(status, body)) return { port, state: 'sorter' };
    } catch {
        // Nothing answered over HTTP: free, or something that is not a web server.
    }
    return { port, state: (await portIsFree(port)) ? 'free' : 'other' };
}

/** Probe ports in order and stop at the first one that settles the plan. */
async function choosePlan(envPort) {
    const probes = [];
    for (const port of candidatePorts(envPort)) {
        const probe = await probePort(port);
        probes.push(probe);
        if (probe.state !== 'other') break;
    }
    return planBackend(probes);
}

class BackendProcess {
    constructor({ appRoot, platform, baseEnv, logDir, onExit }) {
        this.appRoot = appRoot;
        this.platform = platform;
        this.baseEnv = baseEnv;
        this.logDir = logDir;
        this.onExit = onExit;
        this.child = null;
        this.stopping = false;
        this.port = null;
        this.logPath = path.join(logDir, 'desktop-backend.log');
    }

    python() {
        return resolvePython(this.appRoot, this.platform, fs.existsSync, this.baseEnv.SD_IMAGE_SORTER_PYTHON);
    }

    start(port) {
        const python = this.python();
        if (!python) {
            throw new Error('python-missing');
        }
        this.port = port;
        const env = buildBackendEnv({
            appRoot: this.appRoot, python, platform: this.platform, baseEnv: this.baseEnv, port, parentPid: process.pid,
        });
        for (const folder of foldersToCreate(env)) fs.mkdirSync(folder, { recursive: true });
        fs.mkdirSync(this.logDir, { recursive: true });
        const log = fs.openSync(this.logPath, 'a');
        fs.writeSync(log, `\n--- ${new Date().toISOString()} starting ${python.python} main.py --port ${port}\n`);
        this.child = spawn(python.python, ['main.py', '--port', String(port)], {
            cwd: path.join(this.appRoot, 'backend'),
            env,
            stdio: ['ignore', log, log],
            windowsHide: true,
        });
        fs.closeSync(log);
        this.child.once('exit', (code) => this.handleExit(code));
        return this.child.pid;
    }

    handleExit(code) {
        const wasStopping = this.stopping;
        this.child = null;
        if (!wasStopping && code === RESTART_EXIT_CODE) {
            this.start(this.port);
            this.onExit?.({ code, restarted: true });
            return;
        }
        this.onExit?.({ code, restarted: false, expected: wasStopping });
    }

    /**
     * The shell is about to exit: an exit of the child from now on is
     * expected. The backend stops itself once this process is gone.
     */
    release() {
        this.stopping = true;
    }

    tailLog(lines = 40) {
        try {
            return fs.readFileSync(this.logPath, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
        } catch {
            return '';
        }
    }
}

/** Resolve once the backend answers as SD Image Sorter; reject if the child exits first. */
async function waitUntilReady(port, isAlive) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (isAlive && !isAlive()) throw new Error('backend-exited');
        try {
            const { status, body } = await fetchJson(`${backendUrl(port)}/api/updates/boot-id`, PROBE_TIMEOUT_MS);
            if (looksLikeSorter(status, body)) return;
        } catch {
            // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error('backend-timeout');
}

async function postJson(port, apiPath, payload) {
    const response = await fetch(`${backendUrl(port)}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function getJson(port, apiPath) {
    const { status, body } = await fetchJson(`${backendUrl(port)}${apiPath}`, 10000);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return body;
}

module.exports = { BackendProcess, choosePlan, getJson, postJson, waitUntilReady };
