## v3.2.0 — UI Layout & Generator Classification / 介面排版與生成器分類

This release polishes the navigation layout, separates the global Setup utility from the destructive Clear Gallery action, and adds a real "Others" category for SD images whose generator string the parser does not recognize but that still carry valid metadata.

這版改善了主介面排版，把全域用的 Setup 入口與只影響當前 gallery 的破壞性 Clear Gallery 按鈕分開，並為「有 metadata 但 generator 字串不是 ComfyUI / NovelAI / WebUI / Forge」的圖片新增真正的 "Others" 分類，而不是繼續塞進 Unknown。

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

---

## Fixed / 修復

- **Metadata parser no longer silently buckets recognizable images into "Unknown"**: When a PNG/JPEG carries a real prompt, negative prompt, checkpoint, or LoRA list, but the generator name is not one of the known tools, the image is now classified as `others` instead of `unknown`. WebP files that go through the WebP-specific path are also reclassified the same way.
  - **Metadata parser 不再把有 metadata 的圖默默歸成 "Unknown"**：當 PNG / JPEG 帶有真實 prompt、negative prompt、checkpoint 或 LoRA，但 generator 字串不在 ComfyUI / NovelAI / WebUI / Forge 列表內時，現在會歸到 `others`，而不是繼續混進 `unknown`。WebP 檔案走專屬的 WebP 解析路徑時也會同樣重新分類。

---

## Notes / 備註

- This release does not change save/overwrite semantics, scan/import flow, manual sort session storage, or model packaging. It is a UI polish + classifier fix release.
  - 這版沒有改保存/覆蓋語意、掃描/匯入流程、Manual Sort session 儲存或模型打包，是介面 + 分類器的改善版。

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
