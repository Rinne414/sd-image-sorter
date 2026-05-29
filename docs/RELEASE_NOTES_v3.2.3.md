## v3.2.3 — 安全加固 + database.py 重构 + ruff CI / Security Hardening + database.py Refactor + ruff CI

维护加固版：idna 升级清除 CVE-2026-45409、画师模型 SHA-256 校验、解压炸弹改回 413；database.py 拆分为多个聚焦模块（对外 import 介面不变）；ruff lint 纳入阻断式 CI 并顺手修掉两个真 bug。无新使用者功能，升级零操作。

Maintenance / hardening release: idna bumped to clear CVE-2026-45409, artist-model SHA-256 verification, decompression-bomb 413; database.py split into focused modules (public import surface unchanged); ruff lint added as a blocking CI gate. No user-facing feature changes.

---

## 🔒 Security / 安全

- **idna bumped 3.13 → 3.17 (CVE-2026-45409)**: clears a CPU-DoS that could be triggered by decoding a crafted hostname. Not reachable from untrusted input in this loopback-only tool, but fixed anyway. An explicit `idna>=3.15` floor was added to the lock inputs so it cannot silently regress.
  - **idna 升级 3.13 → 3.17（CVE-2026-45409）**：清除恶意主机名解码导致的 CPU-DoS。本工具仅监听 loopback、不可被不可信输入触达，仍一并修复。lockfile 加了 `idna>=3.15` 下限防回退。

- **Artist model integrity verification**: the Kaloscope checkpoint and `class_mapping.csv` are now verified against pinned SHA-256 digests before they are loaded.
  - **画师模型完整性校验**：Kaloscope checkpoint 与 `class_mapping.csv` 载入前会比对固定的 SHA-256 摘要。

- **Decompression-bomb uploads return HTTP 413**: oversized / decompression-bomb images sent to the obfuscation endpoint now fail fast with a clean 413 instead of erroring late.
  - **解压炸弹上传回 HTTP 413**：送往混淆端点的超大 / 解压炸弹图片会快速回 413，而非延后报错。

- Additional fixes from a full-stack (backend / frontend / pipeline) security and quality review.
  - 来自全栈（后端 / 前端 / pipeline）安全与品质审查的其他修正。

---

## 🧱 Changed / 变更

- **`database.py` split into focused modules** — `db_core`, `db_helpers`, `db_query`, `db_schema`, `db_images_read`, `db_images_write`, `db_tags`, `db_facets`, `db_collections`. `database.py` is now a thin re-export facade (4441 → 351 lines). The public import surface is unchanged, so nothing downstream needs to change.
  - **`database.py` 拆分为多个聚焦模块**：`database.py` 变成薄薄的 re-export facade（4441 → 351 行）。对外 import 介面不变，下游无需改动。

- **ruff lint is now a blocking CI gate** (`select = F, E9` — high-signal pyflakes + syntax checks). Adopting it surfaced and fixed two real undefined-name bugs plus a batch of dead code / unused imports.
  - **ruff lint 成为阻断式 CI 闸门**（`select = F, E9`，高信噪比的 pyflakes + 语法检查）。采用过程中修掉两个真正的 undefined-name bug 与一批死码 / 未用 import。

- The release SOP is now version-controlled at `docs/RELEASE_SOP.md`.
  - 发布 SOP 现纳入版本控制（`docs/RELEASE_SOP.md`）。

---

## ⚠️ Upgrading / 升级注意

- **Zero manual steps.** This release contains no schema migrations and no behavior changes. In-app updater users get it via Check Update; portable users can extract the new archive over a fresh folder as usual.
  - **零操作。** 本版本无 schema 迁移、无行为变更。更新器用户走「检查更新」即可；便携版用户照常解压到新资料夹。

---

## ✅ Validation / 验证

- Backend: 1675 passed / 6 skipped / 0 failed on Python 3.12.7.
- `ruff check backend`: clean (the new CI gate).
- Compiled lock freshness + dependency security audit (pip-audit) green; only the reviewed `starlette` advisory remains allow-listed (its fix is a breaking FastAPI bump).
- Full `scripts/run_ci.py` pipeline (lockfile, security audit, frontend JS syntax, ruff lint, backend suite, Playwright E2E) green before release.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.2.3-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux (any modern distro, including Python 3.13 / 3.14 systems and Raspberry Pi 5) → `sd-image-sorter-v3.2.3-linux-portable-x86_64.tar.gz`** or `…-aarch64.tar.gz` — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux source install** (advanced users with their own Python 3.12 / 3.13 toolchain) → `sd-image-sorter-v3.2.3-linux.tar.gz` — extract, run `./run.sh`.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.2.3-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.2.3-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

See `release-manifest.json` for the SHA-256 of each release asset.
