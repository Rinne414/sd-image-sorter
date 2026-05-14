(function () {
    'use strict';

    var state = {
        initialized: false,
        loading: false,
        loaded: false,
        data: null
    };

    var ISSUE_KEYS = [
        'unreadable',
        'metadata_error',
        'metadata_pending',
        'missing_prompt',
        'missing_checkpoint',
        'missing_dimensions',
        'unknown_generator',
        'untagged',
        'missing_embedding',
        'missing_aesthetic'
    ];

    function $(selector) {
        return document.querySelector(selector);
    }

    function t(key, fallback, params) {
        var translated = window.I18n && typeof window.I18n.t === 'function'
            ? window.I18n.t(key, params)
            : key;
        return translated && translated !== key ? translated : (fallback || key);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatNumber(value) {
        var number = Number(value || 0);
        return Number.isFinite(number) ? number.toLocaleString() : '0';
    }

    function formatPercent(value) {
        var number = Number(value || 0);
        if (!Number.isFinite(number)) return '0%';
        return number.toFixed(number % 1 === 0 ? 0 : 1) + '%';
    }

    function formatSize(bytes) {
        if (window.App && typeof window.App.formatSize === 'function') {
            return window.App.formatSize(Number(bytes || 0));
        }
        var size = Number(bytes || 0);
        if (size < 1024) return size + ' B';
        if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
        if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
        return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function setText(selector, value) {
        var element = $(selector);
        if (element) element.textContent = value;
    }

    function showEmpty(container, key, fallback) {
        if (!container) return;
        container.innerHTML = '<div class="health-empty">' + escapeHtml(t(key, fallback)) + '</div>';
    }

    function recommendationText(item) {
        var count = formatNumber(item && item.count);
        var key = item && item.kind;
        var fallbackMap = {
            metadata_pending: 'Wait for metadata import to finish before trusting generator counts.',
            reparse_or_reconnect: 'Re-parse or reconnect unreadable records before moving files.',
            missing_prompt: 'Re-import or inspect files with missing prompts before dataset export.',
            missing_checkpoint: 'Checkpoint gaps may weaken model-based filtering and archive folders.',
            untagged: 'Run AI tagging to unlock safer filtering, sorting, and search.',
            duplicate_filenames: 'Duplicate filenames are risky for cache, tag export, and flat archive folders.'
        };
        return t('health.recommendation.' + key, fallbackMap[key] || 'Review this library signal.', { count: count });
    }

    function issueLabel(key) {
        var fallbackMap = {
            unreadable: 'Unreadable / missing files',
            metadata_error: 'Metadata parse errors',
            metadata_pending: 'Metadata still pending',
            missing_prompt: 'Missing prompt',
            missing_checkpoint: 'Missing checkpoint',
            missing_dimensions: 'Missing dimensions',
            unknown_generator: 'Unknown generator',
            untagged: 'Not AI-tagged',
            missing_embedding: 'No similarity embedding',
            missing_aesthetic: 'No aesthetic score'
        };
        return t('health.issue.' + key, fallbackMap[key] || key);
    }

    function sampleReason(sample) {
        if (!sample) return '';
        if (sample.read_error) return sample.read_error;
        var status = String(sample.metadata_status || '').toLowerCase();
        if (status === 'error') return t('health.reason.metadataError', 'Metadata error');
        if (status === 'pending') return t('health.reason.metadataPending', 'Metadata pending');
        if (!sample.prompt || !String(sample.prompt).trim()) return t('health.reason.missingPrompt', 'Missing prompt');
        if (!sample.checkpoint_normalized || !String(sample.checkpoint_normalized).trim()) return t('health.reason.missingCheckpoint', 'Missing checkpoint');
        if (!sample.width || !sample.height) return t('health.reason.missingDimensions', 'Missing dimensions');
        if (!sample.tagged_at) return t('health.reason.untagged', 'Not tagged');
        return t('health.reason.review', 'Review');
    }

    function renderStatus(data) {
        var summary = data.summary || {};
        var score = Number(summary.quality_score || 0);
        var ring = $('#health-score-ring');
        if (ring) ring.style.setProperty('--score', String(Math.max(0, Math.min(100, score))));
        setText('#health-score-value', Number.isFinite(score) ? score.toFixed(0) : '—');

        var titleKey = 'health.statusGoodTitle';
        var detailKey = 'health.statusGoodDetail';
        if ((summary.total_images || 0) <= 0) {
            titleKey = 'health.statusEmptyTitle';
            detailKey = 'health.statusEmptyDetail';
        } else if (score < 60) {
            titleKey = 'health.statusRiskTitle';
            detailKey = 'health.statusRiskDetail';
        } else if (score < 82) {
            titleKey = 'health.statusWatchTitle';
            detailKey = 'health.statusWatchDetail';
        }
        setText('#health-status-title', t(titleKey));
        setText('#health-status-detail', t(detailKey));
    }

    function renderKpis(data) {
        var summary = data.summary || {};
        setText('#health-total-images', formatNumber(summary.total_images));
        setText('#health-metadata-ready', formatPercent(summary.metadata_ready_percent));
        setText('#health-tag-coverage', formatPercent(summary.tagged_percent));
        setText('#health-actionable', formatNumber(summary.actionable_count));
    }

    function renderIssues(data) {
        var list = $('#health-issue-list');
        if (!list) return;
        var counts = data.issue_counts || {};
        var rows = ISSUE_KEYS.map(function (key) {
            return { key: key, count: Number(counts[key] || 0) };
        }).filter(function (item) {
            return item.count > 0 || ['missing_embedding', 'missing_aesthetic'].indexOf(item.key) !== -1;
        });

        if (!rows.length) {
            showEmpty(list, 'health.noIssues', 'No quality issues found.');
            return;
        }

        var max = Math.max.apply(null, rows.map(function (item) { return item.count; }).concat([1]));
        list.innerHTML = rows.map(function (item) {
            var width = Math.max(4, Math.round((item.count / max) * 100));
            return '<div class="health-issue-row">'
                + '<div class="health-issue-meta"><span>' + escapeHtml(issueLabel(item.key)) + '</span><strong>' + formatNumber(item.count) + '</strong></div>'
                + '<div class="health-issue-bar"><span style="width:' + width + '%"></span></div>'
                + '</div>';
        }).join('');
    }

    function renderRecommendations(data) {
        var container = $('#health-recommendations');
        if (!container) return;
        var recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
        if (!recommendations.length) {
            showEmpty(container, 'health.noRecommendations', 'Nothing urgent. Keep importing and tagging normally.');
            return;
        }
        container.innerHTML = recommendations.map(function (item) {
            var severity = item.severity || 'info';
            return '<article class="health-recommendation ' + escapeHtml(severity) + '">'
                + '<span class="health-rec-dot"></span>'
                + '<p>' + escapeHtml(recommendationText(item)) + '</p>'
                + '</article>';
        }).join('');
    }

    function renderDuplicates(data) {
        var duplicateData = data.duplicate_filenames || {};
        var samples = Array.isArray(duplicateData.samples) ? duplicateData.samples : [];
        setText('#health-duplicate-summary', t('health.duplicateSummary', '{groups} groups • {images} images', {
            groups: formatNumber(duplicateData.groups || 0),
            images: formatNumber(duplicateData.images || 0)
        }));

        var container = $('#health-duplicate-list');
        if (!container) return;
        if (!samples.length) {
            showEmpty(container, 'health.noDuplicates', 'No duplicate filenames detected.');
            return;
        }
        container.innerHTML = samples.map(function (item) {
            return '<div class="health-row">'
                + '<span class="health-row-main">' + escapeHtml(item.filename || t('common.unknown', 'Unknown')) + '</span>'
                + '<span>' + formatNumber(item.count) + '×</span>'
                + '<span>' + formatSize(item.total_size) + '</span>'
                + '</div>';
        }).join('');
    }

    function renderFolders(data) {
        var container = $('#health-folder-list');
        if (!container) return;
        var folders = Array.isArray(data.top_folders) ? data.top_folders : [];
        if (!folders.length) {
            showEmpty(container, 'health.noFolders', 'No folder data yet.');
            return;
        }
        container.innerHTML = folders.map(function (item) {
            var folder = item.folder || t('health.rootFolder', 'Root / unknown folder');
            var issueText = t('health.folderIssues', '{missing} missing prompts • {untagged} untagged', {
                missing: formatNumber(item.missing_prompt || 0),
                untagged: formatNumber(item.untagged || 0)
            });
            return '<div class="health-row health-folder-row">'
                + '<span class="health-row-main" title="' + escapeHtml(folder) + '">' + escapeHtml(folder) + '</span>'
                + '<span>' + formatNumber(item.count) + '</span>'
                + '<span>' + formatSize(item.total_size) + '</span>'
                + '<small>' + escapeHtml(issueText) + '</small>'
                + '</div>';
        }).join('');
    }

    function renderSamples(data) {
        var container = $('#health-sample-list');
        if (!container) return;
        var samples = Array.isArray(data.issue_samples) ? data.issue_samples : [];
        if (!samples.length) {
            showEmpty(container, 'health.noSamples', 'No attention samples right now.');
            return;
        }
        container.innerHTML = samples.map(function (item) {
            var dimensions = item.width && item.height ? item.width + '×' + item.height : '—';
            return '<div class="health-row health-sample-row">'
                + '<span class="health-row-main" title="' + escapeHtml(item.path || '') + '">#' + escapeHtml(item.id) + ' ' + escapeHtml(item.filename || '') + '</span>'
                + '<span>' + escapeHtml(item.generator || 'unknown') + '</span>'
                + '<span>' + escapeHtml(dimensions) + '</span>'
                + '<span>' + escapeHtml(sampleReason(item)) + '</span>'
                + '</div>';
        }).join('');
    }

    function render(data) {
        state.data = data;
        renderStatus(data);
        renderKpis(data);
        renderIssues(data);
        renderRecommendations(data);
        renderDuplicates(data);
        renderFolders(data);
        renderSamples(data);
    }

    function setLoading(isLoading) {
        state.loading = isLoading;
        var button = $('#btn-health-refresh');
        if (button) {
            button.disabled = isLoading;
            button.classList.toggle('is-loading', isLoading);
        }
        if (isLoading && !state.loaded) {
            setText('#health-status-title', t('health.loadingTitle', 'Checking your library...'));
            setText('#health-status-detail', t('health.loadingDetail', 'This is read-only. No files will be moved, deleted, or rewritten.'));
        }
    }

    async function refresh() {
        if (state.loading) return;
        setLoading(true);
        try {
            var api = window.App && window.App.API;
            var data = api && typeof api.get === 'function'
                ? await api.get('/api/library-health?sample_limit=8')
                : await fetch('/api/library-health?sample_limit=8').then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                });
            state.loaded = true;
            render(data || {});
        } catch (error) {
            setText('#health-status-title', t('health.failedTitle', 'Could not load library health'));
            setText('#health-status-detail', t('health.failedDetail', 'The audit endpoint failed. Try again after the current scan finishes.'));
            if (window.App && typeof window.App.showToast === 'function') {
                window.App.showToast(t('health.failedToast', 'Failed to load library health'), 'error');
            }
        } finally {
            setLoading(false);
        }
    }

    function bind() {
        var refreshButton = $('#btn-health-refresh');
        if (refreshButton && refreshButton.dataset.healthBound !== '1') {
            refreshButton.dataset.healthBound = '1';
            refreshButton.addEventListener('click', refresh);
        }

        var scanButton = $('#btn-health-open-scan');
        if (scanButton && scanButton.dataset.healthBound !== '1') {
            scanButton.dataset.healthBound = '1';
            scanButton.addEventListener('click', function () {
                if (window.App && typeof window.App.showModal === 'function') {
                    window.App.showModal('scan-modal');
                }
            });
        }
    }

    function init() {
        if (!$('#view-health')) return;
        bind();
        if (!state.loaded) refresh();
        state.initialized = true;
    }

    document.addEventListener('languageChanged', function () {
        if (state.data && $('#view-health.active')) render(state.data);
    });

    window.LibraryHealth = {
        init: init,
        refresh: refresh,
        render: render
    };
})();
