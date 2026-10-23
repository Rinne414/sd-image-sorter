'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { BY_IDS_CHUNK, cleanImageIds, cleanLibraryId, resolveImagePaths } = require('../src/drag-resolver');
const { isStatusPageUrl } = require('../src/paths');

test('image ids: positive integers only, each once, in order', () => {
    assert.deepEqual(cleanImageIds([3, 1, 3, 0, -2, 1.5, '4', null, 2]), [3, 1, 2]);
    assert.deepEqual(cleanImageIds('C:\\secret.png'), []);
    assert.deepEqual(cleanImageIds(undefined), []);
});

test('library id: a safe id passes, anything else is the main library', () => {
    assert.equal(cleanLibraryId('work_2-a'), 'work_2-a');
    assert.equal(cleanLibraryId('../x'), 'main');
    assert.equal(cleanLibraryId(''), 'main');
    assert.equal(cleanLibraryId(7), 'main');
});

test('paths come from the backend rows, in the order of the ids', async () => {
    const rows = { 1: 'C:\\pics\\a.png', 2: 'C:\\pics\\b.png', 3: 'C:\\pics\\c.png' };
    const asked = [];
    const paths = await resolveImagePaths([3, 1, 99, 2, 3], async (chunk) => {
        asked.push(chunk);
        return chunk.filter((id) => rows[id]).map((id) => ({ id, path: rows[id] }));
    });
    assert.deepEqual(paths, [rows[3], rows[1], rows[2]]);
    assert.deepEqual(asked, [[3, 1, 99, 2]]);
});

test('a page cannot slip a path in: non-ids are never sent and unasked rows are ignored', async () => {
    const asked = [];
    const paths = await resolveImagePaths(['C:\\Windows\\win.ini', 5], async (chunk) => {
        asked.push(chunk);
        return [{ id: 5, path: 'C:\\pics\\five.png' }, { id: 6, path: 'C:\\other.png' }, { id: 5.5, path: 'x' }];
    });
    assert.deepEqual(asked, [[5]]);
    assert.deepEqual(paths, ['C:\\pics\\five.png']);
    assert.deepEqual(await resolveImagePaths([], async () => assert.fail('no request for no ids')), []);
});

test('many ids are asked for in backend-sized chunks', async () => {
    const ids = Array.from({ length: BY_IDS_CHUNK + 5 }, (_, index) => index + 1);
    const sizes = [];
    const paths = await resolveImagePaths(ids, async (chunk) => {
        sizes.push(chunk.length);
        return chunk.map((id) => ({ id, path: `/p/${id}.png` }));
    });
    assert.deepEqual(sizes, [BY_IDS_CHUNK, 5]);
    assert.equal(paths.length, ids.length);
});

test('only the bundled status page counts as the start-up page', () => {
    const page = path.resolve('/app/src/pages/status.html');
    const url = pathToFileURL(page).href;
    assert.equal(isStatusPageUrl(url, page, 'linux'), true);
    assert.equal(isStatusPageUrl(`${url}?title=Starting&actions=1`, page, 'linux'), true);
    assert.equal(isStatusPageUrl(pathToFileURL(path.resolve('/app/src/pages/status.js')).href, page, 'linux'), false);
    assert.equal(isStatusPageUrl(pathToFileURL(path.resolve('/home/me/evil.html')).href, page, 'linux'), false);
    assert.equal(isStatusPageUrl('file://server/share/status.html', page, 'linux'), false);
    assert.equal(isStatusPageUrl('http://127.0.0.1:8487/status.html', page, 'linux'), false);
    assert.equal(isStatusPageUrl('not a url', page, 'linux'), false);
    assert.equal(isStatusPageUrl(pathToFileURL(page.toUpperCase()).href, page, 'win32'), true);
});
