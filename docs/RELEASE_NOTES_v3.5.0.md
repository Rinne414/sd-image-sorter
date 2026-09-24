## v3.5.0 — 3.5 正式版：更顺手、不再硬挡 / Stable: Smoother, No Hard Stops

操作栏回到画面、图库不串库、模型准备先说清楚。Batch bar back on screen, libraries stay separate, clearer setup.

---

## Fixed / 修复

This is the stable release of the 3.5 line: everything from 3.5.0-beta.1 to beta.6 (see CHANGELOG) plus the changes below. 3.5 is the last release of the V3 line.
这是 3.5 系列的正式版：包含 3.5.0-beta.1 到 beta.6 的全部内容（见 CHANGELOG），以及下面的改动。3.5 是 V3 系列的最后一版。

- **Gallery batch actions are on screen again**: after selecting images, the Move / Tag / Censor / Collection / More bar sits at the bottom of the window. Selected tiles show a check mark and their pick order.
  - 选好图后，底部操作栏（移动、打标、打码、加入合集、更多）又回到画面上；选中的图显示 ✓ 和顺序。

- **No hard stops**: exports skip problem images instead of refusing, Censor can export un-censored images as they are, and caps on claims, moves, blacklists, tag counts and watermark regions were raised or removed.
  - 不再硬挡：导出会跳过有问题的图而不是拒绝；没打码的图可以选择照原图导出；认领、搬移、黑名单、标签数、水印区域的上限放宽或拿掉。

- **Libraries stay separate**: "Move N into this library" moves every image, the unsaved Dataset draft stays in its own library, and deleting a library also removes its collections and dataset projects.
  - 图库互不串：「移进这个图库」会搬全部；未保存的数据集草稿留在自己的图库；删除图库会一并清掉它的合集和数据集项目。

- **.txt tags and WD14 tags stop overwriting each other**: a re-tag keeps its scored row, a tag the tagger drops comes back from the .txt, and an unchanged sidecar writes nothing on rescan.
  - .txt 标签和 WD14 标签不再互相覆盖：重新打标保留置信度；打标器不再给的标签会从 .txt 回来；sidecar 没变时重扫不写库。

- **Model setup says what happens**: first use states the download size, the packages and whether a restart follows. A restart happens in place from the launcher, and setup continues afterwards.
  - 模型准备先说清楚：第一次使用会告诉你下载多大、装几个包、要不要重启；重启由启动器原地完成，回来后接着准备。

- **Missions show their steps**: the LoRA, Pixiv and Organize missions list what each step asks, with the current step marked.
  - 任务会列出步骤：LoRA、Pixiv、整理任务会写出每一步要做什么，并标出现在在哪一步。

- **Silent failures fixed**: confirm dialogs closed any way count as Cancel, Find near reports a busy AI runtime instead of "CLIP could not read this image", an export never saves an empty file, and late censor renames never reuse a name.
  - 修掉默默失败：确认框用任何方式关掉都算取消；AI 忙时找相似会说清楚；导出不会存成空文件；打码改名不会撞名。

- **Faster**: gallery page 0.36 s to 0.045 s, Mass Tag on 1,000 images 170 s to 106 s, and the dataset audit's full check about 25x faster.
  - 更快：图库翻页 0.36 秒降到 0.045 秒；批量打标 1000 张 170 秒降到 106 秒；数据集完整查重约快 25 倍。

- **Clearer pages**: Censor keeps Save All on screen at 1366x768, the tagger says what Start will tag, repeated explanations were removed, Model Center shows the model cards first, and settings toggles read On / Off.
  - 页面更清楚：1366x768 的打码页看得到「全部保存」；打标会说明这次标哪些图；重复说明拿掉；模型中心先显示模型卡片；设置开关统一显示开 / 关。

- **Chinese UI is Chinese**: 73 tooltips and 5 placeholders follow the UI language, the default library shows as 主图库, and each thing has one name.
  - 中文界面全是中文：73 个提示和 5 个占位文字跟着界面语言；默认图库显示为「主图库」；同一个东西只用一个名字。

- **Python 3.11 portable fix and a quieter launcher**: folder scans no longer crash on a bundled Python 3.11, and missing thumbnails no longer flood the launcher window.
  - 可携版内嵌 Python 3.11 扫描文件夹不再崩溃；缺缩略图不再刷满启动器窗口。

---

## Upgrading / 升级注意

- The first launch adds two database indexes (migrations 047 and 048). It takes a second or two; nothing needs re-scanning.
  - 第一次启动会加两个数据库索引（迁移 047、048），只要一两秒，不需要重扫。
- 3.5.0-beta users and 3.4.3 users are both offered this update in the app.
  - 3.5.0 beta 用户和 3.4.3 用户都会在应用内收到这次更新。

---

## Validation / 验证

Backend 6,734 passed, 9 skipped; desktop E2E 892 tests: 890 passed, 0 failed, 2 skipped. / 后端 6,734 个通过、9 个跳过；桌面 E2E 892 项：890 通过、0 失败、2 跳过。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.0-windows-portable.zip` | `58485ee1c11feb69d93c8746a959403625bcd6e9e0a01a9a9f71e7f8de338d0a` |
| `sd-image-sorter-v3.5.0-app-patch.zip` | `93821ec215a24797b1e40743b0314c5f04ede087a8eca06315a6d7a13b006de8` |
| `sd-image-sorter-v3.5.0-linux.tar.gz` | `5c101f097019c4e1f810c518f0eb210333c39978a93d041cc2bfe3e4e15b014b` |
| `sd-image-sorter-v3.5.0-linux-portable-x86_64.tar.gz` | `7a8d14340a5f238fa218add338bef757b22236506bac173c7a6dd887fcb7d251` |
| `sd-image-sorter-v3.5.0-linux-portable-aarch64.tar.gz` | `a78fcdf67f3f156538d48e4562d18b2427e68da8f55e20d8245200076e454ef4` |
| `sd-image-sorter-v3.5.0-release-manifest.json` | `b3a57b634e2a344d10a6ffd9c9ba9cceffc77e3bdb295471c89b367ec5fcc175` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
