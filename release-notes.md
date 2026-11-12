## v3.11.0 — 日常整理 + 找图 + 单一界面 / Organise + Find + One Interface

新图片与留汰收尾、文件夹改名与拖放、含义搜索、Eagle 导入、内置助手；只保留一套界面。

New Pictures, folder rename, meaning search, Eagle import, assistant; one interface.

---

## Fixed / 修复

- **New Pictures, and Keep / Reject that finishes the job / “新图片”，以及做到底的留 / 汰**: Home has a New Pictures mission: only the pictures made since your last cull, with Keep / Reject one press away. When a session ends, one line offers what to do with the files: move the kept to a folder (with Undo), look at the rejected, or send the rejected to the recycle bin (asked first, with the count). The last result stays on the Keep / Reject setup page after that line is closed.
  - 首页多了“新图片”任务：只看上次挑选之后生成的图，一按就能逐张决定留 / 汰。一轮结束时，会有一行让你处理文件：把保留的移到文件夹（可撤销）、查看剔除的、或把剔除的送进回收站（会先确认并写明数量）。这一行关掉之后，留 / 汰的设置页还留着上一次的结果。
- **Folders you can work with / 可以直接操作的文件夹**: each folder in the sidebar has a menu (the dots, or a right-click): Rename renames the folder on your disk and its pictures keep their tags, ratings and sets, with Undo; "Move the selection to a new folder here" makes a folder and moves the selected pictures in. Pictures can be dragged onto a folder to move them, rows show how many pictures they hold, and More > Recent moves lists the last moves and copies, each with Undo. Auto-Separate can be undone too.
  - 侧栏里每个文件夹都有菜单（行尾的三个点，或右键）：“重命名”会在磁盘上改名，里面图片的标签、评分和合集都保留，可以撤销；“把选中的图片移到这里的新文件夹”会新建文件夹并把选中的图移进去。图片可以直接拖到文件夹上移动，每行显示图片数量，“更多 > 最近的移动”列出最近的移动和复制，每一次都能撤销。自动分类现在也能撤销。
- **Search that finds more / 更会找的搜索**: the Gallery search reads Chinese and Japanese tag names (猫耳 is read as `cat_ears`), part of a LoRA or model name, and `sampler:`, `steps:` and `cfg:`. Beside any word search there is "Search by meaning instead", which finds pictures that look like your words whatever their prompt says; with the optional multilingual model it reads Chinese and 50+ other languages. It says how many pictures are not in the similarity index yet and can index them. Home has a search box, and "Find by pose or camera angle" lists the pose tags your library really has.
  - 图库搜索读得懂中文和日文的标签名（猫耳会当作 `cat_ears`）、LoRA 或模型名的一部分，以及 `sampler:`、`steps:`、`cfg:`。用词语搜索时，旁边都有“改用含义搜索”：找画面像这些词的图，不管提示词里写了什么；装上可选的多语言模型后能读中文和另外 50 多种语言。它会写出还有多少张图不在相似索引里，并可以一键建立索引。首页有搜索框；“按姿势或镜头角度找图”会列出图库里实际有的姿势标签。
- **Reuse what you made / 重用自己做过的图**: the picture viewer says what changed from the picture made just before (prompt words, settings, LoRAs, seed), two selected pictures can be compared side by side, and a picture can carry a note that the search finds. "Pick the most different" cuts a selection down to the number you ask for, and a picture can float above other programs as a reference.
  - 看图窗口会写出和上一张相比改了什么（提示词、参数、LoRA、种子）；选中两张可以并排比较；图片可以写备注，搜索能找到。“挑出差别最大的”能把一堆候选图减到你要的张数；图片还能浮在其他程序上方当参考。
- **A built-in assistant / 内置助手**: a chat panel (the Assistant button in the top bar). Say what you want and it searches, shows the result in the Gallery, selects pictures or opens the right page. Tagging, rating, notes and collections show a card first and happen only after you confirm; it never moves, renames or deletes a file. It uses a chat model you choose: one on this computer (Ollama, LM Studio) or an online service with your own key.
  - 顶栏的“助手”按钮会打开一个对话面板。说出你想做的事，它会搜索、在图库里显示结果、选中图片或打开对应的页面。打标签、评分、写备注、放进合集都会先给你一张确认卡片，确认后才执行；它不会移动、重命名或删除任何文件。它使用你选的对话模型：本机的（Ollama、LM Studio），或用你自己密钥的在线服务。
- **Bring an Eagle library in (not yet tried on a real Eagle library) / 带入 Eagle 资源库（尚未在真实的 Eagle 资源库上试过）**: Import > "From an Eagle library…" indexes the pictures where Eagle keeps them and brings stars, notes, tags, folders (as nested collections) and source pages along. Nothing is copied and nothing in the Eagle folder is changed. It was built from public notes on the folder layout and tested on libraries made to that layout.
  - “导入 > 从 Eagle 资源库…”会在 Eagle 存放的位置原地索引图片，并带上星级、备注、标签、文件夹（变成嵌套的合集）和来源页面。不复制文件，也不改动 Eagle 文件夹里的任何东西。它是按公开的文件夹结构说明做的，只在按这个结构造出来的资源库上测过。
- **Collections inside collections, Group runs, Wander / 合集里的合集、同批合并、漫游**: a collection can hold other collections and takes pictures dragged onto it. Group runs (off by default) shows one generation run as a stack. Find Similar has a Wander tab for looking around: each batch is somewhat like the last one and never repeats a picture.
  - 合集可以放其他合集，也能接收拖上来的图片。“同批合并”（默认关闭）把同一批生成的图显示成一叠。“相似”页多了“漫游”标签，用来随便看看：每一批都和上一批有点像，而且不重复。
- **Faster in a large library / 大图库更快**: measured with 100,000 pictures: the search box about ten times faster (1.2 s to about 0.1 s), a `steps:` search 1.7 s to 0.3 s, a page in the middle of a name-sorted Gallery 5 to 6 s to about 0.5 s, the first page in random order about 1 s to 0.35 s. The program idles at 147 MB instead of 880 MB and holds no graphics memory, and after a fast scroll the screen fills in about 1 s (it stayed blank for 9.7 s with large pictures).
  - 用 10 万张图实测：搜索框快约十倍（1.2 秒降到约 0.1 秒），`steps:` 搜索从 1.7 秒降到 0.3 秒，按名称排序时翻到中间一页从 5 到 6 秒降到约 0.5 秒，随机排序的第一页从约 1 秒降到 0.35 秒。程序空闲时占 147 MB 内存（原来 880 MB），不再占用显存；快速滚动后屏幕约 1 秒填满（大图时以前要空白 9.7 秒）。
- **An action that names its pictures acts on those pictures (data safety) / 点名哪些图，就只动哪些图（数据安全）**: a set opened in the Gallery arrives fully selected, and "Rejected to the recycle bin", Move to Trash or Remove on one right-clicked picture then took the whole selection instead of the pictures they named. They act on the named pictures now.
  - 在图库里打开的一组图是全选状态；这时“把剔除的送进回收站”，或对一张图右键“移到回收站”“从图库移除”，以前会作用于整个选择，而不是点名的那些图。现在只作用于点名的图。
- **Moves that used to fail or do nothing / 以前会失败或没反应的移动**: moving a picture to a place an old record of a missing file still claimed failed and put the file back; it works now. In the desktop program, dragging pictures onto a sidebar folder or collection did nothing; the sidebar now knows what such a drag carries (checked in a browser with the desktop side imitated, not yet with a real drag in the packaged program).
  - 把图片移到一个还留着“文件丢失”旧记录的位置，以前会失败并把文件放回去，现在可以了。在桌面程序里把图片拖到侧栏的文件夹或合集上，以前没有反应；现在侧栏认得这种拖动（已在浏览器里模拟桌面程序一侧验证，还没有在打包后的桌面程序里真正拖过）。
- **Network proxy, automatic update check, Ctrl K / 网络代理、自动检查更新、Ctrl K**: Model Center takes the port of Clash, v2rayN or a similar tool once, and downloads, installs and update checks use it. The program checks for a new version once a day and only reminds (off switch in Settings). Ctrl K opens the list of every feature anywhere, and a reload returns to the page you were on.
  - 模型中心里填一次 Clash、v2rayN 之类工具的端口，模型下载、依赖安装和检查更新都会走它。程序每天检查一次新版本，只提醒（设置里可以关）。Ctrl K 在任何地方都能打开全部功能的列表；刷新后回到原来的页面。
- **Professional look (preview) / “专业”外观（预览）**: Settings › Appearance has a second look, off by default: one accent colour, flat sidebar rows, one corner shape, the picture count as a title. Many pages were also gone over for cut-off text, unnamed buttons and laptop heights.
  - “设置 › 外观”里多了第二种外观，默认关闭：一个强调色、扁平的侧栏行、统一的圆角、把图片数量当标题。很多页面也一并检查过：被截断的文字、没有名字的按钮、笔记本屏幕高度下的排版。
- **One interface / 只保留一套界面**: V Opus and the trial interface are retired. The program had three interfaces over one library and only one of them kept getting new features. The Interface row in Settings is gone; the old addresses open the program.
  - V Opus 和试验界面已停用。以前程序在同一个图库上有三套界面，而新功能只进了其中一套。设置里的“界面”一项已移除；旧地址会直接打开程序。

---

## Upgrading / 升级注意

- The first start upgrades the database (search index, notes, nested collections) and saves a copy to `data/backups` first. Older versions cannot open the upgraded database; to go back, restore that copy.
  - 第一次启动会升级数据库（搜索索引、备注、嵌套合集），升级前先在 `data/backups` 留一份副本。旧版本打不开升级后的数据库；想退回旧版时，请用这份副本。
- If you had chosen V Opus as the interface, the program now opens its one interface. Your library, settings and files are not touched, and bookmarks to `/vopus/` still open the program.
  - 如果以前把界面选成了 V Opus，现在会打开唯一的这套界面。图库、设置和文件都不受影响，`/vopus/` 的书签仍然能打开程序。
- Folders are not watched unless you switch it on: Folders > Manage > "Watch for new pictures". Without it, New Pictures only sees pictures after the folder was checked again.
  - 文件夹默认不会自动收入新图：在“文件夹 > 管理”里打开“自动收入新图”。不打开的话，“新图片”要等文件夹被再次检查之后才看得到新图。

---

## Validation / 验证

Local Windows gate on the release commit: backend 9,787 passed (16 skipped), browser tests 1,745 passed, 0 failed (6 skipped), every backend file compiles on Python 3.11 (an install that was always updated in place keeps that interpreter). The Windows package was built in a clean checkout, extracted to a new folder and started with its own launcher as a new user: version 3.11.0, 24 pictures imported, New Pictures, a folder renamed from the sidebar (10 pictures followed on disk and in the library), two pictures moved into a new folder, Recent moves and the meaning-search link all worked at 1366x768, 1920x1080 and 2560x1440 with no console errors; the old addresses of the retired interfaces opened the program. The desktop program from the same package started its backend, showed 3.11.0 and opened the floating reference window with its picture. Upgrade: a real 3.10.2 Windows package with 8 pictures, a 5-star rating, a favourite and V Opus chosen as its interface took the 3.11.0 patch through its own updater in 3 seconds; it then opened the program at once, with the 8 pictures, the rating and the favourite, a copy of the database saved before the upgrade, the 107 files of the retired interface removed, and the what's-new notice showing this version's summary. The download and checksum step of the in-app update was not part of that run (it only accepts GitHub). Not run: GitHub CI on Linux and macOS for this commit (it runs after the push), a real drag in the packaged desktop program, and an import from a real Eagle library.
  - 本机 Windows，在发版提交上：后端 9,787 通过（16 跳过），浏览器测试 1,745 通过、0 失败（6 跳过）；所有后端文件都能在 Python 3.11 上编译（一直用程序内更新的旧安装仍是这个版本的解释器）。Windows 包在干净的代码副本里打包，解压到全新文件夹后用它自己的启动文件以新用户身份运行：版本 3.11.0，导入 24 张图，“新图片”、在侧栏给文件夹重命名（磁盘上和图库里的 10 张图都跟着改了）、把两张图移到新文件夹、“最近的移动”、含义搜索链接，在 1366x768、1920x1080、2560x1440 下都正常，控制台没有错误；已停用界面的旧地址会打开程序。同一个包里的桌面程序能启动后端、显示 3.11.0，并能打开参考图浮窗、显示图片。升级：一个真实的 3.10.2 Windows 包（8 张图、一个 5 星评分、一个收藏、界面选成 V Opus），用它自己的更新程序在 3 秒内套用了 3.11.0 的补丁；之后直接打开程序，8 张图、评分和收藏都在，升级前留了数据库副本，已停用界面的 107 个文件被移除，“更新了什么”的提示显示了本版摘要。程序内更新的下载和校验这一步不在这次验证里（它只接受 GitHub 来源）。没有做的：这个提交在 GitHub 上的 Linux 和 macOS 测试（推送之后才会跑）、在打包后的桌面程序里真正拖一次图、从真实的 Eagle 资源库导入。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.11.0-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.11.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.11.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.11.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.11.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.11.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.11.0-windows-portable.zip` | `fd8132586e1442a7b4815b52c8a15cded4a8629d65060012e6bd2c2eaa8aa989` |
| `sd-image-sorter-v3.11.0-app-patch.zip` | `702349ccec84e9ca4c571e1ad8a89fa19574faa8d42f18e8087a35429bd7715b` |
| `sd-image-sorter-v3.11.0-linux.tar.gz` | `4842c39b98d983951c3ef215a9119334a01bea6774e16c509e9375df6ca85b05` |
| `sd-image-sorter-v3.11.0-linux-portable-x86_64.tar.gz` | `56eac4018eac7ca9e49249b06215cc04a956726b6187b49e51f3e374a6da76a8` |
| `sd-image-sorter-v3.11.0-linux-portable-aarch64.tar.gz` | `4516ecd1fb69b0eb32f26b3c8742d961ad1ea9a7a6ffa5f6ffe1766af7ee0c63` |
| `sd-image-sorter-v3.11.0-release-manifest.json` | `522d157abb51f58debe31306f4890118fc1b3d852309eb4f24a37bed0ec9d3e5` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
