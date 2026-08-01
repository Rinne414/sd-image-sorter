## v3.5.0-beta.3 — 旧版启动修复 / Legacy Startup Fix

旧版 Windows 更新后可正常启动；补丁强制兼容 Python 3.11，CI 分片缓存已隔离。

Legacy Windows updates start again; patches stay Python 3.11-compatible.

---

## Fixed / 修复

- **Legacy Windows startup**: In-app patches no longer ship Python 3.12-only type-alias syntax to Beta 1, Beta 2, or v3.4.x Windows portable installations that keep their bundled Python 3.11 runtime. Database migration behavior is unchanged.
  - **旧版 Windows 启动**：应用内补丁不再把 Python 3.12 专属类型别名语法送入仍使用内置 Python 3.11 的 Beta 1、Beta 2 或 v3.4.x Windows portable 安装；数据库迁移行为保持不变。

- **Patch compatibility gate**: Release tests parse every Python source that actually enters the app patch with the Python 3.11 grammar, so a future incompatible syntax change fails before packaging.
  - **补丁兼容门禁**：发布测试会用 Python 3.11 语法检查实际进入 app patch 的每个 Python 源文件，未来若再次引入不兼容语法，会在打包前明确失败。

- **Deterministic sharded CI**: Each Playwright shard now owns a run-scoped transform cache. Concurrent shards can no longer delete one another's compiled fixtures and exit with collection errors despite reporting zero failed assertions.
  - **确定性分片 CI**：每个 Playwright 分片现在独占本次运行的转换缓存；并行分片不再互删已编译 fixture，也不会出现断言零失败却因收集错误退出的情况。

---

## Upgrading / 升级注意

- **Beta 2 cannot open the UI**: Close SD Image Sorter, then double-click `update.bat` in the installation folder. This updater works without the web UI, downloads and verifies Beta 3, applies it, and relaunches the app when possible.
  - **Beta 2 无法打开界面**：关闭 SD Image Sorter，然后双击安装目录内的 `update.bat`。这个更新器不依赖网页界面，会下载并校验 Beta 3、完成更新并在条件允许时重新启动。

- Beta 1 and v3.4.x users who can still open the app may use the normal Check Update button. Beta 3 is published on GitHub Latest so these installations can discover it directly.
  - 仍可打开应用的 Beta 1 与 v3.4.x 用户可继续使用普通「检查更新」按钮。Beta 3 会发布到 GitHub Latest，供这些安装直接发现。

- Existing images, tags, projects, models, settings, and the `data/` folder remain outside updater-managed application files. Back up `data/` before beta updates as usual.
  - 现有图片、标签、项目、模型、设置与 `data/` 文件夹仍不属于更新器管理的应用文件。测试版更新前仍建议照常备份 `data/`。

---

## Validation / 验证

Full local CI passed: 5,624 backend tests and 732 passed / 2 skipped desktop Playwright tests with 0 failed and 0 flaky. The real bundled Python 3.11.9 parsed all 367 patch Python files, loaded all 36 migrations, and booted an isolated backend to HTTP 200. / 完整本地 CI 已通过：后端 5,624 项；桌面 Playwright 732 通过、2 跳过、0 失败、0 flaky。真实内置 Python 3.11.9 已解析补丁内全部 367 个 Python 文件、加载全部 36 个迁移，并将隔离后端启动至 HTTP 200。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-beta.3-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-beta.3-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-beta.3-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-beta.3-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-beta.3-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.5.0-beta.3-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.5.0-beta.3-windows-portable.zip` | `911100457ba26c105524fd963fce798352d187313230ccf94c144a06660af589` |
| `sd-image-sorter-v3.5.0-beta.3-app-patch.zip` | `e6131722e04a42a5dd524d2714cc2fbece8ba91d8417c51dca1a9a48e992f56f` |
| `sd-image-sorter-v3.5.0-beta.3-linux.tar.gz` | `e63b922c7e2024b8c3c2c0ae3e47c7fc07c49ca2a7010a3e23420ac4b8511271` |
| `sd-image-sorter-v3.5.0-beta.3-linux-portable-x86_64.tar.gz` | `13d6db0eaf1969f83a5f5bd23d7ca6184674f851b502fc23d04e1c3c76e3f927` |
| `sd-image-sorter-v3.5.0-beta.3-linux-portable-aarch64.tar.gz` | `786fe73d432296390d3c6987387b15bb7e2bbcdb140d081d71b6933239efd0e7` |
| `sd-image-sorter-v3.5.0-beta.3-release-manifest.json` | `ae2628a5302551b26642fe1976b31a8700116e9750a3e0f1d9376cb814482d21` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
