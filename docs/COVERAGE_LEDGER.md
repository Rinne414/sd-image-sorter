# Click-Coverage Ledger（覆蓋帳本）

QA sweep Phase 2：把「每個按鈕都被測過嗎」這半邊的巡檢機械化。人工 sweep 只需要判讀增量，不再手點全表面。

## 元件

| 檔案 | 角色 |
|---|---|
| `tests/e2e/fixtures/control-key.js` | 控件身分函数 `window.__controlKey(el)` / `window.__controlContext()` — ledger 与 inventory 共用同一份，diff 才精确 |
| `tests/e2e/fixtures/click-ledger.ts` | 扩展版 `test`（所有 spec 都从这里 import）。capture-phase click listener + `exposeBinding`（跨 navigation 存活）→ 每测试点击流写入 `artifacts/click-coverage/raw-*.jsonl` |
| `tests/e2e/fixtures/global-setup.ts` | 每次 Playwright 运行前清空 click-coverage artifacts（防跨 run 混算） |
| `tests/e2e/specs/zz-coverage-crawl.spec.ts` | ①走遍所有 view 快照全部控件 → `artifacts/control-inventory.json`；②机械点击每个安全按钮（含点开的 modal 一层），断言 0 console error / 0 未捕获异常 / 0 4xx-5xx；③V8 JS coverage → `artifacts/js-coverage-unused.json`（advisory） |
| `scripts/coverage_gate.py` | 合并 ledger + inventory → `artifacts/click-coverage.json` + `artifacts/untested-controls.json`；对 `tests/e2e/coverage-baseline.json` 做棘轮（ratchet）判定 |
| `tests/e2e/coverage-baseline.json` | 提交入库的底线 `min_click_coverage_pct`（只许升不许降）+ waiver regex 列表（每条要写理由） |

`scripts/run_ci.py` 在 playwright e2e 之后新增 `click coverage gate` 步骤。

## 语义

- **coverage** = 全套件实际点击到的控件（∪ waivers）÷ crawl 盘点到的控件总数。
- **untested-controls.json** 按 context（view / modal）分组列出没有任何测试点过的控件 — 这就是下一轮补测试的工作清单。
- crawl 的 **denylist**（`DENY_PATTERNS`）挡掉有外部副作用的按钮：破坏性操作、后台长任务/模型下载、文件系统写入、会话状态流。这些按钮算在 inventory 里（除非 waiver），所以覆盖率天然到不了 100% — 用 waiver 明示豁免，不要偷偷调高 denylist。

## 常用操作

```bash
# 局部跑（没跑 crawl 时 gate 直接跳过）
python scripts/coverage_gate.py --allow-missing

# 全量（run_ci 自动含 gate）
python scripts/run_ci.py

# 只看未测清单
python -c "import json;d=json.load(open('artifacts/untested-controls.json',encoding='utf-8'));print(d['count']);[print(k,len(v)) for k,v in d['by_context'].items()]"
```

覆盖率明显高于底线时 gate 会提示上调 `min_click_coverage_pct` — 提交那次上调就是棘轮的一格。

## 已知限制（v1）

- 入口页（entry overlay）默认被 e2e storageState 跳过，不在 crawl 范围内。
- JS coverage 只统计 crawl 那一条会话，不是全套件合并（handoff 提的 monocart 合并版留待需要时再上）。
- 关闭页面早于 teardown 的 page 不贡献点击（exposeBinding 已把主要流量收齐）。
