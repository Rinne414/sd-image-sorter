# SD Image Sorter — UI Design Rules

This document has two layers: **§principles** is the macro design philosophy every
feature and surface must serve; everything after it is a **micro-invariant** that
survived a "wait, why?" review. It is the source of truth for "why does this look
like that" questions. When a change conflicts with either layer, the change is
wrong — see `docs/AI_PRINCIPLES.md` for the authority order.

---

## §principles — The design principles (macro layer)

Distilled from owner directives 2025–2026; none of these are generic best-practice
imports — each one came from a real owner complaint or an explicit ruling. Read
this before adding any feature, entrance, or surface.

### Product layer (owner-set, highest authority)

1. **One-stop tool.** Managing / tagging / sorting / censoring / publishing SD
   images never requires a second program.
2. **Comfort > stability > speed** — in that order (owner ranking).
3. **Serve pros AND newcomers by layering, never by capping.** Do not limit or
   remove functionality for "safety" or "performance" without asking the owner.
4. **Desktop/laptop only (≥ ~1280px).** No mobile/tablet effort, ever
   (owner directive 2026-06-05, recorded in `CLAUDE.md`).

### Entrance & information-architecture layer (owner FB 2026-07-06/07)

5. **Intent first.** The entry page asks "what are we organizing today":
   missions (outcome-oriented) above, tools (room-oriented) below.
6. **The Library is home.** Biggest button on the entry page; always one step
   away; its nav tab can never be hidden.
7. **Missions are guided modes.** Picking a mission scopes the top bar to only
   that pipeline's tabs, in order, with step numbers — the bar itself answers
   "how do I go". A visible chip exits back to the full set.
8. **Never cage.** Every feature stays reachable through at least two paths
   (direct tab or More-menu mirror, plus the function catalog). ESC always goes
   up exactly one level and never loses progress.
9. **Newcomer defaults, pro overrides.** The default experience explains itself
   (badges, step numbers, catalog descriptions); power users can customize the
   tab bar, skip the entry page, change the cover mode — and every override is
   reversible.
10. **The app carries its own map.** The 所有功能 catalog lists every feature
    with a one-line usage; a feature that is not in the catalog effectively
    does not exist for new users.
11. **Entrances may duplicate; implementations must not.** A feature may be
    reachable from the entry page, the nav bar, the catalog, and a menu — but
    all entrances must proxy the SAME button/function (e.g. the entry page's
    language button clicks `#btn-language-toggle`). Never fork the behavior
    per entrance.

### Visual-language layer (Aurora contract, v3.5.0)

12. **Color is semantics, not decoration.** Blue = the next action, pink = a
    user decision, purple = AI output. One solid-blue primary per screen;
    the blue→purple gradient at most once per screen, cross-step only.
    `frontend/css/tokens.css` is the single palette owner (see §css-ownership).
13. **Bilingual completeness.** en/zh key parity is audited; user-facing errors
    must have a Chinese variant. No zh-TW in the zh-CN pack.
14. **Dangerous operations sit far from common ones** (e.g. the danger divider
    in menus); icon-only buttons always carry a tooltip.

Do NOT:
- Add an entrance whose behavior differs from the existing entrance to the
  same feature (rule 11).
- Ship a feature without a catalog row (rule 10).
- Hide or remove capability to simplify a surface — layer it instead (rule 3).

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

## §nav-bar — Tab visibility has three layers; nothing becomes unreachable

(Rewritten 2026-07-07 — the old rule "all tabs always visible at 1366×768"
predates mission mode and the customize checklist. Deliberate tucking is now a
feature; INVOLUNTARY hiding is still the bug.)

Three layers decide which direct tabs show (`frontend/js/modules/nav-missions.js`):
1. **Mission mode** (`aurora-nav-mission`): an entry mission scopes the bar to
   its pipeline tabs with step badges + an exit chip.
2. **Base set** (`aurora-nav-tabs`): the 自定义标签栏 checklist under More.
   Gallery is locked in. Dataset is out of the DEFAULT set (owner 2026-07-07).
3. **Width-degradation ladder** (`updateNavigationOverflowState` in `app.js`):
   involuntary, width-driven — labels/brand compact before any tab vanishes;
   Prompt Helper / Style Finder tuck first into their More mirrors.

Invariants:
- Every tucked view (any layer) must have a More-menu mirror (`#nav-tools-{view}`)
  that is visible exactly while its direct tab is hidden.
- Mirrors carry `data-mirror-view`, NEVER `data-view` — Playwright page objects
  click plain `[data-view=...]` locators; a duplicate trips strict mode.
  (`#nav-tools-promptlab`/`-artist` predate this rule and are grandfathered.)
- The active view's tab is always contextually revealed, so an open view never
  lacks its highlighted tab.
- The DEFAULT base set must fit at 1366×768 without the ladder eating tabs.
- Mirror-like new elements need a `[hidden]{display:none}` guard — `.nav-tab`'s
  own display rule beats the UA `[hidden]` rule (recurring trap).

Nav actions (right side):
- Below 1500px, `.nav-actions .btn:not(.btn-icon-only)` shows icons only (label hidden).
- Below 1500px, secondary icon buttons (`#btn-refresh-ui`, `#btn-mass-tag-editor`, `#btn-app-update`) are hidden to free space.

Do NOT:
- Give a More-menu mirror a `data-view` attribute.
- Add a view to the default base set without verifying the 1366×768 fit.
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

## §css-ownership — Shared tokens and feature layouts must have one owner

The frontend still uses plain CSS with multiple layered stylesheets. Keep the ownership boundary explicit so broad UI refresh work does not become override-only churn.

Ownership:
- `tokens.css`: THE palette owner (Aurora canonical tokens + legacy variable
  remap + prefers-contrast re-assertion). Loaded LAST in `index.html` — it must
  stay last or the high-contrast a11y re-assertion breaks (v3.5.0 Aurora Phase 1).
- `styles.css`: legacy/base layout foundation and broad compatibility rules.
- `ui-refresh.css`: current theme/chrome, shared controls, and cross-view refresh overrides (its color literals defer to `tokens.css` vars).
- Feature stylesheets (`censor-v2.css`, `dataset-maker.css`, `vlm.css`, etc.): feature-local layout and controls only.

Do NOT:
- Load any stylesheet after `tokens.css`, or define palette values outside it.
- Add a third stylesheet that competes with `ui-refresh.css` for global tokens or nav/gallery chrome.
- Put feature-specific layout fixes in `ui-refresh.css` when a feature stylesheet already owns that surface.
- Change the same shell from both `styles.css` and a feature stylesheet without documenting which layer wins.
- Add broad selectors that wrap or resize toolbar/nav/filter text without checking the 1366x768 desktop contract.

---

## Maintenance

- Update this file when reverting or revising any rule above.
- Add a new section every time a UI rule survives a "wait, why?" review.
- Cross-reference rules from CSS comments via the `§<slug>` anchor.
