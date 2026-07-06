/**
 * TraitPruner (P1-17) — reviewable character-trait pruning checklist.
 *
 * Community character-LoRA practice prunes the character's INNATE traits
 * (hair / eyes / skin / body markers) from captions so the trigger word
 * absorbs the identity. The tagger audit mandated a reviewable checklist,
 * never silent deletion: this module fetches frequency-ranked candidates
 * from POST /api/tags/trait-candidates and lets the user pick which ones to
 * append to an existing blacklist textarea. Attached in two places:
 * the batch-export modal (#batch-export-blacklist, comma-separated) and the
 * Dataset Maker workbench (#dataset-blacklist, newline-separated).
 *
 * Tags are appended in the backend's stored spelling — blacklist matching is
 * exact lowercase equality applied BEFORE underscore normalization, so the
 * endpoint's verbatim tag is the only spelling guaranteed to hit.
 */
(function () {
    'use strict';

    const FAMILY_ORDER = ['hair', 'eyes', 'skin', 'body'];
    const FAMILY_LABELS = {
        hair: ['traitPruner.familyHair', 'Hair'],
        eyes: ['traitPruner.familyEyes', 'Eyes'],
        skin: ['traitPruner.familySkin', 'Skin'],
        body: ['traitPruner.familyBody', 'Body'],
    };
    const PANEL_CLASS = 'trait-pruner-panel';

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        return (value && value !== key) ? value : fallback;
    }

    function toast(message, kind) {
        if (typeof window.showToast === 'function') window.showToast(message, kind || 'info');
    }

    function normalizeToken(token) {
        return String(token || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function existingTokens(textarea) {
        const tokens = String(textarea.value || '').split(/[\n,]/);
        return new Set(tokens.map(normalizeToken).filter(Boolean));
    }

    function appendTags(textarea, tags, separator) {
        const present = existingTokens(textarea);
        const fresh = tags.filter((tag) => !present.has(normalizeToken(tag)));
        if (!fresh.length) return 0;
        const current = String(textarea.value || '').trim();
        textarea.value = current ? current + separator + fresh.join(separator) : fresh.join(separator);
        // Real input event so debounce watchers (live preview) re-render.
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return fresh.length;
    }

    async function fetchCandidates(config) {
        const body = { min_ratio: 0.5, limit: 80 };
        const token = config.getSelectionToken ? config.getSelectionToken() : null;
        if (token) {
            body.selection_token = token;
        } else {
            const ids = (config.getImageIds ? config.getImageIds() : []) || [];
            if (!ids.length) return { error: 'empty-selection' };
            body.image_ids = ids;
        }
        const response = await fetch('/api/tags/trait-candidates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
    }

    function closePanel(config) {
        const panel = config._panel;
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        config._panel = null;
        config.button.setAttribute('aria-expanded', 'false');
    }

    function buildPanel(config, data) {
        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;

        const hint = document.createElement('p');
        hint.className = 'trait-pruner-hint';
        hint.textContent = t(
            'traitPruner.hint',
            'Innate traits found in ≥50% of the {count} selected images. Checked tags go to the blacklist so the trigger word carries them.',
            { count: data.total_images }
        );
        panel.appendChild(hint);

        const grouped = new Map();
        for (const item of (data.candidates || [])) {
            if (!grouped.has(item.family)) grouped.set(item.family, []);
            grouped.get(item.family).push(item);
        }

        const listWrap = document.createElement('div');
        listWrap.className = 'trait-pruner-groups';
        for (const family of FAMILY_ORDER) {
            const items = grouped.get(family);
            if (!items || !items.length) continue;
            const group = document.createElement('div');
            group.className = 'trait-pruner-group';
            const heading = document.createElement('div');
            heading.className = 'trait-pruner-group-title';
            const [labelKey, labelFallback] = FAMILY_LABELS[family];
            heading.textContent = t(labelKey, labelFallback);
            group.appendChild(heading);
            for (const item of items) {
                const row = document.createElement('label');
                row.className = 'trait-pruner-row';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = item.ratio >= 0.9;
                checkbox.dataset.traitTag = item.tag;
                const name = document.createElement('span');
                name.className = 'trait-pruner-tag';
                name.textContent = item.tag;
                const stat = document.createElement('span');
                stat.className = 'trait-pruner-stat';
                stat.textContent = `${item.count}/${data.total_images}`;
                row.appendChild(checkbox);
                row.appendChild(name);
                row.appendChild(stat);
                group.appendChild(row);
            }
            listWrap.appendChild(group);
        }
        panel.appendChild(listWrap);

        const actions = document.createElement('div');
        actions.className = 'trait-pruner-actions';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-small btn-primary';
        addBtn.textContent = t('traitPruner.addSelected', 'Add checked to blacklist');
        addBtn.addEventListener('click', () => {
            const picked = Array.from(panel.querySelectorAll('input[data-trait-tag]:checked'))
                .map((box) => box.dataset.traitTag)
                .filter(Boolean);
            if (!picked.length) {
                toast(t('traitPruner.nonePicked', 'No traits checked.'), 'warning');
                return;
            }
            const added = appendTags(config.textarea, picked, config.separator);
            toast(
                added
                    ? t('traitPruner.added', 'Added {count} trait tag(s) to the blacklist.', { count: added })
                    : t('traitPruner.allPresent', 'All checked traits were already blacklisted.'),
                added ? 'success' : 'info'
            );
            closePanel(config);
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-small btn-ghost';
        cancelBtn.textContent = t('traitPruner.close', 'Close');
        cancelBtn.addEventListener('click', () => closePanel(config));
        actions.appendChild(addBtn);
        actions.appendChild(cancelBtn);
        panel.appendChild(actions);
        return panel;
    }

    async function togglePanel(config) {
        if (config._panel) {
            closePanel(config);
            return;
        }
        config.button.disabled = true;
        try {
            const data = await fetchCandidates(config);
            if (data && data.error === 'empty-selection') {
                toast(t('traitPruner.noSelection', 'No images in the queue — nothing to analyze.'), 'warning');
                return;
            }
            if (!data || !(data.candidates || []).length) {
                toast(t('traitPruner.empty', 'No recurring innate traits found across the selected images.'), 'info');
                return;
            }
            const panel = buildPanel(config, data);
            config.button.insertAdjacentElement('afterend', panel);
            config._panel = panel;
            config.button.setAttribute('aria-expanded', 'true');
        } catch (error) {
            window.console?.warn?.('trait-candidates failed', error);
            toast(t('traitPruner.error', 'Could not load trait suggestions.'), 'error');
        } finally {
            config.button.disabled = false;
        }
    }

    /**
     * Wire a trigger button to a blacklist textarea.
     * @param {{ button: HTMLElement, textarea: HTMLTextAreaElement,
     *           getImageIds?: () => number[],
     *           getSelectionToken?: () => (string|null),
     *           separator?: string }} options
     */
    function attach(options) {
        const button = options?.button;
        const textarea = options?.textarea;
        if (!button || !textarea) return;
        const config = {
            button,
            textarea,
            getImageIds: options.getImageIds,
            getSelectionToken: options.getSelectionToken,
            separator: options.separator || ', ',
            _panel: null,
        };
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => togglePanel(config));
    }

    window.TraitPruner = { attach };
})();
