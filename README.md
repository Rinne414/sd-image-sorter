# SD Image Sorter (AI 图像筛选管理器)

[English](#english) | [简体中文](#简体中文)

---

<a name="english"></a>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.6.1-purple" alt="Version">
  <img src="https://img.shields.io/badge/python-3.9+-blue" alt="Python">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Platform">
</p>

<h3 align="center">The all-in-one image manager for Stable Diffusion creators.</h3>

<p align="center">
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-windows-portable.zip"><b>⬇️ Download for Windows</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-linux-mac.tar.gz"><b>⬇️ Download for Linux/Mac</b></a>
</p>

---

### Ever feel like this?

> *Thousands of AI images scattered everywhere. Some have metadata, some don't. You can't search by prompt, can't filter by model, can't find that one image you made last week...*

**SD Image Sorter** fixes all of that — and more.

| Gallery View | Manual Sort | Censor Edit |
|:------------:|:-----------:|:-----------:|
| ![Gallery](docs/screenshots/gallery_view.png) | ![Manual Sort](docs/screenshots/manual_sort.png) | ![Censor Edit](docs/screenshots/censor_edit.png) |

| Gallery Navigation | Manual Sort Flow |
|:------------------:|:----------------:|
| ![Gallery Demo](docs/screenshots/gallery_demo.gif) | ![Manual Sort Demo](docs/screenshots/manual_sort_demo.gif) |

---

## ✨ What Can It Do?

### 🖼️ Gallery — Your images, finally organized

Point it at any folder. The app scans your images, **auto-detects the generator** (ComfyUI, NovelAI, WebUI, Forge), and **extracts everything**: prompts, negative prompts, sampling settings, checkpoints, LoRAs, seeds — all searchable, all filterable.

- **Filter** by generator, tags, content rating, checkpoint, LoRA, prompt keywords, image dimensions, aspect ratio
- **Sort** by date, filename, prompt length, tag count, or AI-predicted rating
- **Tab view** separating images by generator type

### 🏷️ AI Tagging — One click, thousands of tags

Built-in **WD14 Tagger** (anime/illustration-focused) automatically labels every image with descriptive tags like `1girl`, `blue_hair`, `school_uniform`, `outdoors` — plus character recognition and content rating.

- **8 runnable taggers**: EVA02-Large, SwinV2, ConvNeXt, ViT, ViT-Large, Camie v2, PixAI v0.9, ToriiGate 0.5
- **Newer tag spaces**: Camie v2 and PixAI v0.9 improve coverage beyond the older WD tag databases
- **Experimental VLM backend**: ToriiGate 0.5 runs through a separate Transformers-based multimodal backend instead of the WD14 ONNX runtime
- **Large first-run download warning**: ToriiGate is much larger than the WD14 models, so the first download is significantly heavier
- **Dual thresholds**: tune general tag sensitivity separately from character tag sensitivity
- **Content rating**: auto-classifies General / Sensitive / Questionable / Explicit
- **AI captions**: ToriiGate generates natural-language descriptions alongside tags — viewable in the image detail modal
- **Background tagging**: close the tagger modal and keep browsing — a floating progress pill in the bottom-right corner tracks the job, with stop and details controls
- **Elastic batch sizing**: the app monitors your RAM/VRAM in real time and adjusts batch size to prevent crashes
- Models auto-download from HuggingFace on first use

### 📁 Sorting — Organize at game speed

Two powerful sorting modes:

- **Auto-Separate**: set filter criteria → pick a destination folder → one click moves all matching images
- **WASD Manual Sort**: images appear one by one, press `W`/`A`/`S`/`D` to sort into 4 folders. `Space` to skip, `Z` to undo. It's fast, satisfying, and hard to stop.

### 🔳 Censor Edit — AI detection + pixel-perfect manual control

A full canvas-based editor for privacy masking. The AI detects sensitive regions, then you fine-tune with manual tools.

- **Detection models**: Wenaka YOLO (privacy-focused), NudeNet v3, or both combined for best coverage
- **Censor styles**: mosaic pixelation, gaussian blur, solid black/white bars
- **Manual tools**: variable-size brush, pen, eraser (restore original pixels), clone stamp
- **SAM3 integration**: text-prompt guided segmentation for surgical precision (requires CUDA GPU)
- **Batch workflow**: queue multiple images → detect all → review → batch save with custom naming and optional metadata stripping
- **Queue Manager**: full-screen modal for large batches — search by filename, drag-and-drop reorder, multi-select, move-to-position

### 🔍 Similar Images — Find duplicates and visual matches

Powered by **CLIP embeddings**, this feature creates a visual fingerprint of every image in your library.

- **Search by ID**: click any image → find visually similar ones
- **Search by upload**: drop in any image from outside your library
- **Duplicate finder**: scan your entire collection for near-identical pairs
- **Adjustable threshold**: from loose similarity to strict duplicate matching
- Local-first: the CLIP model runs on your machine, nothing leaves your PC

### 🧪 Prompt Lab — Generate new prompts from your own library

Analyze the tags across your image collection and generate randomized, coherent prompts.

- **Smart randomizer**: picks tags while respecting exclusion rules (e.g., `from_behind` auto-excludes `looking_at_viewer`)
- **Tag sets**: pre-built outfits (school uniform, swimsuit, maid, etc.) for one-click outfit combos
- **Category browser**: explore your library's tags organized by type (body, pose, outfit, expression, etc.)
- **Negative prompt**: auto-generates quality-focused negative prompts
- Works even with a small library — built-in fallback tag pools fill the gaps

### 🎨 Artist Identification *(experimental)*

Identify the artist or style of your images using **Kaloscope 2.0** (LSNet-based classifier).

- Batch-process your entire library with progress tracking
- Filter gallery by predicted artist
- View top artists and their image counts
- Supports HuggingFace, ModelScope, or local model loading

---

## ⬇️ Download & Install

### Windows

1. **[Download sd-image-sorter-v2.6.1-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-windows-portable.zip)**
2. Extract to any folder
3. Double-click **`run-portable.bat`**
4. Browser opens `http://localhost:8487` — done

> Python 3.11 is bundled. AI models auto-download on first use (~500 MB).
>
> For **GPU tagging on Windows**, your system still needs the NVIDIA driver plus the CUDA / cuDNN / MSVC runtime pieces required by `onnxruntime-gpu`. If those dependencies are missing, the app now falls back cleanly to CPU and the tagger modal will show that in the runtime status chips.

### Linux / macOS

1. **[Download sd-image-sorter-v2.6.1-linux-mac.tar.gz](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-linux-mac.tar.gz)**
2. Extract and run:
   ```bash
   tar xzf sd-image-sorter-v2.6.1-linux-mac.tar.gz
   cd sd-image-sorter && chmod +x run.sh && ./run.sh
   ```
> Requires Python 3.9+. The script creates a virtualenv automatically.

### From Source

```bash
git clone https://github.com/peter119lee/sd-image-sorter.git
cd sd-image-sorter
# Windows: run.bat  |  Linux/Mac: ./run.sh
```

---

## 🌐 China Mainland / 大陆用户

Models download from HuggingFace by default. Behind the GFW? Add one line to `backend/.env`:

```
HF_ENDPOINT=https://hf-mirror.com
```

Artist ID and SAM3 also support [ModelScope](https://modelscope.cn) — select in the UI.

---

## 🧰 Hardware Guide

| Feature | RAM | GPU |
|:--------|:----|:----|
| Gallery · Filters · Sort · Prompt Lab | 4 GB | — |
| WD14 tagging (SwinV2 / ConvNeXt / ViT family) | 8 GB | Optional |
| WD14 tagging (EVA02 / Camie / PixAI) | 16 GB | Recommended |
| ToriiGate 0.5 multimodal tagging | 24 GB | **CUDA strongly recommended** |
| Censor detection | 8 GB | Optional |
| Similar images (CLIP) | 8 GB | — |
| Artist ID (Kaloscope) | 16 GB | Recommended |
| SAM3 refinement | 16 GB | **CUDA required** |

<details>
<summary>Model sizes (downloaded on first use)</summary>

| Model | Size | Feature |
|:------|:-----|:--------|
| wd-swinv2-tagger-v3 | ~446 MB | AI Tagging (default) |
| wd-eva02-large-tagger-v3 | ~1.2 GB | AI Tagging (best quality) |
| camie-tagger-v2 | ~1.3 GB | AI Tagging (newer tag space) |
| pixai-tagger-v0.9 | ~1.2 GB | AI Tagging (newer tag space) |
| clip-ViT-B-32-vision | ~335 MB | Similar Images |
| wenaka_yolov8s-seg | ~46 MB | Censor detection |
| NudeNet 320n | ~12 MB | Censor detection |
| Kaloscope 2.0 | ~2.8 GB | Artist ID |
| SAM3 | ~3.3 GB | Censor refinement |
</details>

---

## ⌨️ Keyboard Shortcuts

| Context | Key | Action |
|:--------|:----|:-------|
| **Manual Sort** | `W` `A` `S` `D` | Move to folder slot |
| | `Space` | Skip image |
| | `Z` | Undo |
| **Censor Edit** | `A` / `D` | Prev / Next image |
| | `B` `P` `E` `G` | Brush · Pen · Eraser · Clone |
| | `[` `]` | Brush size −/+ |
| | `Ctrl+Z` | Undo stroke |
| | `Ctrl+Scroll` | Zoom canvas |

---

## 🙏 Credits

[Antigravity](https://github.com/peter119lee) — core development &nbsp;·&nbsp;
[Wenaka2004](https://github.com/Wenaka2004/auto-censor) — censor inspiration & [YOLO model](https://civitai.com/models/1736285) &nbsp;·&nbsp;
[Spawner1145](https://github.com/spawner1145/comfyui-lsnet) — LSNet artist ID &nbsp;·&nbsp;
[SmilingWolf](https://huggingface.co/SmilingWolf) — WD14 models &nbsp;·&nbsp;
[Receyuki](https://github.com/receyuki/stable-diffusion-prompt-reader) — prompt reader inspiration

📄 [MIT License](LICENSE)

---

<br>

<a name="简体中文"></a>

<h3 align="center">🎨 SD Image Sorter — AI 图像筛选管理器</h3>

<p align="center">
  专为 Stable Diffusion 创作者打造的全能图像管理工具
</p>

<p align="center">
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-windows-portable.zip"><b>⬇️ 下载 Windows 版</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-linux-mac.tar.gz"><b>⬇️ 下载 Linux/Mac 版</b></a>
</p>

---

### 你是不是也这样？

> *几千张 AI 图散落各处。有些有元数据有些没有。想按提示词搜搜不了，想按模型筛筛不了，上周那张满意的图死活找不到…*

**SD Image Sorter** 帮你全搞定。

---

## ✨ 功能介绍

### 🖼️ 画廊 — 你的图库，终于能管了

指向任意文件夹，程序自动扫描图片，**识别生成器**（ComfyUI、NovelAI、WebUI、Forge），**提取所有信息**：正向提示词、负向提示词、采样参数、模型、LoRA、种子 — 全部可搜索、可筛选。

- **筛选**：按生成器、标签、内容评级、模型、LoRA、提示词关键字、图片尺寸、长宽比
- **排序**：按时间、文件名、提示词长度、标签数量、AI 评级
- **分页浏览**：按生成器类型自动分页

### 🏷️ AI 打标 — 一键标注成千上万张图

内置 **WD14 Tagger**（动漫/插画专用），自动为每张图打上描述标签：`1girl`、`blue_hair`、`school_uniform`、`outdoors` — 还能识别角色和内容分级。

- **8 个可运行打标模型**：EVA02-Large、SwinV2、ConvNeXt、ViT、ViT-Large、Camie v2、PixAI v0.9、ToriiGate 0.5
- **更新的标签空间**：Camie v2 和 PixAI v0.9 比老 WD 标签库更现代
- **实验性 VLM 后端**：ToriiGate 0.5 通过单独的 Transformers 多模态后端运行，不走 WD14 ONNX 运行链
- **首次下载很大**：ToriiGate 体积远大于 WD14 系模型，首次下载会明显更重
- **双阈值**：通用标签和角色标签分开调节灵敏度
- **内容评级**：自动分类 General / Sensitive / Questionable / Explicit
- **AI 描述**：ToriiGate 在打标签的同时生成自然语言描述，可在图片详情弹窗查看
- **后台打标**：关闭打标弹窗继续浏览，右下角浮动进度条实时跟踪任务，支持停止/查看详情
- **弹性 batch**：程序实时监控 RAM/VRAM 使用量，自动调节 batch size 防止崩溃
- 模型首次使用时从 HuggingFace 自动下载

### 📁 排序 — 打游戏一样快

两种强大的排序模式：

- **自动分类**：设好筛选条件 → 选目标文件夹 → 一键移动所有符合条件的图
- **WASD 手动排序**：图片逐张显示，按 `W`/`A`/`S`/`D` 分到 4 个文件夹。`空格`跳过，`Z`撤销。快到停不下来。

### 🔳 打码编辑 — AI 检测 + 像素级手动精修

完整的画布编辑器，AI 自动检测敏感区域，然后你可以精修。

- **检测模型**：Wenaka YOLO（隐私部位专用）、NudeNet v3、或两者并用覆盖更全
- **打码风格**：马赛克、高斯模糊、纯黑条、纯白条
- **手动工具**：可调大小画笔、铅笔、橡皮擦（恢复原图像素）、仿制图章
- **SAM3**：文本提示引导的精准分割（需要 CUDA GPU）
- **批量流程**：加入队列 → 全部检测 → 逐张审核 → 批量保存，支持自定义命名和元数据剥离
- **队列管理器**：大批量专用全屏弹窗 — 按文件名搜索、拖拽排序、多选、移到指定位置

### 🔍 相似图片 — 找重复、找相似

基于 **CLIP 向量**，为图库里每张图创建视觉指纹。

- **按 ID 搜索**：点击任意图片 → 找到视觉相似的
- **上传搜索**：拖入外部图片搜索你的图库
- **重复检测**：扫描整个图库找近似重复对
- **阈值可调**：从宽松的相似到严格的重复
- 本地运行：CLIP 模型在你电脑上跑，数据不外传

### 🧪 提示词工坊 — 从你自己的图库生成新提示词

分析你图库中的标签，生成随机但连贯的提示词。

- **智能随机**：选标签时自动遵守排除规则（比如 `from_behind` 自动排除 `looking_at_viewer`）
- **标签套装**：预设服装组合（校服、泳装、女仆装等），一键套用
- **分类浏览**：按类别（身体、姿势、服装、表情等）探索你图库的标签
- **负向提示词**：自动生成质量优化的负向提示词
- 图库小也能用 — 内置兜底标签池

### 🎨 画师识别 *（实验性）*

用 **Kaloscope 2.0**（基于 LSNet）识别图片的画师或风格。

- 批量处理整个图库
- 按识别出的画师筛选画廊
- 支持 HuggingFace、ModelScope、本地模型

---

## ⬇️ 下载安装

### Windows

1. **[下载 sd-image-sorter-v2.6.1-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-windows-portable.zip)**
2. 解压到任意文件夹
3. 双击 **`run-portable.bat`**
4. 浏览器打开 `http://localhost:8487` — 搞定

> 内置 Python 3.11，无需安装。AI 模型首次使用自动下载（约 500 MB）。
>
> 如果你想在 **Windows 上用 GPU 打标**，系统仍然需要满足 `onnxruntime-gpu` 的 CUDA / cuDNN / MSVC 运行时要求。缺少这些依赖时，程序现在会稳定回退到 CPU，并在 Tagger 弹窗里明确显示当前 runtime 状态。

### Linux / macOS

1. **[下载 sd-image-sorter-v2.6.1-linux-mac.tar.gz](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.6.1-linux-mac.tar.gz)**
2. 解压并运行：
   ```bash
   tar xzf sd-image-sorter-v2.6.1-linux-mac.tar.gz
   cd sd-image-sorter && chmod +x run.sh && ./run.sh
   ```
> 需要 Python 3.9+，脚本自动创建虚拟环境。

### 从源码

```bash
git clone https://github.com/peter119lee/sd-image-sorter.git
cd sd-image-sorter
# Windows: run.bat  |  Linux/Mac: ./run.sh
```

---

## 🌐 大陆镜像

模型默认从 HuggingFace 下载。大陆用户在 `backend/.env` 加一行：

```
HF_ENDPOINT=https://hf-mirror.com
```

画师识别和 SAM3 还支持 [ModelScope](https://modelscope.cn) — 在界面下拉菜单选择。

---

## 🧰 硬件指南

| 功能 | 内存 | GPU |
|:-----|:-----|:----|
| 画廊 · 筛选 · 排序 · 提示词 | 4 GB | — |
| WD14 打标（SwinV2 / ConvNeXt / ViT 系） | 8 GB | 可选 |
| WD14 打标（EVA02 / Camie / PixAI） | 16 GB | 建议 |
| ToriiGate 0.5 多模态打标 | 24 GB | **强烈建议 CUDA** |
| 打码检测 | 8 GB | 可选 |
| 相似图片 (CLIP) | 8 GB | — |
| 画师识别 | 16 GB | 建议 |
| SAM3 精修 | 16 GB | **必须 CUDA** |

<details>
<summary>模型体积（首次使用自动下载）</summary>

| 模型 | 大小 | 用途 |
|:-----|:-----|:-----|
| wd-swinv2-tagger-v3 | ~446 MB | AI 打标（默认） |
| wd-eva02-large-tagger-v3 | ~1.2 GB | AI 打标（最高质量） |
| camie-tagger-v2 | ~1.3 GB | AI 打标（更新标签空间） |
| pixai-tagger-v0.9 | ~1.2 GB | AI 打标（更新标签空间） |
| clip-ViT-B-32-vision | ~335 MB | 相似图片 |
| wenaka_yolov8s-seg | ~46 MB | 打码检测 |
| NudeNet 320n | ~12 MB | 打码检测 |
| Kaloscope 2.0 | ~2.8 GB | 画师识别 |
| SAM3 | ~3.3 GB | 打码精修 |
</details>

---

## ⌨️ 快捷键

| 场景 | 按键 | 动作 |
|:-----|:-----|:-----|
| **排序** | `W` `A` `S` `D` | 移到对应文件夹 |
| | `空格` | 跳过 |
| | `Z` | 撤销 |
| **打码** | `A` / `D` | 上/下一张 |
| | `B` `P` `E` `G` | 画笔 · 铅笔 · 橡皮 · 仿制 |
| | `[` `]` | 笔触大小 |
| | `Ctrl+Z` | 撤销 |
| | `Ctrl+滚轮` | 缩放 |

---

## 🙏 Credits

[Antigravity](https://github.com/peter119lee) — core development &nbsp;·&nbsp;
[Wenaka2004](https://github.com/Wenaka2004/auto-censor) — censor inspiration & [YOLO model](https://civitai.com/models/1736285) &nbsp;·&nbsp;
[Spawner1145](https://github.com/spawner1145/comfyui-lsnet) — LSNet artist ID &nbsp;·&nbsp;
[SmilingWolf](https://huggingface.co/SmilingWolf) — WD14 models &nbsp;·&nbsp;
[Receyuki](https://github.com/receyuki/stable-diffusion-prompt-reader) — prompt reader inspiration

📄 [MIT License](LICENSE)

*Made with ❤️ for the Stable Diffusion community*
