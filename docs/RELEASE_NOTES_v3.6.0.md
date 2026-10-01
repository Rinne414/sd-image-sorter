## v3.6.0 — 画风地图 + 模型共用 / Style Map + Shared Models

新增画风地图；直接用 ComfyUI 已有的模型；元数据误判修正，升级后请重扫图库。Style Map, reuse ComfyUI models, metadata fixes; rescan once.

---

## Fixed / 修复

- **Style Map**: a new top-bar tab draws the library in 3D, similar styles close together, in three switchable spaces (style identification, similarity, and the optional CSD style model). Colour dots by generator, folder, artist or an aesthetic score (LAION, Waifu, anime); find any Gallery picture on the map or search it with Gallery syntax; drop a picture to find its nearest; see the pictures and style tags at both ends of each axis, or define your own axis from example pictures (e.g. thick paint ↔ flat colour); Shift+drag to box-select dots and send them to a collection, Censor, Dataset Maker, or view only them in the Gallery; region landmarks name styles and likely artists.
  - **画风地图**：新的顶栏分页把图库画成 3D 点云，画风相近的靠在一起，可切换三种空间（画风识别、相似，以及可选的 CSD 画风模型）。点可按生成器、文件夹、画师或美学评分（LAION、Waifu、动漫）上色；能在地图上找到图库里的任一张图，或用图库的搜索写法查找；丢一张图找最像的；可看每个轴两端的代表图和画风标签，或用范例图自订轴（例如厚涂 ↔ 平涂）；Shift+拖曳框选后送去合集、打码、数据集，或在图库里只看这些图；区域标记会标出画风和可能的画师。
- **Portable launcher**: GPU installs no longer reinstall packages at every start; the launcher writes why it reinstalls to the screen and `data/logs/launcher.log`.
  - **便携版启动器**：GPU 安装不再每次启动都重装依赖；启动器会在屏幕上和 `data/logs/launcher.log` 写出重装的原因。
- **Trusted model folders / Model sources card**: Model Center shows where models are read from, finds pinned models in ComfyUI installs and Hugging Face caches, and uses them in place instead of downloading again. Network drives are added by you; a missing external file is never silently re-downloaded.
  - **信任模型文件夹 / 模型来源卡**：模型中心显示模型的读取位置，能在 ComfyUI 安装和 Hugging Face 缓存里找到所需模型并直接使用，不再重复下载。网络磁盘由你自己加入；外部文件不见时不会被悄悄重新下载。
- **Gallery filters and top bar**: filter by anime grade and Waifu score; customise every tab and its order; the Gallery toolbar stays pinned while the grid scrolls; the tag library can Show all.
  - **图库筛选与顶栏**：可按动画等级和 Waifu 评分筛选；每个分页及顺序都可自定义；图库滚动时工具栏固定；标签库可「显示全部」。
- **Re-read ComfyUI Prompts**: Settings → Dataset Audit re-parses every ComfyUI image of the library from its file and rewrites only rows whose prompt came out different.
  - **重读 ComfyUI 提示词**：设置 → 数据集体检 把图库里每张 ComfyUI 图从文件重新读一遍，只改写提示词读出来不同的图。
- **Quality tag from the anime grade**: the dataset caption `{quality}` uses the deepghs anime grade when a picture has one.
  - **质量词来自动画等级**：数据集 caption 的 `{quality}` 在图片有 deepghs 动画等级时改用它。
- **Security**: `/api` refuses requests from other websites and DNS-rebinding hostnames; full-pickle model files load only from the program folder or a trusted folder; an offline NAS no longer freezes the program; the settings file survives power loss and a failed save says why.
  - **安全**：`/api` 拒绝其他网站和 DNS 重绑定主机名发来的请求；完整 pickle 的模型文件只从程序文件夹或信任文件夹加载；离线 NAS 不再卡住程序；设置文件能承受断电，保存失败会说明原因。
- **Scan and reconnect**: a stale fingerprint is no longer kept for a changed file that cannot be rehashed; reconnect verifies approximate matches against the pixels, and manual relinking shows whether pixels match or differ.
  - **扫描与重新连接**：内容变了但无法重新哈希的文件不再保留过期指纹；重新连接会用像素验证近似匹配，手动配对时会显示像素相同或不同。
- **Selection scope**: every "act on the matches" path uses the whole Gallery filter, and loading a preset or smart folder replaces the filter.
  - **选择范围**：所有「对匹配结果执行」的操作都用完整的图库筛选，载入预设或智能文件夹会替换筛选。
- **Metadata false positives**: chat-app GIF stickers are no longer read as ComfyUI; Note nodes, GPU names, overlay text and an LLM node's system prompt are no longer stored as the prompt; stale widget values and zeroed negatives are ignored. Parsing a workflow with a long chain of text nodes went from 16-40 s to fast per image. Parsed metadata version is now 12.
  - **元数据误判**：聊天软件的 GIF 贴图不再判成 ComfyUI；笔记节点、显卡名称、叠加文字和 LLM 节点的系统提示词不再被当成提示词；过期的控件旧值和被清零的负面会被忽略。含很长文字节点链的工作流，每张图的解析时间从 16-40 秒降到很短。解析版本升到 12。
- **ComfyUI prompts**: Impact Pack pipes, TIPO / WD14 ban lists and hires or refiner passes no longer put the negative inside the positive or store the prompt twice.
  - **ComfyUI 提示词**：Impact Pack 管线、TIPO / WD14 屏蔽词列表和高清修复 / 精修的第二遍，不再把反向混进正向或把提示词存两遍。
- **Quick Auto Censor on Windows CPU**: onnxruntime is now 1.21.0, which reads the opset 22 YOLO files current PyTorch exports; a detector that did not run says so instead of "No match".
  - **Windows CPU 的快速自动打码**：onnxruntime 升到 1.21.0，能读现在 PyTorch 导出的 opset 22 YOLO；检测器没有运行时会明说，而不是显示「未匹配」。
- **Progress and error text**: scan, tagging, Smart Tag, Auto-Separate, moves, artist identification and character purity messages now follow the UI language and keep the actionable cause.
  - **进度与错误信息**：扫描、打标、智能标签、自动分类、移动、画师识别和角色纯度的信息现在按界面语言显示，并保留可操作的原因。
- **Gallery search and layout**: a half-typed `tag:` value is no longer applied while typing; the Entry page, Settings, Auto-Separate and Prompt Lab layouts are fixed at laptop sizes.
  - **图库搜索与版面**：打了一半的 `tag:` 值不再在输入中途套用；入口页、设置、自动分类和提示词实验室的版面在笔记本尺寸下已修正。

---

## Upgrading / 升级注意

- Rescan your Gallery folders once after upgrading so the metadata fixes reach old pictures (parsed metadata version is now 12). For ComfyUI pictures you can also use Settings → Dataset Audit → Re-read ComfyUI Prompts.
  - 升级后请对图库文件夹重新扫描一次，元数据修正才会套用到旧图（解析版本升到 12）。ComfyUI 的图也可以用 设置 → 数据集体检 → 重读 ComfyUI 提示词。
- The Style Map builds an index of style vectors the first time you open it; this takes a while on a large library. UMAP is an optional install; PCA works without it.
  - 画风地图第一次打开时会建立画风向量索引，图库很大时需要一些时间。UMAP 是可选安装，不装也能用 PCA。
- Windows CPU installs get onnxruntime 1.21.0 on the next launch. The theme picker is gone; the interface keeps one palette.
  - Windows CPU 安装在下次启动时会装上 onnxruntime 1.21.0。主题选择已移除，界面只保留一套配色。

---

## Validation / 验证

TBD (lead fills in)

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.6.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.6.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.6.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.6.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.6.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.6.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

TBD (filled after packaging)
