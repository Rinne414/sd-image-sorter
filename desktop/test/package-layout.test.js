'use strict';

// The packaged Windows layout: the user starts SD Image Sorter.exe at the top
// of the extracted folder (next to backend\, python\ and run-portable.bat);
// the Electron shell and its files live in the desktop\ subfolder.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
    buildBackendEnv, findAppRoot, needsDependencySetup, pendingUpdateFiles, resolvePython,
} = require('../src/paths');
const { shortcutPlan, writeShortcuts } = require('../src/shortcuts');

const ROOT = path.resolve('/Downloads/SD Image Sorter v1');
const exists = (files) => (file) => files.has(path.resolve(file));
const PACKAGE_FILES = new Set([
    path.join(ROOT, 'backend', 'main.py'),
    path.join(ROOT, 'python', 'python.exe'),
    path.join(ROOT, 'run-portable.bat'),
]);

const SHELL_DIR = path.join(ROOT, 'desktop');
const SHELL_EXE = path.join(SHELL_DIR, 'sd-image-sorter-shell.exe');

test('the shell in desktop/ finds the program folder above it and the bundled python', () => {
    const asar = path.join(SHELL_DIR, 'resources', 'app.asar');
    assert.equal(findAppRoot([path.dirname(SHELL_EXE), asar], exists(PACKAGE_FILES)), ROOT);
    assert.equal(findAppRoot([asar], exists(PACKAGE_FILES)), ROOT);
    const python = resolvePython(ROOT, 'win32', exists(PACKAGE_FILES));
    assert.deepEqual(python, { python: path.join(ROOT, 'python', 'python.exe'), kind: 'portable' });
});

test('a copy of the package in a folder with spaces and CJK characters resolves the same way', () => {
    const root = path.resolve('/Downloads/SD Image Sorter v1 (副本)/package');
    const files = new Set([path.join(root, 'backend', 'main.py'), path.join(root, 'python', 'python.exe')]);
    assert.equal(findAppRoot([path.join(root, 'desktop')], exists(files)), root);
});

test('the shell in desktop/ does not mistake its own folder for the program folder', () => {
    assert.equal(findAppRoot([SHELL_DIR], exists(new Set([path.join(SHELL_DIR, 'resources.pak')]))), null);
});

test('the backend learns the shell version only when there is one', () => {
    const python = { python: path.join(ROOT, 'python', 'python.exe'), kind: 'portable' };
    const base = { appRoot: ROOT, python, platform: 'win32', baseEnv: {}, port: 8681, parentPid: 4 };
    assert.equal(buildBackendEnv({ ...base, shellVersion: '0.1.0' }).SD_IMAGE_SORTER_SHELL_VERSION, '0.1.0');
    assert.equal('SD_IMAGE_SORTER_SHELL_VERSION' in buildBackendEnv(base), false);
});

const reader = (files) => (file) => {
    const key = path.relative(ROOT, file).replaceAll('\\', '/');
    return key in files ? Buffer.from(files[key]) : null;
};
const md5Of = (data) => `md5:${data.toString()}`;
const portable = { python: 'x', kind: 'portable' };

test('first start of a fresh package needs the core packages', () => {
    const readFile = reader({ 'backend/requirements-core.txt': 'fastapi' });
    assert.equal(needsDependencySetup({ appRoot: ROOT, python: portable, env: {}, readFile, md5: md5Of }), true);
});

test('installed packages with a matching hash need nothing, a changed file needs a refresh', () => {
    const files = { 'backend/requirements-core.txt': 'fastapi', 'backend/.requirements_hash': 'MD5:FASTAPI\r\n' };
    const args = { appRoot: ROOT, python: portable, env: {}, md5: md5Of };
    assert.equal(needsDependencySetup({ ...args, readFile: reader(files) }), false);
    const changed = { ...files, 'backend/requirements-core.txt': 'fastapi\nnumpy' };
    assert.equal(needsDependencySetup({ ...args, readFile: reader(changed) }), true);
});

test('hash "installed" (no certutil), venv, override and full-AI file choice', () => {
    const files = { 'backend/requirements-core.txt': 'a', 'backend/.requirements_hash': 'installed' };
    const args = { appRoot: ROOT, python: portable, env: {}, md5: md5Of };
    assert.equal(needsDependencySetup({ ...args, readFile: reader(files) }), false);
    for (const kind of ['venv', 'override']) {
        assert.equal(needsDependencySetup({ ...args, python: { python: 'x', kind }, readFile: reader({}) }), false);
    }
    assert.equal(needsDependencySetup({ ...args, python: null, readFile: reader({}) }), false);
    const full = { 'backend/requirements.txt': 'all', 'backend/.requirements_hash': 'md5:core' };
    const env = { SD_IMAGE_SORTER_INSTALL_FULL_AI: '1' };
    assert.equal(needsDependencySetup({ ...args, env, readFile: reader(full) }), true);
    assert.equal(needsDependencySetup({ ...args, env, readFile: reader({}) }), false);
});

test('only unfinished update manifests count as pending', () => {
    const names = ['pending-update-3.8.0.json', 'pending-update-3.8.0.json.failed', 'pending-restart.json', 'x.json'];
    assert.deepEqual(pendingUpdateFiles(names), ['pending-update-3.8.0.json']);
});

test('shortcut plan covers the desktop and the Start menu, skipping an unknown folder', () => {
    const exePath = SHELL_EXE;
    const plan = shortcutPlan({
        exePath, appRoot: ROOT, desktopDir: path.resolve('/Users/me/Desktop'), startMenuDir: path.resolve('/Users/me/Programs'),
        appUserModelId: 'id',
    });
    assert.deepEqual(plan.map((item) => path.basename(item.file)), ['SD Image Sorter.lnk', 'SD Image Sorter.lnk']);
    assert.equal(plan[0].options.target, exePath);
    assert.equal(plan[0].options.icon, exePath);
    assert.equal(plan[0].options.cwd, ROOT);
    assert.equal(shortcutPlan({ exePath, appRoot: ROOT, desktopDir: null, startMenuDir: path.resolve('/p'), appUserModelId: 'id' }).length, 1);
});

test('writing shortcuts reports each failure instead of claiming success', () => {
    const plan = [{ file: 'a.lnk', options: {} }, { file: 'b.lnk', options: {} }, { file: 'c.lnk', options: {} }];
    const shellApi = {
        writeShortcutLink: (file) => {
            if (file === 'b.lnk') return false;
            if (file === 'c.lnk') throw new Error('denied');
            return true;
        },
    };
    assert.deepEqual(writeShortcuts(shellApi, plan), {
        created: ['a.lnk'],
        failed: [{ file: 'b.lnk', reason: 'refused' }, { file: 'c.lnk', reason: 'denied' }],
    });
});
