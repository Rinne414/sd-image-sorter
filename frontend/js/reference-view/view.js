/**
 * The reference view: one picture to keep beside other work.
 *
 * It fills its window with the picture and lets the user look closer: the
 * wheel zooms at the pointer, a drag moves a zoomed picture, a double-click
 * goes back to the whole picture, and three buttons mirror it, show it in
 * grey (to read values) and fit it again.
 *
 * The view is built in whatever document it is given, because it runs in two
 * places: its own page (reference.html, the desktop program's always-on-top
 * window or a browser pop-up) and a browser's picture-in-picture window, which
 * has a document of its own but runs no script of its own.
 */
(function initReferenceView(global) {
    'use strict';

    const MAX_ZOOM = 16;
    const ZOOM_STEP = 1.2;

    /**
     * @param {HTMLElement} root  the element to fill (in any document)
     * @param {{src: string, name?: string, text: (key: string, fallback: string) => string}} options
     */
    function mount(root, options) {
        const doc = root.ownerDocument;
        const text = options.text;
        const view = { zoom: 1, x: 0, y: 0, mirrored: false, grey: false, drag: null };

        const el = (tag, className, label) => {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (label !== undefined) node.textContent = label;
            return node;
        };

        const stage = el('div', 'reference-stage');
        const picture = el('img', 'reference-picture');
        picture.alt = options.name || '';
        picture.draggable = false;
        const problem = el('p', 'reference-problem');
        problem.hidden = true;
        const bar = el('div', 'reference-bar');
        bar.setAttribute('role', 'toolbar');

        function draw() {
            const side = view.mirrored ? -1 : 1;
            picture.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom * side}, ${view.zoom})`;
            picture.style.filter = view.grey ? 'grayscale(1)' : '';
            stage.classList.toggle('is-zoomed', view.zoom > 1);
            mirrorButton.setAttribute('aria-pressed', String(view.mirrored));
            greyButton.setAttribute('aria-pressed', String(view.grey));
            fitButton.disabled = view.zoom === 1;
        }

        function fit() {
            view.zoom = 1;
            view.x = 0;
            view.y = 0;
            draw();
        }

        /** Zoom so the point under the pointer stays under it. */
        function zoomAt(clientX, clientY, factor) {
            const next = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
            if (next === view.zoom) return;
            if (next === 1) {
                fit();
                return;
            }
            const box = stage.getBoundingClientRect();
            const fromCentreX = clientX - (box.left + box.width / 2);
            const fromCentreY = clientY - (box.top + box.height / 2);
            const ratio = next / view.zoom;
            view.x = fromCentreX - (fromCentreX - view.x) * ratio;
            view.y = fromCentreY - (fromCentreY - view.y) * ratio;
            view.zoom = next;
            draw();
        }

        function button(key, fallback, hint, onPress) {
            const node = el('button', 'reference-button', text(key, fallback));
            node.type = 'button';
            node.title = text(`${key}Tip`, hint);
            node.addEventListener('click', onPress);
            bar.appendChild(node);
            return node;
        }

        const mirrorButton = button('reference.mirror', 'Mirror', 'Mirror the picture (H)', () => {
            view.mirrored = !view.mirrored;
            draw();
        });
        const greyButton = button('reference.grey', 'Grey', 'Show it in grey to read the values (G)', () => {
            view.grey = !view.grey;
            draw();
        });
        const fitButton = button('reference.fit', 'Whole picture', 'Show the whole picture again (0)', fit);

        stage.addEventListener('wheel', (event) => {
            event.preventDefault();
            zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }, { passive: false });

        stage.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || view.zoom === 1) return;
            view.drag = { id: event.pointerId, startX: event.clientX - view.x, startY: event.clientY - view.y };
            stage.setPointerCapture(event.pointerId);
        });
        stage.addEventListener('pointermove', (event) => {
            if (!view.drag || view.drag.id !== event.pointerId) return;
            view.x = event.clientX - view.drag.startX;
            view.y = event.clientY - view.drag.startY;
            draw();
        });
        const endDrag = (event) => {
            if (view.drag && view.drag.id === event.pointerId) view.drag = null;
        };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);
        stage.addEventListener('dblclick', fit);

        doc.addEventListener('keydown', (event) => {
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            const key = event.key.toLowerCase();
            if (key === 'h') mirrorButton.click();
            else if (key === 'g') greyButton.click();
            else if (key === '0') fit();
            else if (key === 'escape') doc.defaultView?.close();
            else return;
            event.preventDefault();
        });

        picture.addEventListener('error', () => {
            picture.hidden = true;
            bar.hidden = true;
            problem.hidden = false;
            problem.textContent = text('reference.cannotShow', 'This picture cannot be shown. Its file may have been moved or deleted.');
        });

        stage.appendChild(picture);
        root.replaceChildren(stage, problem, bar);
        picture.src = options.src;
        draw();
    }

    global.ReferenceView = Object.freeze({ mount });
})(window);
