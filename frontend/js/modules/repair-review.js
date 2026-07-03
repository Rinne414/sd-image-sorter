/**
 * Aurora Phase 3 / Roadmap-C — review UI for AMBIGUOUS reconnect matches.
 *
 * A "Find Moved Images" run persists ambiguous groups (one found file, 2+
 * same-name-same-size gallery records) as pending reviews. This modal pages
 * through GET /api/images/repair-candidates, previews the found file via
 * GET /api/image-preview-by-path, and commits per-row choices with
 * POST /api/images/repair-confirm:
 *   pick  — relink the chosen record to the found file (others untouched)
 *   merge — relink the chosen record AND delete the other candidate records
 *           (DB records only; files on disk are never touched)
 *   skip  — dismiss the review, change nothing
 *
 * DOM is built with createElement/textContent — paths never hit innerHTML.
 */
(function () {
    'use strict';

    const PAGE_SIZE = 20;

    const state = {
        offset: 0,
        total: 0,
        loading: false,
    };

    function t(key, fallback) {
        const v = window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(key) : null;
        return v && v !== key ? v : fallback;
    }

    function app() {
        return window.App || null;
    }

    function toast(message, kind) {
        const a = app();
        if (a && typeof a.showToast === 'function') a.showToast(message, kind || 'info');
    }

    function formatBytes(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return '';
        if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(n / 1024))} KB`;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function renderReview(review) {
        const row = el('div', 'repair-review-item');
        row.dataset.reviewId = String(review.review_id);

        // Found file: thumbnail preview + path
        const found = el('div', 'repair-review-found');
        const thumb = document.createElement('img');
        thumb.className = 'repair-review-thumb';
        thumb.loading = 'lazy';
        thumb.alt = review.filename || '';
        thumb.src = `/api/image-preview-by-path?size=192&path=${encodeURIComponent(review.found_path || '')}`;
        thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
        found.appendChild(thumb);

        const foundMeta = el('div', 'repair-review-found-meta');
        foundMeta.appendChild(el('strong', null, review.filename || ''));
        const foundPath = el('code', 'repair-review-path', review.found_path || '');
        foundMeta.appendChild(foundPath);
        if (review.found_exists === false) {
            foundMeta.appendChild(el('span', 'repair-review-missing-badge',
                t('repairReview.foundGone', 'File no longer at this path')));
        }
        found.appendChild(foundMeta);
        row.appendChild(found);

        // Candidate records
        const list = el('div', 'repair-review-candidates');
        const groupName = `repair-review-choice-${review.review_id}`;
        (review.candidates || []).forEach((candidate, index) => {
            const label = el('label', 'repair-review-candidate');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = groupName;
            radio.value = String(candidate.image_id);
            if (index === 0) radio.checked = true;
            label.appendChild(radio);

            const body = el('span', 'repair-review-candidate-body');
            body.appendChild(el('code', 'repair-review-path', candidate.path || ''));
            const detailBits = [];
            const size = formatBytes(candidate.file_size);
            if (size) detailBits.push(size);
            if (candidate.still_missing === false) {
                detailBits.push(t('repairReview.candidateReadable', 'currently readable'));
            }
            if (detailBits.length) {
                body.appendChild(el('small', 'repair-review-candidate-detail', detailBits.join(' · ')));
            }
            label.appendChild(body);
            list.appendChild(label);
        });
        row.appendChild(list);

        // Actions
        const actions = el('div', 'repair-review-actions');
        const pickBtn = el('button', 'btn btn-primary btn-small', t('repairReview.pick', 'Relink chosen record'));
        pickBtn.type = 'button';
        const mergeBtn = el('button', 'btn btn-secondary btn-small', t('repairReview.merge', 'Relink + remove the others'));
        mergeBtn.type = 'button';
        const skipBtn = el('button', 'btn btn-ghost btn-small', t('repairReview.skip', 'Skip'));
        skipBtn.type = 'button';

        const chosenId = () => {
            const checked = row.querySelector(`input[name="${groupName}"]:checked`);
            return checked ? Number(checked.value) : null;
        };

        pickBtn.addEventListener('click', () => confirmReview(row, review, 'pick', chosenId()));
        mergeBtn.addEventListener('click', () => {
            const a = app();
            const doMerge = () => confirmReview(row, review, 'merge', chosenId());
            if (a && typeof a.showConfirm === 'function') {
                a.showConfirm(
                    t('repairReview.mergeConfirmTitle', 'Remove the other records?'),
                    t('repairReview.mergeConfirmBody', 'The chosen record is relinked to the found file; the OTHER candidate records are removed from the gallery (their tags and ratings are lost). Files on disk are not touched.'),
                    doMerge
                );
            } else {
                doMerge();
            }
        });
        skipBtn.addEventListener('click', () => confirmReview(row, review, 'skip', null));

        actions.appendChild(pickBtn);
        actions.appendChild(mergeBtn);
        actions.appendChild(skipBtn);
        row.appendChild(actions);

        return row;
    }

    async function confirmReview(row, review, action, chosenImageId) {
        if (action !== 'skip' && !chosenImageId) {
            toast(t('repairReview.chooseFirst', 'Choose one record first.'), 'warning');
            return;
        }
        row.classList.add('is-busy');
        row.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
        try {
            const resp = await fetch('/api/images/repair-confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    review_id: review.review_id,
                    action,
                    chosen_image_id: action === 'skip' ? null : chosenImageId,
                }),
            });
            const payload = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                throw new Error(payload.detail || payload.message || `HTTP ${resp.status}`);
            }
            row.remove();
            state.total = Math.max(0, state.total - 1);
            updateFooter();
            toast(
                action === 'skip'
                    ? t('repairReview.skipped', 'Skipped.')
                    : t('repairReview.confirmed', 'Record relinked.'),
                action === 'skip' ? 'info' : 'success'
            );
            const listEl = document.getElementById('repair-review-list');
            if (listEl && !listEl.querySelector('.repair-review-item')) {
                await load();
            }
            // The gallery list may now show the relinked file — refresh lazily.
            const a = app();
            if (action !== 'skip' && a && typeof a.markGalleryNeedsRefresh === 'function') {
                a.markGalleryNeedsRefresh();
            }
        } catch (error) {
            row.classList.remove('is-busy');
            row.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
            toast(t('repairReview.confirmFailed', 'Could not apply that choice: ') + (error.message || ''), 'error');
        }
    }

    function updateFooter() {
        const countEl = document.getElementById('repair-review-count');
        if (countEl) {
            countEl.textContent = t('repairReview.pendingCount', '{count} pending')
                .replace('{count}', String(state.total));
        }
        const prevBtn = document.getElementById('btn-repair-review-prev');
        const nextBtn = document.getElementById('btn-repair-review-next');
        if (prevBtn) prevBtn.disabled = state.loading || state.offset <= 0;
        if (nextBtn) nextBtn.disabled = state.loading || state.offset + PAGE_SIZE >= state.total;
    }

    async function load() {
        const listEl = document.getElementById('repair-review-list');
        if (!listEl || state.loading) return;
        state.loading = true;
        updateFooter();
        listEl.replaceChildren(el('div', 'repair-review-loading', t('repairReview.loading', 'Loading…')));
        try {
            const resp = await fetch(`/api/images/repair-candidates?limit=${PAGE_SIZE}&offset=${state.offset}&status=pending`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            state.total = Number(data.total || 0);
            const items = Array.isArray(data.items) ? data.items : [];
            // A shrinking total can strand the offset past the end — snap back.
            if (!items.length && state.offset > 0 && state.total > 0) {
                state.offset = Math.max(0, Math.floor((state.total - 1) / PAGE_SIZE) * PAGE_SIZE);
                state.loading = false;
                return load();
            }
            listEl.replaceChildren();
            if (!items.length) {
                listEl.appendChild(el('div', 'repair-review-empty',
                    t('repairReview.empty', 'No pending matches to review — you are done here.')));
            } else {
                items.forEach((review) => listEl.appendChild(renderReview(review)));
            }
        } catch (error) {
            listEl.replaceChildren(el('div', 'repair-review-empty',
                t('repairReview.loadFailed', 'Could not load reviews: ') + (error.message || '')));
        } finally {
            state.loading = false;
            updateFooter();
        }
    }

    function open() {
        state.offset = 0;
        const a = app();
        if (a && typeof a.showModal === 'function') a.showModal('repair-review-modal');
        load();
    }

    function close() {
        const a = app();
        if (a && typeof a.hideModal === 'function') {
            a.hideModal('repair-review-modal');
        } else {
            document.getElementById('repair-review-modal')?.classList.remove('visible');
        }
    }

    function boot() {
        document.getElementById('btn-close-repair-review')?.addEventListener('click', close);
        document.querySelector('#repair-review-modal .modal-backdrop')?.addEventListener('click', close);
        document.getElementById('btn-repair-review-prev')?.addEventListener('click', () => {
            state.offset = Math.max(0, state.offset - PAGE_SIZE);
            load();
        });
        document.getElementById('btn-repair-review-next')?.addEventListener('click', () => {
            state.offset += PAGE_SIZE;
            load();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.RepairReview = { open, close, load };
})();
