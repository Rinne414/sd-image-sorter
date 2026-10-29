## v3.10.1 — QQ 图片能读图 + 不再擅自生成 _real.png / QQ Pictures + No _real.png

读图能直接粘贴或拖入 QQ 里的图片；导入不再擅自在原文件夹生成 _real.png。

Reader takes pictures from QQ. Imports no longer write _real.png unasked.

---

## Fixed / 修复

- **Pictures copied or dragged from QQ open in the Reader / 从 QQ 复制或拖出的图片能在读图里打开**: QQ and some other programs hand over a picture as its file location (`<img src="file://...">` or a `file://` link) instead of the picture itself, so the Reader, gallery paste, Quick collect, Privacy and similar-image search did nothing with them. They now read the original file from disk, with its full generation details, in classic and V Opus. A drop or paste that carries no usable picture now says what was missing instead of staying silent. A pasted picture that carries its generation details no longer gets a false "may be incomplete" warning. Locations on network shares are refused before they are looked up, because looking one up makes Windows sign in to that computer.
  - QQ 等程序复制或拖出图片时，给的是图片的文件位置（`<img src="file://...">` 或 `file://` 链接），不是图片本身，所以读图、图库粘贴、快速收集、隐私处理和找相似图都没有反应。现在会直接从磁盘读取原文件，生成信息完整保留，经典界面和 V Opus 都一样。拖入或粘贴的内容里没有可用图片时，会说明缺了什么，不再毫无反应。粘贴的图片带着完整生成信息时，不再误报“信息可能不完整”。网络共享上的位置在查找之前就会被拒绝，因为查找它会让 Windows 自动登录那台电脑。
- **Importing no longer writes _real.png files unasked / 导入不再擅自生成 _real.png 文件**: An import used to save a `<name>_real.png` next to every chat disguise image it found, without asking, and a picture whose hidden copy was the same as what it shows got a pure duplicate, so a folder could double in size. Restoring is now a choice in the import dialog's advanced options ("Restore chat disguise images", off by default and remembered once ticked), the same in all three interfaces; library rescans, auto-refresh, folder watching and collected pictures never restore. A picture whose hidden picture is the same as the one shown is never copied, and Privacy's Restore calls it not a disguise. When the option is on, the import's summary says how many real pictures it saved.
  - 以前导入时，只要发现聊天伪装图就会在旁边另存一份 `<文件名>_real.png`，不问一声；藏着的图和显示的图一样时，存下的就是一份重复文件，文件夹可能因此翻倍。现在还原改为导入对话框“高级设置”里的一个选择（“还原聊天伪装图”，默认关闭，勾选后会记住），三个界面都一样；图库重新扫描、自动刷新、文件夹监视和收集图片都不会还原。藏着的图和显示的图一样时绝不另存，隐私工具的“还原”也会说它不是伪装图。勾选后，导入完成的提示会说明另存了几张真图。

---

## Upgrading / 升级注意

- Nothing to do. `_real.png` files that 3.10.0 or earlier already wrote stay where they are; delete them yourself if you do not need them (search the folder for `*_real.png`). If the original really is a chat disguise, its `_real.png` holds the real picture, so look before deleting.
  - 无需操作。3.10.0 及更早版本已经生成的 `_real.png` 不会自动删除；不需要的话请自己删（在文件夹里搜索 `*_real.png`）。如果原图确实是聊天伪装图，`_real.png` 里才是真图，删之前看一眼。

---

## Validation / 验证

Released before the full GitHub CI run finished, at the owner's request. GitHub CI on the code before the last small fix (6b03f21d): Windows, macOS and both Linux portable checks green; the Linux full suite was still running at release time. Local checks on the release code: backend tests for every changed area 235 passed (1 skipped, POSIX only); the Reader's browser tests 45 passed; V Opus unit tests 219 passed. On a fresh 3.10.1 Windows package: in the desktop program, a real Ctrl+V of a picture copied in QQ read the 1024x1536 original with its full ComfyUI prompt; a paste carrying only QQ's <img src="file://..."> opened the picture with its prompt in the classic and V Opus Reader, and a real file drag and a real Ctrl+V still worked; an import wrote no _real.png, and with the new option ticked it wrote one only for the real disguise, not for the one whose hidden picture equals its cover; classic in English and Chinese and V Opus showed no console errors; the desktop program started its backend, showed 3.10.1 and stopped the backend on Quit.
  - 应作者要求，在 GitHub CI 完整测试跑完之前发布。最后一个小修正之前的代码（6b03f21d）在 GitHub CI 上：Windows、macOS 和两个 Linux 便携版检查通过；发布时 Linux 完整测试仍在运行。本地检查：所有改动范围的后端测试 235 通过（1 个仅限 POSIX 的跳过）；读图的浏览器测试 45 通过；V Opus 单元测试 219 通过。在全新的 3.10.1 Windows 包里：在桌面程序中，从 QQ 复制的图片按真实 Ctrl+V，读出了 1024x1536 的原图和完整的 ComfyUI 提示词；只带 QQ 那种 <img src="file://..."> 的粘贴，在经典界面和 V Opus 的读图里都打开了图片和提示词，真实拖入文件和真实 Ctrl+V 也照常可用；导入没有生成任何 _real.png，勾选新选项后只为真正的伪装图生成了一份，藏着的图与显示的图相同的那张没有生成；经典界面中英文和 V Opus 都没有控制台错误；桌面程序能启动后台、显示 3.10.1，退出时会停止后台。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.10.1-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.10.1-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.10.1-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.10.1-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.10.1-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.10.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.10.1-windows-portable.zip` | `0f34eff03ccaf5191d5f07d96ec462f39587b5088879ef054a6f164248423033` |
| `sd-image-sorter-v3.10.1-app-patch.zip` | `3d2bccc915e8f8649730ccdcf00f99e60eb265d44234d77dd3270c04dc458cab` |
| `sd-image-sorter-v3.10.1-linux.tar.gz` | `e2eb75a4e2f424b391323560276058a9dd3bbd8b595a14c410d5431f03fd92a4` |
| `sd-image-sorter-v3.10.1-linux-portable-x86_64.tar.gz` | `a19adf8b88308ef19671bdac086c5b04f9d27ad6816a548c5d19029c84501134` |
| `sd-image-sorter-v3.10.1-linux-portable-aarch64.tar.gz` | `280060721692004dad20a98dd6daf845851b1aea696f844cef80dce7a0a879ea` |
| `sd-image-sorter-v3.10.1-release-manifest.json` | `f7fed6c06dc7ea20c5a08efae3d916b2313c541a1ca202c643f801f2e31da88f` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
