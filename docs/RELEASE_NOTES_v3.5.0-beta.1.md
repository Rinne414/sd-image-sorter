## v3.5.0-beta.1 — 清爽极光重设计公测 + 搜索语法 + LoRA 导出大修 / Fresh Aurora Public Beta

v3.5.0 的公开测试版：全局换新「清爽极光」设计与任务入口页，图库搜索升级为完整查询语法 + danbooru 自动补全，LoRA 训练导出端到端大修，camie 打标器角色识别修复。功能零删除。这是预发布版，欢迎试用并反馈问题；正式版发布前不会替换你现有的稳定版。

A public beta of v3.5.0: the "Fresh Aurora" redesign + mission entry page, a full gallery search query language with danbooru autocomplete, an end-to-end LoRA export overhaul, and the camie tagger character fix. Zero feature removals. This is a prerelease for testing — it will NOT auto-replace your stable install.

---

## 🧪 Beta notes / 公测说明

- **This is a prerelease (not "Latest") / 这是预发布版（不是「Latest」）**: existing v3.4.x users are **not** auto-updated to this beta. Grab it manually from the assets below to try it.
  - 现有 v3.4.x 用户不会被自动升级到公测版。想试用请从下方资源手动下载。
- **Please report anything that feels off / 欢迎反馈任何问题**: this is the first public build of the Aurora redesign; bug reports and UX feedback directly shape the stable v3.5.0.
  - 这是极光重设计的首个公开构建；你的 bug 反馈与体验意见会直接影响正式版 v3.5.0。
- **Moving to stable later / 之后升级到正式版**: when stable v3.5.0 ships as "Latest", download it manually (the in-app updater treats this beta as already-current and won't prompt for the same base version).
  - 正式版 v3.5.0 发布为「Latest」后，请手动下载升级（应用内更新器会把本公测视为同版本，不会重复提示）。

---

## Highlights / 本次重点

- **Fresh Aurora visual system / 「清爽极光」视觉系统**: a new last-loaded `frontend/css/tokens.css` owns the global palette — blue #5CC8FF = next action, pink #FF8FC0 = user decisions, purple #A78BFF = AI output — with unified focus rings, solid-blue primaries, and Noto Sans SC + IBM Plex Mono + Oswald typography. ~470 hardcoded legacy colors across 13 stylesheets now reference tokens.
  - 全新最后加载的 `frontend/css/tokens.css` 接管全局配色（蓝=下一步、粉=用户决定、紫=AI 产物），统一焦点圈、实心蓝主按钮、思源黑体 + IBM Plex Mono + Oswald 字体组；13 个样式表约 470 处硬编码旧色改为 token 引用。

- **Mission entry page + smart nav + function catalog / 任务入口页 + 智能导航 + 所有功能清单**: picking a mission scopes the top bar to that pipeline's tabs (①② step numbers + exit chip); a checklist under More ▾ customizes which tabs stay visible; a 所有功能 catalog modal lists every feature with a one-line usage. The classic top bar stays; the brand block returns to the entry page.
  - 在入口页选任务后，顶栏只显示该流程的页面（带 ①② 步骤编号 + 退出 chip）；「更多 ▾」新增自定义标签栏；「所有功能」清单弹窗每个功能一句用途、点击直达。顶栏保持经典布局，点品牌区回入口页。

- **Gallery search query language + quick chips + bottom action bar / 图库搜索查询语言、快捷筛选、底部批量操作条**: the search box speaks a full query language over every filter — 21 keys (en/zh aliases), `score>=7` comparisons, `score:6..8` ranges, `size:1024x1536`, `-tag:blurry` negation — with a live "Understood as:" chip line, a ? help modal, and Danbooru-style value autocomplete from your own library. Batch actions live in a floating bottom bar; selection turns pink with ♥ pick-order badges. Color search (`color:red` / `color:红`) lands via migration 022.
  - 搜索框升级为覆盖全部筛选的查询语言（21 键中英别名、`score>=7` 比较、`score:6..8` 区间、精确分辨率、`-tag:blurry` 排除），配实时「解析为：」chip 行、? 语法帮助与库内模糊补全。批量操作在底部悬浮条；选中为粉色 + ♥ 顺序徽章。颜色搜图（`color:red` / `color:红`）经 migration 022 落地。

- **LoRA export overhaul / LoRA 导出大修**: exported captions tell the truth — per-image rating + aesthetic quality replace hardcoded `safe`/`score_5`; multi-paragraph captions flatten to one line; the trigger word persists as a real top-confidence tag; sidecar name collisions are reported not silently renamed; every export returns a trainer-consumability health report; preview renders through the exact export engine. Three opt-in tools: training-purpose filter, danbooru implication dedup, and a 🎯 trait-pruning checklist.
  - 导出标注句句属实——逐图分级 + 美学画质取代硬编码 `safe`/`score_5`；多段字幕压平单行；触发词落库为置顶真实标签；撞名如实报错；每次导出返回训练可用性体检；预览与导出同引擎。三个可选工具：训练目的过滤、蕴含去重、🎯 角色特征修剪清单。

- **camie-tagger-v2 character fix / camie 打标器角色修复**: the runtime silently read the coarse intermediate ONNX head, so characters never resolved (0/4). After the one-line fix a 29-image re-run restored WD-family quality (characters 4/4, ground-truth recall 35/52 → 48/52). Tagger model cards now state measured verdicts.
  - camie-tagger-v2 此前静默读取粗预测中间头，角色全部认不出（0/4）；一行修复后 29 张实图复测恢复 WD 系列水平（角色 4/4，真值命中 35/52 → 48/52）。打标 UI 的模型卡写明六个打标器的实测结论。

- **Sort focus mode + named presets / 排序专注模式 + 命名预设**, **censor review conveyor / 打码审核流水线**, **Smart Tag 智能一趟 landing tab**, **duplicate cleanup / 查重清理**, **background bulk jobs + persistent AI queue / 后台批量任务 + AI 队列持久化**, **Linux NVIDIA GPU tagging fix / Linux NVIDIA GPU 打标修复**, and **tag provenance (re-tagging never destroys manual tags) / 标签来源追踪（重打标不毁手动标签）**.

---

## Fixed / 修复

- **Stale "N images can't open" banner after Clear Gallery / 清空图库后「有 N 张图打不开」横幅残留**: clearing the gallery (and removing/reconnecting images) now invalidates both the backend library-health cache and the frontend banner cache, so the banner reflects the emptied library immediately instead of lingering on a pre-clear count for its 60s TTL.
  - 清空图库（以及移除/找回图片）现在会同时失效后端 library-health 缓存与前端横幅缓存，横幅立即反映清空后的状态，不再在 60 秒 TTL 内停留在清空前的旧数字。
- **UI text coverage + Simplified-Chinese purity / 界面文案补全与简体统一**: toast/button strings that silently fell back to English now have entries in both language packs; Traditional-Chinese leftovers were converted to Simplified.
  - 静默回退英文的提示/按钮文案补上双语词条；残留的繁体中文全部转换为简体。
- **Duplicate setup buttons + one-blue-per-screen tightening / 重复入口按钮与「每屏一个主蓝」收敛**: a `[hidden]`-override leak that showed two "build similarity index" buttons is fixed, and co-equal solid-blue primaries were demoted so each surface reads a single next-action blue.
  - 修复因 `[hidden]` 覆盖导致的「建立相似索引」重复按钮；并把并列的实心蓝主按钮降级，让每个界面只有一个「下一步」蓝。

---

## Upgrading / 升级注意

- Database migrations 018-024 (NL captions, activity log, reconnect reviews, color backfill, tag provenance) run automatically on first start — no manual steps, existing data untouched.
  - 数据库迁移 018-024（自然语言字幕、活动日志、找回审查、颜色回填、标签来源追踪）首次启动自动执行，无需手动操作，现有数据不受影响。
- First launch shows the new mission entry page; click any lane (or press ESC later to return). Prefer the old behavior? Settings → 跳过入口页.
  - 首次启动会看到新的任务入口页；点任意动线进入，之后按 ESC 可随时回来。想跳过它：设置 → 「跳过入口页」。
- **Back up your `data/` folder before trying a beta.** Keep your stable install; run this beta from a separate extracted folder so you can fall back instantly.
  - **试用公测版前请备份你的 `data/` 目录。** 保留稳定版，把公测版解压到另一个文件夹单独运行，随时可回退。

---

## Validation / 验证

- Full CI green: backend pytest 2537 passed / 7 skipped; Playwright e2e 211 passed; ruff, strict tsc, JS syntax, lock freshness, and dependency audit all clean.
- Real-package boot smoke: Windows portable served `/`, `/docs`, `/api` (HTTP 200) after a fresh first-run install from the built `sd-image-sorter-v3.5.0-beta.1-windows-portable.zip`.

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.5.0-beta.1-windows-portable.zip`** — extract, run `run-portable.bat`.

**Linux portable x86_64 → `sd-image-sorter-v3.5.0-beta.1-linux-portable-x86_64.tar.gz`** — extract, `chmod +x run-portable.sh`, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.5.0-beta.1-linux-portable-aarch64.tar.gz`** — for ARM Linux / Raspberry Pi 5 / Graviton.

**Linux source install → `sd-image-sorter-v3.5.0-beta.1-linux.tar.gz`** — for users with their own Python 3.12+ environment.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.5.0-beta.1-app-patch.zip` — in-app updater payload only / 仅供更新器
- `sd-image-sorter-v3.5.0-beta.1-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums (SHA256)

| Asset | SHA256 |
|---|---|
| `windows-portable.zip` | `c3e11c7d04f947e7ced0559dda70db723a4c48e59b9bf8589f25a270c8be8d5c` |
| `app-patch.zip` | `4da552929a1521201f0b16d826afc4f8a142e1c689643f99ea7091d8991c2c3d` |
| `linux.tar.gz` | `29b085e908300443f0c4587d5c60e6f825e5b91df44f85705f7dcb31fca450b8` |
| `linux-portable-x86_64.tar.gz` | `1da6700840a496c511e9648419412e63517a6dc5bf029cb965d82ea66ca16a93` |
| `linux-portable-aarch64.tar.gz` | `e0dfb2fbf1763ad2586614797b856f941839d50a2dd60bf6db330c619d855533` |

(Also machine-readable in `sd-image-sorter-v3.5.0-beta.1-release-manifest.json`.)
