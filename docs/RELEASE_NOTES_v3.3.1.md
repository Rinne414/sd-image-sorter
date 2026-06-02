## v3.3.1 — 合集界面 + 功能互联 + Aurora 视觉翻新 / Collections UI + Connections + Aurora Glass

把 v3.3.0 只做了后端的「收藏与合集」补成完整体验：左侧栏合集区、按合集浏览、新建 / 重命名 / 删除、右键「加入合集」（支持多选）。相似度搜索与 WASD 手动分拣可指向某个合集，Prompt Lab 与图库互相跳转。全站换上「Aurora Glass」靛→青视觉。未新增任何功能上限。

Finishes the Favorites & Collections experience whose backend shipped in v3.3.0: a left-sidebar Collections section, browse-by-collection, create / rename / delete, and multi-select "Add to collection". Similarity search and the WASD manual sort can target a collection; Prompt Lab and the gallery cross-link. Plus a full Aurora Glass indigo→cyan refresh.

---

## ✨ Added / 新增

- **Favorites & Collections UI** — the read / browse / manage half of the feature. v3.3.0 shipped the heart toggle and the `/api/collections` backend, but there was no way to *see* what you favorited or to use named collections. Now a left-sidebar **Collections** section lists Favorites plus your named collections with live counts; click one to browse only its images. Create, rename, and delete collections inline (the Favorites collection is protected from deletion). A right-click **Add to collection** menu works on a single image or a multi-select batch.
  - **收藏与合集界面** —— 补上「查看 / 浏览 / 管理」这一半。v3.3.0 做了爱心切换和 `/api/collections` 后端，但没有地方查看收藏、也无法使用具名合集。现在左侧栏新增 **合集** 区，列出收藏与你的具名合集（带实时数量）；点一下即可只浏览该合集的图片。可就地新建 / 重命名 / 删除（收藏合集受删除保护）。右键 **加入合集** 菜单支持单张或多选批量。

---

## 🔗 Connections / 功能互联

- **Collections everywhere** — browse a collection straight from the sidebar, and add a selection to a collection from the gallery context menu. Collections thread through the existing gallery filters via a new `?collection_id=` scope.
  - **合集贯穿全站** —— 从侧栏直接浏览某个合集，从图库右键菜单把选中项加入合集。合集通过新的 `?collection_id=` 过滤参数贯穿既有图库筛选。
- **Similarity ↔ Collections / Favorites** — scope a similarity search to a single collection (or Favorites) so "find more like this" stays inside the set you care about. Results are identical to the global search, just bounded.
  - **相似度 ↔ 合集 / 收藏** —— 把相似度搜索限定在某个合集（或收藏）内，让「找更多类似的」停留在你关心的集合里。结果与全局搜索一致，只是范围受限。
- **Manual Sort ↔ Collections** — the WASD manual sort gains a per-slot **Collection** target: a keypress adds the image to a collection *by reference* (no file move), with full undo / redo in the same history as folder moves.
  - **手动分拣 ↔ 合集** —— WASD 手动分拣新增每槽位的 **合集** 目标：一次按键把图片按引用加入合集（不移动文件），并与文件夹移动共用同一套撤销 / 重做历史。
- **Prompt Lab ↔ Gallery** — send a built prompt's terms straight into the gallery as a filter, and jump from any image back into the Lab. (The reverse direction was wired but treated the whole prompt as one exact term; it now splits on commas.)
  - **Prompt Lab ↔ 图库** —— 把构建好的 prompt 词条直接当图库筛选用，并能从任意图片跳回 Lab。（反向跳转之前把整段 prompt 当成单个精确词；现在按逗号拆分。）

---

## 🎨 Changed / 变更

- **"Aurora Glass" visual refresh** — a unified indigo→cyan accent over refined dark glassmorphism, replacing the previous amber / teal palette. The whole theme is token-driven, so accents, gradients, borders, glows, focus rings, and hover states move together across every view (gallery, Prompt Lab, dataset, censor, model manager).
  - **「Aurora Glass」视觉翻新** —— 统一的靛→青强调色配精修的深色玻璃拟态，取代旧的琥珀 / 青绿配色。整套主题 token 驱动，强调色、渐变、边框、光晕、聚焦环、悬停态在所有视图（图库、Prompt Lab、数据集、打码、模型管理器）一起更新。

---

## 🛠️ Fixed / 修复

- **Collection browse total count** — browsing a collection reported the whole library's image count as the gallery total. The cursor-path count now honors the collection filter, so the reported total matches what you actually see.
  - **合集浏览总数** —— 浏览合集时图库总数显示的是整库数量。游标路径的计数现在会遵守合集筛选，显示的总数与你实际看到的一致。

---

## ⚙️ Internal / 内部

- **Hermetic E2E artist runtime** — the model-manager E2E suite no longer resolves the LSNet artist runtime to a developer's real `models/artist/` checkout. Both runtime resolvers skip the legacy in-repo paths when `SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY=1` (set only by the test harness; production never sets it and resolves legacy installs exactly as before), so local runs match clean CI.
  - **E2E 画师运行时隔离** —— model-manager E2E 不再把 LSNet 画师运行时解析到开发者本机真实的 `models/artist/` 目录。两个运行时解析器在 `SD_IMAGE_SORTER_DISABLE_LEGACY_MODEL_COPY=1` 时跳过 repo 内 legacy 路径（仅测试环境设置；生产从不设置、对 legacy 安装的解析完全不变），本机结果与干净 CI 一致。

---

## ⚠️ Upgrading / 升级注意

- **Near-zero manual steps.** No destructive migration: Favorites & Collections reuse the existing collection tables as references (no image files are copied or moved), and the visual refresh is pure CSS. In-app updater users get it via **Check Update**; portable users extract the new archive as usual. A normal F5 refetches the restyled assets (the cache-bust token follows the version).
  - **几乎零操作。** 无破坏性迁移：收藏与合集以引用方式复用既有合集表（不复制、不移动任何图片文件），视觉翻新是纯 CSS。更新器用户走 **检查更新** 即可；便携版用户照常解压新档。普通 F5 即可重新拉取换肤后的资源（缓存失效令牌跟随版本号）。

---

## ✅ Validation / 验证

- Backend: full pytest suite green on Python 3.12 (collections `collection_id` filter + total-count regression, similarity scoping parity, manual-sort collect/undo/redo, and a new hermetic artist-runtime resolver test included). `ruff check backend`: clean. Lock freshness + dependency security audit + frontend JS syntax: green.
- Playwright E2E: critical gallery / scan / move / filter flows pass; the model-manager artist-runtime spec is now green on dev machines too, not just clean CI.
- Visual refresh verified live (gallery + Prompt Lab + Dataset) with 0 CSS-caused console errors; grep confirms 0 leftover legacy accent colors across all CSS.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.3.1-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.3.1-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.3.1-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.3.1-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.3.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
