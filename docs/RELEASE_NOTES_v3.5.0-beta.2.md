## v3.5.0-beta.2 — 元数据修复 + 队列定位 / Metadata + Queue Position

含生成参数的图片不再误判 Unknown；拖拽或选择队列后不再跳回顶部。

Metadata recovery avoids false Unknown results; queue actions keep your place.

---

## Fixed / 修复

- **Stealth PNG metadata recovery**: Signed Stealth PNG Info carriers are decoded from alpha or RGB channels in compressed and uncompressed forms. Strict length, UTF-8, JSON, gzip, and payload-size validation keeps malformed carriers explicit without inventing metadata.
  - **Stealth PNG 元数据恢复**：现可从 alpha 或 RGB 通道读取压缩与未压缩的签名 Stealth PNG Info 载体。长度、UTF-8、JSON、gzip 与载荷大小均严格验证，损坏载体会明确报错，不会伪造元数据。

- **Existing Unknown records are revisited**: The parser revision bump makes a normal scan re-parse older PNG rows whose prompt, negative prompt, and checkpoint were incomplete, so the fix is not limited to newly imported images.
  - **旧 Unknown 记录会自动重查**：解析器修订号提升后，普通扫描会重新解析 prompt、negative prompt 与 checkpoint 不完整的旧 PNG 记录，修复不只对新导入图片生效。

- **Queue position preservation**: Queue Solitaire keeps the current scroll position after drag-and-drop, selection, sorting, and same-session re-renders. When collapsing content shortens the list, the position is clamped to the new valid bottom; reopening a new session still starts at the top.
  - **队列位置保持**：队列接龙在拖放、选择、排序与同会话重渲染后保留当前位置；折叠内容导致列表缩短时会钳制到新的有效底部，重新打开新会话仍从顶部开始。

- **Cross-platform release gate**: The full validation pipeline now uses resource-bounded isolated browser shards and deterministic async request gates. Windows, macOS, Linux, and both Linux portable architectures complete without failed or flaky tests.
  - **跨平台发布门禁**：完整验证流水线改用资源受控的隔离浏览器分片与确定性的异步请求闸门；Windows、macOS、Linux 与两种 Linux portable 架构均无失败、无 flaky 完成。

---

## Upgrading / 升级注意

- **In-app update for existing users**: This Beta 2 is published on the GitHub Latest channel so Beta 1 and v3.4.x installations can discover it through Check Update. It is still a beta build; back up your `data/` folder before installing.
  - **旧用户可应用内更新**：本次 Beta 2 发布到 GitHub Latest 通道，让 Beta 1 与 v3.4.x 安装可通过「检查更新」直接发现。它仍是测试版，安装前请备份 `data/` 文件夹。

- Database migrations run automatically on first start. Existing images, tags, projects, models, settings, and user data remain outside the updater-managed application files.
  - 数据库迁移会在首次启动时自动执行；现有图片、标签、项目、模型、设置与用户数据均不属于更新器管理的应用文件，不会被补丁覆盖。

---

## Validation / 验证

Full local CI and GitHub Actions are green: 5,623 backend tests; 732 passed / 2 skipped desktop Playwright tests with 0 failed and 0 flaky; Windows, macOS, Linux full, Linux portable x86_64, and Linux portable aarch64 jobs all passed. All six release assets passed archive, manifest, checksum, permission, and architecture QA. / 完整本地 CI 与 GitHub Actions 全绿：后端 5,623 项；桌面 Playwright 732 通过、2 跳过、0 失败、0 flaky；Windows、macOS、Linux full 与两种 Linux portable job 全部通过。六项发布资产均通过归档、manifest、校验和、权限与架构 QA。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-beta.2-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-beta.2-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-beta.2-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-beta.2-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-beta.2-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.0-beta.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.0-beta.2-windows-portable.zip` | `998f41b0db280c57e934c111a6c8c2f68bfb110774804d1a2d4b12709862fb2a` |
| `sd-image-sorter-v3.5.0-beta.2-app-patch.zip` | `4c48f980a0019677e68397b6727b263a3f5893935b96c485c9ff92b9447ad5cb` |
| `sd-image-sorter-v3.5.0-beta.2-linux.tar.gz` | `1df49e3f1b5b9274292f8f712c869b6a7f92fe15361b1bcec12c7f2dcdf70c78` |
| `sd-image-sorter-v3.5.0-beta.2-linux-portable-x86_64.tar.gz` | `0e6360ef5fd088268f2764a43cf11da1d4c72f1b98eebd1317cc6eb67c6e121f` |
| `sd-image-sorter-v3.5.0-beta.2-linux-portable-aarch64.tar.gz` | `b63715f4502bf0f18125a1ca2a3bf61e625a508657c625a1f41fa8d2b2bcf36c` |
| `sd-image-sorter-v3.5.0-beta.2-release-manifest.json` | `f86b9f4665e507d235f62978ce43835ca1a579391ed92192d810217ada10bdfe` |
