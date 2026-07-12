/**
 * Dataset Maker — anime starter defaults + renamed-pair preview chip (+ .txt preview popover).
 * Moved VERBATIM from dataset-maker-pipeline.js L1046-1217 (+ documented
 * non-verbatim: the per-module init split).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ============== LoRA starter defaults (T11) ==============

    const ANIME_DEFAULTS_FLAG = 'sd-image-sorter-dataset-customized';

    function applyAnimeDefaults({ silent = false } = {}) {
        // Common tags pre-fill (only if empty so we don't clobber user input).
        // The seed value is the LoRA community's de-facto quality-tag pair;
        // it intentionally matches the ``dataset.commonTagsPlaceholder``
        // copy so the field looks the same before and after the click.
        const ct = document.getElementById('dataset-common-tags');
        if (ct && !String(ct.value || '').trim()) {
            ct.value = DM._t?.('dataset.commonTagsPlaceholder', 'masterpiece, best_quality') || 'masterpiece, best_quality';
            ct.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Underscore-to-space ON (preserve user choice if already changed).
        const us = document.getElementById('dataset-underscore-to-space');
        if (us && !us.dataset.userTouched) {
            us.checked = true;
        }
        // Naming preset = renumber (better LoRA workflow than 'keep' random filenames).
        const renumberRadio = document.querySelector('input[name="dataset-naming-preset"][value="renumber"]');
        const keepRadio = document.querySelector('input[name="dataset-naming-preset"][value="keep"]');
        const presetUserTouched = (keepRadio && keepRadio.dataset.userTouched)
            || (renumberRadio && renumberRadio.dataset.userTouched);
        if (renumberRadio && !presetUserTouched) {
            renumberRadio.checked = true;
            renumberRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Trigger placeholder hint if the user has typed nothing yet.
        const trigger = document.getElementById('dataset-trigger');
        if (trigger && !String(trigger.value || '').trim()) {
            trigger.placeholder = DM._t?.('dataset.previewTriggerPlaceholder', 'your_lora_trigger') || 'your_lora_trigger';
        }
        if (!silent && typeof DM._toast === 'function') {
            DM._toast(DM._t('dataset.animeDefaultsApplied',
                'Applied starter defaults.'), 'success');
        }
    }

    function bindAnimeDefaults() {
        const btn = document.getElementById('btn-dataset-anime-defaults');
        if (btn) {
            btn.addEventListener('click', () => {
                // Force reset by clearing user-touched flags first.
                document.querySelectorAll('[data-user-touched="1"]').forEach((el) => {
                    delete el.dataset.userTouched;
                });
                // Clear fields so applyAnimeDefaults will repopulate them.
                const ct = document.getElementById('dataset-common-tags');
                if (ct) ct.value = '';
                applyAnimeDefaults({ silent: false });
                try { localStorage.removeItem(ANIME_DEFAULTS_FLAG); } catch {}
            });
        }
        // Mark fields as user-touched once they edit them so the defaults
        // never override their choices on subsequent inits.
        const fields = [
            'dataset-common-tags', 'dataset-underscore-to-space',
            'dataset-blacklist', 'dataset-trigger',
        ];
        for (const id of fields) {
            const el = document.getElementById(id);
            if (!el) continue;
            const evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'input';
            el.addEventListener(evt, () => {
                el.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                radio.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        });

        // Apply defaults on the first init (no localStorage flag yet).
        const customized = (() => {
            try { return localStorage.getItem(ANIME_DEFAULTS_FLAG) === '1'; }
            catch { return false; }
        })();
        if (!customized) {
            applyAnimeDefaults({ silent: true });
        }
    }

    DM._applyAnimeDefaults = applyAnimeDefaults;

    // ============== Renamed-pair preview chip (T12) ==============

    function extensionForDatasetId(id) {
        const filename = DM.meta?.get?.(id)?.filename || '';
        const match = String(filename).match(/\.([^.]+)$/);
        return match ? match[1].toLowerCase() : 'png';
    }

    function refreshPairChip() {
        const png = document.getElementById('dataset-pair-chip-png');
        const txt = document.getElementById('dataset-pair-chip-txt');
        if (!png || !txt) return;
        const trigger = (document.getElementById('dataset-trigger')?.value || '').trim();
        const preset = (document.querySelector('input[name="dataset-naming-preset"]:checked')?.value) || 'keep';
        const ext = extensionForDatasetId((DM.imageIds || [])[0]);
        const outputMode = DM._outputMode?.() || 'folder';
        // Preview placeholders are illustrative sample names shown in the
        // renamed-pair chip before the user types anything. They go
        // through i18n so a non-English UI isn't shown English filler.
        const imgPlaceholder = DM._t?.('dataset.previewImagePlaceholder', 'your_image_name') || 'your_image_name';
        const triggerPlaceholder = DM._t?.('dataset.previewTriggerPlaceholder', 'your_lora_trigger') || 'your_lora_trigger';
        let stem;
        if (outputMode === 'beside_image' || preset === 'keep') {
            stem = imgPlaceholder;
        } else if (preset === 'renumber') {
            // Mirror _effectivePattern: an empty trigger exports plain
            // '001.png', so the chip must not promise 'trigger_001.png'.
            stem = trigger ? `${trigger}_001` : '001';
        } else {
            const pattern = (document.getElementById('dataset-naming-pattern')?.value || '{trigger}_{index:03d}');
            stem = pattern
                .replace(/\{trigger\}/g, trigger || triggerPlaceholder)
                .replace(/\{index:0*(\d+)d\}/g, (_m, w) => '1'.padStart(parseInt(w, 10) || 1, '0'))
                .replace(/\{index\}/g, '1')
                .replace(/\{filename\}/g, imgPlaceholder)
                .replace(/\{generator\}/g, 'webui')
                .replace(/\{ext\}/g, ext)
                .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
        }
        png.textContent = `${stem}.${ext}`;
        txt.textContent = `${stem}.txt`;
    }

    function bindPairChip() {
        for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
            document.getElementById(id)?.addEventListener('input', refreshPairChip);
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((r) => {
            r.addEventListener('change', refreshPairChip);
        });
        refreshPairChip();

        // Issue 5: click .txt chip to preview caption content
        const txtChip = document.getElementById('dataset-pair-chip-txt');
        if (txtChip) {
            txtChip.style.cursor = 'pointer';
            txtChip.title = DM._t?.('dataset.txtPreviewHint', 'Click to preview .txt content') || 'Click to preview .txt content';
            txtChip.addEventListener('click', () => {
                const id = DM.activeId;
                if (id == null) {
                    if (typeof window.showToast === 'function') window.showToast(DM._t?.('dataset.txtPreviewNoImage', 'Select an image first') || 'Select an image first', 'info');
                    return;
                }
                const caption = DM.captionEdits?.has?.(id) ? DM.captionEdits.get(id) : (DM.captions?.get?.(id) || '');
                const text = String(caption || '').trim() || DM._t?.('dataset.txtPreviewEmpty', '(empty - no caption yet)') || '(empty)';
                showTxtPreviewPopover(txtChip, text);
            });
        }
    }

    function showTxtPreviewPopover(anchor, text) {
        let pop = document.getElementById('dataset-txt-preview-pop');
        if (pop) { pop.remove(); return; }
        pop = document.createElement('div');
        pop.id = 'dataset-txt-preview-pop';
        pop.className = 'dataset-txt-preview-pop';
        pop.textContent = text;
        anchor.parentElement.appendChild(pop);
        const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', dismiss); } };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    }

    DM._refreshPairChip = refreshPairChip;

    // Split of dataset-maker-pipeline.js's single init() (forced
    // non-verbatim) — this module keeps only its own binder. See
    // dataset/audit.js for the full note.
    function init() {
        bindAnimeDefaults();
        bindPairChip();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
