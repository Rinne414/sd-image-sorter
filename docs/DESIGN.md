# SD Image Sorter — UI Design Rules

This document captures **non-obvious UI invariants** that future changes must preserve.
It is the source of truth for "why does this look like that" questions.

---

## §filter-sidebar — Filter summary rows must stay single-line

Each row in `.filter-summary > .summary-row` shows a label (e.g. `生成器`, `Tags`) and a value (e.g. `14/14`, `0`, `Any`). These rows MUST render on ONE visual line. Long values truncate with `text-overflow: ellipsis`, never wrap.

Rationale:
- The sidebar is a dense scannable summary, not a body of prose.
- Wrapping makes label and value look like separate items rather than a key-value pair.
- Users complained at 1366×768 that the rows broke into "label on top / value below" stacks because of `word-break: break-word`. Confirmed regression caused by a generic `.summary-value` rule in `ui-refresh.css`.

Implementation:
- `.filter-summary .summary-row { flex-wrap: nowrap; align-items: center; }`
- `.filter-summary .summary-label { flex: 0 0 auto; white-space: nowrap; }`
- `.filter-summary .summary-value { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`
- The generic `.summary-value` rule (which wraps for prose-like uses elsewhere) is preserved separately so it does not affect the filter sidebar.

Do NOT:
- Add `flex-wrap: wrap` to `.filter-summary .summary-row`.
- Set `word-break: break-word` or `overflow-wrap: anywhere` directly on `.filter-summary .summary-value`.
- Stack label and value as `<div>` blocks — they must remain inline children of a flex row.

---

## §gallery-toolbar — All buttons fit a 1366×768 laptop without wrapping

The gallery toolbar (`.gallery-header`) and generator tabs (`.generator-tabs`) MUST remain on one line at 1366×768. This is the lowest-resolution consumer laptop the project supports.

Implementation:
- `.gallery-header { flex-wrap: nowrap; }`
- `.generator-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }`
- Below 1500px, secondary actions (Random, Reconnect) and inactive tab counts are hidden via `@media (max-width: 1500px)`.
- Below 1600px, the "X images" count is hidden (the active tab badge already shows the count).

Do NOT:
- Use `flex-wrap: wrap` on these containers; users have explicitly rejected line breaks here.
- Hide gen-tab labels — only the count badges are removable.

---

## §nav-bar — Top navigation must show all tabs without a hamburger at 1366×768

The top nav (`.nav-bar`) shows view-switching tabs (Gallery, Reader, Sort, ...) on the left and action buttons (Import, Tag, Help, ...) on the right. At 1366×768, all tabs must remain visible without overflow into the hamburger menu.

Implementation:
- Below 1500px, `.nav-actions .btn:not(.btn-icon-only)` shows icons only (label hidden).
- Below 1500px, secondary icon buttons (`#btn-refresh-ui`, `#btn-mass-tag-editor`, `#btn-app-update`) are hidden to free space.
- The overflow detector in `ui-refresh.js` only triggers below ~1300px.

Do NOT:
- Add new always-visible icon buttons to `.nav-actions` without first verifying 1366×768 still fits.
- Render the same Help/Guide button both in nav-bar and inside a view (`.gallery-header`, `.censor-toolbar-v2`, etc.) at the same time. The nav-bar `#btn-help` covers all views via `Guide.getCurrentTab()`.

---

## §progress-toast — Background work must show a clear "Done" state

Long-running background jobs (color analysis, scanning, tagging, similarity build) MUST surface a clear completion state, not silently disappear.

Pattern (see `frontend/js/color-backfill.js`):
1. Detect `running` → `idle` transition (use a `wasRunning` flag).
2. On transition, show a "Done — N items processed" banner via the in-app toast.
3. Update the nav chip from `N%` to `✓` and keep it visible for ~5 s.
4. Auto-hide both chip and toast after 5 s.

Do NOT:
- Hide the chip immediately when polling sees `running=false` (user has no time to see completion).
- Leave the toast showing the last in-progress filename forever.

---

## Maintenance

- Update this file when reverting or revising any rule above.
- Add a new section every time a UI rule survives a "wait, why?" review.
- Cross-reference rules from CSS comments via the `§<slug>` anchor.
