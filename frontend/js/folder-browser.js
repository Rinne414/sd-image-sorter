/**
 * Folder Browser Widget + System Info Display
 * Provides a folder tree picker for the scan modal
 * and system hardware info display for the tag modal.
 */

// ============== Folder Browser ==============

/**
 * Fetch folder contents from the backend browse-folder API.
 * @param {string} path - Folder path to browse (empty string for root/drives)
 * @returns {Promise<{current: string, parent: string|null, subdirs: Array}>}
 */
async function fetchFolderContents(path) {
    const resp = await fetch('/api/browse-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path || '' })
    });
    if (!resp.ok) {
        const errData = await resp.json().catch(function() { return {}; });
        throw new Error(errData.detail || 'Failed to browse folder');
    }
    return resp.json();
}

/** Currently active folder browser state (null when closed). */
let _folderBrowserState = null;

/**
 * Show the folder browser panel below the given input element.
 * @param {HTMLInputElement} inputElement - The path input to fill when a folder is selected
 */
async function showFolderBrowser(inputElement) {
    const container = document.getElementById('folder-browser-container');
    if (!container) return;
    if (_folderBrowserState) { hideFolderBrowser(); return; }
    _folderBrowserState = {
        inputElement: inputElement,
        currentPath: inputElement.value.trim() || '',
        selectedPath: null
    };
    await _renderFolderBrowser(container, _folderBrowserState.currentPath);
}

/** Hide and destroy the folder browser panel. */
function hideFolderBrowser() {
    const container = document.getElementById('folder-browser-container');
    if (container) container.innerHTML = '';
    _folderBrowserState = null;
}

/**
 * Render the folder browser panel contents.
 * @param {HTMLElement} container - The container element
 * @param {string} path - Path to browse
 */
async function _renderFolderBrowser(container, path) {
    container.innerHTML = '<div class="folder-browser"><div class="folder-browser-loading">Loading folders...</div></div>';
    try {
        const data = await fetchFolderContents(path);
        _folderBrowserState.currentPath = data.current;
        _folderBrowserState.selectedPath = data.current;
        const parentDisabled = data.parent == null ? ' disabled' : '';
        const currentDisplay = data.current || 'Computer';
        let listHtml = '';
        if (data.subdirs.length === 0) {
            listHtml = '<div class="folder-browser-empty">No subfolders found</div>';
        } else {
            listHtml = data.subdirs.map(function(dir) {
                const arrow = dir.has_children ? '<span class="folder-browser-item-arrow">&#9654;</span>' : '';
                return '<div class="folder-browser-item" data-path="' + escapeHtml(dir.path) + '" data-has-children="' + dir.has_children + '">' +
                    '<span class="folder-browser-item-icon">&#128193;</span>' +
                    '<span class="folder-browser-item-name">' + escapeHtml(dir.name) + '</span>' +
                    arrow + '</div>';
            }).join('');
        }
        container.innerHTML = '<div class="folder-browser">' +
            '<div class="folder-browser-header">' +
            '<button type="button" class="folder-browser-btn" id="folder-browser-up"' + parentDisabled +
            ' title="Go to parent folder" aria-label="Go to parent folder">&uarr; Up</button>' +
            '<span class="folder-browser-path" title="' + escapeHtml(currentDisplay) + '">' + escapeHtml(currentDisplay) + '</span></div>' +
            '<div class="folder-browser-list">' + listHtml + '</div>' +
            '<div class="folder-browser-footer">' +
            '<button type="button" class="folder-browser-btn" id="folder-browser-cancel">Cancel</button>' +
            '<button type="button" class="folder-browser-btn" id="folder-browser-select" style="background:rgba(255,138,61,0.2);color:var(--accent-primary);">Select This Folder</button>' +
            '</div></div>';
        _attachFolderBrowserEvents(container, data);
    } catch (err) {
        if (path) {
            try { await _renderFolderBrowser(container, ''); return; }
            catch (rootErr) { /* fall through */ }
        }
        container.innerHTML = '<div class="folder-browser">' +
            '<div class="folder-browser-error">Error: ' + escapeHtml(err.message) + '</div>' +
            '<div class="folder-browser-footer">' +
            '<button type="button" class="folder-browser-btn" id="folder-browser-cancel">Close</button></div></div>';
        const cancelBtn = container.querySelector('#folder-browser-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', hideFolderBrowser);
    }
}

/**
 * Attach click handlers to folder browser elements.
 * @param {HTMLElement} container - The browser container
 * @param {Object} data - The browse-folder API response
 */
function _attachFolderBrowserEvents(container, data) {
    const upBtn = container.querySelector('#folder-browser-up');
    if (upBtn && data.parent != null) {
        upBtn.addEventListener('click', function() {
            _renderFolderBrowser(container, data.parent);
        });
    }
    const cancelBtn = container.querySelector('#folder-browser-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', hideFolderBrowser);
    const selectBtn = container.querySelector('#folder-browser-select');
    if (selectBtn) {
        selectBtn.addEventListener('click', function() {
            if (_folderBrowserState && _folderBrowserState.inputElement) {
                const pathToSet = _folderBrowserState.selectedPath || _folderBrowserState.currentPath || '';
                _folderBrowserState.inputElement.value = pathToSet;
                _folderBrowserState.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            }
            hideFolderBrowser();
        });
    }
    const items = container.querySelectorAll('.folder-browser-item');
    items.forEach(function(item) {
        item.addEventListener('click', function() {
            const itemPath = item.getAttribute('data-path');
            const hasChildren = item.getAttribute('data-has-children') === 'true';
            items.forEach(function(it) { it.classList.remove('selected'); });
            item.classList.add('selected');
            if (_folderBrowserState) _folderBrowserState.selectedPath = itemPath;
            if (hasChildren) _renderFolderBrowser(container, itemPath);
        });
        item.addEventListener('dblclick', function() {
            const itemPath = item.getAttribute('data-path');
            if (_folderBrowserState && _folderBrowserState.inputElement) {
                _folderBrowserState.inputElement.value = itemPath;
                _folderBrowserState.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            }
            hideFolderBrowser();
        });
    });
}


// ============== System Info ==============

/**
 * Load system hardware info and display it in the tagger modal.
 * Called when the tag-modal is opened. Fails silently (info is optional).
 */
async function loadSystemInfo() {
    try {
        const resp = await fetch('/api/system-info');
        if (!resp.ok) return;
        const data = await resp.json();
        window.__taggerSystemInfo = data;
        const panel = document.getElementById('system-info-panel');
        const contentEl = document.getElementById('system-info-content');
        const hardwareChip = document.getElementById('tag-hardware-chip');
        const riskChip = document.getElementById('tag-risk-chip');
        const providerChip = document.getElementById('tag-provider-chip');
        const recEl = document.getElementById('tag-system-recommendation');
        const batchEl = document.getElementById('tag-batch-recommendation');
        if (!panel || !contentEl) return;
        const sys = data.system_info || {};
        const rec = data.recommendation || {};
        const providers = Array.isArray(sys.onnx_providers) ? sys.onnx_providers.map(String) : [];
        const hasCuda = providers.indexOf('CUDAExecutionProvider') !== -1;
        const hasTensorRt = providers.indexOf('TensorrtExecutionProvider') !== -1;
        const parts = [];
        if (sys.gpu_name) { parts.push(String(sys.gpu_name)); }
        else { parts.push('CPU only'); }
        if (sys.total_ram_gb) { parts.push(sys.total_ram_gb.toFixed(0) + 'GB RAM'); }
        if (sys.gpu_vram_total_mb) { parts.push((sys.gpu_vram_total_mb / 1024).toFixed(1) + 'GB VRAM'); }
        contentEl.textContent = parts.join(' · ') || 'Hardware detection is available for this machine.';
        panel.style.display = '';

        if (hardwareChip) {
            hardwareChip.textContent = rec.recommended_use_gpu ? 'GPU available' : 'CPU safe';
            hardwareChip.className = 'system-info-chip ' + (rec.recommended_use_gpu ? 'is-safe' : 'is-warning');
        }

        if (riskChip) {
            const riskLevel = String(rec.risk_level || 'medium').toLowerCase();
            const riskClass = riskLevel === 'high'
                ? 'is-danger'
                : (riskLevel === 'medium' ? 'is-warning' : 'is-safe');
            riskChip.textContent = 'Risk: ' + riskLevel;
            riskChip.className = 'system-info-chip ' + riskClass;
        }

        if (providerChip) {
            providerChip.textContent = hasCuda
                ? (hasTensorRt ? 'TensorRT + CUDA ready' : 'CUDA ready')
                : 'CPU runtime';
            providerChip.className = 'system-info-chip ' + (hasCuda ? 'is-safe' : 'is-warning');
        }

        if (recEl) {
            recEl.textContent = rec.message || 'The app will use the recommended runtime for your hardware.';
        }

        if (batchEl) {
            const recommendedChunk = rec.recommended_batch_size || 4;
            batchEl.textContent = 'Recommended runtime chunk size: ' + recommendedChunk + '. The backend now uses real WD14 multi-image batching when the model supports it.';
        }

        // Set recommended runtime chunk size in the advanced dropdown
        const batchSelect = document.getElementById('tagger-batch-size');
        if (batchSelect && rec.recommended_batch_size && batchSelect.dataset.userChosen !== '1') {
            batchSelect.value = String(rec.recommended_batch_size);
        }

        if (typeof syncTaggerModelUi === 'function') {
            syncTaggerModelUi({ applyModelDefaults: true });
        }
    } catch (e) {
        // Silent fail - system info is optional
    }
}


// ============== Init on DOMContentLoaded ==============

document.addEventListener('DOMContentLoaded', function() {
    // Browse folder button
    const btnBrowse = document.getElementById('btn-browse-folder');
    if (btnBrowse) {
        btnBrowse.addEventListener('click', function() {
            const pathInput = document.getElementById('scan-folder-path');
            if (pathInput) showFolderBrowser(pathInput);
        });
    }
});

