/**
 * app/stats-aesthetic.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 5795-6083 (of 10,152): loadStats + aesthetic scoring status/poll/start.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
// ============== Stats ==============

async function loadStats() {
    try {
        const stats = await API.getStats();

        // Update generator counts in tabs
        let totalCount = 0;
        const genCounts = {};
        stats.generators.forEach(gen => {
            genCounts[gen.generator] = gen.count;
            totalCount += gen.count;

            // Legacy checkbox count update
            const countEl = $(`.checkbox-count[data-generator="${gen.generator}"]`);
            if (countEl) {
                countEl.textContent = gen.count;
            }
        });

        const metadataPending = Number(stats.metadata_pending || stats.metadata_status?.pending || stats.metadata_status_counts?.pending || 0);
        const scanStatus = String(stats.scan_status || '').toLowerCase();
        const scanRunning = scanStatus === 'running' || scanStatus === 'cancelling';
        const scanLibraryReady = stats.scan_library_ready === true;
        const countsResolving = metadataPending > 0 || (scanRunning && !scanLibraryReady);
        const reportedTotal = Number.isFinite(Number(stats.total_images))
            ? Number(stats.total_images)
            : totalCount;

        // Update generator tab counts
        const countAll = $('#count-all');
        if (countAll) countAll.textContent = reportedTotal;

        ['nai', 'comfyui', 'forge', 'webui', 'unknown'].forEach(gen => {
            const countEl = $(`#count-${gen}`);
            if (countEl) {
                const count = genCounts[gen] || 0;
                countEl.textContent = countsResolving && count === 0 ? '…' : String(count);
                countEl.title = countsResolving
                    ? appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.')
                    : '';
            }
        });

        // The "Others" tab bundles every uncommon generator (Fooocus,
        // reForge, Gemini, gpt-image, ...) — its count must reflect the
        // sum so the badge matches the gallery once the user clicks it.
        const othersCount = OTHERS_GENERATOR_BUNDLE.reduce(
            (sum, gen) => sum + (genCounts[gen] || 0),
            0
        );
        const countOthersEl = $('#count-others');
        const othersTab = $('.gen-tab[data-gen="others"]');
        const activeOtherGenerators = OTHERS_GENERATOR_BUNDLE
            .filter((gen) => (genCounts[gen] || 0) > 0)
            .map((gen) => `${formatGeneratorLabel(gen)} (${genCounts[gen]})`);
        const othersHint = activeOtherGenerators.length > 0
            ? appT('generator.othersActiveHint', 'Grouped generators: {generators}', {
                generators: activeOtherGenerators.join(', '),
            }).replace('{generators}', activeOtherGenerators.join(', '))
            : appT('generator.othersHint', 'Groups uncommon generators');
        if (countOthersEl) {
            countOthersEl.textContent = countsResolving && othersCount === 0 ? '…' : String(othersCount);
            countOthersEl.title = countsResolving
                ? appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.')
                : othersHint;
        }
        if (othersTab) othersTab.title = othersHint;
        syncGeneratorRailOverflow();

        const metadataChip = $('#metadata-status-chip');
        if (metadataChip) {
            if (countsResolving) {
                metadataChip.textContent = metadataPending > 0
                    ? appT('gallery.metadataResolving', 'Reading image info: {count} pending')
                        .replace('{count}', String(metadataPending))
                    : appT('gallery.scanResolving', 'Scanning library: generator counts are not final yet');
                metadataChip.title = appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.');
                metadataChip.style.display = 'inline-flex';
            } else {
                metadataChip.textContent = '';
                metadataChip.title = '';
                metadataChip.style.display = 'none';
            }
        }

        // Populate version badge
        if (stats.app_version) {
            const vBadge = document.getElementById('brand-version');
            if (vBadge) vBadge.textContent = 'v' + stats.app_version;
            AppState.appVersion = stats.app_version;
            AppState.githubUrl = stats.github_url || '';
        }

        // Store analytics for later use
        AppState.analytics = {
            checkpoints: stats.checkpoints || [],
            loras: stats.loras || [],
            top_tags: stats.top_tags || [],
            generatorCounts: genCounts,
            totalImages: reportedTotal,
            metadataPending,
            metadataStatus: stats.metadata_status || stats.metadata_status_counts || {},
            countsResolving,
            scanStatus,
            scanLibraryReady
        };

        // Update model filters summary UI
        updateModelSelectionSummaries();

    } catch (error) {
        Logger.error('Failed to load stats:', error);
    }
}

let _aestheticStatus = { available: false, message: '' };
let _aestheticProgressTimer = null;

function clearAestheticProgressTimer() {
    if (_aestheticProgressTimer) {
        clearTimeout(_aestheticProgressTimer);
        _aestheticProgressTimer = null;
    }
}

function updateAestheticUi({ running = false, completed = 0, total = 0 } = {}) {
    const button = $('#btn-score-aesthetic');
    const cancelBtn = $('#btn-cancel-aesthetic');
    const chip = $('#aesthetic-status-chip');
    if (!button) return;

    const t = (key, fallback, params) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };

    if (cancelBtn) cancelBtn.style.display = running ? '' : 'none';

    if (!_aestheticStatus.available) {
        button.disabled = true;
        button.title = _aestheticStatus.message || t('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable');
        button.setAttribute('aria-label', button.title);
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (chip) {
            chip.style.display = 'inline-flex';
            chip.className = 'tagger-aesthetic-status is-warning';
            chip.textContent = t('gallery.aestheticUnavailableShort', 'Aesthetic unavailable');
            chip.title = button.title;
        }
        return;
    }

    button.disabled = running;
    button.title = running
        ? t('gallery.aestheticRunning', 'Scoring aesthetics...')
        : t('gallery.scoreAesthetic', 'Score Aesthetic');
    button.setAttribute('aria-label', button.title);

    if (running && chip) {
        chip.style.display = 'inline-flex';
        chip.className = 'tagger-aesthetic-status is-info';
        chip.textContent = t('gallery.aestheticProgress', '{completed}/{total} scored', {
            completed,
            total: Math.max(total, completed),
        });
        chip.title = chip.textContent;
    } else if (chip) {
        chip.style.display = 'inline-flex';
        chip.className = 'tagger-aesthetic-status is-safe';
        chip.textContent = t('gallery.aestheticReady', 'Aesthetic ready');
        chip.title = chip.textContent;
    }
}

async function refreshAestheticStatus() {
    try {
        const status = await API.getAestheticStatus();
        _aestheticStatus = {
            available: Boolean(status?.available),
            message: status?.message || '',
            scored_count: Number(status?.scored_count || 0),
        };
    } catch (error) {
        _aestheticStatus = {
            available: false,
            message: formatUserError(error, appT('gallery.aestheticStatusFailed', 'Could not check aesthetic scoring status')),
            scored_count: 0,
        };
    }

    updateAestheticUi();

    // Update sort dropdown option availability
    const sortDropdown = $('#gallery-sort');
    if (sortDropdown) {
        const aestheticOption = sortDropdown.querySelector('option[value="aesthetic"]');
        if (aestheticOption) {
            if (!_aestheticStatus.available && _aestheticStatus.scored_count === 0) {
                aestheticOption.disabled = true;
                aestheticOption.textContent = appT('sort.aestheticDisabled', 'Aesthetic Score (unavailable)');
            } else if (_aestheticStatus.scored_count === 0) {
                aestheticOption.disabled = false;
                aestheticOption.textContent = appT('sort.aestheticNoScores', 'Aesthetic Score (no scores yet - score from AI Tag)');
            } else {
                aestheticOption.disabled = false;
                aestheticOption.textContent = appT('sort.aesthetic', 'Aesthetic Score') +
                    ` (${_aestheticStatus.scored_count} scored)`;
            }
        }
    }
}

async function pollAestheticProgress() {
    clearAestheticProgressTimer();
    try {
        const progress = await API.getAestheticProgress();
        const running = Boolean(progress?.running);
        const completed = Number(progress?.completed || 0);
        const total = Number(progress?.total || 0);

        updateAestheticUi({ running, completed, total });

        if (running) {
            _aestheticProgressTimer = setTimeout(pollAestheticProgress, 1200);
            return;
        }

        // The backend writes progress.error when the whole batch crashed
        // (model load / CUDA failure). Surface that instead of the success
        // toast the run would otherwise fake.
        const batchError = String(progress?.error || '').trim();
        if (batchError) {
            showToast(
                appT('gallery.aestheticFailed', 'Aesthetic scoring failed: {error}').replace('{error}', batchError),
                'error'
            );
            if (completed > 0) {
                // Partial scores may have landed before the crash.
                await loadImages();
                await loadStats();
            }
            return;
        }

        if (total > 0) {
            const errors = Number(progress?.errors || 0);
            showToast(
                errors > 0
                    ? appT('gallery.aestheticCompletedWarn', 'Aesthetic scoring finished with {errors} errors.').replace('{errors}', errors)
                    : appT('gallery.aestheticCompleted', 'Aesthetic scoring completed.'),
                errors > 0 ? 'warning' : 'success'
            );
            await loadImages();
            await loadStats();
        }
    } catch (error) {
        updateAestheticUi({ running: false });
        showToast(formatUserError(error, appT('gallery.aestheticProgressFailed', 'Failed to read aesthetic progress')), 'error');
    }
}

async function startAestheticScoring(force = false) {
    if (!_aestheticStatus.available) {
        showToast(_aestheticStatus.message || appT('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable'), 'warning');
        return;
    }

    try {
        const result = await API.startAestheticScoring(force);
        const status = String(result?.status || 'started');
        const total = Number(result?.total || 0);
        if (status === 'started' && total === 0) {
            updateAestheticUi({ running: false, completed: 0, total: 0 });
            showToast(appT('gallery.aestheticNothingToScore', 'All current images already have aesthetic scores.'), 'info');
            return;
        }
        if (status === 'started' || status === 'already_running') {
            updateAestheticUi({ running: true, completed: 0, total });
            if (status === 'started') {
                showToast(appT('gallery.aestheticStarted', 'Aesthetic scoring started in the background.'), 'info');
            }
            await pollAestheticProgress();
        }
    } catch (error) {
        showToast(formatUserError(error, appT('gallery.aestheticStartFailed', 'Failed to start aesthetic scoring')), 'error');
    }
}

