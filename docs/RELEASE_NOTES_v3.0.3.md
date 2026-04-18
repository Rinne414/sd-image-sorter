## v3.0.3 — Portable launcher + Civitai download + Artist diagnostics + ToriiGate UX / Portable 启动脚本 + Civitai 下载 + 艺术家诊断 + ToriiGate 体验

A small but important patch release. v3.0.2 passed the original cuDNN stress test, but an independent fresh-environment audit on 2026-04-18 found two real regressions plus two UX gaps that got promoted to proper fixes. v3.0.3 addresses all four. The tagging / GPU inference path from v3.0.2 is unchanged.

v3.0.3 是 v3.0.2 之后的补丁版。v3.0.2 虽然通过了原本的 cuDNN 压测，但在 2026-04-18 另一个干净环境的独立验收中，又抓到 2 个真实 regression 和 2 个体验缺口，这一版一次性修掉。Tagger 和 GPU 推理路径沿用 v3.0.2，没有变化。

---

## What's Fixed / 修复内容

### 🧭 Portable launcher now honours `SD_IMAGE_SORTER_PORT` / 启动脚本会跟随 `SD_IMAGE_SORTER_PORT`

- All three launchers (`run-portable.bat`, `run.bat`, `run.sh`) used to hardcode `http://localhost:8487` in both the console message and the "open browser" step.
- If you overrode the port (e.g. `SD_IMAGE_SORTER_PORT=19087`), the server bound correctly on the new port but the browser opened the old, unbound `8487` — first-run UX broken.
- Now the launchers read the env var and route the browser to the real port. Default stays `8487`.

- 旧版的三个启动脚本（`run-portable.bat`、`run.bat`、`run.sh`）都把 `http://localhost:8487` 硬编码在提示文字和 "打开浏览器" 上。
- 一旦你用 `SD_IMAGE_SORTER_PORT=19087` 改端口，server 其实起在新端口，但浏览器会去 `8487` — 首次启动直接打到空页。
- 现在三个脚本都会读环境变量，打开真正绑定的端口。未设时仍是 `8487`。

### 🔐 Civitai privacy-YOLO prepare flow: better errors + UA fix / Civitai 隐私 YOLO 下载：更清楚的错误提示 + UA 修复

- `POST /api/models/prepare {"model_id":"censor-legacy"}` used to return a generic 500 on fresh installs. Two separate things were going wrong and they now behave correctly:
  1. **UA 403** — Civitai's metadata API was rejecting the default `Python-urllib/x.y` User-Agent with `HTTP 403 Forbidden`. Fixed by sending a realistic browser `User-Agent` on every Civitai request, switching the base URL from `civitai.com` to the new `civitai.red` domain, and falling back to a pinned direct-download URL (version `1965032`) when the metadata API misbehaves.
  2. **Civitai auth wall (policy change)** — Civitai now gates NSFW model downloads behind account login. Unauthenticated download requests receive `HTTP 200` + a sign-in HTML page instead of the zip, which previously exploded as a cryptic `BadZipFile`. The backend now detects this (Content-Type `text/html` or not a valid zip) and raises a clear, actionable error with step-by-step manual-download instructions — you sign in on Civitai once, drop the archive into `models/yolo/`, and reopen the Models panel. **The app cannot bypass Civitai's auth wall; this is their policy, not ours.**

- 旧版 `POST /api/models/prepare {"model_id":"censor-legacy"}` 在干净环境会回笼统的 500。实际上是两件事一起出事，这版都处理好了：
  1. **UA 403** — Civitai 的 metadata API 对默认的 `Python-urllib/x.y` UA 回 `HTTP 403 Forbidden`。已修：所有 Civitai 请求都带上接近浏览器的 `User-Agent`，域名从 `civitai.com` 切到新的 `civitai.red`，metadata API 抽风时回落到固定版本（`1965032`）的直链。
  2. **Civitai 登录墙（政策变更）** — Civitai 现在把 NSFW 模型下载藏在账号登录后面。未登录的下载请求会收到 `HTTP 200` + 一个登录 HTML 页（不是 zip），旧版会炸成难懂的 `BadZipFile`。后端现在会识别这种情况（Content-Type 是 `text/html` 或不是合法 zip），并抛出清楚的错误，附带一步一步的手动下载指引 — 浏览器上 Civitai 登录一次、把压缩档丢进 `models/yolo/`、重新打开 Models 面板就能用。**这个登录墙绕不过去，那是 Civitai 的政策，不是我们能动的部分。**

### 🎨 Artist diagnostics no longer lies / 艺术家识别诊断不再回错值

- `/api/artists/diagnostics` used to report `available:false` whenever the Kaloscope runtime files were missing — even after the HuggingFace fallback had successfully loaded and `/api/artists/identify` was returning real predictions. The UI badge was wrong.
- Diagnostics now also consults the identifier singleton. If it has a live loaded model (HF / ModelScope / local), the endpoint reports `available:true` plus new `runtime_loaded`, `runtime_backend`, and `runtime_error` fields so the UI can distinguish "Kaloscope files missing, fallback loaded" from "nothing loaded".

- 旧版 `/api/artists/diagnostics`，只要 Kaloscope 本地文件不齐，就一律回 `available:false`，哪怕 HuggingFace fallback 已经成功加载、`/api/artists/identify` 正在输出真实结果。UI 上的状态灯会一直报错。
- 现在诊断接口会同时看 identifier singleton 的活状态。只要 runtime 有模型在跑（HF / ModelScope / 本地），就 `available:true`，另外新增 `runtime_loaded`、`runtime_backend`、`runtime_error`，让前端能区分 "Kaloscope 文件缺但 fallback 已加载" 和 "真的没加载"。

### 🛰️ ToriiGate first-use size warning / ToriiGate 首次下载大小提示

- First-use of ToriiGate silently pulled the Qwen2.5-VL weights (~5 GB) from HuggingFace while only showing a generic `Loading model on GPU...` toast. Users on slow or metered connections had no idea a multi-gigabyte fetch was happening.
- The tagging service now checks whether the ToriiGate cache is empty and, if so, emits an explicit `First-time ToriiGate download: ~5 GB from HuggingFace. This runs once; keep the app open until it completes.` Later runs show a short `Loading ToriiGate on GPU/CPU…`.

- 旧版首次点 ToriiGate，会静默从 HuggingFace 拉 Qwen2.5-VL（~5 GB），UI 只给一个通用的 `Loading model on GPU...`。慢速网络或流量付费的用户完全不知道背后在下载几 GB。
- 现在 tagging service 会检查 ToriiGate 本地缓存是否为空，首次会明确提示 `First-time ToriiGate download: ~5 GB from HuggingFace. This runs once; keep the app open until it completes.`。之后的运行只显示简短的 `Loading ToriiGate on GPU/CPU…`。

---

## Still Included from v3.0.0 – v3.0.2 / 继承自 v3.0.0 到 v3.0.2

All v3.0.2 features remain: NVIDIA VRAM accurate readout, full GPU auto-detect (Blackwell / Intel Arc / AMD Radeon), Reader clipboard paste, and the v3.0.0 originals (Image Reader, Obfuscation, Aesthetic scoring, ONNX Runtime auto-repair). See the [v3.0.2 release notes](https://github.com/peter119lee/sd-image-sorter/releases/tag/v3.0.2) for the full list.

保留 v3.0.2 全部功能：真实 NVIDIA 显存识别、NVIDIA Blackwell / Intel Arc / AMD Radeon 的 GPU 自动识别、阅读器粘贴，以及 v3.0.0 的图片阅读器、图片混淆、美学评分、ONNX Runtime 自动修复。详见 [v3.0.2 release notes](https://github.com/peter119lee/sd-image-sorter/releases/tag/v3.0.2)。

---

## Download / 下载

| Platform | File | Size |
|----------|------|------|
| **Windows** (portable, Python included) | `sd-image-sorter-v3.0.3-windows-portable.zip` | ~13 MB |
| **Linux / macOS** (requires Python 3.9+) | `sd-image-sorter-v3.0.3-linux-mac.tar.gz` | ~0.57 MB |

### Windows Quick Start / Windows 快速开始
1. Download and extract the zip / 下载并解压 zip
2. Double-click **`run-portable.bat`** / 双击 **`run-portable.bat`**
3. Open `http://localhost:8487` in your browser / 浏览器打开 `http://localhost:8487`

> **Existing v3.0.2 users**: this is a targeted fix release — upgrade in place by replacing the zip contents, or stay on v3.0.2 if you don't use the legacy YOLO prepare flow, custom port overrides, artist diagnostics UI, or ToriiGate first-use. Tagger inference is unchanged.
>
> **v3.0.2 老用户**：本版只改几个体验问题，可以原地覆盖升级，也可以继续留在 v3.0.2，只要你不走 legacy YOLO 的首次准备、没改端口、不在意艺术家识别的 UI 状态灯、也不用 ToriiGate 首次下载。Tagger 推理逻辑没动。

### Linux / macOS
```bash
tar xzf sd-image-sorter-v3.0.3-linux-mac.tar.gz
cd sd-image-sorter && chmod +x run.sh && ./run.sh
```

---

## SHA-256

```
sd-image-sorter-v3.0.3-windows-portable.zip  <填入发布后的 SHA-256>
sd-image-sorter-v3.0.3-linux-mac.tar.gz      <填入发布后的 SHA-256>
```
