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

GitHub CI run 40535707003 (Linux full suite with browser tests and click coverage, macOS, Windows, Linux portable x86_64 and aarch64): 5 of 5 green; backend 9,208 passed; browser tests 1,976 passed, 0 failed, 0 flaky; V Opus unit tests 1,183 passed. The three new gallery tests fail on 3.9.1's code and pass now. On a fresh 3.9.2 Windows package with 150 pictures scanned into the Library: a refresh in place held for two seconds showed "Updating the gallery…" on the disabled Load More button and gave it back afterwards; reading deep, the picture being read and ten above it were removed from the gallery (files kept), and after the refresh the next picture sat exactly where the reader's had been. No console errors.
  - GitHub CI（40535707003：Linux 完整测试含浏览器测试和点击覆盖、macOS、Windows、Linux 便携版 x86_64 与 aarch64）5 项全部通过；后端 9,208 通过；浏览器测试 1,976 通过、0 失败、0 个偶发；V Opus 单元测试 1,183 通过。三个新的图库测试在 3.9.1 的代码上失败、现在通过。在全新的 3.9.2 Windows 包里把 150 张图扫描进图库：原地刷新被拖住两秒时，“加载更多”按钮变成不可点的“正在更新图库…”，刷新后恢复；往下看到深处后，把正在看的图和上面十张从图库移除（文件保留），刷新后紧接着的那张正好停在原来那张的位置。没有控制台错误。

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

| Asset | SHA-256 |
|---|---|
| `sd-image-sorter-v3.9.2-windows-portable.zip` | `685f08a0bbc4c3222402b50784fa99b6963bc1217075fed83d19506ab4c2b406` |
| `sd-image-sorter-v3.9.2-app-patch.zip` | `c1f5fdbe68d9c698544ffc502354c2f7cfe18fbaecfcc8a81aa8f99148589941` |
| `sd-image-sorter-v3.9.2-linux.tar.gz` | `de11ee6ae57ececa173e233f10b22eddfd6e292a3bc6a1e18a6009e8e5983bff` |
| `sd-image-sorter-v3.9.2-linux-portable-x86_64.tar.gz` | `84af04c3d39078c719cf685e0041cebbe8ca4bddac39460e79c83827eedf0501` |
| `sd-image-sorter-v3.9.2-linux-portable-aarch64.tar.gz` | `b92855b4bbc3fb347bb5361b1313aa855f17d019e9a2d38ff8936db33abff318` |
| `sd-image-sorter-v3.9.2-release-manifest.json` | `31c8830dd05be325d45742b8fc8a1de656c7ab80ba4673b79421791fff0407b4` |

The manifest contains the five archive checksums; its own checksum is recorded above. / manifest 内含五个归档校验和，其自身校验和记录于上表。
