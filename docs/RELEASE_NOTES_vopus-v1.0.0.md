## Vopus 1.0.0 — V4 改名 Vopus / V4 Is Now Vopus

新界面正式叫 Vopus，版本从 1.0.0 开始，只检查 Vopus 自己的更新。
The new interface is now called Vopus, starts at 1.0.0 and checks only for Vopus updates.

---

## Fixed / 修复

- **The name Vopus**: the top bar, Settings › About, the browser tab and the copied diagnostics say Vopus instead of V4.
  - 顶栏、设置 › 关于、浏览器标签页和复制的诊断信息都写 Vopus，不再写 V4。
- **Updates stay on the Vopus line**: the update check offers only releases tagged `vopus-v…`. A V3.5 release is never offered, however high its number.
  - 检查更新只看标签为 `vopus-v…` 的发布；V3.5 的发布不管版本号多大都不会出现。
- **Launcher messages**: when the interface cannot be built, the launcher says the program still starts instead of pointing at a V3.5 interface this package does not have.
  - 界面构建不了时，启动器会说程序照常启动，不再提这个包里没有的 V3.5 界面。

---

## Upgrading / 升级注意

- Vopus is its own program with its own version line. V3.5 is not updated to Vopus in the app: download the full package below.
  - Vopus 是独立的程序，版本号单独计算。V3.5 不会在程序内更新到 Vopus，请下载下面的完整包。
- Installs of the earlier V4 preview (version 3.5.0) are not offered Vopus in the app either: download the full package.
  - 之前的 V4 预览版（版本 3.5.0）同样不会在程序内收到 Vopus，请下载完整包。
- V4 preview installs report version 3.5.0 and use the old updater, which may offer a V3.5 update (3.5.x). Do not install it: it replaces the interface with V3.5, which cannot open the database Vopus uses. Install the Vopus package instead.
  - V4 预览版显示的版本是 3.5.0，用的是旧的更新器，可能会提示 V3.5 的更新（3.5.x）。不要安装：它会把界面换回 V3.5，而 V3.5 打不开 Vopus 用的数据库。请改装 Vopus 完整包。
- Opening a library in Vopus upgrades its database, and V3.5 then refuses to open it. Copy `data/images.db` first if you want to go back to V3.5.
  - 用 Vopus 打开图库会升级数据库，之后 V3.5 打不开它。想回到 V3.5 的话，先备份 `data/images.db`。

---

## Validation / 验证

Filled in from the release CI run. / 发布时填入 CI 结果。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-vopus-v1.0.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-vopus-v1.0.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-vopus-v1.0.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-vopus-v1.0.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-vopus-v1.0.0-app-patch.zip` — in-app updater only / 仅供程序内更新器
- `sd-image-sorter-vopus-v1.0.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| Filled in at release / 发布时填入 | |
