# SD Image Sorter Vopus — UI Design Rules

This document describes the Vopus interface (formerly V4; `frontend-v4/`, React
+ TypeScript, served at `/v4/`; `/` redirects there). It has two layers: **§principles** is
the design philosophy every surface must serve; the sections after it are
**micro-invariants** that survived a "wait, why?" review. When a change
conflicts with either layer, the change is wrong; see `docs/AI_PRINCIPLES.md`
for the authority order. The D-numbers below point to the decision log,
`.plans/v4/decisions.md`, which is kept next to the checkout and is not part
of the repository (`.plans/` is ignored).

---

## §principles — The design principles (macro layer)

Distilled from owner directives 2025–2026. Read this before adding any
feature, entrance, or surface.

### Product layer (owner-set, highest authority)

1. **One-stop tool.** Managing / tagging / sorting / censoring / publishing SD
   images never requires a second program.
2. **Comfort > stability > speed** — in that order (owner ranking).
3. **Serve pros AND newcomers by layering, never by capping.** Do not limit or
   remove functionality for "safety" or "performance" without asking the owner.
4. **Desktop/laptop only (≥ ~1280px).** No mobile/tablet effort, ever
   (owner directive 2026-06-05, recorded in `CLAUDE.md`).

### Product narrative — what this app *is* (owner 2026-08, highest for library)

This section decides product direction when Gallery, workspaces, storage, or
"multiple sets of images" features conflict. UI copy, defaults, and new
architecture must obey it. Detailed rules: **§product-narrative** below.

**One-line pitch (EN):** A local multi-library workbench for SD images — files
stay on disk; each long-lived library is a switchable workspace you can clear
or delete without touching the others.

**One-line pitch (中文):** 本机多图库工作台：图片仍在你的文件夹里；每本图库是
可切换、可单独清空/删除的长期工作集，互不影响。

**Hard product truths:**
- **Libraries are long-term** — not process-lifetime "sessions." Restart must
  not wipe a library the user did not clear.
- **Multiple libraries (workspaces)** — user can hold several; **one is
  current**. Clear gallery = clear **current** library only. Delete library =
  remove that workspace; others remain.
- **Files stay where the user put them** — we index paths; we do not become the
  primary bulk store of original pixels.
- **No short-term gallery product** — "just scanned this pile" uses sort/filter
  (e.g. newest / folder), not a second disposable gallery world.
- **Within one library:** roots + folders + collections + tags. **Across
  isolation boundaries:** switch/create/delete libraries (not equal chrome to
  generator tabs).
- **Storage we own:** per-library index (+ thumbs strategy) and shared optional
  AI models. **Storage we do not own:** original image folders.

When in doubt: behave like local multi-catalog tools (Eagle libraries /
Lightroom catalogs class) — durable workspaces, explicit clear/delete — never
like a temporary viewer or two peer "session vs permanent" galleries.

### Shell and information architecture (Vopus)

5. **Three places, one toolbox.** The top bar holds 图库 (Library), 批次
   (Batches) and 分拣 (Sort); everything else is reached from 工具 (Tools),
   ⚙ (Settings) or Ctrl K. Home (the brand button) shows the ★5 film strip,
   where you left off, and the three ways to start. Settings and Tools are
   pages (`#/settings/<tab>`, `#/tools/<tool>`, D43), not modals.
6. **A batch is an ordered, saved set of images with steps.** Pixiv
   (挑图 → 打码 → 排顺序 → 命名 → 导出), dataset (挑图 → AI 打标 → 改标签 → 检查
   → 导出) and custom batches share one step rail; steps can be switched off
   and reordered. Every "group of images" workflow is a batch; do not add a
   parallel concept.
7. **Click inspects, double-click opens.** In the library a click shows the
   image's generation card in the right column; double-click or Enter opens
   the lightbox (one image up close); `I` toggles the right column.
8. **Esc closes only the topmost layer and never navigates** (D8).
9. **Never cage.** Every feature is reachable from at least two places (its
   page or menu, plus Ctrl K). A feature missing from Ctrl K is hard to find.
10. **Entrances may duplicate; implementations must not.** Two entrances to
    one feature call the same function or open the same page.

### Visual language (Vopus's own; D9, D10)

11. **Two themes of Vopus's own, never a copy of V3.5's Dusk.** Dark
    "darkroom" (warm near-black, paper-white type, amber edge print) and
    light "proof" (a contact sheet on proof paper, ink type). The default
    follows Windows; the choice is stored in `sd-v4-theme`.
12. **One spot colour per role.** Amber (`--accent`) marks focus, the active
    tab and the current step; vermilion (`--marker`) marks picked frames;
    cyanotype blue (`--ai`) marks what a model produced. Status colours
    (`--ok`, `--warn`, `--danger`) are data and sit next to words or a glyph.
    Primary buttons are printed in ink (`--ink-button`): paper-white on dark,
    ink-black on light. One primary per area.
13. **Film is the shape of a group of images.** The home film strip, the
    lightbox strip and every batch card are drawn as film (black rebate,
    sprocket holes, amber edge print). A batch card is a contact sheet: only
    its real frames, then "+N" for the rest, and under it a step track of the
    batch's own switched-on steps (done, current in amber, still to come).
    An empty batch or inspector shows one unexposed frame, never grey
    placeholder boxes. Film keeps the same black rebate in both themes, like
    a contact print.
14. **Must not look AI-made** (owner rule, D10): no purple or indigo
    gradients, glass or blur, glow, emoji or sparkle icons, pills everywhere,
    or stock icon sets. Icons are drawn by hand in `src/ui/Icon.tsx`. The
    image is the only thing that may glow.
15. **Contrast floors** (checked by script, D9): body text at least 9:1,
    muted text at least 5:1, accents at least 5:1, in both themes.
16. **Bilingual completeness.** Every string exists in `zh-CN` and `en`
    (the i18n types enforce key parity). Chinese strings are Simplified
    Chinese with no English hints, no Taiwan terms, and never the word
    "app" (use 程序). Errors a user can see have a Chinese version.
17. **Dangerous operations sit apart from common ones.** Delete, Trash and
    "remove from library" use the danger button with focus on Cancel (D15),
    and sit at the far end of their row or behind a divider in menus.
18. **Filled controls, readable labels** (owner choice A, 2026-09-28).
    Buttons are filled surfaces, not outlines; buttons, text fields and
    selects share one height (`--control-h`) so a row lines up. Corners are
    `--radius` on controls, `--radius-lg` on cards, `--radius-sm` inside
    them. Section labels are `--fs-2` in `--text-2`, never tiny muted caps.
    Counts are ordinary text in `--muted`; mono and amber stay for edge print
    and data. A chosen option wears the accent wash and edge, like a checked
    row.

Do NOT:
- Add a second "group of images" concept next to batches (rule 6).
- Define a colour, font size or radius outside `tokens.css` (§css-ownership).
- Import an icon package or add emoji to the interface (rule 14).
- Hide or remove capability to simplify a surface; layer it instead (rule 3).

---

## §product-narrative — Multi long-lived libraries / workspaces

Owner decision context (2026-08): the product began as a one-shot "scan this
folder, work, restart clears memory" gallery, then grew a permanent
`images.db` index (Eagle/Billfish-class local library). A header
"current_session vs library" scope fought both stories. Owner ruling:

1. **No short-term gallery product** — batch focus = sort/filter (newest,
   folder), not a disposable second gallery.
2. **Yes multi long-lived libraries (workspaces)** — user can keep several;
   clear/delete applies to the **current** one (or a chosen one), not all.
3. **Cloud is not required** for long-term memory.

Naming: user-facing **图库 / Library** (or **工作区 / Workspace**). Avoid
**session** in UI — it collides with process-lifetime `gallery_session_*` and
implies data will vanish.

### What we are

- **Local-first multi-library workbench** for SD images on desktop/laptop.
- **Index and work**, do not hostage files: originals stay on disk; each
  library indexes membership, metadata, tags, and work state.
- **Many libraries, one current:** default first-run library e.g. **主图库**.
  User can create, switch, rename, clear, or delete libraries.
- **Clear gallery** = clear **current library** index/membership only; other
  libraries untouched. Confirm with the library name.
- **Delete library** = remove that workspace entirely; others remain. Default
  does **not** delete original files on disk.
- **Within one library:** roots, folder tree, collections, tags, sort/filter
  (including by import/index time for "what I just added").

### What we are not

- Not a process-lifetime session gallery (`gallery_session_images` as a user
  concept).
- Not two peer worlds "本次会话 / 永久图库" in the Gallery header.
- Not a cloud account product as the core promise.
- Not "one .db per source folder" by default.
- Not auto-wiping library rows on app exit.

### User-facing story (copy tone)

| Moment | Say this (sense) | Do not say this (sense) |
|--------|------------------|-------------------------|
| First open | 主图库 — import folders into this library | Temporary session |
| After scan | Added to **current library** · sort by newest if needed | Opened short-term gallery |
| Restart | All libraries still here; last current library restored | Sessions were wiped |
| Clear | Clear **this** library (name shown); others kept | Clear everything forever (unless only one exists and copy says so) |
| Delete library | Delete library "训练-2026"; files on disk kept | Delete session |
| Switch | Current library ▾ | Session scope toggle next to generators |
| Storage | Per-library index/thumbs + shared models; originals in your folders | We store all your pixels in the app |

Prefer **图库 / Library** over **永久图库**; prefer **当前图库** over **本次会话**.

### Information architecture

```
App
└── Libraries (workspaces) — long-lived, switchable
    ├── 主图库          ← default current
    ├── 训练-2026
    └── 私密
         └── inside each library:
              library roots · folder tree · batches · favorites · tags · sort/filter
```

| Need | Mechanism |
|------|-----------|
| Images on D: and E: | Library **roots** + folder tree **inside** current library |
| Curated training pack | A dataset **batch** inside the current library |
| Just scanned a batch | **Sort newest** / filter folder — not a new library |
| Work vs private isolation | **Separate libraries** + switch |
| Wipe only this project | **Clear current library** or **Delete library** |
| Nuke everything | Explicit multi-step; not the default Clear label |

### Clear vs delete (contract)

| Action | Affects | Survives | Originals on disk |
|--------|---------|----------|-------------------|
| Clear current library | Index/membership/tags-as-stored for **this** library | Other libraries | Kept (default) |
| Delete library | That workspace record + its index data | Other libraries | Kept (default) |
| Remove from library (single/batch) | Rows/membership in current library | Rest of library | Kept (default) |
| OS delete file | File gone; index may show missing → reconnect/remove | — | Gone |

**Clear gallery** button must mean **clear current library**, never "all
libraries" and never "only a process session."

### Storage narrative

**User-owned:** original files under user folders.

**App-owned:**
- Library index data (single-db multi-workspace **or** one db/dir per library —
  implementation choice; product speaks in libraries)
- Thumbnails (prefer partition by library id to bound growth)
- Shared optional AI models (not duplicated per library unless necessary)
- Temp / export scratch

Prioritize size honesty + cleanup (thumbs, models, vacuum) over cloud quotas.

### Decisions this narrative freezes

- Short-term gallery / process session as a **product** → **no**.
- Long-lived multi-library workspaces → **yes** (Phase 1 = one named library;
  Phase 2 = many).
- Clear gallery → **current library only**.
- Delete library → **explicit**; keeps other libraries; defaults keep files.
- "Just imported" → **sort/filter**, not scope world.
- Cloud → **out of core** until explicitly prioritized.
- Restart → restore **last current library**; no silent wipe.

### Do NOT

- Ship header "本次会话 | 永久图库" as two equal galleries.
- Use the word **session** in user-facing library switching.
- Make Clear wipe all libraries without naming them.
- Auto-create one library per scanned folder.
- Require cloud for durable libraries.
- Clear library data on process exit as a feature.

---

## §desktop-layout — Every page fits 1366×768 through 2560×1440

- Supported widths are desktop and laptop only: test 1366×768, 1920×1080 and
  2560×1440 (plus 3840×2160 when a page scales). Never phone or tablet.
- A page's spec ends with a "fits at W×H" test over `VIEWPORTS`
  (`tests/e2e/fixtures/v4-seed.ts`) that checks the primary action is in the
  viewport (`toBeInViewport`, not `toBeVisible`) and that nothing overlaps,
  clips or scrolls sideways. 37 of the 47 Vopus page specs (`v4-*.spec.ts`) have one (four more specs test the API only); these do not yet:
  browse, dataset-batch, dataset-tagstyle, folder-chooser, libraries, library-status, missing, models, pixiv-export (it checks 2560 on its own) and status. A new page's spec must have one.
  `backend/tests/test_desktop_viewport_contract.py` only rejects browser
  viewports narrower than 1280 px; it does not check that the fits-at tests
  exist.
- The interface zoom follows the window width by default
  (`src/lib/uiScale.ts`: 100% below 2000 px, then 115% / 130% / 140% / 150%
  from 2000 / 2350 / 3100 / 3600 px); the user can pin it in Settings ›
  Appearance. Heights tied to the window use `calc(N * var(--vh))`, never
  `Nvh`, because `vh` is zoomed too.
- A Chinese label never breaks between its characters: tab rows and button
  rows are `flex: none` or `white-space: nowrap`, and give way by shrinking
  the search box, not the labels.

---

## §css-ownership — One owner for every token, one module per component

- `src/design/tokens.css` owns every colour, font, size, radius, layout width
  and motion token, for both themes. Nothing else defines a palette value.
- `src/design/base.css` owns the element reset and the shared control shapes
  (`.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-icon`, `.btn-sm`, `kbd`,
  `.mono`, `.chip` and the tag category classes). Components compose these
  classes; nothing restyles them later.
- Every component styles itself in its own CSS Module (`*.module.css`). A
  module reaches a global class only through `:global(...)`. This removed the
  V3.5 bug class where a later stylesheet silently overrode an earlier one
  (D3).

Do NOT:
- Style another component's module class from outside it.
- Add a global stylesheet next to `tokens.css` and `base.css`.

---

## §color-exemptions — Data colours are exempt from the spot-colour roles

A literal or extra hue is legitimate only when it encodes data. Registered:
- **Tag categories**: 14 `--cat-*` tokens mirroring backend
  `tag_rules.categorize_tag`, used through the `.cat-*` classes.
- **Adjust histogram**: `--hist-r`, `--hist-g`, `--hist-b`.
- **Marks drawn over pictures**: `--on-image`, `--ai-on-image`,
  `--ok-on-image` (they sit on arbitrary pixels, so they do not follow the
  theme's surfaces).

A new hardcoded colour must encode data and be registered here; anything else
uses the role tokens.

---

## §jobs — Background work always ends with a visible result

Imports, tagging, colour analysis, similarity indexing, model downloads and
file moves run as jobs. The jobs button in the top bar shows what is running;
when a job ends it says so (done, failed with the reason, or stopped) and the
result stays in the jobs drawer. A job never just disappears. A followed model
download always ends with its own result (D52).

---

## §motion — Motion clarifies state; it never decorates

- Tokens: `--t-fast` (120 ms) for hover, focus and small toggles; `--t-med`
  (180 ms) for panels, dialogs and page fades; `--ease` for both.
- Animate `transform` and `opacity` for anything large or repeated.
- No ambient loops, parallax or attention-seeking idle motion. Under
  `prefers-reduced-motion` both durations drop to 1 ms.

---

## Maintenance

- Update this file when a rule above is revised or reverted, and record the
  decision in the decision log (`.plans/v4/decisions.md`, outside the
  repository).
- Add a section every time a UI rule survives a "wait, why?" review.
- Cross-reference rules from CSS comments with the `§<slug>` anchor.
