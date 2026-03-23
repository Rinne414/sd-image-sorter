# Unfinished / Follow-up

日期：2026-03-23

## 本日已完成
- 補強 ComfyUI / NAI metadata parser
- 新增單張 metadata reparse API
- 整理 thumbnail pipeline
- 重做 preview modal（image-first + async hydrate + copy actions）
- 新增 Favorites MVP（backend + frontend）
- 新增 Gallery `Grid / Large / Waterfall` view mode
- 補上 backend 測試並確認通過
- 完成本機 smoke test
- 已停止背景 FastAPI 測試 server

## 尚未完成 / 建議後續處理

### 1. mypy 清理
目前 backend `mypy` 仍失敗，屬於既有型別債，不是這次功能唯一引入。

現況摘要：
- `152 errors in 17 files`
- 這次修改直接相關的檔案仍有 typing 改善空間：
  - `backend/utils/path_validation.py`
  - `backend/database.py`
  - `backend/metadata_parser.py`
  - `backend/image_manager.py`
- 另外還有多個既有模組與第三方 stub 缺失：
  - `fastembed`
  - `nudenet`
  - `onnxruntime`
  - `sam3.*`
  - `modelscope`
  - `requests`

### 2. 前端自動化測試不足
目前已做 smoke test，但還沒有完整自動化覆蓋以下流程：
- Favorites add / remove / favorites-only filter
- Preview modal copy actions
- Waterfall / Grid / Large 切換
- Reparse 後 modal refresh

### 3. Waterfall 模式仍可再 polish
目前功能可用，但仍可進一步改善：
- empty state 呈現一致性
- 大圖庫下的效能優化
- 與 virtual gallery 更完整整合

### 4. Release / 文件同步
若要正式發版為 `2.0`，建議後續同步：
- README changelog / feature summary
- 正式 release notes
- 版本命名與對外描述
