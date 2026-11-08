/**
 * ui-icon.js - one icon style everywhere: the line icons of the page's sprite.
 *
 * Menus, the feature catalog and the guide used emoji as icons (multi-colour
 * pictographs next to the thin line icons of the top bar: "reads as two
 * products", UI audit 2026-11-08). A renderer calls UiIcon.fill(span, name):
 * a sprite name ("i-folder") draws that line icon; anything else is written as
 * text, so an entry not yet moved over keeps working.
 *
 * Classic script, loaded early: window.UiIcon.
 */
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    function isSpriteName(name) {
        return typeof name === 'string' && /^#?i-[a-z0-9-]+$/.test(name);
    }

    function bare(name) {
        return String(name).replace(/^#/, '');
    }

    /** A sprite icon element (<svg class="icon"><use href="#name"/></svg>). */
    function svg(name) {
        const icon = document.createElementNS(SVG_NS, 'svg');
        icon.setAttribute('class', 'icon');
        icon.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `#${name}`);
        icon.appendChild(use);
        return icon;
    }

    /** Put an icon into `target`: a sprite name draws the line icon, other text is kept as text. */
    function fill(target, name) {
        if (!target) return;
        target.replaceChildren();
        if (isSpriteName(name)) target.appendChild(svg(bare(name)));
        else if (name) target.textContent = String(name);
    }

    /** The icon as markup, for code that builds HTML strings (the name is checked, never raw input). */
    function html(name) {
        return isSpriteName(name) ? `<svg class="icon" aria-hidden="true"><use href="#${bare(name)}"/></svg>` : '';
    }

    window.UiIcon = { fill, svg, html, isSpriteName };
})();
