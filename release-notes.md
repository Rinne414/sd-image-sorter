## v3.6.0 — vFable：ComfyUI 提示词修正 + 打码修复 / ComfyUI Prompt Fixes + Censor

ComfyUI 提示词不再把反向混进正向或存两遍，一键重读旧图；Windows CPU 版打码能读新版 YOLO；搜索不再套用半个标签。ComfyUI prompts read right, censor works on CPU installs.

---

## Fixed / 修复

- **ComfyUI prompts read right**: Impact Pack pipe nodes are followed by output slot, tag generators' ban / exclude lists (TIPO, WD14Tagger) are no longer walked into the positive, a hires or refiner pass no longer stores the prompt twice, and a pipe behind a switch resolves through the selected branch. On the owner's 1,447 ComfyUI images 413 came out different and none worse.
  - Impact Pack 管线节点按输出端口追踪；TIPO / WD14Tagger 的屏蔽词接线不再被走进正向；高清修复或精修不再把提示词存两遍；管线经过开关节点时按选中的分支解析。在主人的 1,447 张 ComfyUI 图上 413 张结果不同、没有一张变差。

- **Re-read ComfyUI Prompts**: Settings → Dataset Audit gains a button that parses every ComfyUI image of the current library again from its file and rewrites only rows whose prompt or negative prompt came out different. Tags, scores and captions stay; a file that no longer parses to a prompt keeps its stored text.
  - 设置 → 数据集体检 新增「重读 ComfyUI 提示词」：把当前图库的每张 ComfyUI 图从文件重新读一遍，只改写提示词或反向提示词读出来不一样的图。标签、评分、描述都不动；文件读不出提示词的图保持原样。

- **Quick Auto Censor on Windows CPU installs**: the CPU install now carries onnxruntime 1.21.0, which reads the ONNX opset 22 files current PyTorch / Ultralytics export (Wenaka, yolov8s-seg, yolo26s-seg). 1.20.1 refused them, so combined mode quietly ran NudeNet alone and explicit anime pictures came back "no match". A model that still cannot be read now gets a message naming both opsets and the way out.
  - Windows CPU 安装改用 onnxruntime 1.21.0，能读现在 PyTorch / Ultralytics 导出的 ONNX opset 22 文件（Wenaka、yolov8s-seg、yolo26s-seg）。1.20.1 会拒绝它们，组合模式只剩 NudeNet，明显的动画图返回「未匹配」。模型仍读不了时，提示会写出两边的 opset 和解决办法。

- **Gallery search**: a half-typed `tag:` value is no longer applied while you type; the box waits until the token is complete (space, Enter, an accepted suggestion, or a value that is one of the suggestions). The generator strip fades where it is cut off at 1366 px.
  - 图库搜索不再在输入途中套用打了一半的 `tag:` 值，词完整（空格、回车、选中建议，或输入的值正好是建议之一）才套用。1366 宽度下生成器条带被切断处改为渐隐。

- **Quality tag from the anime grade**: the dataset caption slot `{quality}` uses the deepghs anime grade when a picture has one, on the same ladder NoobAI-XL's model card uses; pictures without a grade keep the CLIP score buckets, and your override still wins.
  - 数据集 caption 的 `{quality}` 在图片有 deepghs 动画等级时改用它，阶梯与 NoobAI-XL 模型卡一致；没有等级的图仍按 CLIP 分数分档，你自己填的覆盖值仍然优先。

---

## Upgrading / 升级注意

- Stored prompts are not rewritten by the upgrade. To repair images scanned before, open Settings → Dataset Audit → Re-read ComfyUI Prompts once per library (about 1,500 images per minute).
  - 升级不会改写已存的提示词。要修好以前扫进来的图，每个图库点一次 设置 → 数据集体检 → 重读 ComfyUI 提示词（约每分钟 1,500 张）。
- Windows CPU installs get onnxruntime 1.21.0 on the next launch: the launcher sees the changed core requirements and installs them. GPU installs already run 1.21.0 and are unchanged.
  - Windows CPU 安装在下次启动时会装上 onnxruntime 1.21.0：启动器检测到核心依赖清单变了会自动安装。GPU 安装本来就是 1.21.0，不受影响。
- No database migration. Nothing is downloaded by the upgrade itself.
  - 没有数据库迁移。升级本身不会下载任何东西。

---

## Validation / 验证

Full CI on the final tree (2026-09-29): lock freshness, runtime dependencies, security audit, JS syntax, E2E typecheck, ruff, backend 7,177 passed / 12 skipped / 0 failed, Playwright 1,023 total: 1,018 passed / 0 failed / 5 skipped / 0 flaky, click coverage gate 46.70% (baseline 39%); lazy_release_qa --skip-server PASS; Windows portable booted on a copy of the owner's library (12,853 images). / 最终代码完整 CI 全部通过：后端 7,177 通过 / 12 略过 / 0 失败，Playwright 1,023 个：1,018 通过 / 0 失败 / 5 略过 / 0 不稳定，点击覆盖门 46.70%；发布 QA 通过；Windows 便携版在主人图库副本上开机验证。

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.6.0-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.6.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.6.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.6.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.6.0-app-patch.zip` — in-app updater only / 仅供应用内更新器
- `sd-image-sorter-v3.6.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.6.0-windows-portable.zip` | `ea8d3fb81d553601dd39d817beb791785b49ad21ebac713adeb6f27f80f551e0` |
| `sd-image-sorter-v3.6.0-app-patch.zip` | `765e807c9293a27756524bc6f16f0c7cf0cb8bc2f57f77d796c1f22394f78084` |
| `sd-image-sorter-v3.6.0-linux.tar.gz` | `f52d33159c48dc4dd18bdf5bc7dd2767ae32e92bebfef99963a2c4ee98c8bd3b` |
| `sd-image-sorter-v3.6.0-linux-portable-x86_64.tar.gz` | `c13d789c7221ed05d4a91965e79a2cd21a55ad3022ed0c67fb402dde453b9f21` |
| `sd-image-sorter-v3.6.0-linux-portable-aarch64.tar.gz` | `34dfdddf41ac0888ce6aedd568c9d7b0a779a41cea06c796dbe5c0dfb11ab458` |
| `sd-image-sorter-v3.6.0-release-manifest.json` | `c42d4d49d7a944b298d65f57152674c6807889fdf55632073678b561d97f6f52` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
