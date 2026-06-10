## v3.3.4 — Gallery Reader Polish + Prompt Workflow Fixes / 图库读图与 Prompt 工作流修复

This release tightens the Gallery image reader experience after v3.3.3: preview information is easier to read, right-click and copy menus behave correctly on 2K screens, and prompt/tag category workflows now expose the useful one-click outputs users actually need.

本版是 v3.3.3 后的体验修复版：图库预览弹窗更适合连续读图，右键菜单与复制菜单在 2K 屏幕不再跑位，Prompt / tag 分类工作流补上实际会用的一键输出。

---

## Fixed / 修复

- **Gallery preview reader / 图库预览读图**: the image preview modal now has a fixed compact header and an independent reading pane. Prompt, negative prompt, tags, and parameters can be read without the low-frequency action buttons taking over the expensive space.
  - 图库图片预览弹窗改为固定紧凑头部 + 独立正文阅读区。Prompt、负向提示词、标签与参数更靠前，低频按钮不再占据正文前面的空间。
- **Preserved reading position / 切图保留阅读位置**: switching to the previous/next image keeps the preview inspector scroll position instead of resetting the reader to the top.
  - 在预览弹窗中切换上一张/下一张时，会保留信息区阅读位置，不再回到顶部。
- **Compact modal tools / 弹窗工具收纳**: Send to Censor Edit, Similar, Dataset, Collection, Prompt Helper, Full Reader, Score, Colors, Artist, and Caption moved into a compact Tools menu; Copy actions stay grouped in a Copy menu.
  - 发送到打码编辑、相似图、Dataset、合集、Prompt Helper、完整读图、美学评分、颜色、画师、描述等低频动作收进 Tools 菜单；复制动作集中在 Copy 菜单。
- **2K menu placement / 2K 菜单定位**: Gallery right-click menus stay near right-side images and clamp inside the viewport. The preview modal Tools menu and close button no longer overlap on 2K layouts.
  - 图库右键菜单在右侧图片附近弹出并保持在视口内。预览弹窗的 Tools 菜单与关闭按钮在 2K 布局下不再重叠。
- **Category and purpose copy / 分类与用途型复制**: Gallery and Reader copy flows can copy category-specific tags, clean training captions, image-search keywords, and other purpose prompts without manually rebuilding the prompt.
  - 图库与 Reader 的复制流程可按分类复制标签，也可一键复制干净训练 caption、搜图关键词等用途型 Prompt，不需要手工重组。
- **Prompt Lab image recipe / Prompt Lab 图片配方**: Prompt Lab can turn tags from a selected gallery image into a categorized prompt recipe, then build a clean prompt while dropping quality/meta noise when needed.
  - Prompt Lab 可从图库图片标签生成分类配方，并一键构建干净 Prompt；需要时可去掉质量词 / 元信息噪音。
- **Smarter tag categories / 更智能的标签分类**: tag category lookup uses the existing danbooru/gelbooru-style category signals and local tagger vocab coverage instead of relying on one-off hardcoded prompt lists.
  - 标签分类优先使用已有 danbooru / gelbooru 风格分类信号与本地 tagger 词库覆盖，不靠一次性手写 prompt 列表堆规则。

---

## Upgrading / 升级注意

- **Zero manual steps.** v3.3.4 does not add a database schema migration. Existing libraries, image files, captions, model files, tags, and ratings are untouched.
  - **零手动操作。** v3.3.4 不新增数据库结构迁移。既有图库、图片文件、caption、模型文件、标签与评分不受影响。
- If the UI still looks stale after updating, do a normal browser refresh once.
  - 如果更新后界面仍像旧版，普通刷新浏览器一次即可。

---

## Validation / 验证

- JavaScript syntax checks passed for the changed Gallery, Reader, UI refresh, and skeleton modal files.
- Playwright targeted checks passed for Gallery preview scroll retention, Reader scroll retention, Reader save/overwrite flows, right-click menu bounds including 2K placement, category copy purpose prompts, and Prompt Lab image-to-category-prompt generation.
- 2K visual QA was checked for the Gallery preview modal and Tools dropdown.
- `git diff --check` reported no whitespace errors; only the repository's normal LF/CRLF warning was shown.

---

## Download / 下载

**Windows → `sd-image-sorter-v3.3.4-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.3.4-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.3.4-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.3.4-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.3.4-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.3.4-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all release assets.
