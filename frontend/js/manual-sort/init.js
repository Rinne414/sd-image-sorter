/**
 * manual-sort/init.js — manual-sort.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 1208-1502: initManualSortCooldownControls and initManualSort
 * (the whole setup-screen wiring: folder inputs, browse, operation radios,
 * filter modal, scope buttons, start/exit, mode switch, bracket + zoom, cull,
 * mute, zen, presets, resume/discard, languageChanged, server-session check).
 * Classic script: loads after manual-sort/state-constants.js (base); the
 * DOMContentLoaded registration that CALLS initManualSort lives in
 * manual-sort/boot-touch.js (loaded last), preserving the original exec order.
 */
// ============== Initialization ==============

// v3.3.0 USR-4: wire the opt-in action-cooldown controls and restore the
// persisted value. Default is OFF (0 ms) so existing users see no change.
function initManualSortCooldownControls($) {
    const toggle = $('#manual-sort-cooldown-toggle');
    const slider = $('#manual-sort-cooldown-ms');
    const valueLabel = $('#manual-sort-cooldown-value');
    const row = $('#manual-sort-cooldown-row');
    if (!toggle || !slider) return;

    const savedMs = Number(localStorage.getItem(MANUAL_SORT_COOLDOWN_KEY) || 0) || 0;
    const enabled = savedMs > 0;
    toggle.checked = enabled;
    if (enabled) slider.value = String(savedMs);
    if (row) row.style.display = enabled ? 'flex' : 'none';
    ManualSortState.actionCooldownMs = enabled ? Number(slider.value) || 0 : 0;
    if (valueLabel) valueLabel.textContent = `${slider.value} ms`;

    const persist = () => {
        const ms = toggle.checked ? (Number(slider.value) || 0) : 0;
        ManualSortState.actionCooldownMs = ms;
        localStorage.setItem(MANUAL_SORT_COOLDOWN_KEY, String(ms));
    };

    toggle.addEventListener('change', () => {
        if (row) row.style.display = toggle.checked ? 'flex' : 'none';
        persist();
    });
    slider.addEventListener('input', () => {
        if (valueLabel) valueLabel.textContent = `${slider.value} ms`;
        if (toggle.checked) persist();
    });
}

async function initManualSort() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    loadManualSortFilters();
    loadManualSortScopeMeta();
    loadManualSortSlotCollections();
    setManualSortOperationMode(localStorage.getItem(MANUAL_SORT_OPERATION_MODE_KEY) || 'copy', {
        persist: false,
        updateUi: true,
    });
    updateManualSortFilterSummary();
    initManualSortCooldownControls($);
    initManualSortSlotControls();
    // Populate the collection <select>s from the API (best-effort; folder slots
    // keep working even if this fails).
    loadManualSortCollections();

    // Folder path inputs
    $$('.folder-path-input').forEach(input => {
        const savedFolder = localStorage.getItem(`sort-folder-${input.dataset.key}`);
        if(savedFolder) {
            input.value = savedFolder;
            ManualSortState.folders[input.dataset.key] = savedFolder;
        }

        input.addEventListener('change', () => {
            ManualSortState.folders[input.dataset.key] = input.value;
            localStorage.setItem(`sort-folder-${input.dataset.key}`, input.value);
        });
    });

    // Browse folder buttons
    $$('.browse-folder').forEach(btn => {
        btn.addEventListener('click', async () => {
            // Find the input in the same folder-slot as this button
            const folderSlot = btn.closest('.folder-slot');
            const input = folderSlot?.querySelector('.folder-path-input');
            if (input) {
                const key = input.dataset.key?.toUpperCase() || '';
                const currentValue = input.value || '';
                const path = await window.App.showInputModal(
                    `Folder Path for ${key}`,
                    `Enter the destination folder path.\nExample: D:\\sorted\\folder-name`,
                    currentValue
                );
                if (path !== null) {
                    input.value = path;
                    ManualSortState.folders[input.dataset.key] = path;
                    localStorage.setItem(`sort-folder-${input.dataset.key}`, path);
                }
            }
        });
    });

    document.querySelectorAll('input[name="manual-sort-operation"]').forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) {
                setManualSortOperationMode(input.value);
            }
        });
    });

    // Edit Filters button - open unified filter modal
    const filterBtn = $('#btn-manual-sort-filters');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            if (window.App && window.App.openFilterModal) {
                window.App.openFilterModal({
                    mode: 'manual-sort',
                    titleText: manualSortText('manual.filterTitle', 'Manual Sort Filters', '手动排序筛选'),
                    applyButtonText: manualSortText('manual.applyFilters', 'Apply to Manual Sort', '应用到手动排序'),
                    resetButtonText: manualSortText('manual.resetFilters', 'Reset Manual Sort Filters', '重置手动排序筛选'),
                    filterState: getManualSortFilters(),
                    onApply: (filters) => {
                        setManualSortFilters(filters);
                        markManualSortScopeCustomized();
                        updateManualSortFilterSummary();
                    },
                    onReset: (filters) => {
                        setManualSortFilters(filters);
                        markManualSortScopeCustomized();
                        updateManualSortFilterSummary();
                    },
                });
            }
        });
    }

    $('#btn-manual-sort-use-gallery-scope')?.addEventListener('click', () => {
        syncManualSortFiltersFromGallery({ toastKey: 'scope.copiedToast' });
    });
    $('#btn-manual-sort-resync-scope')?.addEventListener('click', () => {
        syncManualSortFiltersFromGallery({ toastKey: 'scope.resyncedToast' });
    });
    $('#btn-manual-sort-keep-scope')?.addEventListener('click', keepManualSortSavedScope);

    // Start sorting button
    const startBtn = $('#btn-start-sorting');
    if (startBtn) {
        startBtn.addEventListener('click', startSorting);
    }

    // v3.3.2 WB-S3: Workbench mode switch + A/B Showdown (bracket) controls.
    bindManualSortModeSwitch();
    // Fighter-image clicks pick — unless sync-zoom is on, where a click should
    // inspect (the dedicated 选 A/选 B buttons + keyboard still pick).
    const championFighter = $('#bracket-champion');
    const challengerFighter = $('#bracket-challenger');
    championFighter?.addEventListener('click', () => { if (!ManualSortState.bracketZoom) performBracketAction('champion'); });
    challengerFighter?.addEventListener('click', () => { if (!ManualSortState.bracketZoom) performBracketAction('challenger'); });
    $('#bracket-btn-champion')?.addEventListener('click', () => performBracketAction('champion'));
    $('#bracket-btn-challenger')?.addEventListener('click', () => performBracketAction('challenger'));
    $('#bracket-btn-skip')?.addEventListener('click', () => performBracketAction('skip'));
    $('#bracket-btn-undo')?.addEventListener('click', () => performBracketAction('undo'));
    $('#bracket-btn-redo')?.addEventListener('click', () => performBracketAction('redo'));
    $('#bracket-btn-exit')?.addEventListener('click', exitSorting);

    // v3.3.2 WB-S6: remember the showdown winner destination.
    $('#bracket-winner-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_BRACKET_WINNER_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });

    // v3.3.2 WB-S5: synchronized pixel-peep zoom.
    $('#bracket-btn-zoom')?.addEventListener('click', () => setBracketZoomActive(!ManualSortState.bracketZoom));
    [championFighter, challengerFighter].forEach((fighter) => {
        if (!fighter) return;
        fighter.addEventListener('mousemove', handleBracketZoomMove);
        fighter.addEventListener('mouseleave', () => { if (ManualSortState.bracketZoom) applyBracketZoom(null, null); });
    });

    // v3.3.2 FF-1: 留/汰 Keep-Reject cull controls.
    $('#cull-btn-keep')?.addEventListener('click', () => performCullAction('keep'));
    $('#cull-btn-reject')?.addEventListener('click', () => performCullAction('reject'));
    $('#cull-btn-skip')?.addEventListener('click', () => performCullAction('skip'));
    $('#cull-btn-undo')?.addEventListener('click', () => performCullAction('undo'));
    $('#cull-btn-redo')?.addEventListener('click', () => performCullAction('redo'));
    $('#cull-btn-exit')?.addEventListener('click', exitSorting);
    $('#cull-keep-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_CULL_KEEP_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });
    $('#cull-reject-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_CULL_REJECT_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });

    // Exit sorting button
    const exitBtn = $('#btn-exit-sorting');
    if (exitBtn) {
        exitBtn.addEventListener('click', exitSorting);
    }

    // On-stage sound mute toggle — silences the sort SFX without leaving the
    // stage. Wires to the same AudioManager singleton + sort-audio-enabled key
    // as the global Settings toggle. syncSortMuteButton() is module-level so
    // activateSortingUi can re-sync it on stage entry (the global Settings
    // toggle mutates AudioManager without notifying this button).
    const muteBtn = $('#btn-sort-mute');
    if (muteBtn) {
        syncSortMuteButton();
        muteBtn.addEventListener('click', () => {
            if (window.AudioManager?.toggle) window.AudioManager.toggle();
            syncSortMuteButton();
        });
    }

    // Focus (zen) mode toggle — hides the top nav bar for the WASD stage.
    const zenBtn = $('#btn-sort-zen');
    if (zenBtn) {
        // Reflect the persisted preference on the button without touching the
        // class yet (the class only applies once a session is active).
        applyManualSortZen(getManualSortZenPref(), { persist: false });
        clearManualSortZen();
        zenBtn.addEventListener('click', () => {
            applyManualSortZen(!document.documentElement.classList.contains('sort-zen'));
        });
    }

    // Named full-config preset bar (save / load / delete).
    populateManualSortPresetSelect();
    $('#btn-sort-preset-save')?.addEventListener('click', handleManualSortPresetSave);
    $('#btn-sort-preset-load')?.addEventListener('click', handleManualSortPresetLoad);
    $('#btn-sort-preset-delete')?.addEventListener('click', handleManualSortPresetDelete);
    // Double-clicking a name in the list is a fast load.
    $('#sort-preset-select')?.addEventListener('dblclick', handleManualSortPresetLoad);

    // Resume session button
    const resumeBtn = $('#btn-resume-sorting');
    if (resumeBtn) {
        resumeBtn.addEventListener('click', () => resumeSavedSession());
    }

    // Discard saved session button
    const discardBtn = $('#btn-discard-session');
    if (discardBtn) {
        discardBtn.addEventListener('click', () => {
            window.App.showConfirm(
                manualSortText('manual.discardSessionTitle', 'Discard Saved Session', '丢弃已保存会话'),
                manualSortText(
                    'manual.discardSessionMessage',
                    'Delete the saved manual-sort session and lose the remaining progress? This cannot be undone.',
                    '要删除已保存的手动排序会话，并丢失剩余进度吗？此操作无法撤销。'
                ),
                async () => {
                    try {
                        await window.App.API.delete('/api/sort/session');
                        renderManualSortResumeBanner(null, { visible: false });
                        window.App.showToast(
                            manualSortText('manual.discardSessionSuccess', 'Saved session discarded', '已丢弃已保存会话'),
                            'success'
                        );
                    } catch (e) {
                        if (window.Logger) Logger.warn('Failed to discard session:', e);
                        window.App.showToast(
                            formatUserError(
                                e,
                                manualSortText('manual.discardSessionFailed', 'Failed to discard saved session', '丢弃已保存会话失败')
                            ),
                            'error'
                        );
                    }
                }
            );
        });
    }

    // Keyboard listener (added when sorting starts)

    // Update filter summary display initially
    setTimeout(() => {
        if (window.App && window.App.AppState) {
            updateManualSortFilterSummary();
        }
    }, 100);

    document.addEventListener('gallery-filters-changed', () => {
        updateManualSortScopeStatus();
        updateManualSortExecutionScopeSummary();
    });
    document.addEventListener('languageChanged', () => {
        updateManualSortFilterSummary();
        setManualSortOperationMode(ManualSortState.operationMode, { persist: false, updateUi: true });
        if (ManualSortState.resumeBannerSessionSnapshot) {
            renderManualSortResumeBanner(ManualSortState.resumeBannerSessionSnapshot, { visible: true });
        }
    });

    // Check for saved session on the server
    try {
        const session = await window.App.API.get('/api/sort/current').catch(e => {
            console.warn('Operation failed:', e);
            return null;
        });
        if (session && !session.done && (session.image || session.champion)) {
            renderManualSortResumeBanner(session, { visible: true });
        }
    } catch(e) {
        if (window.Logger) Logger.warn('Failed to check sort session:', e);
    }
}

