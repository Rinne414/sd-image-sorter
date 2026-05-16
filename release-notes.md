## v3.2.0 — UI Layout & Generator Classification / 介面排版與生成器分類

This release polishes the navigation layout, separates the global Setup utility from the destructive Clear Gallery action, adds a real "Others" category for SD images whose generator string the parser does not recognize but that still carry valid metadata, brings back the count-first scan progress so ETA is visible from the start, ships a "Save next to each image" sidecar export mode for libraries spread across many subfolders, and stops mislabeled JPEG/`.png` files from being flagged as "unreadable".

這版改善了主介面排版，把全域用的 Setup 入口與只影響當前 gallery 的破壞性 Clear Gallery 按鈕分開，新增真正的 "Others" 分類，掃描進度恢復到一開始就能看到精確總數和 ETA，批量導出 sidecar 多了"存到每張圖所在的資料夾"模式（適合圖庫分散在多個子資料夾），並修正了 JPEG 用 `.png` 副檔名時被誤判為損壞的問題。

---

## Added / 新增

- **Batch Tag Export: "Save next to each image" mode** — A new segmented control above "Output Folder" lets you write each `.txt` / `.json` into the same folder as its source image instead of collapsing everything into a single output folder. Best when your library spans many subfolders or feeds a per-folder training tool that expects `foo.png` + `foo.txt` to sit together. UI defaults to this mode; the legacy "Save to one folder" option is still there.
  - **批量打標導出新增「存到每張圖所在的資料夾」模式** — 「輸出文件夾」上方多了一組單選，可以把每個 `.txt` / `.json` 寫到對應來源圖的同一個資料夾，不再強迫所有 sidecar 擠到單一輸出資料夾。圖庫散在多個子資料夾、或下游訓練工具要 `foo.png` + `foo.txt` 同位的情境特別適合。UI 預設就是這個模式；想用舊的「統一存到一個資料夾」也還在。

- **Auto-Separate / Manual Sort default to "copy"** — Both batch sorting flows now default to "Copy and keep originals" out of the box. The Move radio is still right next to it, and your last choice is remembered for next time, but new users will not move thousands of files in a single click before they understand what the radio does.
  - **Auto-Separate / Manual Sort 預設改為「複製」** — 兩套批量分類流程的預設都改成「複製並保留原圖」，移動的單選還在旁邊，上次的選擇會記住。第一次用的人不會在還沒看清楚單選按鈕之前一鍵搬走幾千個檔案。

---

## Changed / 變更

- **Setup moved to the nav bar**: The global "Setup" button now lives in the top nav bar instead of inside the gallery toolbar, so it is reachable from any view (Reader, Censor, Sorting, Library Health, etc.).
  - **Setup 移到主導航**：全域用的 "Setup" 按鈕現在固定在最上方導航列，從 Reader、Censor、Sorting、Library Health 等任何頁面都可以直接打開，不再藏在 Gallery 工具列裡。

- **Clear Gallery moved to the gallery toolbar**: The destructive "Clear Gallery" action moved out of the global nav bar and into the gallery toolbar, where it actually belongs. This makes the destructive scope visible: it only affects the gallery you are currently viewing.
  - **Clear Gallery 移到 Gallery 工具列**：破壞性的 "Clear Gallery" 按鈕從全域導航列移到 Gallery 自己的工具列，讓「這顆按鈕只影響目前 gallery」這件事在 UI 上看得出來，避免從其他頁面誤點。

- **Setup is now reachable from the mobile menu**: A "Setup" entry was added to the mobile navigation panel.
  - **手機選單新增 Setup 入口**：手機版選單裡也能直接打開 Setup（之前只有桌面版有）。

- **Generator filter and tab list now expose "Others"**: Gallery generator tabs, the filter modal, and gallery counts now include an "Others" category alongside ComfyUI / NovelAI / WebUI / Forge / Unknown.
  - **Generator 分類與篩選新增 "Others"**：Gallery 上方分類列、篩選彈窗的 generator 勾選與計數，現在多了 "Others" 一欄，跟 ComfyUI / NovelAI / WebUI / Forge / Unknown 並列。

- **Default scan brings back the count-first pass**: Scan progress now walks the folder once for a precise total (typically 1–2 seconds for ~50 K files on a local SSD), then runs the import + metadata pipeline with a real `current/total` denominator. The phase order is `Counting images... → Found N images → Importing X/N`, so ETA is visible from the very first heartbeat. v3.1.6's single-pass mode broke the progress UI on large libraries; this restores the older behaviour.
  - **預設掃描恢復「先點數再導入」兩階段**：掃描進度會先走一遍資料夾算出精確總數（本機 SSD 上 5 萬張圖大約 1–2 秒），再跑導入與 metadata 流程，每次心跳都會顯示真正的 `current/total`。順序是 `正在計算圖片數量... → 找到 N 張 → 導入 X/N`，從第一個心跳開始就能估時間。v3.1.6 的 single-pass 模式讓大型圖庫的進度看起來像壞掉，這版改回原本的行為。

---

## Fixed / 修復

- **JPEG / WEBP / GIF files saved with `.png` extension now import**: Civitai, Discord, browsers, and other content-management tools regularly save JPEGs with a `.png` extension. They render fine in browsers and Windows Explorer because those programs sniff format from content, but until this release the parser strict-trusted the extension and reported these images as "unreadable" — sometimes hundreds at a time per scan. The parser now falls through to the content-sniff path when the PNG magic-bytes check fails, so mislabeled JPEG/WEBP/GIF files import as their actual format. Genuine PNG corruption still surfaces as a parse error.
  - **`.png` 後綴但實際是 JPEG / WEBP / GIF 的圖片不再被報為不可讀**：Civitai、Discord、瀏覽器等工具經常把 JPEG 用 `.png` 副檔名儲存，瀏覽器和 Windows 資源管理器看內容魔術字節就能正常顯示，但本版本之前 metadata 解析器只信副檔名，看到首 8 位元組不是 PNG 就直接報「不可讀」——一次掃描有時會被這樣藏掉幾百張。現在 PNG 快速路徑校驗失敗時會回退到內容嗅探路徑，被改錯副檔名的 JPEG / WEBP / GIF 就能照實際格式正常導入。真正的 PNG 損壞仍然會按錯誤處理。

- **Dataset Audit panel layout fixed**: The "Health Score" label inside the Dataset Audit (Setup → Dataset Audit) was being pushed completely outside the inner dark donut hole and onto the conic-gradient ring, where it was nearly unreadable. The "Read-only library audit" eyebrow heading was also a tiny uppercase label that visually disappeared. The score ring now uses a clean flex column with sane font sizes; the eyebrow is rendered as the actual section heading; and opening the audit details auto-scrolls so the eyebrow is always visible.
  - **資料集體檢面板排版修復**：體檢裡的分數環之前會把「健康評分」標籤擠出內圈深色甜甜圈，落在外層漸變圈上幾乎看不清；「只讀圖庫體檢」這行 eyebrow 也被做成很小的大寫字幾乎看不到。現在分數環改用正常的 flex 縱向排列、字號合理；eyebrow 改成真正的小標題；展開體檢時還會自動把整段頂端滾到可見位置。

- **Metadata parser no longer silently buckets recognizable images into "Unknown"**: When a PNG/JPEG carries a real prompt, negative prompt, checkpoint, or LoRA list, but the generator name is not one of the known tools, the image is now classified as `others` instead of `unknown`. WebP files that go through the WebP-specific path are also reclassified the same way.
  - **Metadata parser 不再把有 metadata 的圖默默歸成 "Unknown"**：當 PNG / JPEG 帶有真實 prompt、negative prompt、checkpoint 或 LoRA，但 generator 字串不在 ComfyUI / NovelAI / WebUI / Forge 列表內時，現在會歸到 `others`，而不是繼續混進 `unknown`。WebP 檔案走專屬的 WebP 解析路徑時也會同樣重新分類。

- **Fresh Windows portable: ONNX Runtime / SAM3 first-launch installs are robust**: On a brand-new portable extract, both the ONNX Runtime auto-install (used by WD14 / NudeNet / CLIP) and the CUDA torch auto-install (required by SAM3) had failure modes that left the user stuck. Both are now fixed and locked with regression tests. See CHANGELOG for details.
  - **Windows portable 首次啟動 ONNX Runtime / SAM3 自動安裝不再卡住**：剛解壓的新 portable 中，ONNX Runtime 自動安裝（WD14 / NudeNet / CLIP 共用）和 CUDA torch 自動安裝（SAM3 必需）原本各有一條會把使用者卡住的失敗路徑。兩條都修了，加上回歸測試鎖住新行為，詳見 CHANGELOG。

---

## Notes / 備註

- This release does not change save/overwrite semantics, scan/import flow, manual sort session storage, or model packaging. It is a UI polish + classifier fix + safer-default release.
  - 這版沒有改保存/覆蓋語意、掃描/匯入流程、Manual Sort session 儲存或模型打包，是介面 + 分類器修正 + 更安全的預設值版本。

- **Windows portable zip pre-installs the GPU runtime**: As with v3.1.6, NVIDIA `onnxruntime-gpu==1.21.0` plus the matching CUDA 12 runtime wheels are already shipped inside the Windows portable zip's embedded `python\Lib\site-packages`. Supported NVIDIA machines do not have to re-download CUDA / cuDNN on first launch; AMD/Intel and CPU-only paths still go through the same hardware-gated repair as v3.1.6.
  - **Windows portable zip 已預裝 NVIDIA GPU runtime**：如同 v3.1.6，NVIDIA `onnxruntime-gpu==1.21.0` 與對應的 CUDA 12 runtime wheel 已經內建在 Windows portable zip 的 `python\Lib\site-packages` 裡。被支援的 NVIDIA 機器第一次啟動不會再重新下載 CUDA / cuDNN；AMD / Intel 與純 CPU 機器仍然走 v3.1.6 已經導入的硬體 gating 修復路徑。

---

## Upgrading / 升級注意

- No database migration needed. This is a drop-in replacement for v3.1.6.
  - 不需要資料庫遷移。可以直接替換 v3.1.6。

- After upgrading, existing rows whose generator is still `unknown` keep that value. New scans, reparses, and clipboard / Reader uploads will use the new `others` classification when appropriate.
  - 升級後，已經被歸到 `unknown` 的舊 row 會保留 `unknown` 值。重新掃描、reparse、Reader 與剪貼簿上傳的新圖會在合適情況下使用新的 `others` 分類。

---

## ⬇️ Which file should I download? / 我該下載哪一個？

**Windows → windows-portable.zip** — extract, run `run-portable.bat`
**Linux → linux.tar.gz** — extract, run `./run.sh`

**Do NOT download / 不要下載：**
- app-patch.zip — in-app updater only / 僅供更新器
- release-manifest.json — updater metadata / 更新器元資料

---

## Checksums

See `release-manifest.json` for SHA-256 checksums of all assets.
