## v3.10.0 — V Opus 补齐经典功能 / V Opus Has Every Classic Feature

V Opus 与新界面补齐全部经典功能：画风地图、视频、GIF/视频打码、收集等。

V Opus and the new interface have every classic feature: Style Map, video, collect and more.

---

## Fixed / 修复

- **Style Map in V Opus / V Opus 有了画风地图**: The 3D map of your pictures' styles is a V Opus tool now: build the index for CLIP, CSD or Kaloscope as a job you can pause, turn and zoom the map, find a picture and its nearest ones, read what the axes mean, pick dots with a box or a lasso and send them to a batch, the censor step, a dataset or the Library, and lay the map out along your own axes. The picture window has a Style Map button.
  - 图片画风的三维地图成了 V Opus 的工具：可为 CLIP、CSD 或 Kaloscope 建立索引（任务可暂停），旋转缩放地图，找图和找最像的图，看坐标轴的含义，用框选或套索选点并发送到批次、打码、数据集或图库，还能按你自己的轴重新排布。看图窗口也有“画风地图”按钮。
- **Videos in V Opus / V Opus 支持视频**: An All / Pictures / Videos filter, a play mark and length on every tile, hover to play and scrub, playback in the big view with loop, sound and frame steps, and the video support install with its progress and every failure said in words. Actions that only work on pictures are shown off for a video with the reason, and a mixed pick acts on the pictures and says how many videos were left out.
  - “全部 / 图片 / 视频”筛选，每个缩略图都有播放标记和时长，悬停即播放并可拖动进度，大图里播放支持循环、声音和逐帧，视频支持的安装有进度，每种失败都有说明。只适用于图片的操作对视频会灰掉并说明原因；混合选择时只处理图片，并说明跳过了几个视频。
- **Censor GIFs and videos in V Opus / V Opus 可给 GIF 和视频打码**: The library's Censor sends GIFs and videos to a GIF and video censor that runs as a job (Stop, progress, honest results, picked up again after a reload); pictures still go to the censor step. Video censoring now uses the same ffmpeg as video support, so it is never downloaded twice (classic too).
  - 图库的“打码”会把 GIF 和视频交给 GIF/视频打码，以任务形式运行（可停止、有进度、结果如实，刷新页面后会接上）；图片照旧进入打码步骤。视频打码现在和视频支持共用同一个 ffmpeg，不会下载两份（经典界面也是）。
- **Collect, the browser extension and Send to generator / 收集、浏览器扩展和发送到生成器**: Ctrl+V in the library and Paste picture in the import dialog save a picture or a picture address; the browser extension's pairing, paired list and Revoke are in Settings, and a collected picture shows where it came from. Send to generator shows a picture's recipe as WebUI, NovelAI or ComfyUI text, copies or saves the workflow, and queues it in ComfyUI at the address you set.
  - 在图库按 Ctrl+V，或在导入对话框点“粘贴图片”，即可保存图片或图片地址；浏览器扩展的配对、已配对列表和撤销都在设置里，收集来的图片会显示来源。“发送到生成器”会以 WebUI、NovelAI 或 ComfyUI 的格式显示图片的参数，可复制或保存工作流，并发送到你设置的 ComfyUI 地址排队。
- **Everything else classic had / 经典界面的其余功能**: Privacy's chat disguise (cover picture, packing, restore); saving, renaming and deleting VLM prompt presets and the AI defaults; a Desktop settings tab, Quick collect, a hard refresh, the Background models line and one output folder; customizing the top bar; adding a batch's picks to another batch; auto-sorting the censor queue with saved profiles; the tag blacklist presets; leaving out already sorted pictures; tool cards on Home; pausing colour analysis; hiding the unreadable-files line; text repair in Settings; and Ctrl K for all of them. V Opus and the new interface now lack nothing the classic interface has.
  - 隐私工具的聊天伪装（封面、打包、还原）；VLM 提示词预设的保存、改名、删除，以及 AI 默认设置；“桌面”设置页、快速收集、强制刷新、后台模型和统一输出文件夹；自定义顶栏；把批次里选中的图加入别的批次；打码队列自动分组排序及保存方案；标签黑名单预设；排除已整理的图片；首页工具卡片；暂停颜色分析；隐藏无法读取文件那一行；在设置里修复文字；这些都能用 Ctrl K 找到。V Opus 和新界面现在不缺经典界面的任何功能。
- **Fixes found on the way / 顺带修复**: A failed picture download or video support install now says why in words (the site could not be reached, it took too long, it answered an error) instead of the system's own error text, and an HTTP error no longer became a number shown as the error. Stopping the colour analysis really stops it (it used to start the next round). A full top bar keeps room for the AI chip, the update hint and Jobs (the brand then shows only its mark), and More appears only once you hide a page. GIF and video censoring without NudeNet says so and points to the Model Center instead of calling the picture unreadable. On a laptop the Privacy options fit without scrolling, the search box keeps its width with the info card open, and the English sort menu reads "Sort: Newest". The browser extension says the new download failures in its own language too.
  - 图片下载或视频支持安装失败时，现在会用文字说明原因（连不上网站、太慢超时、网站返回错误），不再显示系统自己的错误文字；HTTP 错误也不再变成一个数字当作错误显示。停止颜色分析现在真的会停下（以前会接着开始下一轮）。顶栏放满页面时会给 AI 状态、更新提示和任务留出位置（此时商标只显示图标），“更多”只在你收起页面后出现。没有 NudeNet 时，GIF/视频打码会直说并指向模型中心，不再说成图片读不出。笔记本屏幕上，隐私工具的选项不用滚动就能看全，打开信息卡时搜索框也保持够宽。浏览器扩展也会用自己的语言说明新的下载失败原因。

---

## Upgrading / 升级注意

- Nothing to do. Video censoring now uses the video support ffmpeg; if you only installed the ffmpeg from the Model Center, it keeps working with that one.
  - 无需操作。视频打码现在使用视频支持的 ffmpeg；如果你只装过模型中心里的 ffmpeg，它会继续用那一个。

---

## Validation / 验证

VALIDATION_PENDING

---

## ⬇️ Which file should I download? / 我该下载哪一个？

**Windows → `sd-image-sorter-v3.10.0-windows-portable.zip`** — extract, double-click `SD Image Sorter.exe` (desktop program) or `run-portable.bat` (browser mode).

**Linux portable x86_64 → `sd-image-sorter-v3.10.0-linux-portable-x86_64.tar.gz`** — extract, run `./run-portable.sh`.

**Linux portable aarch64 → `sd-image-sorter-v3.10.0-linux-portable-aarch64.tar.gz`** — for ARM Linux, Raspberry Pi 5, and Graviton.

**Linux source install → `sd-image-sorter-v3.10.0-linux.tar.gz`** — for systems with Python 3.12+.

**Do NOT download / 不要下载：**
- `sd-image-sorter-v3.10.0-app-patch.zip` — in-app updater only / 仅供更新器
- `sd-image-sorter-v3.10.0-release-manifest.json` — updater metadata / 更新器元数据

---

## Checksums

CHECKSUMS_PENDING
