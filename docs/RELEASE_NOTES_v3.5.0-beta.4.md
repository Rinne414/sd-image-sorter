## v3.5.0-beta.4 — 多图库与 WebP / Libraries + WebP

多图库隔离、续看与每日进度恢复；长距离滚动稳定，NovelAI WebP 提示词不再丢失。

Libraries stay isolated; resume, long scroll, and NovelAI WebP metadata now work.

---

## Fixed / 修复

- **Durable multi-library workspaces**: Create, switch, rename, and remove independent local libraries without leaking images, roots, filters, or destructive actions across workspace boundaries. Existing data is adopted into the default library automatically.
  - **持久多图库工作区**：可创建、切换、重命名与移除彼此独立的本地图库；图片、根目录、筛选条件与危险操作不会跨图库串线，现有数据会自动归入默认图库。

- **Gallery comfort and desktop clarity**: Continue where you left off now restores a real long-scroll position, daily favorite/selection progress counts real interactions, direct navigation fits better, image totals explain missing originals, and entry-page text remains readable on laptop screens.
  - **图库舒适度与桌面清晰度**：「接着看」现可恢复真实长滚动位置；每日收藏/选择进度会统计真实交互；导航更易直达，图片数量会解释缺失原图，笔记本入口页文字也保持清晰。

- **Long-distance virtual scrolling**: Grid, large-card, and waterfall modes stay aligned after large forward and reverse jumps through 6,000+ images, including the 1.3x desktop UI scale. Rendering remains bounded instead of growing with the full library.
  - **长距离虚拟滚动**：标准网格、大卡片与瀑布流在 6,000+ 图片中前后大幅跳转后仍保持对齐，并覆盖 1.3 倍桌面 UI 缩放；渲染数量保持有界，不再随整库增长。

- **NovelAI WebP metadata recovery**: NovelAI V4/V4.5 WebP files that omit the optional Exif sub-IFD terminator now retain the exact positive and negative prompts. Tolerance is scoped to the owning IFD so corrupt parent pointers still produce an explicit metadata error.
  - **NovelAI WebP 元数据恢复**：省略 Exif 子 IFD 结束字段的 NovelAI V4/V4.5 WebP 现可完整保留正向与负向提示词；容错严格限定在所属 IFD，损坏的父指针仍会明确报错。

- **Similarity, Auto-Separate, and VLM guidance**: Similarity distinguishes model preparation from index readiness, Auto-Separate uses the real folder browser with recent destinations and optional subfolder splitting, and VLM settings can probe a stable concurrency value.
  - **相似度、自动分类与 VLM 指引**：相似度页面明确区分模型准备与索引就绪；自动分类使用真实目录浏览器、最近目标与可选子目录拆分；VLM 设置可探测稳定并发值。

---

## Upgrading / 升级注意

- Database migrations 037 and 038 run automatically. They create the default library workspace and scope existing Library Roots without moving, deleting, or rewriting source images.
  - 数据库迁移 037 与 038 会自动执行，建立默认图库工作区并归属现有 Library Roots；不会移动、删除或改写原始图片。

- Beta 3 and older supported installations can update through Check Update. If the UI cannot open, close the app and run the root `update.bat` updater directly.
  - Beta 3 及更早的受支持安装可通过「检查更新」升级；若界面无法打开，请关闭应用并直接运行根目录的 `update.bat`。

- Existing images, tags, projects, models, settings, and the `data/` folder remain outside updater-managed application files. Back up `data/` before beta updates as usual.
  - 现有图片、标签、项目、模型、设置与 `data/` 文件夹仍不属于更新器管理的应用文件；测试版更新前仍建议照常备份 `data/`。

---

## Validation / 验证

Full local CI passed: 5,639 backend tests and 748 passed / 2 skipped desktop Playwright tests with 0 failed and 0 flaky. Package integrity, portable startup, and previous-version update verification follow before publication. / 完整本地 CI 已通过：后端 5,639 项；桌面 Playwright 748 通过、2 跳过、0 失败、0 flaky。发布前将继续完成归档完整性、portable 启动与旧版更新验证。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-beta.4-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-beta.4-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-beta.4-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-beta.4-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-beta.4-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.0-beta.4-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.0-beta.4-windows-portable.zip` | `0a222cbed2f5bf5314442475f94b66673aaa08423a450bd0c5f73df0151cf045` |
| `sd-image-sorter-v3.5.0-beta.4-app-patch.zip` | `751f1c6dc896cc4e80d591605b7a6e356852f343c25950f539736eedfb942844` |
| `sd-image-sorter-v3.5.0-beta.4-linux.tar.gz` | `e46fc903e3d5d136200528a5617da7c1438db9ee4d98de6d228df2ff6750a1d1` |
| `sd-image-sorter-v3.5.0-beta.4-linux-portable-x86_64.tar.gz` | `3ee25b4878ce2913a7075bdb286ba40949e1e97b1733b8587977ef69ca263abb` |
| `sd-image-sorter-v3.5.0-beta.4-linux-portable-aarch64.tar.gz` | `c00144fa202522e779f163290d82cf2f0c3bc6b1a49f2c4d4e71cb5f6dde3fdb` |
| `sd-image-sorter-v3.5.0-beta.4-release-manifest.json` | `d6bfe8c3a298a49ce3216c2fdd9f51314fed4301c499aa312aff98f6b458a794` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
