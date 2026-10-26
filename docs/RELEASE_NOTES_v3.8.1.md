## v3.8.1 — 英文单复数 + 中文补全 / English Counts + Chinese Gaps

英文数量为 1 时用单数，不再写 image(s)；中文界面里残留的英文提示补上中文。

English counts read right for one; leftover English in Chinese mode is translated.

---

## Fixed / 修复

- **English counts / 英文数量**: every count in the classic interface, Vopus, the program's messages and the browser extension says the singular for one ("1 image is", "1 region", "1 problem stops this export"), and no text writes "image(s)" any more. Sentences that could not read right for one were reworded.
  - 经典界面、Vopus、程序消息和浏览器扩展里的英文数量为 1 时用单数（如 "1 image is"、"1 region"），不再写 "image(s)"；数量为 1 时读不通的英文句子改写了。
- **Chinese where English was left / 补齐中文**: Queue Solitaire's undo messages, the Censor queue's "loaded" line, the image counts in Prompt Lab's stats, the Smart Tag overwrite question, the VLM model list status, the artist cards' image count and the Mass Tag scope follow the language setting.
  - 队列接龙的撤销提示、打码队列的「已载入」、提示词实验室统计里的张数、Smart Tag 覆盖确认、VLM 模型列表状态、画师卡片的张数和批量标签的范围，现在都跟着语言设置走。
- **Text with special characters / 特殊字符**: file names, tags and other values that contain `$&` or `{…}` show exactly as written in messages.
  - 文件名、标签等内容里有 `$&` 或 `{…}` 时，消息里原样显示。

---

## Upgrading / 升级注意

- Nothing to do for the program. For the extension's "Save 1 picture", open Settings > Browser extension once (it rewrites the extension folders), then press Reload on the browser's extensions page; in Firefox, load the temporary add-on again.
  - 程序本身无需操作。想让扩展显示「保存 1 张图片」：打开一次 设置 > 浏览器扩展（会重写扩展文件夹），再到浏览器的扩展页点「重新加载」；Firefox 要重新载入临时附加组件。

---

## Validation / 验证

VALIDATION_PENDING

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

Filled in after the packages are built. / 打包后填入。
