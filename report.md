# SD Image Sorter — 開發報告

## 概述

本報告涵蓋了 SD Image Sorter 在此次開發週期中所有已完成的工作、遇到的問題與解決方案，以及軟體目前的狀態與剩餘工作。

---

## 一、已完成的工作

### 任務 #1：建立 CLAUDE.md 專案說明文件
- **狀態：** ✅ 完成
- 建立了完整的專案架構說明、技術棧、啟動方式、API 端點列表，以及開發注意事項。

### 任務 #2：修復 Prompt/Metadata 讀取器
- **狀態：** ✅ 完成
- **問題：** 原本的 `metadata_parser.py` 僅有約 194 行，對於部分圖片格式（JPEG、WebP EXIF、NAI V4+）無法正確辨識生成器。
- **解決方案：** 大幅重寫為 ~1052 行，新增：
  - 圖形化 ComfyUI 節點遍歷（追蹤 KSampler → positive/negative prompt 的連線）
  - NovelAI V4+ EXIF UserComment 解析
  - JPEG SD metadata 提取
  - WebP EXIF IFD 提取
  - 支援 20+ 種 ComfyUI 節點類型（文字串接、ConditioningCombine、ControlNet 直通等）
  - 優先順序偵測：WebUI/Forge → NAI EXIF → NAI Comment → ComfyUI prompt → workflow → EXIF fallback

### 任務 #3：改善 ComfyUI 複雜工作流程解析
- **狀態：** ✅ 完成
- **問題：** 原本只做簡單的 JSON 搜尋，無法處理多節點串聯的 ComfyUI 工作流程。
- **解決方案：** 實作了 `_trace_sampler_prompts()` 方法，使用圖形遍歷演算法追蹤 KSampler 的 positive/negative 連線到文字來源節點。

### 任務 #4：升級審查偵測系統 — SAM3 + YOLO26 + NudeNet
- **狀態：** ✅ 完成
- **遇到的問題與解決方案：**

  | 問題 | 解決方案 |
  |------|---------|
  | 一開始誤用 SAM2.1 和 YOLO11（過時版本） | 使用者糾正後，全部改為 SAM3 和 YOLO26 |
  | 在 `routers/censor.py` 新增 3 個端點時，Edit 工具的 `old_string` 同時匹配到 `/save` 和 `/save-data` 兩個端點的錯誤處理區塊，導致編輯失敗 | 選用包含 `png_kwargs` 變數的更長、更唯一的上下文字串來精確定位 `/save-data` 端點 |

- **新增檔案：**
  - `backend/yolo26_detector.py`（194 行）— YOLO26 偵測器封裝
  - `backend/nudenet_detector.py`（186 行）— NudeNet v3 封裝
  - `backend/sam3_refiner.py`（256 行）— SAM3 遮罩精修
- **新增 API 端點：**
  - `POST /api/censor/detect` — 支援 `model_type` 參數（yolo26/nudenet/both/legacy）
  - `POST /api/censor/refine-mask` — SAM3 邊界框轉精確遮罩
  - `POST /api/censor/segment-text` — SAM3 開放詞彙文字分割
  - `GET /api/censor/models` — 列出可用的偵測後端

### 任務 #5：跳過 LSNet
- **狀態：** ✅ 完成（確認不適用後跳過）

### 任務 #6：圖片相似度搜尋
- **狀態：** ✅ 完成
- **新增檔案：**
  - `backend/similarity.py`（339 行）— FastEmbed CLIP 嵌入向量
  - `backend/routers/similarity.py`（118 行）— 相似度搜尋 API
- **功能：**
  - 使用 FastEmbed 產生 512 維 CLIP 嵌入向量
  - 嵌入向量存於 SQLite 的 BLOB 欄位（每張圖 2048 bytes）
  - 支援以圖片 ID 搜尋、上傳圖片搜尋、重複圖片偵測
  - 後台批次嵌入任務支援

### 任務 #7：探索專案架構
- **狀態：** ✅ 完成

### 任務 #8：智慧標籤分類與隨機 Prompt 產生器
- **狀態：** ✅ 完成
- **新增檔案：**
  - `backend/tag_rules.py`（566 行）— 300+ 預分類標籤、12 個類別、10 組服裝套組、6 條排除規則、加權隨機群組
  - `backend/prompt_generator.py`（512 行）— 10 步分層 Prompt 產生器
  - `backend/routers/prompts.py`（356 行）— 14 個 CRUD + 產生端點
- **資料庫：**
  - 新增 7 個資料表：`tag_categories`、`tag_sets`、`tag_set_members`、`tag_exclusions`、`tag_exclusion_conditions`、`tag_exclusion_targets`、`prompt_presets`

### 任務 #9：主要 UI 重新設計
- **狀態：** ⚠️ 大部分完成（詳見「剩餘工作」）

#### 已完成的 UI 子任務：

**Similar 標籤頁（任務 #11）✅**
- 建立 `frontend/js/similar.js`（311 行）
- HTML 區段已加入 `index.html`
- 功能：嵌入向量管理、以 ID 搜尋、上傳搜尋、重複偵測、結果渲染

**Prompt Lab 標籤頁（任務 #12）✅**
- 建立 `frontend/js/prompt-lab.js`（579 行）
- HTML 區段已加入 `index.html`
- 功能：類別瀏覽器、插槽式建構器、鎖定/解鎖、權重滑桿、衝突偵測、預設管理

**增強版手動排序（任務 #10）⚠️ 部分完成**
- 新增追蹤狀態：sortedCount、skippedCount、startTime、actionTimestamps
- ESC 鍵退出排序
- 增強進度條：百分比、已排序/跳過/剩餘計數、滾動速度計算
- 分段式進度條（綠色=已排序、橘色=已跳過）
- 結束訊息顯示詳細統計：「42 sorted, 8 skipped in 3m 15s」
- ❌ **未完成：** 迷你地圖畫布/影片帶 UI（可點擊跳轉功能）

**虛擬捲動相簿（任務 #14）✅**
- 建立 `frontend/js/virtual-gallery.js`（317 行）
- 僅渲染可見行，使用絕對定位
- ResizeObserver 響應式欄位計算
- requestAnimationFrame 節流捲動處理
- 透明覆寫 `Gallery.setImages()` 和 `Gallery.render()`

**CSS 組織（任務 #13）⚠️ 部分完成**
- 建立 `frontend/css/new-views.css`（874 行）— 新視圖樣式
- 為 `styles.css` 新增目錄索引
- ❌ **未完成：** 未按計劃拆分為 variables.css / layout.css / components.css 等獨立檔案

---

## 二、遇到的問題與解決方案

### 問題 1：SAM 和 YOLO 版本錯誤
- **描述：** 訓練資料截止日期導致初始使用了 SAM2.1 和 YOLO11 而非最新的 SAM3 和 YOLO26。
- **使用者回饋：**「Wait, Bruh, why you use SAM2.1 and YOLO11???? I told you to use SAM3 and YOLO26. THEY ARE EXIST」
- **解決方案：** 透過網路搜尋確認 SAM3 和 YOLO26 確實存在，然後：
  - 將所有後端檔案更新為使用 SAM3（`from sam3.build_sam import build_sam3_image_model`）
  - 將 YOLO 偵測器更新為 YOLO26（`ultralytics>=8.4.0`、`YOLO("yolo26n-seg.pt")`）
  - 更新 PLAN.md 中所有 SAM2.1/YOLO11 的引用為 SAM3/YOLO26

### 問題 2：censor.py 端點新增失敗
- **描述：** 需要在 `routers/censor.py` 的結尾新增 3 個端點，但 Edit 工具要求 `old_string` 必須是唯一的。初次嘗試使用的字串 `except Exception as e: raise HTTPException(status_code=500, detail=f"Save failed: {str(e)}")` 同時匹配到 `/save` 和 `/save-data` 兩個端點。
- **解決方案：** 使用更長的上下文字串，包含 `png_kwargs` 變數宣告（僅存在於 `/save-data` 端點），成功定位並新增了 3 個新端點。

### 問題 3：Context Window 用盡
- **描述：** 由於專案規模龐大（3389 行 CSS + 1932 行 app.js + 多個新模組），對話上下文在完成所有任務前耗盡，需要在新的 Session 中繼續。
- **解決方案：** 使用 Context Summary 功能記錄所有已完成的工作和待辦事項，在新 Session 中無縫銜接。

### 問題 4：CSS 檔案過大
- **描述：** `styles.css` 已有 3389 行，`new-views.css` 也達到 874 行（超過建議的 800 行上限）。
- **解決方案：** 目前只新增了目錄索引做為臨時措施。完整的 CSS 拆分（Phase 5）列為未來工作。

---

## 三、軟體目前狀態

### 檔案統計

| 類別 | 新增檔案 | 修改檔案 | 新增程式碼行數 |
|------|---------|---------|--------------|
| 後端（Python） | 8 個 | 4 個 | ~2,527 行 |
| 前端（JS） | 3 個 | 2 個 | ~1,207 行 |
| 前端（CSS） | 1 個 | 1 個 | ~874 行 |
| 合計 | 12 個 | 7 個 | ~4,608 行 |

### 後端新增模組

| 檔案 | 行數 | 功能 |
|------|------|------|
| `yolo26_detector.py` | 194 | YOLO26 偵測器（NMS-free 雙頭架構） |
| `nudenet_detector.py` | 186 | NudeNet v3 人體部位偵測（20 類別） |
| `sam3_refiner.py` | 256 | SAM3 遮罩精修（文字引導分割） |
| `similarity.py` | 339 | FastEmbed CLIP 圖片嵌入向量 |
| `prompt_generator.py` | 512 | 10 步分層隨機 Prompt 產生器 |
| `tag_rules.py` | 566 | 300+ 標籤分類規則 + 排除規則 |
| `routers/similarity.py` | 118 | 6 個相似度搜尋 API 端點 |
| `routers/prompts.py` | 356 | 14 個 Prompt 管理 API 端點 |

### 前端新增模組

| 檔案 | 行數 | 功能 |
|------|------|------|
| `js/virtual-gallery.js` | 317 | 虛擬捲動引擎（僅渲染可見行） |
| `js/similar.js` | 311 | 相似圖片搜尋 UI |
| `js/prompt-lab.js` | 579 | Prompt 實驗室 UI |
| `css/new-views.css` | 874 | 新視圖樣式 |

### 新增 API 端點總覽

| 路由前綴 | 端點數量 | 主要功能 |
|---------|---------|---------|
| `/api/censor/` | 4 個新端點 | 多模型偵測、SAM3 遮罩精修、文字分割、模型列表 |
| `/api/similarity/` | 6 個端點 | 嵌入向量、進度查詢、相似搜尋、上傳搜尋、重複偵測、統計 |
| `/api/prompts/` | 14 個端點 | 類別 CRUD、標籤組 CRUD、排除規則 CRUD、隨機產生、驗證、預設管理 |

### 資料庫變更

- `images` 資料表新增 `embedding BLOB` 欄位
- 新增 7 個資料表用於標籤分類、標籤組、排除規則、Prompt 預設
- 所有變更透過 `database.init_db()` 自動遷移

### 導覽標籤

```
原本：Gallery | Auto-Separate | Manual Sort | Censored Edit
現在：Gallery | Auto-Separate | Manual Sort | Censored Edit | Similar | Prompt Lab
```

---

## 四、剩餘工作

### 高優先級

| 項目 | 描述 | 難度 |
|------|------|------|
| 審查編輯器前端升級 | `censor-edit.js` 尚未更新以使用新的多模型選擇介面和 SAM3 精修功能 | 中 |
| 手動排序迷你地圖 | 計劃中的像素級迷你地圖（可點擊跳轉）尚未實作 | 中 |
| CSS 完整拆分 | 將 3389 行的 `styles.css` 拆分為 variables.css / layout.css / components.css / gallery.css / sort.css 等模組化檔案 | 中 |

### 中優先級

| 項目 | 描述 |
|------|------|
| 審查佇列最佳化 | 使用 CSS `order` 屬性替代 DOM 重排，佇列 >50 項時啟用虛擬捲動 |
| 鍵盤快捷鍵說明 | 按 `?` 鍵顯示快捷鍵覆蓋層 |
| 骨架載入畫面 | 取代空白區域的 Loading 狀態 |
| 圖片資訊覆蓋層 | 滑鼠懸停在縮圖上顯示 prompt/生成器/尺寸 |
| 深色/淺色主題切換 | CSS 自訂屬性切換 |

### 低優先級

| 項目 | 描述 |
|------|------|
| 響應式 CSS 完善 | 平板/手機尺寸的媒體查詢 |
| Toast 改進 | 堆疊多個 Toast、帶進度的自動關閉 |
| 側邊欄收合 | 可收合的相簿側邊欄以獲得更多畫布空間 |

---

## 五、Git 狀態

目前所有變更尚未提交（9 個修改檔案 + 12 個未追蹤檔案）。建議：

1. 檢視所有變更確認無誤
2. 分階段提交：
   - 第一次提交：後端新模組（yolo26、nudenet、sam3、similarity、prompt_generator、tag_rules）
   - 第二次提交：新路由與資料庫更新
   - 第三次提交：前端新模組與 UI 變更
   - 第四次提交：metadata_parser 改進
3. 測試所有新功能
4. 安裝新依賴：`pip install fastembed>=0.4.0 nudenet>=3.0.0 ultralytics>=8.4.0`

---

## 六、技術備註

### SAM3 安裝注意事項
SAM3 為可選安裝，需要：
- Python 3.12+
- PyTorch 2.7+
- CUDA 12.6+
- `git clone https://github.com/facebookresearch/sam3.git && pip install -e .`
- 若未安裝，系統會優雅降級為邊界框審查

### YOLO26 確認
已透過搜尋確認 YOLO26 為 Ultralytics 最新正式版本：
- PyPI 版本 8.4.24（2026-03-19 發布）
- 官方文件：https://docs.ultralytics.com/models/yolo26/
- 支援偵測、分割、姿態、旋轉邊界框、分類
- NMS-free 端到端推論，CPU 推論速度提升 43%

---

*報告產生日期：2026-03-21*
