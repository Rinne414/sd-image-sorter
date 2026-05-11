## v3.1.5 — Prompt Lab 固定标签 + 导出范围更清楚 / Prompt Lab Fixed Tags + Clear Export Scope

这版重点不是加一堆新按钮，而是把用户最容易混淆的地方说清楚、做稳：Prompt Lab 可以固定加开头 / 加结尾并自动去重；导出明确只影响当前选中的图片；自动打码会显示实际使用的本地 YOLO 文件；portable 启动不再因为可选 AI 包反复跑安装检查。

This release focuses on clarity and release stability: Prompt Lab can add fixed beginning/end tags with automatic dedupe, exports clearly apply only to the selected Gallery images, Auto Censor shows the actual local YOLO file being used, and the portable launcher no longer repeats install checks because of optional AI packages.

---

## Changed / 改进

- **Prompt Lab fixed beginning/end tags**: Generate / Randomize now merges fixed beginning tags, generated prompt tags, and fixed ending tags in that order, with automatic duplicate removal.
  - Prompt Lab 现在支持固定加开头 / 加结尾。点生成或随机生成时，会按「开头固定标签 → 生成结果 → 结尾固定标签」合并，并自动去重。

- **Prompt Lab presets include fixed tags**: Saved presets now restore the fixed beginning/end tag fields. Clear resets the builder/output but keeps the fixed tags so users can keep generating with the same house style.
  - Prompt Lab preset 会保存并恢复固定标签。清除按钮只清构建区和输出，不清固定标签，方便继续用同一套基础风格反复生成。

- **Export scope is explicit**: Combined Export and same-name `.txt` export now say they only include the images currently selected in Gallery.
  - 导出范围现在写清楚：Combined Export 和同名 `.txt` 导出只处理当前在图库里选中的图片。

- **Batch export remains the right place for selective training-caption edits**: Prefix / Class Token and blacklist stay in export, so users can apply them to only one selected batch instead of changing tagger output for every image.
  - 训练 caption 的前缀 / Class Token 和黑名单继续放在导出层，适合只影响某一批被选中的图片，而不是污染 tagger 的识别结果。

- **Auto Censor shows the actual YOLO file**: The detector selector now shows which local YOLO file will be used, so users can tell whether Wenaka/custom YOLO is actually selected.
  - 自动打码会显示实际使用的本地 YOLO 文件，用户不用展开高级面板也能知道是不是用了 Wenaka / 自定义 YOLO。

- **Optional Prepare installs are more predictable**: Optional AI dependency groups now prefer exact versions already pinned in `backend/requirements.txt` instead of broad `>=` specs when the app prepares a feature runtime.
  - 可选功能 Prepare 现在优先使用 `backend/requirements.txt` 中锁定的精确版本，减少 pip 解析和下载内容随时间漂移。

- **Security lock refresh**: `urllib3` is pinned to `2.7.0` in the full/dev runtime locks to clear the current pip-audit CVE report.
  - **安全锁定更新**：full/dev runtime lock 中的 `urllib3` 已升到 `2.7.0`，解决当前 pip-audit 报告的 CVE。

---

## Fixed / 修复

- **Portable startup no longer re-installs because one optional AI import fails**: `run-portable.bat` now probes only startup-critical packages (`fastapi`, `PIL`, `numpy`, `onnxruntime`). Optional packages such as SAM3 / OpenCV / pycocotools no longer block normal startup or make the launcher look like it is reinstalling everything every time.
  - 便携版启动不再因为某个可选 AI 包 import 失败就每次重跑安装。现在只检查真正启动必需的包：`fastapi`、`PIL`、`numpy`、`onnxruntime`。

---

## Upgrading / 升级注意

- No database migration needed. This is a drop-in replacement for v3.1.4.
  - 不需要数据库迁移。可以直接替换 v3.1.4。
- Tagger behavior is intentionally unchanged: tagger still identifies image content only. Fixed prompt tags belong to Prompt Lab / Export workflows, not AI tag detection.
  - Tagger 行为刻意不变：tagger 只负责识别图片内容。固定 prompt 标签属于 Prompt Lab / 导出流程，不属于 AI 打标识别结果。

---

## Validation / 验证

Local validation includes frontend syntax checks, release-build tests, optional dependency tests, Prompt Lab E2E, export scope E2E, and censor model selector E2E. Full CI is expected to run on GitHub Actions after push.

本地验证覆盖前端语法、release build 测试、optional dependency 测试、Prompt Lab E2E、导出范围 E2E、censor 模型选择器 E2E。推送后以 GitHub Actions 全绿为最终发布准入。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → windows-portable.zip** — extract, run `run-portable.bat`
**Linux → linux.tar.gz** — extract, run `./run.sh`

**Do NOT download / 不要下载：**
- app-patch.zip — in-app updater only / 仅供更新器
- release-manifest.json — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all assets.
