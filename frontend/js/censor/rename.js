/**
 * Censor Editor - batch rename (split VERBATIM from censor-edit.js; god-file decomposition).
 * Rename pattern resolution, live preview, batch apply, single rename prompt.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
// ============== Batch Actions ==============

function resolveRenamePattern(pattern, vars) {
    return pattern.replace(/\{(\w+)(?::(\d+)d)?\}/g, function(match, key, pad) {
        var value = vars[key];
        if (value === undefined) return match;
        if (pad && typeof value === 'number') {
            return String(value).padStart(parseInt(pad, 10), '0');
        }
        if (key === 'n' && typeof value === 'number') {
            return String(value).padStart(3, '0');
        }
        return String(value);
    });
}

function getRenameTargetItems() {
    const onlySelected = document.getElementById('rename-only-selected')?.checked || false;
    const selectedIds = getOrderedSelectedQueueIds();
    if (onlySelected && selectedIds.length) {
        const selectedSet = new Set(selectedIds);
        return CensorState.queue.filter(item => selectedSet.has(item.id));
    }
    return CensorState.queue.slice();
}

function buildRenameFilename(item, index, options = {}) {
    const useOriginal = Boolean(options.useOriginal);
    const base = options.base || 'Image';
    const start = Number(options.start || 1);
    const pattern = String(options.pattern || '').trim();
    const dateStr = options.dateStr || '';
    const timeStr = options.timeStr || '';

    if (useOriginal) {
        const originalName = item?.originalFilename || item?.filename || `image_${index + 1}`;
        const baseName = originalName.replace(/\.[^/.]+$/, '');
        return `${baseName}.png`;
    }

    if (pattern) {
        const originalName = item
            ? (item.originalFilename || item.filename || `image_${index + 1}`).replace(/\.[^/.]+$/, '')
            : `image_${index + 1}`;
        var resolved = resolveRenamePattern(pattern, {
            original: originalName,
            n: start + index,
            date: dateStr,
            time: timeStr
        });
        return resolved + '.png';
    }

    const num = String(start + index).padStart(3, '0');
    return `${base}_${num}.png`;
}

function refreshRenameSelectionUi() {
    const checkbox = document.getElementById('rename-only-selected');
    const help = document.getElementById('rename-selection-help');
    if (!checkbox || !help) return;

    const selectedCount = getOrderedSelectedQueueIds().length;
    checkbox.disabled = selectedCount === 0;
    if (selectedCount === 0) {
        checkbox.checked = false;
        help.textContent = censorT('censor.renameWholeQueueHelp', null, 'Nothing is selected right now, so the whole queue will be renamed.');
        return;
    }

    help.textContent = checkbox.checked
        ? censorT('censor.renameSelectedOnlyHelp', { count: selectedCount }, 'Only the {count} selected queue item(s) will be renamed. The rest stay untouched.')
        : censorT('censor.renameWholeQueueSelectedHelp', { count: selectedCount }, 'You have {count} selected item(s), but this preview is still targeting the whole queue.');
}

function updateRenamePreview() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    const patternEl = document.getElementById('rename-pattern');
    const pattern = patternEl ? patternEl.value.trim() : '';
    const previewSummary = document.getElementById('rename-preview-summary');
    const previewList = document.getElementById('rename-preview-list');
    const previewAlert = document.getElementById('rename-preview-alert');
    const escape = window.escapeHtml;
    if (!escape) { console.error('escapeHtml not available'); return; }

    if (!previewSummary || !previewList || !previewAlert) return;

    var now = new Date();
    var dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    var timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');

    const targets = getRenameTargetItems();
    const previewItems = targets.length ? targets : CensorState.queue.slice(0, 1);
    const rows = previewItems.map((item, index) => ({
        item,
        currentName: item?.outputFilename || item?.originalFilename || item?.filename || `image_${index + 1}.png`,
        newName: buildRenameFilename(item, index, {
            useOriginal,
            base,
            start,
            pattern,
            dateStr,
            timeStr
        })
    }));

    const duplicateMap = rows.reduce((acc, row) => {
        const key = row.newName.toLowerCase();
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
    }, new Map());
    const duplicateCount = Array.from(duplicateMap.values()).filter(count => count > 1).length;

    const rowHtml = rows.map((row) => {
        const isDuplicate = (duplicateMap.get(row.newName.toLowerCase()) || 0) > 1;
        return `
            <div class="rename-preview-row${isDuplicate ? ' is-duplicate' : ''}">
                <span>${escape(row.currentName)}</span>
                <span>${escape(row.newName)}</span>
            </div>
        `;
    }).join('');

    previewList.innerHTML = `
        <div class="rename-preview-row rename-preview-row-head">
            <span>${escape(censorT('censor.renameCurrentColumn', null, 'Current'))}</span>
            <span>${escape(censorT('censor.renameNewColumn', null, 'New name'))}</span>
        </div>
        ${rowHtml || `
            <div class="rename-preview-row">
                <span>${escape(censorT('censor.renameNoQueueItems', null, 'No queue items yet'))}</span>
                <span>${escape(censorT('censor.renamePreviewPlaceholder', null, 'Preview will appear here'))}</span>
            </div>
        `}
    `;

    const selectedCount = getOrderedSelectedQueueIds().length;
    const previewScope = document.getElementById('rename-only-selected')?.checked && selectedCount > 0
        ? censorT('censor.renamePreviewSelected', { count: targets.length }, 'Previewing {count} selected item(s).')
        : censorT('censor.renamePreviewQueue', { count: targets.length }, 'Previewing {count} queue item(s).');
    const extensionNote = censorT('censor.renameExtensionNote', null, ' Final export extension still follows Save Options.');
    previewSummary.textContent = `${previewScope}${extensionNote}`;

    if (duplicateCount > 0) {
        previewAlert.className = 'rename-preview-alert is-warning';
        previewAlert.textContent = censorT(
            'censor.renameDuplicateNamesPreview',
            { count: duplicateCount },
            'Duplicate output names detected in this preview ({count} conflict group(s)). Fix the pattern before applying.'
        );
    } else {
        previewAlert.className = 'rename-preview-alert';
        previewAlert.textContent = '';
    }
}

async function applyBatchRename() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    const patternEl = document.getElementById('rename-pattern');
    const pattern = patternEl ? patternEl.value.trim() : '';
    const targets = getRenameTargetItems();

    if (!targets.length) {
        window.App.showToast(censorT('censor.renameNoTargets', null, 'No queue items to rename'), 'error');
        return;
    }

    var now = new Date();
    var dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    var timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');
    const plannedNames = targets.map((item, index) => buildRenameFilename(item, index, {
        useOriginal,
        base,
        start,
        pattern,
        dateStr,
        timeStr
    }));
    const duplicateNames = plannedNames.filter((name, index) => {
        const lower = name.toLowerCase();
        return plannedNames.findIndex(candidate => candidate.toLowerCase() === lower) !== index;
    });
    if (duplicateNames.length > 0) {
        window.App.showToast(
            censorT('censor.renameDuplicateNamesBlocked', null, 'Rename blocked because the preview still contains duplicate output names.'),
            'error'
        );
        return;
    }

    targets.forEach((item, index) => {
        item.outputFilename = plannedNames[index];
    });

    renderQueue();
    closeCensorModal('rename-modal');

    // Refresh current title if viewing
    if (CensorState.activeId) {
        const item = CensorState.queue.find(i => i.id === CensorState.activeId);
        if (item) document.getElementById('censor-filename').textContent = item.outputFilename;
    }

    window.App.showToast(
        censorT('censor.renamedCount', { count: targets.length }, 'Renamed {count} image(s)'),
        'success'
    );
}

async function promptSingleRename() {
    if (!CensorState.activeId) {
        window.App.showToast(censorT('censor.noImageSelected', null, 'No image selected'), 'error');
        return;
    }

    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (!item) return;

    const currentName = item.outputFilename || item.filename || 'image.png';
    const newName = await window.App.showInputModal(
        censorT('censor.renameDialogTitle', null, 'Rename File'),
        censorT('censor.renameDialogMessage', null, 'Enter the new filename:'),
        currentName
    );

    if (newName !== null && newName !== currentName) {
        // Ensure it has an extension
        let finalName = newName;
        if (!/\.\w+$/.test(finalName)) {
            finalName += '.png';
        }

        item.outputFilename = finalName;
        document.getElementById('censor-filename').textContent = finalName;
        renderQueue();
        window.App.showToast(
            censorT('censor.renamedTo', {
                name: finalName,
            }, 'Renamed to "{name}"'),
            'success'
        );
    }
}

