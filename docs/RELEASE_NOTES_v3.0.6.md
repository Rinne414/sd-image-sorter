## v3.0.6 — ComfyUI advanced workflow support + Aesthetic stability + LoRA weights / ComfyUI 高级工作流支持 + Aesthetic 稳定性 + LoRA 权重

v3.0.6 is a feature and stability release. It fixes ComfyUI prompt extraction for advanced node graphs, prevents system freezes during large aesthetic scoring batches, adds LoRA weight and VAE/CLIP display, and preserves SD metadata when saving censored images as JPG/WebP.

v3.0.6 是功能和稳定性版本。修了高级 ComfyUI 工作流的 prompt 提取，防止大批量 aesthetic 评分时系统冻死，新增 LoRA 权重和 VAE/CLIP 显示，保存打码图为 JPG/WebP 时也能保留 SD metadata。

---

## What's Fixed / 修复内容

### ComfyUI advanced workflow prompt extraction / ComfyUI 高级工作流 prompt 提取

- Prompt extraction now follows `SamplerCustomAdvanced → CFGGuider → CLIPTextEncode` chains.
- `JoinStringMulti` nodes with `string_1`/`string_2` keys are now traversed correctly.
- `String` nodes with capital-S `"String"` input key are now recognized.
- Disabled LoRAs (`on: false`) in rgthree Power Lora Loader are excluded from the LoRA list and filters.

- Prompt 提取现在能跟踪 `SamplerCustomAdvanced → CFGGuider → CLIPTextEncode` 链。
- `JoinStringMulti` 节点的 `string_1`/`string_2` 键现在能正确遍历。
- 大写 `"String"` 键的 String 节点现在能识别。
- rgthree Power Lora Loader 中 `on: false` 的 LoRA 不再出现在 LoRA 列表和筛选器里。

### Aesthetic scoring stability / Aesthetic 评分稳定性

- System no longer freezes at ~1000 images during batch aesthetic scoring.
- Added periodic `torch.cuda.empty_cache()` + `gc.collect()` every 50 images.
- PIL images are now closed explicitly after inference.
- SQLite commits are batched (every 20 images) instead of per-image.

- 批量 aesthetic 评分不再在 ~1000 张时冻死系统。
- 每 50 张图做 `torch.cuda.empty_cache()` + `gc.collect()`。
- PIL 图片推理后立即关闭。
- SQLite 提交改为每 20 张批量，不再每张提交。

### Metadata preservation for JPG/WebP / JPG/WebP 保存保留 metadata

- Censor editor save now converts PNG text chunks to EXIF UserComment for JPG/WebP output.
- Metadata parser now reads ComfyUI JSON from EXIF UserComment in JPEG/WebP files.
- Round-trip verified: PNG → JPG/WebP save → re-parse correctly identifies generator, prompt, checkpoint, and LoRAs.

- Censor 编辑器保存为 JPG/WebP 时，现在会把 PNG text chunks 转写为 EXIF UserComment。
- Metadata parser 现在能从 JPEG/WebP 的 EXIF UserComment 中读取 ComfyUI JSON。
- 往返验证：PNG → JPG/WebP 保存 → 重新解析能正确识别 generator、prompt、checkpoint 和 LoRA。

### UI fixes / UI 修复

- Gallery empty state no longer shows a duplicate camera-icon message.
- Artist ID progress bar no longer stuck on "Starting..." — replaced blocking overlay with inline progress, and removed `data-i18n` that kept overwriting dynamic text.
- Artist confidence threshold value no longer disappears after language refresh.
- Manual Sort now shows a confirmation dialog before starting.

- Gallery 空状态不再同时显示两个提示。
- Artist ID 进度条不再卡在 "Starting..."——去掉全屏遮罩改用内嵌进度条，移除了覆盖动态文字的 `data-i18n`。
- Artist 置信度阈值数值切换语言后不再消失。
- Manual Sort 开始前现在会弹确认对话框。

### New features / 新功能

- **LoRA weights**: `strength_model` / `strength_clip` extracted from standard and rgthree LoRA loaders, displayed next to each LoRA name (e.g. `lora.safetensors (0.5)`).
- **VAE / CLIP display**: VAE and CLIP/Text Encoder models extracted from ComfyUI workflows, shown in the Model Assets section of the image detail modal.

- **LoRA 权重**：从标准和 rgthree LoRA 加载器提取 `strength_model` / `strength_clip`，显示在每个 LoRA 名字旁边。
- **VAE / CLIP 显示**：从 ComfyUI 工作流提取 VAE 和 CLIP/Text Encoder 模型，在图片详情的 Model Assets 区域显示。

---

## Download / 下载

| Platform | File | Size |
|----------|------|------|
| **Windows** (portable, Python included) | `sd-image-sorter-v3.0.6-windows-portable.zip` | ~13 MB |
| **Linux / macOS** (requires Python 3.9+) | `sd-image-sorter-v3.0.6-linux-mac.tar.gz` | ~0.59 MB |

### Windows Quick Start / Windows 快速开始
1. Download and extract the zip / 下载并解压 zip
2. Double-click **`run-portable.bat`** / 双击 **`run-portable.bat`**
3. Open `http://localhost:8487` in your browser / 浏览器打开 `http://localhost:8487`

> **Existing v3.0.5 users**: upgrade in place by replacing the zip contents. This release adds LoRA weight display, VAE/CLIP extraction, and fixes aesthetic scoring stability + ComfyUI advanced workflow support.
>
> **v3.0.5 老用户**：直接原地覆盖升级即可。这版新增 LoRA 权重显示、VAE/CLIP 提取，修了 aesthetic 评分稳定性和 ComfyUI 高级工作流支持。

### Linux / macOS
```bash
tar xzf sd-image-sorter-v3.0.6-linux-mac.tar.gz
cd sd-image-sorter && chmod +x run.sh && ./run.sh
```

---

## SHA-256

```
sd-image-sorter-v3.0.6-windows-portable.zip  578a75bad1e0d5a903b005f77361fd1377b5e3481a3365b5439216ccf364528c
sd-image-sorter-v3.0.6-linux-mac.tar.gz      22e2007665bcc1da66c0d9c142bbdc8a52ec6aeb29362e54b46234018c317f72
```
