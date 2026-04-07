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
    var resp = await fetch('/api/browse-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path || '' })
    });
    if (!resp.ok) {
        var errData = await resp.json().catch(function() { return {}; });
        throw new Error(errData.detail || 'Failed to browse folder');
    }
    return resp.json();
}

/** Currently active folder browser state (null when closed). */
var _folderBrowserState = null;

/**
 * Show the folder browser panel below the given input element.
 * @param {HTMLInputElement} inputElement - The path input to fill when a folder is selected
 */
async function showFolderBrowser(inputElement) {
    var container = document.getElementById('folder-browser-container');
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
    var container = document.getElementById('folder-browser-container');
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
        var data = await fetchFolderContents(path);
        _folderBrowserState.currentPath = data.current;
        _folderBrowserState.selectedPath = data.current;
        var parentDisabled = data.parent == null ? ' disabled' : '';
        var currentDisplay = data.current || 'Computer';
        var listHtml = '';
        if (data.subdirs.length === 0) {
            listHtml = '<div class="folder-browser-empty">No subfolders found</div>';
        } else {
            listHtml = data.subdirs.map(function(dir) {
                var arrow = dir.has_children ? '<span class="folder-browser-item-arrow">&#9654;</span>' : '';
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
        var cancelBtn = container.querySelector('#folder-browser-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', hideFolderBrowser);
    }
}

/**
 * Attach click handlers to folder browser elements.
 * @param {HTMLElement} container - The browser container
 * @param {Object} data - The browse-folder API response
 */
function _attachFolderBrowserEvents(container, data) {
    var upBtn = container.querySelector('#folder-browser-up');
    if (upBtn && data.parent != null) {
        upBtn.addEventListener('click', function() {
            _renderFolderBrowser(container, data.parent);
        });
    }
    var cancelBtn = container.querySelector('#folder-browser-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', hideFolderBrowser);
    var selectBtn = container.querySelector('#folder-browser-select');
    if (selectBtn) {
        selectBtn.addEventListener('click', function() {
            if (_folderBrowserState && _folderBrowserState.inputElement) {
                var pathToSet = _folderBrowserState.selectedPath || _folderBrowserState.currentPath || '';
                _folderBrowserState.inputElement.value = pathToSet;
                _folderBrowserState.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            }
            hideFolderBrowser();
        });
    }
    var items = container.querySelectorAll('.folder-browser-item');
    items.forEach(function(item) {
        item.addEventListener('click', function() {
            var itemPath = item.getAttribute('data-path');
            var hasChildren = item.getAttribute('data-has-children') === 'true';
            items.forEach(function(it) { it.classList.remove('selected'); });
            item.classList.add('selected');
            if (_folderBrowserState) _folderBrowserState.selectedPath = itemPath;
            if (hasChildren) _renderFolderBrowser(container, itemPath);
        });
        item.addEventListener('dblclick', function() {
            var itemPath = item.getAttribute('data-path');
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
        var resp = await fetch('/api/system-info');
        if (!resp.ok) return;
        var data = await resp.json();
        var panel = document.getElementById('system-info-panel');
        var contentEl = document.getElementById('system-info-content');
        if (!panel || !contentEl) return;
        var sys = data.system_info || {};
        var rec = data.recommendation || {};
        var parts = [];
        if (sys.gpu_name) { parts.push(escapeHtml(sys.gpu_name)); }
        else { parts.push('CPU only'); }
        if (sys.total_ram_gb) { parts.push(sys.total_ram_gb.toFixed(0) + 'GB RAM'); }
        if (sys.gpu_vram_total_mb) { parts.push((sys.gpu_vram_total_mb / 1024).toFixed(1) + 'GB VRAM'); }
        if (rec.recommended_batch_size) { parts.push('Recommended batch: ' + rec.recommended_batch_size); }
        contentEl.innerHTML = '<small class="system-info-line">' + parts.join(' &middot; ') + '</small>';
        panel.style.display = '';
    } catch (e) {
        // Silent fail - system info is optional
    }
}


// ============== Init on DOMContentLoaded ==============

document.addEventListener('DOMContentLoaded', function() {
    // Browse folder button
    var btnBrowse = document.getElementById('btn-browse-folder');
    if (btnBrowse) {
        btnBrowse.addEventListener('click', function() {
            var pathInput = document.getElementById('scan-folder-path');
            if (pathInput) showFolderBrowser(pathInput);
        });
    }
});

