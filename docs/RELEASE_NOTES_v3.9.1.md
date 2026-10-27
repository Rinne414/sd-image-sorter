## v3.9.1 — 文件夹图检查 + 精确 token / Folder Checks + Exact Tokens

检查覆盖文件夹图，各底模精确计 token；读不到的图保留 AI 结果；多处卡顿修复。

Checks cover folder pictures; exact tokens per model; unreadable pictures keep AI work.

---

## Fixed / 修复

- **Pictures that cannot be read keep their AI work / 读不到的图保留 AI 结果**: A picture whose drive was unplugged, or whose file would not open, lost its AI and natural-language captions, aesthetic scores, AI rating and similarity data the moment the gallery listed it, and a caption from a paid cloud model cost money to make again. They stay now. When the file is back, the program compares it with what it had: the same picture keeps everything; a different picture at the same path loses the machine's work (it used to keep the old picture's AI tags), and hand-typed tags stay either way.
  - 图所在的硬盘拔掉、或文件打不开时，图库一列出它，AI 和自然语言 caption、美学分数、AI 评级和相似度数据就会被清掉；用付费云端模型生成的 caption 还得再花钱重做。现在都会保留。文件回来后程序会和原来的比对：同一张图全部保留；同一路径换成了别的图时才清掉 AI 结果（以前反而会留下旧图的 AI 标签），手打的标签都保留。
- **Dataset checks cover folder pictures / 数据集检查包含文件夹里的图**: Pictures imported from a folder were skipped by the health check ("local imports are not in the DB yet") and by character purity (CCIP), so a dataset built from a folder could not be checked. Both read them now, in the classic interface and Vopus: subject-count and trigger fixes apply to them too, and a flagged picture can be located. The health check's spelling, framing and frequency checks read the tags that export instead of the Library's tags. The Quality Audit counts their typed captions (it called every one untagged) and gives them the blur, flat and long-caption checks, which skipped them without a word.
  - 从文件夹导入的图以前会被健康检查（“本地导入的图片尚未入库”）和角色纯度（CCIP）跳过，用文件夹做的数据集没法检查。现在经典界面和 Vopus 都会检查它们：人数标签和触发词的修正同样适用，被标出的图也能定位。健康检查的拼写、构图和频率检查改为读取实际导出的标签，而不是图库标签。审计会计入它们输入的 caption（以前把每张都算成没有 caption），并对它们做模糊、过平和 caption 过长检查，以前会不声不响地跳过。
- **Exact token counts for every base model / 所有底模都有精确 token 数**: Only Anima was counted exactly; now SDXL (and no base model) counts with CLIP, FLUX with T5 and Krea 2 with Qwen3, each with its own one-time download (2 to 14 MB). Krea 2 keeps 507 tokens of a caption, not 512: its prompt template takes the rest. The tokenizers were checked to count the same as the ones the trainers and the model use, on 4,000 captions each.
  - 以前只有 Anima 能精确计数；现在 SDXL（以及未选底模）用 CLIP、FLUX 用 T5、Krea 2 用 Qwen3 计数，各自按需下载一次（2 到 14 MB）。Krea 2 的 caption 最多读 507 个 token，而不是 512：剩下的被它的提示词模板占用。每个分词器都在 4,000 条 caption 上核对过，与训练器和模型实际使用的计数一致。
- **Common tags in the Vopus subject-count fix / Vopus 人数修正里的通用标签**: A count tag that came from the batch's common tags (such as "solo") could not be taken off one picture. The fix now offers to move it into the captions: every other picture keeps it, written into its caption where it is missing, then Apply takes it off the conflicting ones. One Undo puts both back, the tag in its old place among the common tags.
  - 来自批次通用标签的人数标签（例如“solo”）以前没法只从一张图上去掉。现在修正会提供把它移进 caption：其他图都保留它（缺的会写进 caption），然后“应用”就能把它从有冲突的图上去掉。一次撤销会把两边都还原，标签回到通用标签里原来的位置。
- **No more freezes from long work / 长时间操作不再卡住程序**: Sending pictures to the trash (about 35 ms each), duplicate cleanup, image protect/restore (3 to 13 s a picture), browsing a slow folder, listing a library on an unplugged drive (over ten minutes for 80,000 pictures before) and 34 other actions whose work grows with the library ran on the server's main loop and held up every other request. They run beside it now.
  - 移到回收站（每张约 35 毫秒）、清理重复图、图片加密/还原（每张 3 到 13 秒）、浏览较慢的文件夹、列出拔掉硬盘上的图库（8 万张以前要十多分钟），以及另外 34 个随图库变大而变慢的操作，以前都在服务器主循环上执行，会卡住其他所有请求。现在都在旁边执行。
- **Honest results / 结果如实说明**: Duplicate cleanup said "Moved N" with N = the pictures it asked to move; it now says how many moved and why the rest did not. A picture that went to the trash while its gallery entry could not be removed says so. Manual Sort says when it cannot save its place. Keep/Reject decisions that could not be saved to a collection keep a Retry. AI captions no longer read an error answer as "Done! 0 captioned". A failed combined export says why. Thirteen error messages showed "HTTP 500" instead of the reason; they show the reason. The Review Cockpit says in plain words which pictures it covers, instead of "local-path items are not materialized".
  - 清理重复图以前说“已移动 N 张”，N 是要移动的数量；现在会说实际移了几张、其余为什么没移。移进回收站但图库条目没能删掉的图会说明。手动排序存不了进度时会提示。留/汰整理里没能存进收藏的决定会保留“重试”。AI caption 不再把错误回应当成“完成！0 张”。合并导出失败会说明原因。13 处错误提示以前只显示“HTTP 500”，现在显示原因。审阅驾驶舱用平实的话说明它检查了哪些图，不再显示“本地路径项目尚未物化”。
- **Controls no longer stay stuck / 按钮不再卡住**: GIF/video censoring kept Start greyed out after one poll got no answer; it keeps asking, says when it lost contact and when it is back, and frees Start for a job the program no longer knows. The restart banner's buttons work again when a restart never comes back. A Vopus sort-by-rules undo that left some images can run again for them.
  - GIF/视频打码只要一次轮询没有回应，“开始”就一直灰着；现在会继续询问，失去联系和恢复时都会提示，程序已不认得的任务会让“开始”恢复可用。重启一直没回来时，重启横幅上的按钮会恢复可用。Vopus 按规则整理的撤销若有几张没能还原，可以再撤销一次。
- **Readable at a glance / 一眼看得清**: On light pictures the Dataset Maker grid's queue numbers and file names were nearly invisible (1.03:1 contrast); they sit on a dark backdrop now. The Censor queue's "1 selected" no longer wraps into two lines beside All / None / Filter. The folder browser opens the nearest folder that exists and says why, instead of jumping to the drive list. The gallery's search row stays on one line at every desktop width; it broke onto two at 1280 in English, between 1536 and 1680 with a video library and at 2560 in Chinese.
  - 在浅色图片上，数据集制作网格里的序号和文件名几乎看不见（对比度 1.03:1）；现在有深色底衬。打码队列里的“已选 1 张”不再挤成两行。文件夹浏览器打不开某个文件夹时，会打开最近一层能打开的文件夹并说明原因，不再直接跳到驱动器列表。图库的搜索栏在各种桌面宽度下都保持一行；以前英文在 1280、有视频的图库在 1536 到 1680、中文在 2560 时会折成两行。

---

## Upgrading / 升级注意

- Nothing to do. Exact token counts for a base model download its tokenizer files the first time you ask (SDXL and FLUX about 2 MB, Krea 2 about 11 MB, Anima about 14 MB; files Anima already downloaded also count Krea 2 and FLUX). Pictures that were already marked unreadable before this update had their AI work cleared then; it cannot be brought back.
  - 无需操作。某个底模第一次要精确 token 数时，会下载它的分词器文件（SDXL 和 FLUX 约 2 MB，Krea 2 约 11 MB，Anima 约 14 MB；Anima 已下载的文件也能给 Krea 2 和 FLUX 计数）。本次更新前已被标为读不到的图，当时清掉的 AI 结果无法找回。

---

## Validation / 验证

GitHub CI run 40515556525 (Linux full suite with browser tests and click coverage, macOS, Windows, Linux portable x86_64 and aarch64): 5 of 5 green; backend 9,208 passed; browser tests 1,973 passed, 0 failed, 0 flaky; V Opus unit tests 1,183 passed. The new tests for the search row and for the folder-scan audit and blur check fail on the code before the fix and pass now. On a fresh 3.9.1 Windows package, as a new user, with four pictures imported from a folder (none in the Library): the health check fixed a typed 1girl, 2girls, solo caption (2girls kept); SDXL downloaded its 2 MB CLIP tokenizer and then counted exactly; the Quality Audit said 3 untagged (the captioned one counted), scored all four and listed the blurred and the flat one; character purity downloaded its model (150 MB) and flagged the flat picture. Classic in English and Chinese and V Opus opened with no console errors.
  - GitHub CI（40515556525：Linux 完整测试含浏览器测试和点击覆盖、macOS、Windows、Linux 便携版 x86_64 与 aarch64）5 项全部通过；后端 9,208 通过；浏览器测试 1,973 通过、0 失败、0 个偶发；V Opus 单元测试 1,183 通过。新加的测试（搜索栏、文件夹扫描的审计和模糊检查）在修复前的代码上失败、现在通过。在全新的 3.9.1 Windows 包里以新用户身份，从文件夹导入四张图（都不在图库里）：训练前健检修正了输入的 1girl, 2girls, solo（保留 2girls）；SDXL 下载 2 MB 的 CLIP 分词器后改为精确计数；审计显示 3 张没有 caption（有 caption 的那张算进去了），四张都评了分并列出糊图和过平的图；角色纯度下载模型（150 MB）后标出了过平的那张。经典界面中英文和 V Opus 打开都没有控制台错误。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.9.1-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.9.1-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.9.1-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.9.1-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.9.1-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.9.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

CHECKSUMS_PENDING
