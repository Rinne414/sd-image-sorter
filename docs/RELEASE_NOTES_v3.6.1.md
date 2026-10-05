## v3.6.1 — 保存更省心 + 流程细节修正 / Easier Saving + Workflow Polish

打码存档不用先选文件夹，同名自动加编号；手动排序跳过已分类的图；LoRA 导出不再重复写标签。Saves need no folder, same names get numbered, Manual Sort skips sorted pictures.

---

## Fixed / 修复

- **Save without setup**: the Censor editor, Pixiv set publishing and video / GIF censoring save into the program's own `output` folder (`output/censor`, `output/publish`, `output/video-censor`) when the folder field is left empty. Settings → General → Where saves go moves that folder for every flow, and the toast after a save opens the folder.
  - **存档不用先设置**：打码编辑器、Pixiv 成套发布和视频 / GIF 打码在保存文件夹留空时，存到程序自带的 `output` 文件夹（`output/censor`、`output/publish`、`output/video-censor`）。设置 → 常规 → 保存位置 可以一次改掉所有流程的位置，保存后的提示可以直接打开文件夹。
- **Same-name files get a number**: saving another version of a picture writes `name_2.png`, `name_3.png` … instead of stopping; Replace or Skip can be picked instead. Moves, dataset exports, uploads and imports use the same `_2` numbering.
  - **同名自动加编号**：同一张图再存一个版本时写成 `name_2.png`、`name_3.png`…，不会卡住；也可以改选覆盖或跳过。移动、数据集导出、上传和导入都用同样的 `_2` 编号。
- **Censor Adjust tab**: brightness, contrast and the other Adjust sliders show on the picture again. A badge says while they are only a preview, and the save dialog offers to apply them first. Rename dialog hints, a reachable Apply button, an honest "saved" badge, Reset buttons named for what they reset, and a review counter that follows queue reorders.
  - **打码调色**：亮度、对比度等调色滑杆的效果重新显示在图上。还只是预览时会有标记，保存对话框会提示先套用。改名对话框有提示、「套用」按钮够得到、「已保存」标记如实显示，三个重置按钮写明各自重置什么，复核计数跟着队列重排。
- **Manual Sort skips already sorted pictures**: pictures Auto-Separate or Manual Sort already copied or moved are left out of a new session, with a note and a one-click "Include them"; undo says what it undid. Resume uses the folders you edited, Continue on the home page resumes, and slots with long paths show the folder name.
  - **手动排序跳过已分类的图**：自动分类或手动排序已复制或移动过的图，新会话不再列入，并有提示和一键「重新包含」；撤销会说明撤销了什么。继续上次的会话会用你改过的文件夹，首页「继续」会接着上次做，长路径的槽位显示文件夹名称。
- **LoRA dataset export**: the default export wrote every tag twice and split the trigger word (`mylora_walk` and `mylora walk`); each tag is now written once and the trigger exactly as typed. Gallery training captions stop repeating Smart Tag's tags. Export goes into kohya's `<repeats>_<name>` folder by default and warns when an older kohya folder next to it would train the pictures twice; a red token count says why and what to do.
  - **LoRA 数据集导出**：默认导出会把每个标签写两遍，触发词也被拆开（`mylora_walk` 和 `mylora walk`）；现在每个标签只写一次，触发词照你输入的写。图库的训练 caption 不再重复智能打标的标签。导出默认写进 kohya 的 `<repeats>_<名称>` 文件夹；旁边若有旧的 kohya 文件夹会让图片被训练两次，会提醒你；token 数变红时会说明原因和怎么做。
- **Pixiv set publishing**: pictures without censoring are left out by default ("Export them as they are" keeps them), the result says what was left out and which name fields apply, and the watermark starts off each time.
  - **Pixiv 成套发布**：没有打码的图默认不导出（选「照原图一起导出」可保留），结果会说明排除了哪些、哪些命名字段有效；水印每次打开都默认关闭。
- **Missions and banners**: the Gallery batch bar leads with the mission's next step; a mission's steps show the first time only; the "what next?" banner closes when you leave the page, start a sort or start selecting; the red confirm button is kept for moves, not downloads or copies.
  - **任务与提示条**：图库批量操作栏把任务的下一步放在最前面；任务步骤只在第一次显示；「下一步做什么」提示条在离开页面、开始排序或开始选图时自动关闭；红色确认按钮只留给移动，下载和复制不再用红色。
- **Smart Tag and Auto-Separate**: Smart Tag shows a finish notice with counts beside Run; Auto-Separate says what it did.
  - **智能打标与自动分类**：智能打标跑完后在「运行」旁显示结果和数量；自动分类会说明做了什么。
- **Interface text**: labels that change while you work (Select Images / Done Selecting, loading messages, dialog titles, tagger hints) no longer jump back to their default text. The Chinese UI translates rating names, button tooltips and path errors, and uses one name for AI tagging.
  - **界面文字**：操作中会变的文字（选择图片 / 完成选择、加载信息、对话框标题、打标器提示）不再跳回默认文字。中文界面翻译了分级名称、按钮提示和路径错误，AI 打标统一用一个名称。
- **Gallery and layout**: imported folders unfold in the sidebar tree; filter group counts show 0 after Clear; a calmer import progress line; readable small text over the home page cover; the Dataset workbench fits 1366×768.
  - **图库与版面**：导入的文件夹会在侧栏树中展开；筛选分组按「清除」后显示 0；导入进度信息更简洁；首页封面上的小字看得清楚；数据集工作台在 1366×768 下排版正常。
- **Linux and macOS**: network (UNC) paths are recognised on Linux and macOS, records whose path the system cannot place are never offered for clearing, exports name case-only twin files correctly, and the support log hides macOS `/private` paths.
  - **Linux 与 macOS**：Linux 和 macOS 上能识别网络（UNC）路径，系统无法定位路径的记录不会被列为可清除，导出能正确指出只差大小写的同名文件，支持日志会隐藏 macOS 的 `/private` 路径。

---

## Upgrading / 升级注意

- Saves with an empty folder field now go to `output` inside the program folder. Video censoring used to write a `censored` folder next to the source pictures. The in-app updater never touches `output`; change the location in Settings → General → Where saves go.
  - 保存文件夹留空时，文件现在存到程序文件夹里的 `output`。视频打码以前会在原图旁边建 `censored` 文件夹。程序内更新不会动 `output`；位置可在 设置 → 常规 → 保存位置 修改。
- Manual Sort leaves out pictures that were already sorted. Only sorts done after upgrading are remembered; "Include them" in the note brings them back.
  - 手动排序会排除已分类的图。只会记住升级之后做的分类；点提示里的「重新包含」可以把它们加回来。
- LoRA dataset export writes into `<folder>/<repeats>_<name>/` by default; uncheck "kohya folder structure" for the old flat layout. If you exported into the same place before, remove the older folder so the pictures are not trained twice.
  - LoRA 数据集导出默认写进 `<文件夹>/<repeats>_<名称>/`；取消勾选「kohya 文件夹结构」可恢复原来直接写进文件夹的方式。如果以前导出到同一个位置，请删掉旧文件夹，免得图片被训练两次。
- The database gets one new table on the first launch; this is automatic and needs no rescan.
  - 第一次启动时数据库会自动新增一张表，不需要重新扫描。

---

## Validation / 验证

Windows: backend 8,532 passed, 13 skipped; desktop E2E 1,321 tests: 1,317 passed, 0 failed, 4 skipped. GitHub CI (Linux, macOS, Windows, both Linux portable builds) green: Linux backend 8,385 passed, 69 skipped (91% line coverage); Linux E2E 1,299 tests: 1,287 passed, 0 failed, 10 skipped, 2 flaky, both traced to test timing and fixed; click coverage gate passed. / Windows：后端 8,532 个通过、13 个跳过；桌面 E2E 1,321 项：1,317 通过、0 失败、4 跳过。GitHub CI（Linux、macOS、Windows、两种 Linux 便携版）全部通过：Linux 后端 8,385 个通过、69 个跳过（行覆盖率 91%）；Linux E2E 1,299 项：1,287 通过、0 失败、10 跳过、2 项不稳定，均查明是测试时序问题并已修正；点击覆盖率检查通过。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.6.1-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.6.1-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.6.1-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.6.1-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.6.1-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.6.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

CHECKSUMS_PLACEHOLDER
