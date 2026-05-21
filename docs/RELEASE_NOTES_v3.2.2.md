# SD Image Sorter v3.2.2 Release Notes

## Caption Editor — Unlimited Images + Virtual Scroll

The Caption Editor no longer has any artificial image cap. Select 100, 10000, or 100000+ images — the queue uses virtual scroll (only ~30 DOM nodes regardless of count) and fetches captions on-demand when you click an item.

- **Virtual scroll queue**: fixed-height items, absolute positioning, only visible items rendered
- **On-demand caption loading**: clicking a queue item fetches its rendered caption from the backend
- **Keyboard shortcuts**: `Escape` close, `Ctrl+Enter` next, `Ctrl+Shift+Enter` prev, `Arrow Up/Down` navigate
- **Queue count badge**: shows total with amber warning when >1000

## Per-Item Exclude on Filters

Filter chips now cycle: **include** (green) → **exclude** (red strikethrough) → **remove**. Excluded items filter OUT matching images.

Works on: tags, generators, ratings, checkpoints, LoRAs.

Applies everywhere: Gallery, Auto-Separate, Manual Sort, selection tokens.

## Auto-Separate Inline Filter Chip Editing

Each filter row in the left pane now has:
- **Active filters**: clickable row with '×' clear button (clears that dimension, debounced 350ms preview refresh)
- **Inactive filters**: '+' button that opens the filter modal for that field

## Other Fixes

- Filter modal stat grid: all 9 chips (including Color) fit on one row at any width
- Stale "up to 20 images" text removed from export preview helper
- Duplicate `TestExportSelectionData` test class renamed (Debt-25)

---

## 中文摘要

- **Caption 编辑器无上限**：虚拟滚动 + 按需加载，100K 张图也不卡
- **筛选排除**：标签/生成器/分级/模型/LoRA 支持排除（红色删除线）
- **自动分类 inline chip 编辑**：左栏每行可直接清除或添加筛选
- **键盘快捷键**：Esc 关闭、Ctrl+Enter 下一张、方向键导航
- **Filter 9 chips 一行**：颜色不再独占第二行
