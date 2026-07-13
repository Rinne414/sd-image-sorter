/**
 * image-reader/sections-scroll.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 240-251 + 263-279 + 284-353 (of 1,749): _bindSectionToggles,
 * _applySectionState, _syncSectionStates (the collapsible reader sections;
 * `_collapsedState` booleans are read as EXPANDED — historical misnomer, kept
 * as-is) and the reader scroll capture/restore quartet
 * (_getReaderScrollElements, _captureReaderScrollState,
 * _cancelReaderScrollRestore, _restoreReaderScrollState — `_readerScrollRestore`
 * is a lazily-created state field, intentionally not declared in core.js).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _bindSectionToggles() {
            document.querySelectorAll('#view-reader .reader-section-toggle').forEach((toggle) => {
                toggle.addEventListener('click', () => {
                    const key = toggle.dataset.collapseKey;
                    const target = document.getElementById(toggle.dataset.target);
                    if (!key || !target) return;
                    this._collapsedState[key] = !this._collapsedState[key];
                    this._applySectionState(toggle, target, this._collapsedState[key]);
                });
            });
        },

        _applySectionState(toggle, target, expanded) {
            target.style.display = expanded ? '' : 'none';
            toggle.classList.toggle('is-collapsed', !expanded);
            const icon = toggle.querySelector('.collapse-icon');
            if (icon) icon.textContent = expanded ? '▼' : '▶';
        },

        _syncSectionStates() {
            document.querySelectorAll('#view-reader .reader-section-toggle').forEach((toggle) => {
                const key = toggle.dataset.collapseKey;
                const target = document.getElementById(toggle.dataset.target);
                if (!key || !target) return;
                const expanded = this._collapsedState[key] !== false;
                this._applySectionState(toggle, target, expanded);
            });
        },

        _getReaderScrollElements() {
            const elements = [
                document.getElementById('view-reader'),
                document.querySelector('#view-reader .reader-right'),
            ].filter(Boolean);
            return [...new Set(elements)];
        },

        _captureReaderScrollState() {
            return this._getReaderScrollElements().map((element) => {
                const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
                return {
                    element,
                    top: element.scrollTop || 0,
                    ratio: maxScroll > 0 ? (element.scrollTop || 0) / maxScroll : 0,
                };
            });
        },

        _cancelReaderScrollRestore() {
            const pending = this._readerScrollRestore;
            if (!pending) return;
            this._readerScrollRestore = null;
            if (pending.rafId) cancelAnimationFrame(pending.rafId);
            if (pending.timerId) window.clearTimeout(pending.timerId);
            pending.detach();
        },

        _restoreReaderScrollState(scrollState) {
            // A new restore supersedes any still-pending one so back-to-back
            // opens cannot replay a stale snapshot.
            this._cancelReaderScrollRestore();
            if (!Array.isArray(scrollState) || scrollState.length === 0) return;
            const apply = () => {
                scrollState.forEach((snapshot) => {
                    const element = snapshot?.element;
                    if (!element || !element.isConnected) return;
                    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
                    if (maxScroll <= 0) return;
                    const targetTop = Math.max(snapshot.top || 0, (snapshot.ratio || 0) * maxScroll);
                    element.scrollTop = Math.min(maxScroll, targetTop);
                });
            };
            // Cancel the delayed re-apply as soon as the user scrolls on
            // their own — otherwise the 120ms timer snaps their position back.
            const userScrollEvents = ['wheel', 'touchstart', 'mousedown'];
            const onUserScroll = () => this._cancelReaderScrollRestore();
            const targets = scrollState
                .map((snapshot) => snapshot?.element)
                .filter((element) => element && element.isConnected);
            targets.forEach((element) => userScrollEvents.forEach((type) => element.addEventListener(type, onUserScroll, { passive: true })));
            const pending = {
                rafId: 0,
                timerId: 0,
                detach: () => targets.forEach((element) => userScrollEvents.forEach((type) => element.removeEventListener(type, onUserScroll))),
            };
            this._readerScrollRestore = pending;
            pending.rafId = requestAnimationFrame(() => {
                pending.rafId = requestAnimationFrame(() => {
                    pending.rafId = 0;
                    apply();
                });
            });
            pending.timerId = window.setTimeout(() => {
                pending.timerId = 0;
                apply();
                this._cancelReaderScrollRestore();
            }, 120);
        },

});
