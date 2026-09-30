/**
 * Style Map boot (the app's first ES module; three.js is only importable as
 * a module). The classic scripts have already built and sealed window.App
 * by the time modules run, so this only publishes window.StyleMap and, when
 * the view is already open (a restored session), starts it. view-switch.js
 * calls window.StyleMap.init() on every later switch to the view.
 */
import { createStyleMap } from './state.js';

const styleMap = createStyleMap();
window.StyleMap = styleMap;

if (document.getElementById('view-stylemap')?.classList.contains('active')) {
    styleMap.init();
}
