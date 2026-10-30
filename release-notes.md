## v3.10.2 — 桌面程序修复 + 更新说明 / Desktop Fixes + What's New

桌面程序能新建、重命名图库；询问都用程序自己的对话框；更新后说明改了什么。

Desktop program creates and renames libraries; questions use its own dialogs; updates say what's new.

---

## Fixed / 修复

- **New library and Rename library work in the desktop program / 桌面程序里能新建和重命名图库**: Both asked for the name with the browser's prompt box, which the desktop program does not have (it throws "prompt() is not supported"), so the buttons did nothing there. They, and naming a collection or a sorting section, now ask in the program's own dialog. A check fails if a page uses the browser prompt box again.
  - 这两个按钮用浏览器自带的输入框询问名称，而桌面程序没有这种输入框（会报错 "prompt() is not supported"），所以在桌面程序里按了没反应。现在它们，以及给合集或整理分组命名，都改用程序自己的对话框。如果再有页面使用浏览器输入框，检查会失败。
- **Every question is asked in the program's own dialog / 所有询问都用程序自己的对话框**: Deleting a library, trashing duplicates, removing images from a dataset or an audit, overwriting captions with Smart Tag, changing tags on every image of a batch export and selecting more than 10,000 filtered images asked with the browser's own box ("127.0.0.1:8487 says", buttons not translated; a plain system box in the desktop program). They now ask in the program's dialog: Escape answers no, and a question that removes or overwrites something starts on Cancel. When Smart Tag cannot start, the message is now translated. A check fails if a page uses the browser's confirm or alert box again.
  - 删除图库、把重复图片移到回收站、从数据集或审查结果里移除图片、用智能打标覆盖已有标注、批量导出时给所有图片增删标签、选中超过 1 万张筛选结果，以前都用浏览器自带的确认框询问（显示“127.0.0.1:8487 显示”，按钮没有翻译；桌面程序里是系统自带的对话框）。现在都改用程序自己的对话框：按 Esc 等于“取消”，会删除或覆盖内容的询问默认停在“取消”上。智能打标无法启动时的提示现在也有中文。如果再有页面使用浏览器的确认框或提示框，检查会失败。
- **After an update the program says what changed / 更新后会说明改了什么**: The first time the program opens after an update (classic or V Opus; seen in one counts for both), a notice shows the new version's summary from its release notes, in the interface language, with a Full notes link; it shows once and leaves after 15 seconds. A fresh install shows nothing. An install updated from a version before this notice existed still gets it when its library holds pictures.
  - 更新后第一次打开程序时（经典界面或 V Opus，在一个里看过就不会在另一个里再出现），会显示新版本发布说明里的摘要（跟随界面语言），并附“完整说明”链接；只显示一次，15 秒后自动消失。全新安装不会显示。从还没有这个提示的旧版本更新上来时，只要图库里有图片，也会显示。
- **Settings has an About section / 设置里有了“关于”**: Classic Settings now shows the version, a Check for updates button, and the two support actions, Copy diagnostics and Open log folder, which were reachable only from the card a stalled import shows. V Opus already had them under Settings > About.
  - 经典界面的设置里现在显示版本号，有“检查更新”按钮，还有两个反馈问题时用的操作：复制诊断信息、打开日志文件夹。以前它们只出现在导入卡住时的卡片上。V Opus 的“设置 > 关于与更新”本来就有。
- **Settings says where the desktop program is / 设置会说明桌面程序在哪里**: In-app updates never install the desktop program, so an install from before 3.8.0 that was updated in the program has no `SD Image Sorter.exe`, and nothing said so. Opened in a browser on Windows, classic Settings > General and V Opus Settings > Desktop now say whether the program folder holds it; when it does not, they say how to get it (quit, extract the full Windows package over the same folder; the `data` folder is not in the package, so the library, settings and models stay) and link the download page.
  - 程序内更新从不安装桌面程序，所以 3.8.0 之前装的、一直在程序里更新的，文件夹里没有 `SD Image Sorter.exe`，而且没有任何提示。现在在 Windows 上用浏览器打开时，经典界面的「设置 > 常规」和 V Opus 的「设置 > 桌面版」会说明程序文件夹里有没有它；没有时，会说明怎么获取（退出程序，把完整的 Windows 包解压到原来的文件夹并覆盖；`data` 文件夹不在包里，图库、设置和模型都会保留），并附上下载页链接。
- **The Reader's paste button reads the clipboard / 读图的粘贴按钮直接读取剪贴板**: The classic Reader's "Paste from Clipboard" button only said "Ready. Press Ctrl+V now."; it now reads the clipboard at once, and waits for Ctrl+V only where the browser does not allow reading it. V Opus's Paste button already did. Win+V needs neither: picking a picture there sends it to the Reader like Ctrl+V (checked on Windows 11), and the hint now says so.
  - 经典界面读图的“从剪贴板粘贴”按钮以前只会提示“准备好了，现在按 Ctrl+V”；现在会直接读取剪贴板，只有浏览器不允许读取时才等你按 Ctrl+V。V Opus 的“粘贴”按钮本来就会直接读取。Win+V 两样都不需要：在里面选一张图，会像 Ctrl+V 一样送进读图（已在 Windows 11 上实测），提示文字现在也写明了。
- **The empty gallery fits the screen / 空图库的引导完整显示**: While the library has no pictures, the generator chips, search, filters, sort and zoom fold away (they have nothing to act on yet and come back with the first picture; a filter with no result keeps them), so the whole card fits a 1366 x 768 screen. The four getting-started steps sat as three plus a lone fourth with empty space beside it; they are now two by two. The hint no longer leaves one character on its own line, and on large screens the gallery panel reaches the bottom instead of ending mid-screen.
  - 图库里还没有图片时，生成器标签、搜索、筛选、排序和缩放先收起来（还没有可操作的对象，第一张图进来就会回来；筛选后没有结果时不会收起），整张卡片在 1366 x 768 的屏幕上能完整显示。四个新手步骤原来排成三个加孤零零的第四个，旁边一片空白；现在排成两行两列。提示文字不再剩一个字单独一行；大屏幕上图库面板一直延伸到底部，不再在半屏处断开。
- **The guide names places as the program shows them / 引导里的名字和程序里一致**: The first-run guide sent users to a "Settings & Models" gear that is called Settings, with models in Model Center, and listed tabs (Picture library, Sort pictures, Censor edit) the top bar does not show. The gear, its dialog and the guide now use the top bar's and Settings' own names, and a check fails when a label changes without the guide.
  - 新手引导让用户去点「设置与模型」齿轮，但它其实叫「设置」，模型在「模型中心」；列出的页面（图片库、整理图片、打码编辑）顶栏上也没有。现在齿轮、它的窗口和引导都用顶栏和设置里的真实名字；以后改了名字却没改引导，检查会失败。
- **Pasted pictures are named "pasted" again in V Opus / V Opus 粘贴的图片重新以 pasted 命名**: Since 3.10.1, V Opus's Paste picture button saved a picture from the clipboard as clipboard.png instead of pasted.png (as before, and as classic does). Found by the full browser test run.
  - 从 3.10.1 起，V Opus 的“粘贴图片”按钮把剪贴板里的图片存成 clipboard.png，而不是以前（和经典界面一样）的 pasted.png。由完整的浏览器测试发现。

---

## Upgrading / 升级注意

- Nothing to do. An install from before 3.8.0 that was always updated inside the program has no desktop program (`SD Image Sorter.exe`): in-app updates never install it. Settings now says so; to get it, quit and extract the full Windows package over the same folder (your library, settings and models stay).
  - 无需操作。3.8.0 之前安装、一直在程序里更新的，文件夹里没有桌面程序（`SD Image Sorter.exe`），因为程序内更新从不安装它。现在设置里会说明；想要的话，退出程序，把完整的 Windows 包解压到原来的文件夹并覆盖（图库、设置和模型都会保留）。

---

## Validation / 验证

GitHub CI run 41002289936 (Linux full suite with browser tests and click coverage, macOS, Windows, Linux portable x86_64 and aarch64): 5 of 5 green; backend 9,302 passed; browser tests 2,187 passed, 0 failed, 0 flaky; V Opus unit tests 1,487 passed. On a fresh 3.10.2 Windows package: in the desktop program, New library asked in the program's own dialog and created the library, and every top-bar page, each Settings tab, the import dialog, Help, the update check and the tag library opened with no console error, no failed request and no browser box. In the browser, classic in English and Chinese, V Opus and the new interface opened with no console errors; Settings > About showed 3.10.2; an empty library folded the gallery toolbar and the whole card fitted 1366x768 in both languages; a fresh install showed no after-update notice. Win+V was checked by hand on Windows 11: the picked picture reaches the page like Ctrl+V.
  - GitHub CI（41002289936：Linux 完整测试含浏览器测试和点击覆盖、macOS、Windows、Linux 便携版 x86_64 与 aarch64）5 项中 5 项通过；后端 9,302 通过；浏览器测试 2,187 通过、0 失败、0 个偶发；V Opus 单元测试 1,487 通过。在全新的 3.10.2 Windows 包里：在桌面程序中，“新建图库”用程序自己的对话框询问并建好了图库；顶栏每个页面、设置的每个分页、导入对话框、帮助、检查更新和标签库都能打开，没有控制台错误、没有失败的请求、没有浏览器对话框。在浏览器里，经典界面中英文、V Opus 和新界面都没有控制台错误；“设置 > 关于”显示 3.10.2；空图库会收起图库工具栏，引导卡片在 1366x768 下中英文都完整显示；全新安装不会显示更新说明。Win+V 已在 Windows 11 上人工实测：选中的图会像 Ctrl+V 一样送进页面。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.10.2-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.10.2-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.10.2-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.10.2-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.10.2-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.10.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.10.2-windows-portable.zip` | `59ec39001d428e0392207317c1ad592f1000faf1fd82004e128f990b9f5fe90b` |
| `sd-image-sorter-v3.10.2-app-patch.zip` | `a82fddb25cdb2e4e7b868db23987376cedc09259821e572b17a059590ef2ee6e` |
| `sd-image-sorter-v3.10.2-linux.tar.gz` | `7936f2f6f9b3c827a182e53c3317641bf012ff017d25d7cc0c3f9ccd39644b57` |
| `sd-image-sorter-v3.10.2-linux-portable-x86_64.tar.gz` | `4761908dbd1d0ab95ca9abec6fc8873b602718bb23570d0a529a91f70eecf0e9` |
| `sd-image-sorter-v3.10.2-linux-portable-aarch64.tar.gz` | `b409d9704a450047f1d965f2c3538966d00c55e2ff4620bcd68ca8e96d2b1451` |
| `sd-image-sorter-v3.10.2-release-manifest.json` | `fc6740b2725364513cf6710a9f5af45be490c1eb76d18897dbf93c0a869dad99` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
