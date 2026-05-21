/**
 * Global button click guard — prevents double-click / rapid-fire issues.
 *
 * Attaches a single delegated listener on document that intercepts clicks
 * on any .btn element. If the button was clicked within the last 300ms,
 * the duplicate click is swallowed. The button gets a brief .is-busy class
 * for visual feedback.
 *
 * This does NOT interfere with buttons that manage their own disabled state
 * (e.g., form submit buttons that disable themselves). It only guards
 * against the "user clicks 3 times because nothing happened" pattern.
 */
(function () {
    const DEBOUNCE_MS = 300;
    const busyButtons = new WeakMap();

    document.addEventListener('click', function (event) {
        const btn = event.target.closest('.btn');
        if (!btn) return;
        // Skip if button is already disabled by its own logic
        if (btn.disabled) return;
        // Skip if it's a toggle/checkbox-style button (aria-pressed)
        if (btn.getAttribute('aria-pressed') !== null) return;
        // Skip small tool buttons (tag add/remove, chip clear) — users
        // legitimately rapid-fire these. Only guard primary actions and
        // large CTA buttons where double-click causes real problems.
        if (btn.classList.contains('btn-small') || btn.classList.contains('btn-ghost')) return;

        const lastClick = busyButtons.get(btn) || 0;
        const now = Date.now();

        if (now - lastClick < DEBOUNCE_MS) {
            // Duplicate click within debounce window — swallow it
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
        }

        busyButtons.set(btn, now);

        // Brief visual feedback
        btn.classList.add('is-busy');
        setTimeout(() => btn.classList.remove('is-busy'), DEBOUNCE_MS);
    }, true); // capture phase so it runs before other handlers
})();
