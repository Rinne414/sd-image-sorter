## v3.9.0 — 数据集检查新增三项 / Dataset Check: Subject Counts, Blur, Anima Tokens

数据集检查新增：人数标签冲突修正、糊图提示、Anima 精确 token 数。

Dataset Check adds subject-count fixes, blur hints and exact Anima token counts.

---

## Fixed / 修复

- **Subject-count conflicts in the Check step / 检查步骤的人数标签冲突**: a caption that says `1girl` and `2girls` (or `multiple girls`), or `solo` beside two or more people, is listed with a fix to preview. The fix keeps the higher count and takes `solo` off multi-subject pictures (`solo_focus` is left alone); you tick the pictures to change and apply them in one undoable step. The idea is from BooruDatasetTagManagerPlus; the code is new.
  - 同一张图的 caption 里 `1girl` 和 `2girls`（或 `multiple girls`）并存，或多人图带 `solo`，会列出可预览的修正：保留较高的人数、去掉多人图上的 `solo`（不动 `solo_focus`），勾选要改的图后一步应用，可一步撤销。思路来自 BooruDatasetTagManagerPlus，代码为新写。
- **Exact Anima token counts in the Check step / 检查步骤里的 Anima 精确 token 数**: with the base model set to Anima, every caption is counted with the two tokenizers Anima reads it with, Qwen3-0.6B and T5 v1.1 XXL, and "too long" means either count is over 512. The two small tokenizer files (about 14 MB, Apache-2.0) are downloaded once on request, pinned and SHA-256 verified; until then the old estimate stays and says it is an estimate. The idea is from dataset-annotation-studio (Apache-2.0); the counting code is new.
  - 底模设为 Anima 时，每条 caption 都用 Anima 读取它的两个分词器（Qwen3-0.6B 和 T5 v1.1 XXL）精确计数，任一计数超过 512 就算太长。两个很小的分词器文件（约 14 MB，Apache-2.0）按需下载一次，固定版本并校验 SHA-256；在此之前仍用旧的估算，并标明是估算。思路来自 dataset-annotation-studio（Apache-2.0），计数代码为新写。
- **Blurry and very flat pictures in the Check step / 检查步骤里的糊图和过平图**: pictures that may be soft or blurry (low Laplacian variance) or are very flat (almost one colour) are listed as hints with their numbers. They are scored on the CPU in a background job (300 pictures take about 3 seconds), cached per file, and never deleted. The blur threshold (default 50, chosen on 1,000 real anime pictures plus 10 blurred by hand; 0 skips it) can be changed; no threshold separates soft-shaded art from real blur, so the hint only says "may be". How it was chosen, and where it is weak, is written in `docs/MODELS_CONSIDERED.md`. The idea is from lora-dataset-studio (non-commercial licence, so only the idea; the code is new).
  - 可能偏软或糊（拉普拉斯方差低）、或过于平（几乎同一种颜色）的图，会作为提示列出并带上数值。分数用 CPU 在后台任务里算（300 张约 3 秒），按文件缓存，从不删除文件。清晰度阈值可改（默认 50，依据 1,000 张真实二次元图和 10 张手工模糊的图；0 为不查糊图），没有任何阈值能把柔和上色和真的糊分开，所以提示只说“可能”；阈值怎么定的、哪里不准，写在 `docs/MODELS_CONSIDERED.md`。思路来自 lora-dataset-studio（非商业许可，只借思路，代码为新写）。
- **The same three checks in the classic interface / 经典界面里的同样三项检查**: the classic Dataset Maker now has what Vopus got first. The Review Cockpit health check lists subject-count conflicts with a tick per picture, one Apply and one Undo. The Quality Audit gets "Blurry / flat" (a sharpness field, scored in the background with progress and a Stop button, shown as badges that filter the queue) and "Long captions" (an estimate until Anima's two tokenizer files, about 14 MB, are downloaded on request; then exact Qwen3 and T5 counts, also in the caption editor's counter).
  - 经典数据集制作现在也有 Vopus 先得到的三项检查。审阅驾驶舱的健康检查会列出人数标签冲突，可逐张勾选、一键应用、一键撤销；审计里新增「糊图 / 过平」（清晰度输入框，后台评分，有进度和停止按钮，结果是可过滤队列的徽章）和「过长的 caption」（Anima 的两个分词器文件约 14 MB，按需下载前只是估算，下载后用 Qwen3 和 T5 精确计数，caption 编辑器下的计数也一样）。
- **Limits of the new checks / 新检查的限制**: subject-count fixes work on Library pictures, not on folder pictures; a conflicting tag that comes from the batch's common tags cannot be removed from one picture's caption (a message says so), and Undo restores only the captions not edited after the fix. The blur threshold of 50 was chosen on 1,000 ComfyUI pictures judged by a model, not rated by people, plus copies blurred by hand: soft or dark anime art can still be listed, so raise the field (for example to 60) or set it to 0 to skip blur. Exact token counts are for Anima only; other base models keep the estimate.
  - 人数标签修正只对图库里的图有效，文件夹里的图不行；冲突的标签如果来自这批图的通用标签，就没法只从一张图的 caption 里去掉（会有提示）；撤销只恢复修正之后没有再编辑过的 caption。清晰度阈值 50 是用 1,000 张 ComfyUI 图（由模型判断，不是人工评分）和手工模糊的副本定的：柔和或偏暗的二次元图仍可能被列出，可以把数值调高（例如 60），或设为 0 不查糊图。精确 token 数只针对 Anima，其他底模仍是估算。
- **Dataset export waits for caption versions / 数据集导出等 caption 版本读完**: a project reads its saved caption versions after it opens, page by page in a large project. Until they are read, Export and Check are disabled and say "Reading the project's caption versions..."; before, they could be pressed and showed an English "Saved caption versions are not loaded" in either language, and the check stayed failed until it was run again. A failed read says "Can't read the project's caption versions right now. Reload the project, then export.", and its message no longer says "Could not save caption version".
  - 项目打开后会读取保存的 caption 版本，大项目分页读取。读完之前「导出」和「检查」会停用，并显示「正在读取项目的 caption 版本...」；以前可以按下，中英文界面都会出现英文的 "Saved caption versions are not loaded"，检查会一直停在失败，要再跑一次。读取失败时提示「现在读不到项目的 caption 版本。重新载入项目后再导出。」，失败消息也不再写成「无法保存 caption 版本」。
- **"Empty captions" in the classic Quality Audit / 经典审计里的「空 caption」**: Library pictures were judged by their Library tags, so a picture with a caption typed in the Dataset Maker was listed as "would export empty .txt files", and one whose caption was cleared there was not. The check now reads the caption each picture exports, for Library and folder pictures alike (Vopus already did).
  - 图库里的图以前按图库标签判断，所以在数据集制作里打了 caption 的图会被列为「会导出空的 .txt」，在这里清空了 caption 的图反而不会。现在图库图和文件夹图一样，按每张图实际导出的 caption 判断（Vopus 本来就是这样）。
- **Style Map recompute / 画风地图重新计算**: asking for a recompute again (or from a second tab) while the same map is being computed takes that result instead of computing it a second time.
  - 同一张画风地图正在计算时再要求重新计算（或从另一个标签页），会直接用这次的结果，不再重算一遍。

---

## Upgrading / 升级注意

- Nothing to do. The exact Anima counts download two tokenizer files (about 14 MB, from Hugging Face, pinned and SHA-256 checked) and install the `tokenizers` package the first time you ask for them; until then the estimate is shown and labelled.
  - 无需操作。第一次要 Anima 精确计数时，会下载两个分词器文件（约 14 MB，来自 Hugging Face，固定版本并校验 SHA-256）并安装 `tokenizers` 组件；在此之前显示估算，并标明是估算。

---

## Validation / 验证

GitHub CI run 40414067489 (Linux full suite with browser tests and click coverage, macOS, Windows, Linux portable x86_64 and aarch64): 5 of 5 green; backend 9,131 passed; browser tests 1,943 passed, 0 failed, 0 flaky. Locally, without retries: the 33 dataset, Find Moved Images and Smart Tag browser spec files (324 tests) and the audit spec (13 tests). The new tests for Export waiting on caption versions, the failed-read message, the Style Map recompute and the empty-caption check fail on 3.8.1's code and pass now. On a fresh 3.9.0 Windows package, as a new user with real pictures: a typed 1girl, 2girls, solo caption got the subject-count fix (2girls kept, 1girl and solo taken off, one Undo); the audit scored four pictures and listed the blurred and the flat one; Anima showed the estimate, downloaded its two tokenizers (14 MB, into the package's own folder) and then counted exactly.
  - GitHub CI（40414067489：Linux 完整测试含浏览器测试和点击覆盖、macOS、Windows、Linux 便携版 x86_64 与 aarch64）5 项全部通过；后端 9,131 通过；浏览器测试 1,943 通过、0 失败、0 个偶发。本机（不重试）：数据集、查找移动的图片和 Smart Tag 的 33 个浏览器测试文件（324 个测试）以及审计测试（13 个）。新加的测试（导出等 caption 版本、读取失败的提示、画风地图重新计算、空 caption 检查）在 3.8.1 的代码上失败、现在通过。在全新的 3.9.0 Windows 包里以新用户身份用真实图片走了一遍：输入 1girl, 2girls, solo 的 caption 得到人数修正（保留 2girls、去掉 1girl 和 solo，可一步撤销）；审计给四张图评分，列出了糊图和过平的图；选 Anima 后先显示估算，下载两个分词器（14 MB，放在程序自己的文件夹里）后改为精确计数。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.9.0-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.9.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.9.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.9.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.9.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.9.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.9.0-windows-portable.zip` | `c30feb6e2d7846fbc066ef3a6254df78c598cdb9f89fc6183b64c76668b97346` |
| `sd-image-sorter-v3.9.0-app-patch.zip` | `564f539408af2259c9d306630b9ac718a4b52f7aa76178af9b8ce3b9c8a0f319` |
| `sd-image-sorter-v3.9.0-linux.tar.gz` | `f12de609cee62028d23630b66b49b8bc4496f78f4198e5250b0879bf1f44b485` |
| `sd-image-sorter-v3.9.0-linux-portable-x86_64.tar.gz` | `b0dd722e4a0778b43119574994df7aa660176a0e09525fe93b186f9acb0398d1` |
| `sd-image-sorter-v3.9.0-linux-portable-aarch64.tar.gz` | `05c2621d3160460f4884e661c5c3bc1d72d9bd6fec5156a383b794276b57b003` |
| `sd-image-sorter-v3.9.0-release-manifest.json` | `afdca974a24545ce56982ea0a66f6e732b970790b45a16ef662a3521817de532` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
