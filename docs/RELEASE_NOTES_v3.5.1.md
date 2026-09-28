## v3.5.1 — 视频打码 + 隐私伪装 + 美学分 / Video Censor + Disguise + Scores

视频和 GIF 可整段自动打码；聊天伪装与去隐写上线；可选 Waifu / deepghs 美学分。GIF/video censor, chat disguise, optional anime scores.

---

## Fixed / 修复

- **Folder video and GIF censor**: auto-censor every frame of the GIFs and videos in a folder. Manual censoring has its own quick keys. Box-only detections can draw an ellipse or a fitted outline, and the edge can grow. Auto mosaic uses a cell of 1/100 of the long side.
  - 文件夹里的 GIF 和视频可以逐帧自动打码。手动打码有自己的快捷键。只有框的检测可以画椭圆或贴合轮廓，边缘可以外扩。自动马赛克格子是画面长边的百分之一。

- **Anime censor detector and face guard**: an opt-in anime detector, and a face guard that skips detections that are really a face. Both download when you Prepare them.
  - 可选的动漫检测器，以及会跳过「其实是脸」的脸部保护。都在准备时才下载。

- **Chat disguise and pixel-hidden prompts**: Privacy Tools can build a chat-disguise image, copy it out, and pack the queue into a plain looping GIF. A scan writes the real picture beside a disguise as `<name>_real.png` and does not replace the disguise. Strip metadata also clears a NovelAI or WebUI stealth prompt hidden in pixels. Protecting a file twice no longer scrambles it again.
  - 隐私工具可以做聊天伪装、复制出去，并把队列收成普通循环 GIF。扫描会在伪装图旁边另存真图 `<name>_real.png`，不覆盖伪装图。「去除元数据」也会清掉藏在像素里的提示词。同一张图保护两次不会再被搅乱。

- **Aesthetic scores**: Waifu Scorer V3 and the deepghs grade (masterpiece through worst) are optional. CLIP now uses QuickGELU. Scores from 3.5.0 and earlier are kept and marked to score again; Score Aesthetic redoes them when you run it.
  - 可选 Waifu Scorer V3 和 deepghs 等级（masterpiece 到 worst）。CLIP 改为 QuickGELU。3.5.0 及更早的分数保留并标成待重算，你自己跑评分时才会重算。

- **PixAI Tagger v1.0 and calmer GPU runs**: v1.0 sits next to v0.9. Large taggers use smaller batches, rest between GPU batches, and keep one tagger loaded. Tag search answers from the library counts, and tags written by another process show up at once.
  - PixAI Tagger v1.0 跟 v0.9 并列。大输入打标器用更小的批次，GPU 批次之间会休息，同时只留一个打标器。标签搜索改读图库计数，别的进程刚写入的标签立刻可见。

- **Each library keeps its own work**: a tab keeps its library when another tab switches. Collections, duplicate scans, artist style results, and tag backup stay in the current library. Smart Tag with the booru tagger off writes only the description.
  - 一个分页保持自己的图库。合集、查重、画师风格、标签备份都留在当前图库。关掉 booru 打标的 Smart Tag 只写描述。

- **Censor boxes, gallery, and sort say what happened**: boxes on EXIF-rotated JPEGs land and save where you see them. Dropping files asks first. Move and copy start from the last destination. Undo, a partial library move, Manual Sort resume, colour analysis, and Find Moved Files report the real result. Reader paste works, and a saved edit stays in that image's own metadata format.
  - 带 EXIF 旋转的 JPEG，打码框落在你看到的位置并按该位置保存。拖入文件会先问。移动和复制从上次的目的地开始。撤销、搬库中途失败、手动分拣、颜色分析、找回移动过的文件都会说明真实结果。读图可以粘贴，保存的编辑仍写回这张图自己的格式。

---

## Upgrading / 升级注意

- The first launch adds migration 049 (aesthetic version and the anime-score columns). Old aesthetic scores stay as they are and count as "to score". Nothing is rescored until you run Score Aesthetic.
  - 第一次启动会跑迁移 049（美学分版本和动画分数栏）。旧分数原样保留，并算作待评分。你自己跑评分之前不会重算。
- Anime censor, face guard, Waifu Scorer, and deepghs stay opt-in. The upgrade does not download them.
  - 动漫打码、脸部保护、Waifu Scorer、deepghs 仍是可选。升级不会自动下载。
- A later scan of a chat-disguise PNG writes `<name>_real.png` beside it. The disguise file is not replaced.
  - 之后再扫描聊天伪装 PNG 时，会在旁边写出 `<name>_real.png`。伪装文件本身不会被替换。

---

## Validation / 验证

Full CI was skipped at the owner's request. lazy_release_qa --skip-server PASS. / 应主人要求跳过完整 CI。lazy_release_qa --skip-server 通过。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.1-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.1-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.1-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.1-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.1-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.1-windows-portable.zip` | `ad2edeccdf0835a07ea1682a0e09b3b90e0b2862b37116b569e836a1761c6d5f` |
| `sd-image-sorter-v3.5.1-app-patch.zip` | `72ab390ad82e3f6cca0b3a60630305ea665de7442345828df66ce7204f73b145` |
| `sd-image-sorter-v3.5.1-linux.tar.gz` | `e2c6cb9eeabed4aea2eff52eb41ba57f0824405386bf2015c9b67a0914cef43a` |
| `sd-image-sorter-v3.5.1-linux-portable-x86_64.tar.gz` | `6b66a3ac2ae80dbce4634461c9e1e3e3d95cf4d91cac9d94745f86503022ca47` |
| `sd-image-sorter-v3.5.1-linux-portable-aarch64.tar.gz` | `658c676fe9a12909b889874021eb9a869a52b6c951ebef34bcc40509ac8222de` |
| `sd-image-sorter-v3.5.1-release-manifest.json` | `700fd36ae86f1ad1962a39b2c2f3d12797d9df19be93d5ce83d389492e9e657d` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
