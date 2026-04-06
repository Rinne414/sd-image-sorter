# SD Image Sorter (AI 图像筛选管理器)

[English](#english) | [简体中文](#简体中文)

---

<a name="english"></a>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.0-purple" alt="Version">
  <img src="https://img.shields.io/badge/python-3.9+-blue" alt="Python">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Platform">
</p>

<h3 align="center">The all-in-one image manager for Stable Diffusion creators.</h3>

<p align="center">
  Scan thousands of images · Auto-extract metadata · AI-tag everything<br>
  Sort at lightning speed · Censor with precision · Find duplicates instantly
</p>

<p align="center">
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-windows-portable.zip"><b>⬇️ Download for Windows</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-linux-mac.tar.gz"><b>⬇️ Download for Linux/Mac</b></a>
</p>

---

| Gallery View | Manual Sort | Censor Edit |
|:------------:|:-----------:|:-----------:|
| ![Gallery](docs/screenshots/gallery_view.png) | ![Manual Sort](docs/screenshots/manual_sort.png) | ![Censor Edit](docs/screenshots/censor_edit.png) |

| Gallery Navigation | Manual Sort Flow |
|:------------------:|:----------------:|
| ![Gallery Demo](docs/screenshots/gallery_demo.gif) | ![Manual Sort Demo](docs/screenshots/manual_sort_demo.gif) |

---

## ⬇️ Download & Install

### Windows

1. **[Download sd-image-sorter-v2.2.0-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-windows-portable.zip)** (~21 MB)
2. Extract to any folder
3. Double-click **`run-portable.bat`**
4. Browser opens `http://localhost:8487` — done

> Python 3.11 is bundled. AI models auto-download on first use (~500 MB).

### Linux / macOS

1. **[Download sd-image-sorter-v2.2.0-linux-mac.tar.gz](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-linux-mac.tar.gz)** (~8 MB)
2. Extract and run:
   ```bash
   tar xzf sd-image-sorter-v2.2.0-linux-mac.tar.gz
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

Artist ID and SAM3 also support [ModelScope](https://modelscope.cn) — select it in the UI dropdown.

---

## ✨ Features

<details open>
<summary><b>🖼️ Gallery</b></summary>

- Auto-detect ComfyUI / NovelAI / WebUI / Forge metadata
- Extract prompts, settings, checkpoints, LoRAs
- Filter by generator, tags, ratings, checkpoint, LoRA, prompt keywords, dimensions
- Sort by date, name, prompt length, tag count, rating
</details>

<details>
<summary><b>🏷️ AI Tagging (WD14)</b></summary>

- Models: EVA02-Large, SwinV2, ConvNeXt, ViT
- Separate thresholds for general vs. character tags
- Auto rating: General / Sensitive / Questionable / Explicit
</details>

<details>
<summary><b>📁 Sorting — Auto-Separate + WASD</b></summary>

- **Auto-Separate**: bulk move images by filter criteria
- **Manual Sort**: WASD keyboard sorting, game-style speed
- **Undo**: revert any move instantly
</details>

<details>
<summary><b>🔳 Censor Edit</b></summary>

- Multi-model detection: Wenaka YOLO · NudeNet v3 · both
- Censor styles: mosaic, blur, black bar, white bar
- Manual tools: brush, pen, eraser, clone stamp
- SAM3 text-prompt segmentation (CUDA GPU required)
- Batch queue with rename and export
</details>

<details>
<summary><b>🔍 Similar Images (CLIP)</b></summary>

- Visual similarity search across your library
- Upload any image to find matches
- Near-duplicate detection with adjustable threshold
- Local-first CLIP model
</details>

<details>
<summary><b>🧪 Prompt Lab</b></summary>

- Random prompt generator with smart exclusion rules
- Pre-built outfit tag sets (school uniform, swimsuit, etc.)
- Category browser for your library's tags
- Auto negative prompt
</details>

<details>
<summary><b>🎨 Artist ID (experimental)</b></summary>

- Kaloscope 2.0 LSNet-based classification
- Batch identification with confidence threshold
- Filter gallery by predicted artist
</details>

---

## 🧰 Hardware Guide

| Feature | RAM | GPU |
|:--------|:----|:----|
| Gallery · Filters · Sort · Prompt Lab | 4 GB | — |
| WD14 tagging (SwinV2) | 8 GB | Optional |
| WD14 tagging (EVA02-Large) | 16 GB | Optional |
| Censor detection | 8 GB | Optional |
| Similar images (CLIP) | 8 GB | — |
| Artist ID (Kaloscope) | 16 GB | Recommended |
| SAM3 refinement | 16 GB | **CUDA required** |

<details>
<summary>Model sizes (downloaded on first use)</summary>

| Model | Size | Used by |
|:------|:-----|:--------|
| wd-swinv2-tagger-v3 | ~446 MB | AI Tagging (default) |
| wd-eva02-large-tagger-v3 | ~1.2 GB | AI Tagging (high quality) |
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
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-windows-portable.zip"><b>⬇️ 下载 Windows 版</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-linux-mac.tar.gz"><b>⬇️ 下载 Linux/Mac 版</b></a>
</p>

---

## ⬇️ 下载安装

### Windows

1. **[下载 sd-image-sorter-v2.2.0-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-windows-portable.zip)** (~21 MB)
2. 解压到任意文件夹
3. 双击 **`run-portable.bat`**
4. 浏览器打开 `http://localhost:8487` — 搞定

> 内置 Python 3.11，无需安装。AI 模型首次使用自动下载（约 500 MB）。

### Linux / macOS

1. **[下载 sd-image-sorter-v2.2.0-linux-mac.tar.gz](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v2.2.0-linux-mac.tar.gz)** (~8 MB)
2. 解压并运行：
   ```bash
   tar xzf sd-image-sorter-v2.2.0-linux-mac.tar.gz
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

## ✨ 功能

<details open>
<summary><b>🖼️ 画廊</b></summary>

- 自动识别 ComfyUI / NovelAI / WebUI / Forge 元数据
- 提取提示词、参数、模型、LoRA
- 按生成器、标签、评级、模型、LoRA、提示词关键字、尺寸筛选
- 按时间、名称、提示词长度、标签数、评级排序
</details>

<details>
<summary><b>🏷️ AI 打标 (WD14)</b></summary>

- 多模型：EVA02-Large、SwinV2、ConvNeXt、ViT
- 通用标签和角色标签独立阈值
- 自动评级：General / Sensitive / Questionable / Explicit
</details>

<details>
<summary><b>📁 排序 — 自动分类 + WASD</b></summary>

- **自动分类**：按筛选条件批量移动
- **手动排序**：WASD 键位，打游戏一样快
- **撤销**：随时撤回
</details>

<details>
<summary><b>🔳 打码编辑</b></summary>

- 多模型检测：Wenaka YOLO · NudeNet v3 · 两者并用
- 打码风格：马赛克、模糊、黑条、白条
- 手动工具：画笔、铅笔、橡皮擦、仿制图章
- SAM3 文本提示分割（需 CUDA GPU）
- 批量队列，重命名并导出
</details>

<details>
<summary><b>🔍 相似图片 (CLIP)</b></summary>

- 视觉相似搜索
- 上传图片搜索图库
- 近似重复检测，阈值可调
</details>

<details>
<summary><b>🧪 提示词工坊</b></summary>

- 随机提示词生成 + 智能排除规则
- 预设服装标签套装
- 分类浏览图库标签
</details>

<details>
<summary><b>🎨 画师识别（实验性）</b></summary>

- Kaloscope 2.0 分类
- 批量识别
- 按画师筛选图库
</details>

---

## 🧰 硬件

| 功能 | 内存 | GPU |
|:-----|:-----|:----|
| 画廊 · 筛选 · 排序 · 提示词 | 4 GB | — |
| WD14 打标 (SwinV2) | 8 GB | 可选 |
| WD14 打标 (EVA02) | 16 GB | 可选 |
| 打码检测 | 8 GB | 可选 |
| 相似图片 (CLIP) | 8 GB | — |
| 画师识别 | 16 GB | 建议 |
| SAM3 精修 | 16 GB | **必须 CUDA** |

---

## ⌨️ 快捷键

| 场景 | 按键 | 动作 |
|:-----|:-----|:-----|
| **排序** | `W` `A` `S` `D` | 移到对应文件夹 |
| | `空格` | 跳过 |
| | `Z` | 撤销 |
| **打码** | `B` `P` `E` `G` | 画笔 · 铅笔 · 橡皮 · 仿制 |
| | `[` `]` | 笔触大小 |
| | `Ctrl+Z` | 撤销 |

---

📄 [MIT License](LICENSE)

*Made with ❤️ for the Stable Diffusion community*
