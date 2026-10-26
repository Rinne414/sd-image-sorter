## v3.8.0 — 桌面程序 + 自动收图 / Desktop Program + Auto Collect

Windows 桌面程序常驻托盘；新图、网图和视频自动进图库；大显卡默认 PixAI v1.0。

A tray desktop program; pictures and videos come in by themselves; PixAI v1.0 by default.

---

## Fixed / 修复

- **Desktop program (Windows)**: `SD Image Sorter.exe` sits at the top of the Windows package next to `run-portable.bat`, which still starts the browser mode. Closing the window keeps it in the tray (Quit is in the tray menu, with Open, Quick collect, Pause / Resume folder watching and shortcut creation); Ctrl+Alt+Space brings it up with the cursor in the gallery search; Settings > Desktop > Start at login is optional; gallery pictures can be dragged into other programs as files. The first start installs the core packages in a visible console window and offers desktop and Start-menu shortcuts (no administrator rights). It sends nothing anywhere.
  - **桌面程序（Windows）**：Windows 包最上层有 `SD Image Sorter.exe`，旁边的 `run-portable.bat` 照旧用浏览器打开。关掉窗口会留在托盘（托盘菜单里有退出、打开、快速收集、暂停/继续监看和创建快捷方式）；Ctrl+Alt+Space 随时叫出窗口并把光标放进图库搜索；设置 > 桌面 > 开机启动 可选；图库里的图可以当作文件拖进别的程序。第一次启动会在看得见的命令行窗口里装核心组件，并询问要不要建桌面和开始菜单快捷方式（不需要管理员权限）。它不会向任何地方发送数据。
- **Pictures come in by themselves**: tick "Watch for new pictures" on a folder (Library Folders, or the offer after an import) and new ComfyUI or WebUI pictures join the gallery within seconds, including the ones made while the program was closed. A Chrome / Edge / Firefox extension saves a right-clicked web picture with its source page into `collected/<date>` (install and pairing in Settings > Browser extension; it talks only to 127.0.0.1), and Ctrl+V in the gallery saves a pasted picture or picture address the same way.
  - **新图自己进来**：在文件夹上勾选「监看新图片」（图库文件夹里，或导入后的提示），ComfyUI 或 WebUI 新出的图几秒内进图库，程序关着时出的图也会补上。Chrome / Edge / Firefox 扩展可以右键把网上的图连同来源网页存到 `collected/<日期>`（安装和配对在 设置 > 浏览器扩展，只和 127.0.0.1 通信）；在图库里 Ctrl+V 粘贴的图片或图片地址也会这样保存。
- **Videos in the library**: videos in watched and scanned folders join the gallery: hover to play, open to play with Space or K and step frames with , and ., read the prompt, and filter with Videos. ffmpeg (about 77 MB, LGPL) downloads only when you press "Install video support"; a system ffmpeg is used when there is one.
  - **图库里的视频**：监看和扫描的文件夹里的视频也会进图库：鼠标悬停就播放，打开后 Space 或 K 播放/暂停、, 和 . 逐帧，能看提示词，也能用「视频」筛选。ffmpeg（约 77 MB，LGPL）只有按「安装视频支持」时才下载；电脑上已有 ffmpeg 就直接用。
- **Send to generator**: right-click a picture > "Send to generator…" to copy its WebUI or NovelAI prompt, copy or save its ComfyUI workflow, or run it again in ComfyUI with a new or the same seed (address in Settings > ComfyUI address).
  - **送回生成器**：右键图片 >「送回生成器…」，可以复制 WebUI 或 NovelAI 提示词、复制或保存 ComfyUI 工作流，或在 ComfyUI 用新种子或同一个种子再跑一次（地址在 设置 > ComfyUI 地址）。
- **The default tagger follows your graphics card**: on an NVIDIA GPU with 12 GB or more the tag panels preselect PixAI v1.0; elsewhere SwinV2 stays the default. On 240 real AI-generated pictures PixAI v1.0 named 130 of the 168 characters in their prompts (SwinV2 79) and 110 of the 126 series (SwinV2 none), with general tags, hair and eye colour and ratings as good; it is about ten times slower and downloads about 2 GB on first use. A tagger you picked before stays picked.
  - **默认打标模型跟着显卡走**：12 GB 以上的 NVIDIA 显卡默认选 PixAI v1.0，其他电脑仍是 SwinV2。在 240 张真实 AI 图上，PixAI v1.0 认出了提示词里 168 个角色中的 130 个（SwinV2 79 个）、126 部作品中的 110 部（SwinV2 0 部），一般标签、发色眼色和分级一样好；代价是慢约十倍，第一次使用要下载约 2 GB。你以前选过的模型会保留。
- **DanbooruTagQuery B/16 and L/16 taggers** (issue #20): two new local taggers trained on danbooru posts up to 2025, with characters and series. Downloads about 370 MB / 1.2 GB on first use; weights under Meta's DINOv3 License; their rating is worked out from their tags.
  - **DanbooruTagQuery B/16 与 L/16** (issue #20)：两个新的本地打标模型，训练数据到 2025 年，含角色和作品标签。第一次使用下载约 370 MB / 1.2 GB；权重使用 Meta 的 DINOv3 许可；分级由它打出的标签推算。
- **Your own VLM prompt presets** (issue #21): save the prompts in the boxes as a named preset, change, rename or delete it, and undo a delete; presets live in `data/config/vlm-prompt-presets.json`, so updates leave them alone.
  - **自己的 VLM 提示词预设** (issue #21)：把输入框里的提示词存成有名字的预设，可以修改、改名、删除，删除也能撤销；预设存在 `data/config/vlm-prompt-presets.json`，更新不会动它。
- **Export and tagging** (issue #5): the export preview follows your newest tags for every picture; the default LoRA caption writes each tag once; "Keep original filenames" keeps every name; Batch export can open the pictures in Dataset Maker, which copies pictures and captions under paired names.
  - **导出与打标** (issue #5)：导出预览对每张图都跟着最新的标签；默认 LoRA caption 每个标签只写一次；「保留原文件名」不再改名；批量导出可以把图带到数据集制作，成对复制图片和标签文件。
- **Safer with heavy models**: PixAI v1.0 goes on the GPU only when about 8.3 GB is free; on the CPU it needs about 6 GB of free memory, and with less it stops and says what is short in your language, keeping the pictures already tagged. A tagger that outgrows the GPU no longer fills the system RAM. Idle AI models are freed, work moves to the CPU while the GPU is busy, and background work runs below normal priority.
  - **跑大模型更稳**：PixAI v1.0 只在空闲显存约 8.3 GB 时才上 GPU；改用 CPU 时需要约 6 GB 空闲内存，不够就停下，用你的语言说明缺多少，已经打好的图保留。打标模型超出显卡时不再把系统内存吃光。闲置的 AI 模型会释放，显卡忙时改用 CPU，后台工作以较低优先级运行。
- **Clearer gallery**: the generator tabs count what the filters leave; Clear current library sits on the gallery page and in Settings (Vopus too); Reset all settings is in Settings; an unexpected error is said on screen with Reload and Copy; the shortcuts panel lists every gallery key; Chinese labels use the Chinese colon; ratings worked out from tags follow danbooru's lines; browser and mouse Back work in Vopus; the All / Pictures / Videos switch shows only when the library has videos and the laptop search row stays on one line; Prompt Lab's Stats scrolls on a laptop screen; a Find Moved Files review left from an earlier run keeps its button in sight; a click keeps a Vopus submenu open.
  - **图库更清楚**：生成器分页的张数跟着筛选变；「清空当前图库」放在图库页和设置里（Vopus 也有）；设置里可以恢复所有设置；没人接住的错误会显示在页面上，带「重新加载」和「复制」；快捷键面板列出图库的所有按键；中文标签改用全角冒号；由标签推算的分级改用 danbooru 的标准；Vopus 里浏览器和鼠标的后退键可以用了；「全部 / 图片 / 视频」开关只在图库有视频时显示，笔记本上的搜索栏保持一行；提示词助手的统计页在笔记本屏幕上可以滚动；上一次「找回移动的文件」留下的待选，按钮不再藏起来；点击不会再把 Vopus 的子菜单关掉。

- **Security updates**: Pillow 13.0.0 (37 image-parsing advisories published in October 2026), filelock 4.2.4, setuptools 84.2.1, certifi 2026.10.23; fastembed 0.9.1 to match Pillow 13.
  - **安全更新**：Pillow 13.0.0（2026 年 10 月公布的 37 个图片解析漏洞）、filelock 4.2.4、setuptools 84.2.1、certifi 2026.10.23；fastembed 升到 0.9.1 以配合 Pillow 13。

---

## Upgrading / 升级注意

- The first start upgrades the database (folder watching, collected pictures, videos) and saves a copy to `data/backups` first. Older versions cannot open the upgraded database; to go back, restore that copy.
  - 第一次启动会升级数据库（监看文件夹、收集的图片、视频），升级前先在 `data/backups` 留一份副本。旧版本打不开升级后的数据库；想退回旧版时，请用这份副本。
- "Check Updates" updates the program files but does not add the desktop program, because `SD Image Sorter.exe` is a separate layer that cannot be replaced while it runs. To get the desktop program, download the Windows package once; your `data` folder can be copied into it.
  - 程序内的「检查更新」会更新程序文件，但不会装上桌面程序，因为 `SD Image Sorter.exe` 是独立的一层，运行时无法替换。想用桌面程序，请下载一次 Windows 完整包；原来的 `data` 文件夹可以复制过去。
- The Windows package grows from about 22 MB to about 165 MB because it carries the desktop program (Electron). The Linux packages stay browser mode only.
  - 因为带了桌面程序（Electron），Windows 包从约 22 MB 变成约 165 MB。Linux 包仍然只有浏览器模式。

---

## Validation / 验证

VALIDATION_PENDING

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.8.0-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.8.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.8.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.8.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.8.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.8.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

Filled in after the packages are built. / 打包后填入。
