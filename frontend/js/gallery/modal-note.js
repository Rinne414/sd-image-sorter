/**
 * The viewer's Note: a few words the user writes on a picture (why it was
 * kept, what to fix, whom it is for). It is saved when the field is left, or
 * with Ctrl+Enter, and the Gallery's search finds its words like a caption's.
 *
 * PATCH /api/images/{id}/note stores it (routers/images_parts/note.py).
 */
(function initModalNote(global) {
    'use strict';

    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const field = () => document.getElementById('modal-note-text');
    const status = () => document.getElementById('modal-note-status');

    let shownId = null;
    let stored = '';

    function say(text, tone) {
        const node = status();
        if (!node) return;
        node.textContent = text;
        node.dataset.tone = tone || 'hint';
    }

    const hint = () => tr('note.hint', 'Only in this program. The search finds its words.');

    /** Fill the field for the picture now in the viewer. */
    function show(image) {
        const input = field();
        if (!input || !image?.id) return;
        shownId = Number(image.id);
        stored = String(image.note || '');
        input.value = stored;
        input.disabled = false;
        say(hint());
    }

    async function save() {
        const input = field();
        if (!input || shownId === null) return;
        const id = shownId;
        const text = input.value.trim();
        if (text === stored.trim()) return;
        say(tr('note.saving', 'Saving...'));
        try {
            const result = await global.App.API.patch(`/api/images/${id}/note`, { note: text });
            // The user may have moved to another picture while this was saving.
            if (id !== shownId) return;
            stored = String(result?.note ?? text);
            const shown = global.Gallery?._lastModalImage;
            if (shown && Number(shown.id) === id) shown.note = stored;
            say(stored ? tr('note.saved', 'Saved.') : tr('note.cleared', 'Note removed.'), 'ok');
        } catch (error) {
            if (id !== shownId) return;
            say(tr('note.failed', 'Not saved: {reason}', { reason: error?.message || String(error) }), 'error');
        }
    }

    function wire() {
        const input = field();
        if (!input) return;
        input.placeholder = tr('note.placeholder', 'Why you kept it, what to fix, whom it is for...');
        input.setAttribute('aria-label', tr('modal.note', 'Note'));
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (event) => {
            // Keys typed here are text, never the viewer's shortcuts (arrows change the picture).
            event.stopPropagation();
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
            } else if (event.key === 'Escape') {
                // Esc gives the field back as it was stored; a second Esc closes the viewer.
                if (input.value !== stored) {
                    input.value = stored;
                    say(hint());
                } else {
                    input.blur();
                }
            }
        });
        document.addEventListener('languageChanged', () => {
            input.placeholder = tr('note.placeholder', 'Why you kept it, what to fix, whom it is for...');
            say(hint());
        });
    }

    global.ModalNote = Object.freeze({ show, save });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
