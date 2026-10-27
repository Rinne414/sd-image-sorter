## v3.9.2 — 图库刷新提示 + 停在原处 / Refresh Notice + Keeps Your Place

图库原地刷新较久时会提示；你看的图被删掉时，由紧接着的那张接替，不再跳走。

Long gallery refreshes say so; if your picture is deleted, the next one takes its place.

---

## Fixed / 修复

- **Long gallery refreshes say so / 图库刷新较久时会提示**: When a job finishes (tagging, scoring, captions) or pictures leave the results, the gallery reloads every page you scrolled through in place, and Load More waits meanwhile. It used to wait without a word; after a moment the Load More row now says "Updating the gallery…" and gives the button back when the refresh lands.
  - 任务完成（打标、评分、caption）或有图离开结果时，图库会原地重新载入你看过的每一页，期间“加载更多”会等待。以前它不声不响地等；现在稍过片刻，“加载更多”那一行会显示“正在更新图库…”，刷新完成后按钮恢复可用。
- **Your place survives a deleted selection / 删掉一批图后仍停在原处**: When the picture you were reading left the results together with pictures above it (a deleted selection, a move out of the Library), the gallery kept its scroll offset and landed rows further on. The picture right after yours now takes its place, else the nearest one before it.
  - 你正在看的图和它上面的一些图一起离开结果时（删除了一批图、移出图库），图库以前只保持滚动位置，结果会落到好几行之后。现在由紧接在后面的那张图接替它的位置，没有的话就是前面最近的一张。

---

## Upgrading / 升级注意

- Nothing to do.
  - 无需操作。

---

## Validation / 验证

VALIDATION_PENDING

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.9.2-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.9.2-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.9.2-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.9.2-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.9.2-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.9.2-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

CHECKSUMS_PENDING
