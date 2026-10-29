## v3.10.1 — QQ 图片能读图 + 不再擅自生成 _real.png / QQ Pictures + No _real.png

读图能直接粘贴或拖入 QQ 里的图片；导入不再擅自在原文件夹生成 _real.png。

Reader takes pictures from QQ. Imports no longer write _real.png unasked.

---

## Fixed / 修复

- **Pictures copied or dragged from QQ open in the Reader / 从 QQ 复制或拖出的图片能在读图里打开**: QQ and some other programs hand over a picture as its file location (`<img src="file://...">` or a `file://` link) instead of the picture itself, so the Reader, gallery paste, Quick collect, Privacy and similar-image search did nothing with them. They now read the original file from disk, with its full generation details, in classic and V Opus. A drop or paste that carries no usable picture now says what was missing instead of staying silent. Locations on network shares are refused before they are looked up, because looking one up makes Windows sign in to that computer.
  - QQ 等程序复制或拖出图片时，给的是图片的文件位置（`<img src="file://...">` 或 `file://` 链接），不是图片本身，所以读图、图库粘贴、快速收集、隐私处理和找相似图都没有反应。现在会直接从磁盘读取原文件，生成信息完整保留，经典界面和 V Opus 都一样。拖入或粘贴的内容里没有可用图片时，会说明缺了什么，不再毫无反应。网络共享上的位置在查找之前就会被拒绝，因为查找它会让 Windows 自动登录那台电脑。
- **Importing no longer writes _real.png files unasked / 导入不再擅自生成 _real.png 文件**: An import used to save a `<name>_real.png` next to every chat disguise image it found, without asking, and a picture whose hidden copy was the same as what it shows got a pure duplicate, so a folder could double in size. Restoring is now a choice in the import dialog's advanced options ("Restore chat disguise images", off by default and remembered once ticked), the same in all three interfaces; library rescans, auto-refresh, folder watching and collected pictures never restore. A picture whose hidden picture is the same as the one shown is never copied, and Privacy's Restore calls it not a disguise. When the option is on, the import's summary says how many real pictures it saved.
  - 以前导入时，只要发现聊天伪装图就会在旁边另存一份 `<文件名>_real.png`，不问一声；藏着的图和显示的图一样时，存下的就是一份重复文件，文件夹可能因此翻倍。现在还原改为导入对话框“高级设置”里的一个选择（“还原聊天伪装图”，默认关闭，勾选后会记住），三个界面都一样；图库重新扫描、自动刷新、文件夹监视和收集图片都不会还原。藏着的图和显示的图一样时绝不另存，隐私工具的“还原”也会说它不是伪装图。勾选后，导入完成的提示会说明另存了几张真图。

---

## Upgrading / 升级注意

- Nothing to do. `_real.png` files that 3.10.0 or earlier already wrote stay where they are; delete them yourself if you do not need them (search the folder for `*_real.png`). If the original really is a chat disguise, its `_real.png` holds the real picture, so look before deleting.
  - 无需操作。3.10.0 及更早版本已经生成的 `_real.png` 不会自动删除；不需要的话请自己删（在文件夹里搜索 `*_real.png`）。如果原图确实是聊天伪装图，`_real.png` 里才是真图，删之前看一眼。

---

## Validation / 验证

To be filled in from the GitHub CI run on the release commit.

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
