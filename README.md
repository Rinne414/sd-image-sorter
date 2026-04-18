# SD Image Sorter

<p align="center">
  <b>Local-first AI image command center for Stable Diffusion creators.</b>
</p>

<p align="center">
  扫图库、读参数、自动打标、WASD 狂飙分拣、相似图查重、AI 打码修图，全都在你自己的电脑上完成。
</p>

<p align="center">
  <a href="#zh-cn">简体中文</a>
  ·
  <a href="#english">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.3-ff8a00" alt="Version">
  <img src="https://img.shields.io/badge/python-3.9%2B-3776AB" alt="Python">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4B5563" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-22C55E" alt="License">
</p>

<p align="center">
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v3.0.3-windows-portable.zip"><b>Download for Windows</b></a>
  ·
  <a href="https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v3.0.3-linux-mac.tar.gz"><b>Download for Linux / macOS</b></a>
  ·
  <a href="#quick-start">Quick Start</a>
</p>

<p align="center">
  <img src="docs/screenshots/gallery_hero.png" alt="SD Image Sorter gallery hero screenshot" width="100%">
</p>

> [!IMPORTANT]
> This is a local-only app. Your images stay on your machine. Models run locally. No cloud upload, no account, no nonsense.

<a name="zh-cn"></a>

## 简体中文

> 你说得对，但这就是 **SD Image Sorter**🤚。能扫几千张 SD 图👌，能自动识别 ComfyUI / NovelAI / WebUI / Forge 元数据✌️，能把 prompt、negative prompt、checkpoint、LoRA、VAE、seed 一口气全扒出来🤙。有 Gallery 管图库✊，有 Image Reader 拖图即读👍，有 WD14 AI 打标👈，有分级和后台批处理👐，有 Auto-Separate 一键搬运🙌，还有 WASD 手动狂飙分拣😨。然后还有 CLIP 相似图查重😰，还有 Prompt Lab 反炼提示词😭，还有 Artist Identification 认风格🖐️，还有 Image Obfuscate 加扰解扰🤚，还有 Aesthetic Score 本地打分😵。然后 Censor Edit 还能 YOLO 自动检测👊🏿😭👊🏿，还能手动画笔、马赛克、高斯模糊、黑白条、批量保存🖐️😭🤚。Reader、Tagger、Sorter、Similarity、Prompt Lab、Artist ID、Obfuscate、Aesthetic、Censor 一套全开，文件夹就啊啊啊啊啊啊。

### 一句话宣传

**SD Image Sorter：把“AI 图满盘爆炸、参数到处失踪、好图根本挑不出来、发出去前还得重新打码”的崩溃现场，硬生生压成“扫描、读取、打标、分拣、查重、炼词、识别、打码、加扰、评分”一套打完的本地工作流。**

### 它到底解决什么问题

如果你也经历过这些破事，这个工具就是给你做的：

- 图很多，但根本想不起哪张是哪个模型、哪组提示词生成的
- 想把 `best / keep / delete / explicit` 分桶，结果手工拖文件拖到怀疑人生
- 想批量打标签、查重、找相似图、做隐私打码，却要开一堆零碎脚本和网站
- 想快速回看一张图的 SD 参数，但不想先导入一整个图库

### 为什么这个仓库值得点 Star

- **真本地**：浏览器只是界面，核心在本机跑，图片不上传。
- **真懂 SD 图**：能读 ComfyUI、NovelAI、WebUI / A1111、Forge 等常见元数据。
- **真能干活**：不是只看图，是完整的筛选、打标、排序、查重、打码工作流。
- **真适合大图库**：几千张图不是展示案例，是默认使用场景。
- **真有速度感**：WASD 手动分拣、批量动作、后台进度、快捷键都不是摆设。
- **真有界面**：不是冷冰冰的调试页，而是带玻璃拟态和霓虹氛围的本地工具。

## 截图

<p align="center">
  <img src="docs/screenshots/gallery_demo.gif" alt="Gallery demo" width="48%">
  <img src="docs/screenshots/manual_sort_demo.gif" alt="Manual sort demo" width="48%">
</p>

<p align="center">
  <img src="docs/screenshots/manual_sort.png" alt="Manual sort screenshot" width="48%">
  <img src="docs/screenshots/censor_edit.png" alt="Censor edit screenshot" width="48%">
</p>

## 核心功能

### 1. Gallery 画廊

- 扫描任意文件夹，建立本地图库
- 自动识别生成器：ComfyUI、NovelAI、WebUI / A1111、Forge
- 提取 prompt、negative prompt、steps、CFG、seed、checkpoint、LoRA、VAE、尺寸等信息
- 按生成器、标签、评级、模型、LoRA、提示词关键字、尺寸、长宽比筛选
- 按时间、文件名、提示词长度、标签数量等排序

### 2. AI Tagging 打标

- 内置 WD14 系列标签模型，支持批量自动打标
- 支持 general / character 双阈值
- 自动判定 General / Sensitive / Questionable / Explicit
- 支持 EVA02、SwinV2、ConvNeXt、ViT、Camie、PixAI、ToriiGate 等模型
- 后台持续打标，右下角进度跟踪，不会卡死整个界面

### 3. Sorting 排序

- **Auto-Separate**：按筛选条件一键批量移动
- **Manual Sort**：`W / A / S / D` 四路分拣，`Space` 跳过，`Z` 撤销
- 适合把收藏、精选、待删、NSFW、角色分类等工作压缩成几分钟

### 4. Censor Edit 打码编辑

- YOLO 自动检测敏感区域
- 支持马赛克、高斯模糊、黑条、白条
- 画笔、铅笔、橡皮、仿制图章一套齐
- 队列式批量处理，适合做分享版、公开版、平台版素材

### 5. Similar Images 相似图

- 基于 CLIP embedding 做视觉相似度搜索
- 找近似重复图
- 用库内图片搜相似图
- 用外部图片搜图库里的相似结果

### 6. Prompt Lab 提示词工坊

- 从你自己的图库标签反推可复用 prompt
- 自动处理部分互斥标签
- 内置标签套装和负向 prompt 生成
- 对小图库也有兜底标签池

### 7. 其他实用模块

- **Artist Identification**：实验性画师 / 风格识别
- **Image Reader**：拖一张图进来，立刻读参数，不用先扫描图库
- **Image Obfuscate**：图片加扰 / 解扰，适合带密码分享
- **Aesthetic Score**：本地美学评分

## 这工具最适合谁

- Stable Diffusion / NovelAI / ComfyUI 重度用户
- 有几千到几万张图，已经开始找不到图的人
- 想把“生成”变成“可检索资产管理”的人
- 想把分拣、筛选、打码、查重流程尽量压在一个本地工具里的人

## 60 秒上手

### Windows

1. 下载 [sd-image-sorter-v3.0.3-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v3.0.3-windows-portable.zip)
2. 解压到任意目录
3. 双击 `run-portable.bat`
4. 浏览器会自动打开 `http://localhost:8487`

### Linux / macOS

1. 下载 [sd-image-sorter-v3.0.3-linux-mac.tar.gz](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v3.0.3-linux-mac.tar.gz)
2. 解压并执行：

```bash
tar xzf sd-image-sorter-v3.0.3-linux-mac.tar.gz
cd sd-image-sorter
chmod +x run.sh
./run.sh
```

### 从源码运行

```bash
git clone https://github.com/peter119lee/sd-image-sorter.git
cd sd-image-sorter
# Windows
run.bat

# Linux / macOS
./run.sh
```

> [!TIP]
> Windows 便携版自带 Python 3.11。AI 模型按需自动下载。首次启动时间长一点是正常的，不是死了。

## 下载与运行说明

### GPU / 运行时说明

- NVIDIA 显卡会优先使用 `onnxruntime-gpu`
- Intel Arc / AMD Radeon 会切到 `onnxruntime-directml`
- 没有合适 GPU 也能 CPU 跑，只是慢一些
- `v3.0.2` 修了 Windows 下部分显卡 VRAM 识别不准导致 batch size 偏保守的问题
- `v3.0.3` 修了 portable launcher 无视 `SD_IMAGE_SORTER_PORT` 打开错误 URL、Civitai 下载 403、艺术家识别诊断接口一直回 `available:false`、ToriiGate 首次下载没有明确 5 GB 提示

### 大陆用户

默认从 HuggingFace 下载模型。网络不顺时，在 `backend/.env` 添加：

```env
HF_ENDPOINT=https://hf-mirror.com
```

Artist ID 和 SAM3 也支持 [ModelScope](https://modelscope.cn)。

## 快捷键

| 场景 | 按键 | 动作 |
|:--|:--|:--|
| Manual Sort | `W` `A` `S` `D` | 移动到 4 个目标文件夹 |
| Manual Sort | `Space` | 跳过当前图片 |
| Manual Sort | `Z` | 撤销上一步 |
| Censor Edit | `A` / `D` | 上一张 / 下一张 |
| Censor Edit | `B` `P` `E` `G` | 画笔 / 铅笔 / 橡皮 / 仿制 |
| Censor Edit | `[` `]` | 调整笔刷大小 |
| Censor Edit | `Ctrl+Z` | 撤销笔触 |
| Censor Edit | `Ctrl + 滚轮` | 缩放画布 |

<details>
<summary><b>支持的元数据来源</b></summary>

- ComfyUI：PNG `prompt` / `workflow` JSON
- NovelAI：PNG `Comment` JSON
- WebUI / A1111：PNG `parameters`
- Forge：兼容 WebUI 参数串
- WebP：EXIF / XMP 中的 SD 元数据

</details>

<details>
<summary><b>硬件建议</b></summary>

| 功能 | 内存 | GPU |
|:--|:--|:--|
| Gallery / Filters / Sort / Prompt Lab | 4 GB | 可无 |
| WD14 打标（SwinV2 / ConvNeXt / ViT） | 8 GB | 可选 |
| WD14 打标（EVA02 / Camie / PixAI） | 16 GB | 建议 |
| ToriiGate 多模态打标 | 24 GB | 强烈建议 CUDA |
| Censor Detection | 8 GB | 可选 |
| Similar Images | 8 GB | 可无 |
| Artist ID | 16 GB | 建议 |
| SAM3 精修 | 16 GB | 必须 CUDA |

</details>

<details>
<summary><b>模型体积（首次使用自动下载）</b></summary>

| 模型 | 大小 | 用途 |
|:--|:--|:--|
| wd-swinv2-tagger-v3 | ~446 MB | AI 打标默认模型 |
| wd-eva02-large-tagger-v3 | ~1.2 GB | 更高质量打标 |
| camie-tagger-v2 | ~1.3 GB | 更新标签空间 |
| pixai-tagger-v0.9 | ~1.2 GB | 更新标签空间 |
| clip-ViT-B-32-vision | ~335 MB | 相似图搜索 |
| wenaka_yolov8s-seg | ~46 MB | 打码检测 |
| NudeNet 320n | ~12 MB | 打码检测 |
| Kaloscope 2.0 | ~2.8 GB | 画师识别 |
| SAM3 | ~3.3 GB | 打码精修 |
| CLIP ViT-L/14 + aesthetic head | ~400 MB | 美学评分 |

</details>

## 项目结构

```text
sd-image-sorter/
├── backend/            # FastAPI + SQLite + AI model orchestration
├── frontend/           # Vanilla HTML / JS / CSS UI
├── docs/screenshots/   # README 展示图
├── models/             # 本地模型目录
├── run-portable.bat    # Windows 便携版入口
├── run.bat             # Windows 源码运行入口
└── run.sh              # Linux / macOS 运行入口
```

## 更多文档

- [CHANGELOG.md](CHANGELOG.md)
- [docs/API.md](docs/API.md)
- [docs/architecture.md](docs/architecture.md)
- [SECURITY.md](SECURITY.md)

## 特别感谢

| 名称 | 贡献 |
|:--|:--|
| [Antigravity](https://github.com/peter119lee) | 项目主导开发 |
| Claude Code / Claude Opus 4.6 / Codex / GPT-5.4 / Gemini 3.1 Pro | AI 辅助开发与验证 |
| [Wenaka2004](https://github.com/Wenaka2004/auto-censor) | 自动打码思路与 YOLO 模型 |
| [Spawner1145](https://github.com/spawner1145/comfyui-lsnet)、DraconicDragon、heathcliff01 | LSNet / Kaloscope 画师识别方向 |
| [SmilingWolf](https://huggingface.co/SmilingWolf) | WD14 Tagger 模型 |
| [Receyuki](https://github.com/receyuki/stable-diffusion-prompt-reader) | Prompt Reader 方向启发 |

License: [MIT](LICENSE)

---

<a name="english"></a>

## English

**SD Image Sorter** is a local-first web app for people who generate too many Stable Diffusion images and are tired of losing track of them.

It scans folders, reads SD metadata, tags images with WD14 models, finds similar images with CLIP, sorts images with keyboard-speed workflows, and provides an AI-assisted censor editor for batch-safe sharing.

### Promo Line

**SD Image Sorter turns “my AI image folder is a landfill” into a fast local workflow for finding, filtering, tagging, sorting, comparing, and cleaning your best shots.**

### Highlights

- **Gallery built for SD workflows**: ComfyUI, NovelAI, WebUI / A1111, Forge metadata support
- **AI Tagging**: WD14 family, rating prediction, background jobs, adjustable thresholds
- **Fast sorting**: Auto-Separate plus addictive `W / A / S / D` manual sorting
- **Censor Edit**: YOLO detection, brush tools, queue workflow, batch save
- **Similar search**: CLIP embeddings for duplicates and near-matches
- **Prompt Lab**: generate reusable prompts from your own library
- **Extra tools**: Artist ID, Image Reader, Image Obfuscate, Aesthetic Score

### Screenshots

<p align="center">
  <img src="docs/screenshots/gallery_hero.png" alt="Gallery screenshot" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/gallery_demo.gif" alt="Gallery demo gif" width="48%">
  <img src="docs/screenshots/manual_sort_demo.gif" alt="Manual sort demo gif" width="48%">
</p>

### Quick Start

#### Windows Portable

1. Download [sd-image-sorter-v3.0.3-windows-portable.zip](https://github.com/peter119lee/sd-image-sorter/releases/latest/download/sd-image-sorter-v3.0.3-windows-portable.zip)
2. Extract it anywhere
3. Double-click `run-portable.bat`
4. Your browser opens `http://localhost:8487`

#### Linux / macOS

```bash
tar xzf sd-image-sorter-v3.0.3-linux-mac.tar.gz
cd sd-image-sorter
chmod +x run.sh
./run.sh
```

#### From Source

```bash
git clone https://github.com/peter119lee/sd-image-sorter.git
cd sd-image-sorter
./run.sh
```

### Tech Stack

- **Backend**: FastAPI, SQLite, Pillow, ONNX Runtime
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **AI models**: WD14 taggers, YOLOv8-based censor detection, CLIP similarity, Kaloscope artist ID
- **Design language**: glassmorphism, neon UI, keyboard-first workflows

### Notes

- Local-only by design
- Models download on first use
- Mainland China users can set `HF_ENDPOINT=https://hf-mirror.com`
- See [CHANGELOG.md](CHANGELOG.md) for recent fixes and release history

### Credits

Huge thanks to the contributors, model authors, and toolmakers listed above.

License: [MIT](LICENSE)
