## v3.7.0 — 两套界面 + 操作更稳 / Two Interfaces + Safer Operations

两套界面在设置里切换；升级前自动备份数据库；移动、撤销如实说明结果；Ctrl+Shift+R 能强制刷新。

Two interfaces in one program, a backup before upgrades, honest moves and undo.

---

## Fixed / 修复

- **Two interfaces, one library**: the classic interface stays at the start page; Vopus, the second interface, opens at `/vopus/` (old `/v4/` links lead there). Settings → Interface switches between them and the choice is remembered; both show the same library. Release packages include Vopus ready to use. Vopus brings a home page with a film strip of your five-star and newest pictures, W A S D and A/B sorting, condition sorting into folders as an undoable job (several rules per run), dataset batches with templates that can be saved as a new batch, and Model Center downloads that resume after a restart.
  - **两套界面，同一个图库**：经典界面仍是首页；第二套界面 Vopus 在 `/vopus/`（旧的 `/v4/` 链接会自动跳过去）。设置 → 界面 可以切换，选择会被记住；两套界面看到的是同一个图库。发布包里已经带好 Vopus。Vopus 有：首页胶片条展示你的五星图和最新的图、W A S D 与 A/B 对决分类、按条件分进文件夹（可一次多条规则，整批可撤销）、带模板的数据集批次（可另存为新批次），以及重启后能接着下载的模型中心。
- **Database backup before upgrades**: before the database is upgraded, a copy is saved to `data/backups` (the newest three are kept). Libraries that Vopus 1.0.0 had already upgraded are repaired on the first start.
  - **升级前备份数据库**：数据库升级前会先复制一份到 `data/backups`（保留最近三份）。用过 Vopus 1.0.0 的图库会在第一次启动时自动修复。
- **Operations tell the truth and can be undone again**: moves, Auto-Separate, dataset export, batch censoring and undo always say how they ended. An undo that left some files behind can be run again; a cross-drive move whose source could not be removed takes its copy back; a publish export says what each file lost and can no longer damage the file it replaces; a censor save asked to keep the metadata says when it could not.
  - **操作结果如实说明，撤销能再跑一次**：移动、自动分类、数据集导出、批量打码和撤销都会说明最后结果。没撤销完的可以再撤销一次；跨磁盘移动删不掉原图时会把复制出去的那份收回；成套发布导出会说明每个文件丢了什么，也不会再弄坏被替换的文件；打码保存要求保留元数据却做不到时会告诉你。
- **Keyboard and back button**: single-letter shortcuts no longer fire while Ctrl, Alt or ⌘ is held, so Ctrl+Shift+R (hard refresh), Ctrl+L, Ctrl+F and other browser keys work again. The browser Back button and the mouse back button go up one level, like Esc. Dialogs take focus, Esc closes only the topmost one, Tab stays inside, and focus returns to the button that opened it.
  - **键盘和后退键**：按住 Ctrl、Alt 或 ⌘ 时，单字母快捷键不再触发，Ctrl+Shift+R（强制刷新）、Ctrl+L、Ctrl+F 等浏览器按键恢复正常。浏览器后退键和鼠标侧键会像 Esc 一样退一层。对话框会取得焦点，Esc 只关最上面一层，Tab 不会跑出对话框，关闭后焦点回到打开它的按钮。
- **Keeps your place**: switching views or refreshing keeps the picture you were reading; a new sort, filter, search or library opens its results at the top.
  - **记住你看到哪里**：切换视图或刷新时停在你正在看的图；换排序、筛选、搜索或图库时从结果顶部开始。
- **Dataset Maker**: filter the queue by tags, add a tag to the selected images from an in-app field, and edited captions get the same export clean-up. A large queue (800+) stays in place when you click a picture, and the workbench fits 1366×768.
  - **数据集工作台**：队列可以按标签筛选，可以在程序里直接给选中的图加标签，手动改过的 caption 导出时也会被整理。大队列（800 张以上）点图时不会跳动，工作台在 1366×768 下排得下。
- **Sorting and libraries**: Manual Sort asks before resuming an unfinished sort that belongs to another library. Collections, duplicate scans, artist results and tag backups stay inside the current library.
  - **整理与图库**：要继续别的图库没做完的手动排序前，会先问你。合集、查重结果、画师识别结果和标签备份都只属于当前图库。
- **Prompt Lab**: an exclusion rule can exclude a whole category, the "tag is missing" condition is checked, and seed and count reach tag sets.
  - **提示词助手**：排除规则可以排除整个分类，「缺少某个标签」条件生效，种子和数量会套用到标签组。
- **Security updates**: fsspec 2026.6.0 (CVE-2026-104851), anyio 4.14.2 and transformers 5.10.4.
  - **安全更新**：fsspec 2026.6.0（CVE-2026-104851）、anyio 4.14.2、transformers 5.10.4。
- **README: what goes online**: a new section lists every feature that connects to the internet and what it sends.
  - **README：哪些功能会联网**：新增一段，列出每个会联网的功能和它送出什么。

---

## Upgrading / 升级注意

- The first start upgrades the database and saves a copy to `data/backups` first. Older versions cannot open the upgraded database; to go back, restore that copy.
  - 第一次启动会升级数据库，升级前先在 `data/backups` 留一份副本。旧版本打不开升级后的数据库；想退回旧版时，请用这份副本。
- If you installed Vopus 1.0.0 on its own, its update button only looks for Vopus releases and will not offer this version. Download this package once by hand; after that, both interfaces update together.
  - 如果你单独装过 Vopus 1.0.0，它的更新按钮只找 Vopus 的版本，看不到这一版。请手动下载一次这个包，之后两套界面会一起更新。

---

## Validation / 验证

Filled in from the release gate before the packages are built. / 打包前填入发布检查结果。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.7.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.7.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.7.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.7.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.7.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.7.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

Added after the packages are built. / 打包完成后补上。
