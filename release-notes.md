## v3.8.1 — 英文单复数 + 中文补全 / English Counts + Chinese Gaps

英文数量为 1 时用单数，不再写 image(s)；中文界面里残留的英文提示补上中文。

English counts read right for one; leftover English in Chinese mode is translated.

---

## Fixed / 修复

- **English counts / 英文数量**: every count in the classic interface, Vopus, the program's messages and the browser extension says the singular for one ("1 image is", "1 region", "1 problem stops this export"), and no text writes "image(s)" any more. Sentences that could not read right for one were reworded.
  - 经典界面、Vopus、程序消息和浏览器扩展里的英文数量为 1 时用单数（如 "1 image is"、"1 region"），不再写 "image(s)"；数量为 1 时读不通的英文句子改写了。
- **Chinese where English was left / 补齐中文**: Queue Solitaire's undo messages, the Censor queue's "loaded" line, the image counts in Prompt Lab's stats, the Smart Tag overwrite question, the VLM model list status, the artist cards' image count and the Mass Tag scope follow the language setting.
  - 队列接龙的撤销提示、打码队列的「已载入」、提示词实验室统计里的张数、Smart Tag 覆盖确认、VLM 模型列表状态、画师卡片的张数和批量标签的范围，现在都跟着语言设置走。
- **A picture opened during an import / 导入中打开的图片**: a picture opened while a quick import is still reading it says "Still reading this picture's details…" and fills in by itself, instead of "Size null×null", "Generator Unknown" or "Couldn't recover a prompt" (classic preview and Vopus card).
  - 快速导入还在读取时打开的图片，会显示「还在读取这张图的信息…」并在读完后自动填上，不再显示 "null×null"、「未知生成器」或「没能读出提示词」（经典预览和 Vopus 卡片）。
- **Text with special characters / 特殊字符**: file names, tags and other values that contain `$&` or `{…}` show exactly as written in messages.
  - 文件名、标签等内容里有 `$&` 或 `{…}` 时，消息里原样显示。

---

## Upgrading / 升级注意

- Nothing to do for the program. For the extension's "Save 1 picture", open Settings > Browser extension once (it rewrites the extension folders), then press Reload on the browser's extensions page; in Firefox, load the temporary add-on again.
  - 程序本身无需操作。想让扩展显示「保存 1 张图片」：打开一次 设置 > 浏览器扩展（会重写扩展文件夹），再到浏览器的扩展页点「重新加载」；Firefox 要重新载入临时附加组件。

---

## Validation / 验证

GitHub CI run 40380041166 (Linux full suite with browser tests and click coverage, macOS, Windows, Linux portable x86_64 and aarch64): 5 of 5 green; browser tests 1,928 passed, 0 failed, 0 flaky. Locally: backend 9,235 passed plus the new count, i18n and preview checks; Vopus typecheck and 1,173 unit tests; every changed browser spec rerun. The new browser tests for a picture opened during an import fail on 3.8.0 and pass now. A fresh 3.8.1 Windows package was extracted and run as a new user (English and Chinese counts, both interfaces, no console errors). 3.8.0 itself was checked on the published packages: Firefox 158 extension (pair, Allow, save a picture with its page), Linux x86_64 package in Ubuntu, desktop tray, folder-watch switch, Quick collect, and a gallery drag handing the real file to Windows (the drop into another program needs a hand-held mouse).
  - GitHub CI（40380041166：Linux 完整测试含浏览器测试和点击覆盖、macOS、Windows、Linux 便携版 x86_64 与 aarch64）5 项全部通过；浏览器测试 1,928 通过、0 失败、0 个偶发。本机：后端 9,235 通过，另加新的数量、多语言和预览检查；Vopus 类型检查和 1,173 个单元测试；每个改动过的浏览器测试都重跑。新加的「导入中打开图片」浏览器测试在 3.8.0 上失败、现在通过。全新的 3.8.1 Windows 包解压后以新用户身份运行（中英文数量、两套界面、无控制台错误）。3.8.0 本身也用发布的包检查过：Firefox 158 扩展（配对、在程序里允许、连同来源页面保存图片）、Ubuntu 上的 Linux x86_64 包、桌面程序托盘、监看开关、快速收集，以及从图库拖出时把真实文件交给 Windows（放进别的程序那一步要真人按住鼠标）。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.8.1-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.8.1-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.8.1-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.8.1-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.8.1-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.8.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.8.1-windows-portable.zip` | `dac61fa0d061f83dea11a713510a915c5d2c14f00e1ab895602989bec3aa5652` |
| `sd-image-sorter-v3.8.1-app-patch.zip` | `90d7823c7d228ac67e8645ee084e0c66d964862a49ddee895cd8d787ed01b42e` |
| `sd-image-sorter-v3.8.1-linux.tar.gz` | `b2eecdf230c36c2531e620ac2dbc49398c6d19b832b7df59cf3b3db50550ac63` |
| `sd-image-sorter-v3.8.1-linux-portable-x86_64.tar.gz` | `fc0e13c3e10a40554a96055baabaa5b1c3781d35497769fa556fe55800f6ccc2` |
| `sd-image-sorter-v3.8.1-linux-portable-aarch64.tar.gz` | `9a509ad49eaccca8ed19ca9687a5906e268b4616f0bb822d6c478c00dd6fc078` |
| `sd-image-sorter-v3.8.1-release-manifest.json` | `58b08aee8919a464d3bb05d21c76252e103c7a46ada4797e0f0177c8b2779d18` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
