'use strict';

// Pure helpers of the desktop shell: run with `npm test` (node --test).

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
    buildBackendEnv, candidatePorts, cleanDragPaths, findAppRoot, isBackendUrl, looksLikeSorter, planBackend, resolvePython,
} = require('../src/paths');
const { sanitize } = require('../src/settings');
const { toAccelerator } = require('../src/shortcut');
const { makeTranslator, STRINGS } = require('../src/strings');
const { linuxEntryText } = require('../src/autostart');

const ROOT = path.resolve('/pkg/SD Image Sorter');
const existing = (files) => (file) => files.has(path.resolve(file));

test('app root is found by walking up from the exe folder', () => {
    const exists = existing(new Set([path.join(ROOT, 'backend', 'main.py')]));
    assert.equal(findAppRoot([path.join(ROOT, 'shell', 'win-unpacked')], exists), ROOT);
    assert.equal(findAppRoot([undefined, path.resolve('/elsewhere')], exists), null);
});

test('portable python wins over the venv, an override wins over both', () => {
    const portable = path.join(ROOT, 'python', 'python.exe');
    const venv = path.join(ROOT, 'backend', 'venv', 'Scripts', 'python.exe');
    const both = existing(new Set([portable, venv]));
    assert.deepEqual(resolvePython(ROOT, 'win32', both), { python: portable, kind: 'portable' });
    assert.deepEqual(resolvePython(ROOT, 'win32', existing(new Set([venv]))), { python: venv, kind: 'venv' });
    assert.equal(resolvePython(ROOT, 'win32', existing(new Set())), null);
    const override = path.resolve('/conda/python.exe');
    assert.equal(resolvePython(ROOT, 'win32', existing(new Set([override, portable])), override).kind, 'override');
    const linuxVenv = path.join(ROOT, 'backend', 'venv', 'bin', 'python');
    assert.equal(resolvePython(ROOT, 'linux', existing(new Set([linuxVenv]))).python, linuxVenv);
});

test('backend env uses package folders, keeps values the user set, and names the shell to watch', () => {
    const python = { python: path.join(ROOT, 'python', 'python.exe'), kind: 'portable' };
    const custom = path.resolve('/my data');
    const env = buildBackendEnv({ appRoot: ROOT, python, platform: 'win32', baseEnv: { Path: 'C:\\Windows', SD_IMAGE_SORTER_DATA_DIR: custom }, port: 8490, parentPid: 4242 });
    assert.equal(env.SD_IMAGE_SORTER_DATA_DIR, custom);
    assert.equal(env.SD_IMAGE_SORTER_DB_PATH, path.join(custom, 'images.db'));
    assert.equal(env.SD_IMAGE_SORTER_WD14_MODEL_DIR, path.join(custom, 'models', 'wd14-tagger'));
    assert.equal(env.SD_IMAGE_SORTER_PARENT_PID, '4242');
    assert.equal(env.SD_IMAGE_SORTER_RESTART_LOOP, '1');
    assert.equal(env.SD_IMAGE_SORTER_OPEN_BROWSER, '0');
    assert.equal(env.SD_IMAGE_SORTER_PORT, '8490');
    assert.equal(env.SD_IMAGE_SORTER_LAUNCHER, 'desktop');
    assert.ok(env.Path.startsWith(path.join(ROOT, 'python') + path.delimiter));
    assert.equal(env.PATH, undefined, 'PATH is extended under the key Windows already uses');
});

test('a venv python does not get the portable PATH prefix', () => {
    const python = { python: path.join(ROOT, 'backend', 'venv', 'Scripts', 'python.exe'), kind: 'venv' };
    const env = buildBackendEnv({ appRoot: ROOT, python, platform: 'win32', baseEnv: { PATH: 'X' }, port: 8487 });
    assert.equal(env.PATH, 'X');
    assert.equal(env.SD_IMAGE_SORTER_DATA_DIR, path.join(ROOT, 'data'));
});

test('ports: preferred first, then the next ones', () => {
    assert.deepEqual(candidatePorts(undefined).slice(0, 3), [8487, 8488, 8489]);
    assert.equal(candidatePorts('8631')[0], 8631);
    assert.equal(candidatePorts('nonsense')[0], 8487);
    assert.equal(candidatePorts('70000')[0], 8487);
});

test('attach to a running SD Image Sorter, else start on the first free port', () => {
    assert.deepEqual(planBackend([{ port: 8487, state: 'sorter' }]), { action: 'attach', port: 8487 });
    assert.deepEqual(planBackend([{ port: 8487, state: 'free' }]), { action: 'start', port: 8487 });
    assert.deepEqual(
        planBackend([{ port: 8487, state: 'other' }, { port: 8488, state: 'free' }]),
        { action: 'start', port: 8488 },
    );
    assert.deepEqual(
        planBackend([{ port: 8487, state: 'other' }, { port: 8488, state: 'sorter' }]),
        { action: 'attach', port: 8488 },
    );
    assert.deepEqual(planBackend([{ port: 8487, state: 'other' }]), { action: 'none', port: null });
});

test('only a boot-id reply counts as SD Image Sorter', () => {
    assert.equal(looksLikeSorter(200, { boot_id: 'abc' }), true);
    assert.equal(looksLikeSorter(200, { boot_id: '' }), false);
    assert.equal(looksLikeSorter(404, { boot_id: 'abc' }), false);
    assert.equal(looksLikeSorter(200, null), false);
});

test('IPC and navigation trust only the backend origin on its port', () => {
    assert.equal(isBackendUrl('http://127.0.0.1:8487/static/x.html', 8487), true);
    assert.equal(isBackendUrl('http://127.0.0.1:8488/', 8487), false);
    assert.equal(isBackendUrl('http://localhost:8487/', 8487), false);
    assert.equal(isBackendUrl('https://example.com/', 8487), false);
    assert.equal(isBackendUrl('not a url', 8487), false);
});

test('drag paths: absolute existing files only, each once', () => {
    const a = path.resolve('/pics/a.png');
    const b = path.resolve('/pics/b.png');
    const isFile = (file) => file === a || file === b;
    assert.deepEqual(cleanDragPaths([a, 'relative.png', a, b, path.resolve('/gone.png'), 42], isFile, 'linux'), [a, b]);
    assert.deepEqual(cleanDragPaths([a, a.toUpperCase()], (file) => file.toLowerCase() === a.toLowerCase(), 'win32'), [a]);
    assert.deepEqual(cleanDragPaths('not a list', isFile), []);
});

test('shortcut text becomes an Electron accelerator', () => {
    assert.equal(toAccelerator('Ctrl+Alt+Space'), 'Control+Alt+Space');
    assert.equal(toAccelerator('alt + ctrl + k'), 'Control+Alt+K');
    assert.equal(toAccelerator('Shift+Win+F12'), 'Shift+Super+F12');
    assert.equal(toAccelerator('Space'), null, 'a bare key would steal typing');
    assert.equal(toAccelerator('Ctrl+A+B'), null);
    assert.equal(toAccelerator(''), null);
});

test('settings keep known keys with the right types', () => {
    assert.deepEqual(sanitize({ closeToTray: 'yes', shortcut: 5, extra: 1 }), {
        closeToTray: true, closeNoticeShown: false, shortcut: 'Control+Alt+Space',
    });
    assert.equal(sanitize({ closeToTray: false }).closeToTray, false);
});

test('shell words exist in both languages', () => {
    assert.deepEqual(Object.keys(STRINGS['zh-CN']).sort(), Object.keys(STRINGS.en).sort());
    assert.equal(makeTranslator('zh-CN')('quit'), '退出');
    assert.equal(makeTranslator('en-GB')('noPort', { first: 8487, last: 8506 }).includes('8487-8506'), true);
    assert.ok(!/应用|app\b/iu.test(Object.values(STRINGS['zh-CN']).join(' ')), 'zh text says 程序, never app');
});

test('linux autostart entry quotes paths with spaces', () => {
    const text = linuxEntryText({ path: '/opt/SD Image Sorter/sd', args: ['--hidden'] });
    assert.match(text, /^Exec="\/opt\/SD Image Sorter\/sd" --hidden$/mu);
});
