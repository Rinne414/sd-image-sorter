## v3.0.5 — Automatic GPU safety + Censor sidebar layout + Streaming scan / 自动 GPU 安全策略 + Censor 侧栏布局 + 流式扫描

v3.0.5 is a pre-release cleanup patch. It removes the stale GPU confirmation modal in favour of automatic hardware clamping, fixes the Censor workspace sidebar sizing, and upgrades folder scan to a real two-pass streaming architecture. Version strings and E2E startup paths are synced across the board.

v3.0.5 是发布前修正补丁。移除了过时的 GPU 二次确认弹窗并统一为自动硬件限流策略，修了 Censor 工作区队列侧栏布局，scan 改成真正两遍流式处理。版本字符串和 E2E 测试启动路径同步干净。

---

## What's Fixed / 修复内容

### GPU confirmation modal removed — automatic hardware clamps are the real product / GPU 确认弹窗移除 —— 自动硬件限流才是真正的产品行为

- The stale "launch-time GPU confirmation" flow has been removed from both the backend model hints and the frontend tagger modal.
- All tagger models now start directly under automatic hardware safety limits: batch size is clamped by real-time VRAM / RAM readings, and session refresh stays active for GPU runs.
- No manual confirmation step is required for any model, including Max Quality (EVA02-Large) and custom ONNX models.
- E2E tests now assert `allow_unsafe_acceleration: false` and `expect(confirm-modal).toHaveCount(0)` for all GPU start paths.

- 移除了后端模型 hints 和前端 tagger modal 里过时的"启动时 GPU 确认"流程。
- 所有 tagger 模型现在直接在自动硬件安全限制下启动：batch size 根据实时 VRAM / RAM 读数做上限裁剪，GPU 运行时 session refresh 始终生效。
- 任何模型都不再需要手动确认，包括 Max Quality（EVA02-Large）和自定义 ONNX 模型。
- E2E 测试现在对所有 GPU 启动路径断言 `allow_unsafe_acceleration: false` 和 `expect(confirm-modal).toHaveCount(0)`。

### Censor workspace sidebar stays readable / Censor 工作区侧栏保持可读

- Tightened the left sidebar to 236px and the right sidebar to 328px with `flex-shrink: 0 !important`, so the queue header, Queue Manager button, and detection settings never get crushed by the canvas.
- Responsive breakpoints at 1024px and 768px adjust gracefully without hiding critical controls.
- E2E test `censor workspace sidebars should stay readable without covering the canvas` validates bounding boxes: left < main < right, canvas > 320px, Queue Manager button > 120px.

- 左侧栏收紧到 236px、右侧栏 328px 且 `flex-shrink: 0 !important`，队列标题、Queue Manager 按钮、检测设置不再被画布挤扁。
- 1024px 和 768px 响应式断点平滑调整，不会隐藏关键控件。
- E2E 测试验证了边界框：left < main < right，画布 > 320px，Queue Manager 按钮 > 120px。

### Folder scan is now a real two-pass streaming walk / 文件夹扫描改为真正的两遍流式处理

- Pass 1: cheap count-only walk (`os.walk` + suffix check, no file opens) to get a truthful total before the first image is processed.
- Pass 2: streaming process pass that never materializes the full path list in memory.
- Cancellation checks run on every directory entry and every file in both passes.
- Symlinked folders and files are explicitly rejected to prevent traversal loops.

- 第一遍：轻量级纯计数走目录（`os.walk` + 后缀检查，不打开文件），在处理第一张图前就拿到真实总数。
- 第二遍：流式处理，不在内存里攒全部路径列表。
- 两遍中每个目录项和每个文件都会检查取消信号。
- 明确拒绝软链接文件夹和文件，防止遍历死循环。

### Version strings and E2E startup synced / 版本字符串和 E2E 启动路径同步

- `backend/main.py` API version, `README.md` download links and badge, `scripts/build_release_packages.py` default version, and `backend/routers/models.py` User-Agent all read `3.0.5`.
- Playwright startup now falls back across Windows (`venv/Scripts/python.exe`) and POSIX (`venv/bin/python`) virtualenv layouts via `PW_BACKEND_PYTHON` env var or auto-detection.

- `backend/main.py` API 版本、`README.md` 下载链接和徽章、`scripts/build_release_packages.py` 默认版本、`backend/routers/models.py` User-Agent 全部统一到 `3.0.5`。
- Playwright 启动现在会自动在 Windows (`venv/Scripts/python.exe`) 和 POSIX (`venv/bin/python`) 之间回退，也支持 `PW_BACKEND_PYTHON` 环境变量覆盖。

---

## Still Included from v3.0.0 – v3.0.4 / 继承自 v3.0.0 到 v3.0.4

All prior features remain: Reader clipboard truthfulness, `censor-legacy` structured 409 auth-wall, corrupt-image quarantine during scan, similarity progress granularity, ToriiGate runtime truthfulness, per-image censor-queue batch failure visibility, portable launcher honours `SD_IMAGE_SORTER_PORT`, Civitai UA fix, artist diagnostics truthfulness, ToriiGate first-use size warning, NVIDIA VRAM accurate readout, full GPU auto-detect, Reader clipboard paste, Image Reader, Obfuscation, Aesthetic scoring, and ONNX Runtime auto-repair. See the [v3.0.4 release notes](https://github.com/peter119lee/sd-image-sorter/releases/tag/v3.0.4) for the full list.

保留 v3.0.0 – v3.0.4 的全部功能：Reader 剪贴板说真话、`censor-legacy` 结构化 409 登录墙、scan 坏图隔离、similarity 进度粒度、ToriiGate 运行时真实状态、censor 队列批次失败可见性、portable launcher 跟随 `SD_IMAGE_SORTER_PORT`、Civitai UA 修复、艺术家识别诊断说真话、ToriiGate 首次下载大小提示、真实 NVIDIA 显存识别、全 GPU 自动识别、Reader 粘贴、图片阅读器、图片混淆、美学评分、ONNX Runtime 自动修复。详见 [v3.0.4 release notes](https://github.com/peter119lee/sd-image-sorter/releases/tag/v3.0.4)。

---

## Download / 下载

| Platform | File | Size |
|----------|------|------|
| **Windows** (portable, Python included) | `sd-image-sorter-v3.0.5-windows-portable.zip` | ~13 MB |
| **Linux / macOS** (requires Python 3.9+) | `sd-image-sorter-v3.0.5-linux-mac.tar.gz` | ~0.59 MB |

### Windows Quick Start / Windows 快速开始
1. Download and extract the zip / 下载并解压 zip
2. Double-click **`run-portable.bat`** / 双击 **`run-portable.bat`**
3. Open `http://localhost:8487` in your browser / 浏览器打开 `http://localhost:8487`

> **Existing v3.0.4 users**: this is a pre-release cleanup patch. Upgrade in place by replacing the zip contents. The tagger GPU inference path is unchanged — what changed is the UI no longer asks for a confirmation modal before starting GPU runs.
>
> **v3.0.4 老用户**：这是发布前修正补丁。直接原地覆盖升级即可。Tagger GPU 推理路径没有变化 —— 改的是 UI 不再在 GPU 运行前弹确认弹窗了。

### Linux / macOS
```bash
tar xzf sd-image-sorter-v3.0.5-linux-mac.tar.gz
cd sd-image-sorter && chmod +x run.sh && ./run.sh
```

---

## SHA-256

```
sd-image-sorter-v3.0.5-windows-portable.zip  (will be filled after packaging)
sd-image-sorter-v3.0.5-linux-mac.tar.gz      (will be filled after packaging)
```
