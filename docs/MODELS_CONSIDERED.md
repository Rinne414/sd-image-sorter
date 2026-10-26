# 考虑过但暂时没加的模型 / Models we considered but have not added (yet)

[简体中文](#简体中文) · [English](#english)

## 简体中文

这些模型我们都知道，也读过它们的模型卡、源码或做过实测。暂时没加，不是因为不知道，而是出于下面写明的考量。
如果你需要其中某一个，请开 issue 说明你的用途，我们会按新的需求重新评估。

最后更新：2026-09-28。

### 美学评分

已经有的：LAION 美学评分（照片取向，已内置）。已加入，都在模型中心下载：**Waifu Scorer V3**（二次元，0–10 分，只多约 11 MB，和 LAION 共用同一个 CLIP 模型）和 **deepghs anime_aesthetic**（二次元，masterpiece 到 worst 共 7 档，约 420 MB 的 ONNX 模型；许可证为 openrail，程序只从官方仓库下载，不重新分发）。两者都在美学评分时一起计算，所以都需要先装好美学评分模型。
我们在 150 张随机图上对比过：三个模型的排名相关只有 0.03–0.12，说明它们看的东西很不一样，所以会都做成可选，由你按用途挑。

| 模型 | 它是什么 | 为什么暂时没加 | 什么情况下会加 |
|---|---|---|---|
| Aesthetic Predictor V2.5（discus0434） | SigLIP 大模型 + 小头，1–10 分，比 LAION 更照顾插画 | 要额外下载约 3.5 GB 的 SigLIP 和 torch；是通用美学，不是二次元专用；作者没公布准确率 | 有人需要比 LAION 更好的通用 / 写实美学分时 |
| Q-Align 蒸馏版（trojblue，aesthetic / quality） | SigLIP2 小模型，模仿 Q-Align 的打分 | 它评的是**画质**（清不清楚、有没有噪点），不是好不好看；作者自己说美学版偏西式口味；只公布了和原模型有多像，没有和人工评分比较 | 如果大家想要一个“筛掉糊图 / 低画质图”的功能，会考虑加 quality 版 |
| kawai-aesthetic-scorer（kawaimasa） | ConvNeXtV2，5 档（SS–C） | 作者明说这是**他个人的口味**，不是客观美学；约 786 MB，还要 torch | 如果要做“按某种口味筛图”的可选分类 |
| Anime-Aesthetic-Predictor-Medium（Blackroot） | ConvNeXt，约 2 万张标注训练的起点模型 | 它的价值在于**拿你自己的偏好再训练**；目前程序还没有“学我的口味”这个功能 | 做“学我的口味”功能时，它会是候选起点 |
| ERNIE-Image-Aes（百度） | 约 80 亿参数的视觉语言模型 | 对本地批量评分太重 | 本地硬件普遍能跑这种规模时 |

### 打码检测

已经有的：Wenaka Privacy YOLO、NudeNet、SAM3；新增 **deepghs 二次元打码检测 + 脸部检测**（MIT，固定到仓库提交并校验 SHA-256）。

| 模型 | 它是什么 | 为什么暂时没加 | 什么情况下会加 |
|---|---|---|---|
| ntd11 anime NSFW segmentation（Civitai） | 二次元私处分割模型，有些工具在用 | 没有清楚的授权，也没有能固定版本、校验文件的官方下载地址 | 作者给出明确授权和稳定的下载源时 |

### 糊图与过平图（"筛掉糊图"）

2026-10-27：不用模型，做成数据集检查步骤里的**提示**：整张图缩成最长边 512 的灰度图，算拉普拉斯方差（清晰度）、边缘占比和平坦色块占比，只用 CPU，在后台任务里算，结果按文件（路径、大小、修改时间）缓存。列出"可能糊"和"过于平"的图，只提示，从不删除文件。
上面表里的 Q-Align quality 版仍然没加：它是模型，要额外下载，而且没和人工评分比较过；这个简单的算法在 300 张测试图上约 3 秒，不用下载。思路来自 shira-qwq/lora-dataset-studio（非商业许可，只借思路，代码自己写）。

阈值怎么定的（诚实地说）：2026-10-27 第一版只在 3 张照片和 1 张合成图上对过，默认 60。同日又拿真实的二次元图重新标定，默认改为 **50**。样本是 ComfyUI 输出文件夹里的 18,328 张图（png 和 jpg，只读不改），随机抽 1,000 张（种子 20261027）；其中 30% 来自 `testing` 文件夹，那是故意糊着做的实验图（多半是 `anima_drift_*` 的一团糊），另外补抽了 1,000 张不在 `testing` 里的图，不含 `testing` 的共 1,695 张。清晰度分数的分位数（1000 张）：1% 为 22.9，5% 为 50.2，10% 为 122，中位数 1012，90% 为 2630。

| 清晰度低于 | 1000 张里被提示 | 不含 `testing` 的 1,695 张里被提示 | 肉眼看过的 60 张里：被提示 / 其中真的糊 / 其中干净 | 手工模糊的 10 张真图（σ=4 / 6 / 10）抓到几张 |
|---|---|---|---|---|
| 30 | 2.5% | 0.12% | 26 / 24 / 2 | 3 / 7 / 10 |
| 40 | 3.9% | 0.24% | 32 / 29 / 3 | 4 / 8 / 10 |
| **50（默认）** | 4.9% | 0.24% | 34 / 31 / 3 | 5 / 9 / 10 |
| 60（旧默认） | 6.1% | 0.41% | 45 / 36 / 9 | 7 / 9 / 10 |
| 80 | 7.6% | 1.0% | 54 / 38 / 14 | 7 / 9 / 10 |

肉眼检查：对 60 张不同的图（分数最低的那些、旧阈值 60 附近的 10 张、60–150 之间随机抽的、以及 34–56 区间和 `testing` 之外补看的）逐张看原图，判断“训练集策展者会不会因为糊而丢掉”：38 张真的糊，4 张略软，16 张柔和上色但干净，2 张清晰。真的糊的几乎都是 `anima_drift` 的糊团（分数 10–64）。被误提示的干净图：柔和上色的二次元图 `anima_test_00015`（28.6）、`anima_test_00115`（50.7）、`anima_test_00090` 和 `anima_test_00198`（58.5）；偏暗或极简的 3D 画面 `storm_00147`（17）、`storm_00177`（59.8）、`still_00026`（54.6）、`storm_00016`（57.8）；蓝色调线稿（31.6）。同样是 58 分左右，既有干净的二次元图，也有真的糊图，没有任何一个阈值能把它们分开。
手工模糊：取 10 张清晰的真图（992–2848 像素），在原分辨率上做高斯模糊 σ=2、4、6、10 像素后评分。原图分数 696–3394，全部高于 500。评分前图被缩到最长边 512，所以有效模糊 = σ ÷ 缩小倍数；同样的有效模糊，分数随内容相差约 3 倍（0.89 像素时 44、57、126）。σ=10 全部抓到，σ=6 在 50 和 60 都是 9/10，σ=4 在 50 是 5/10、60 是 7/10，σ=2 在 100 以内几乎都抓不到。
为什么是 50：在 50 到 60 之间，看过的图里多提示 5 张真糊（都是糊团）和 6 张干净图；不含 `testing` 的 1,695 张里多提示 3 张，全是干净的偏暗或极简画面。代价是 σ=4 的手工模糊图少抓 2 张（大图、轻度模糊）。糊图提示的严重度本来就是最低的“低”，而且只列出不删除，所以这里宁可少打扰：按真实图库，默认只提示约 0.24% 的正常图。因为没有一个阈值能干净地分开，提示的措辞改成“可能偏软或糊”，说明里写明柔和上色、偏暗和极简的图分数也会偏低。
没有采纳的办法：边缘占比（`edge`）。只看抽样里的糊团它很好用（`edge` ≤ 0.009 的平衡准确率 0.90，清晰度分数是 0.85），但手工模糊的真图仍保留大量边缘（σ=4 时 `edge` 都在 0.055 以上，0/10 抓到），偏暗的画面又和糊团分不开；数据不支持换一个新的评分函数，所以它仍然只显示、不参与判断。
没有验证的地方：没有人工打分的标准集，“糊 / 不糊”是我一个人逐张看出来的；样本只来自一个人的图库（二次元和插画为主，含 3D 视频帧，没有照片），而且图库里一大块是故意做糊的实验图，所以“被提示的比例”比一般数据集高得多，不含实验图时才接近日常。分数还和图大小、内容有关：大图轻度模糊分数仍然很高，不会被提示；偏暗或极简的画面分数低，会被误报。所以阈值可以在检查步骤里改（0 为不查糊图），结果只是提示。

---

## English

We know these models and have read their model cards or source, or tested them. Leaving them out is not an oversight; the reasons are written below.
If you need one of them, open an issue with your use case and we will look at it again.

Last updated: 2026-09-28.

### Aesthetic scoring

Already in the app: the LAION aesthetic score (photo-oriented, built in). Added, both downloaded from the Model Center: **Waifu Scorer V3** (anime, 0–10, about 11 MB extra, sharing the CLIP model LAION already uses) and **deepghs anime_aesthetic** (anime, seven grades from masterpiece to worst, a ~420 MB ONNX model; licensed openrail, downloaded from the official repository and not redistributed). Both are computed during aesthetic scoring, so both need the Aesthetic Predictor installed first.
On 150 random pictures the three models' rankings correlate only 0.03–0.12, so they judge different things; all of them will be optional, pick by purpose.

| Model | What it is | Why not yet | When we would add it |
|---|---|---|---|
| Aesthetic Predictor V2.5 (discus0434) | SigLIP backbone + small head, 1–10, better on illustrations than LAION | Needs a ~3.5 GB SigLIP download plus torch; general-purpose, not anime-specific; no published accuracy | When people need a better general / realistic aesthetic score than LAION |
| Q-Align distilled (trojblue, aesthetic / quality) | Small SigLIP2 model imitating Q-Align's scores | It rates image **quality** (sharpness, noise), not taste; its author says the aesthetic variant leans Western; it only reports how close it is to the teacher, not to human ratings | If people ask for a "drop blurry / low-quality pictures" filter, the quality variant is the candidate |
| kawai-aesthetic-scorer (kawaimasa) | ConvNeXtV2, five tiers (SS–C) | The author states it encodes **his own taste**, not objective aesthetics; ~786 MB plus torch | For an optional "sort by a particular taste" category |
| Anime-Aesthetic-Predictor-Medium (Blackroot) | ConvNeXt starting point trained on ~20k labels | Its value is **fine-tuning on your own preferences**; the app has no "learn my taste" feature yet | As the starting point once such a feature exists |
| ERNIE-Image-Aes (Baidu) | ~8B-parameter vision-language model | Too heavy for local batch scoring | When local hardware commonly runs models of that size |

### Censor detection

Already in the app: Wenaka Privacy YOLO, NudeNet, SAM3, plus the new **deepghs anime censor detector + face detector** (MIT, pinned to a repository commit and verified by SHA-256).

| Model | What it is | Why not yet | When we would add it |
|---|---|---|---|
| ntd11 anime NSFW segmentation (Civitai) | Anime private-part segmentation some tools use | No clear license and no official download we can pin and verify | When its author publishes a clear license and a stable source |

### Blurry and flat pictures ("drop blurry images")

2026-10-27: done without a model, as a **hint** in the dataset Check step. Each picture is shrunk to a grey copy of at most 512 px on the long side, and three numbers are computed: the variance of the Laplacian (sharpness), the share of edge pixels and the share of flat 8x8 blocks. CPU only, run as a background job, cached per file (path, size, modification time). The step lists "possibly blurry" and "very flat" pictures; it only lists them and never deletes a file.
The Q-Align quality variant in the table above is still not added: it is a model with an extra download and was never compared with human ratings, while this simple measure scores 300 test pictures in about 3 seconds with nothing to download. The idea comes from shira-qwq/lora-dataset-studio (non-commercial licence: the idea only, the code is our own).

How the thresholds were chosen, honestly: the first version (2026-10-27) was checked on only 3 photos and 1 synthetic picture and used 60. The same day it was calibrated again on real anime pictures and the default became **50**. The pictures are the 18,328 files (png and jpg, read in place, never changed) in the ComfyUI output folder: a random 1,000 (seed 20261027), of which 30% come from a `testing` folder of deliberately smeared experiments (mostly `anima_drift_*` mush), plus another 1,000 drawn from outside `testing`, which gives 1,695 pictures outside it. Blur score percentiles (the 1,000): 1% 22.9, 5% 50.2, 10% 122, median 1012, 90% 2630.

| blur score under | listed, the 1,000 | listed, the 1,695 outside `testing` | looked at (60 pictures): listed / really blurry / clean | 10 real pictures blurred by hand (sigma 4 / 6 / 10): how many caught |
|---|---|---|---|---|
| 30 | 2.5% | 0.12% | 26 / 24 / 2 | 3 / 7 / 10 |
| 40 | 3.9% | 0.24% | 32 / 29 / 3 | 4 / 8 / 10 |
| **50 (default)** | 4.9% | 0.24% | 34 / 31 / 3 | 5 / 9 / 10 |
| 60 (old default) | 6.1% | 0.41% | 45 / 36 / 9 | 7 / 9 / 10 |
| 80 | 7.6% | 1.0% | 54 / 38 / 14 | 7 / 9 / 10 |

Looking at them: 60 different pictures (the lowest scores, 10 around the old threshold of 60, random ones between 60 and 150, and extras from the 34-56 band and from outside `testing`) were opened as the original files and judged as a LoRA curator would ("would I drop this for blur?"): 38 really blurry, 4 slightly soft, 16 soft-shaded but clean, 2 sharp. The really blurry ones are almost all `anima_drift` mush (scores 10-64). The clean pictures that were listed: soft-shaded anime `anima_test_00015` (28.6), `anima_test_00115` (50.7), `anima_test_00090` and `anima_test_00198` (58.5); dark or minimal 3D scenes `storm_00147` (17), `storm_00177` (59.8), `still_00026` (54.6) and `storm_00016` (57.8); a blue-tinted line drawing (31.6). Around 58 there are both clean anime and really blurry pictures with the same score, so no threshold separates them.
Blurring by hand: 10 sharp real pictures (992-2848 px) were blurred with a Gaussian of sigma 2, 4, 6 and 10 px at full resolution and scored. The originals scored 696-3394, all above 500. A picture is shrunk to a long side of 512 before scoring, so the effective blur is sigma divided by the shrink factor, and the same effective blur scores about 3 times differently depending on the picture (0.89 px gave 44, 57 and 126). Sigma 10 was caught every time, sigma 6 caught 9 of 10 at both 50 and 60, sigma 4 caught 5 of 10 at 50 and 7 of 10 at 60, and sigma 2 was caught almost never up to 100.
Why 50: between 50 and 60 the looked-at set gains 5 really blurry pictures (all mush) and 6 clean ones, and among the 1,695 pictures outside `testing` it gains 3 listed pictures, all clean dark or minimal scenes. The price is 2 of the 10 sigma-4 copies no longer caught (large pictures, light blur). The hint is the lowest severity ("low") and only lists, so it should bother rarely: on a real library the default lists about 0.24% of ordinary pictures. Because no single threshold separates soft shading from blur, the wording became "may be soft or blurry" and the explanation says that soft-shaded, dark and minimal pictures score low too.
Not adopted: the edge share (`edge`). On the smeared experiments alone it looks better (`edge` <= 0.009 has a balanced accuracy of 0.90 against 0.85 for the blur score), but blurred real pictures keep plenty of edges (at sigma 4 every one has `edge` above 0.055, 0 of 10 caught) and dark scenes look like mush to it. The data does not support a new scoring function, so the edge share is still only shown and decides nothing.
What is not validated: there is no human-rated set, "blurry or not" is one person looking at each picture; the sample is one library (anime and illustration, some 3D video frames, no photos) in which a large part is deliberately smeared experiments, so the share of listed pictures is far above what an ordinary dataset gives and only the part outside `testing` looks like everyday use. The score also depends on picture size and content: a large, lightly blurred picture still scores high and is not listed, and dark or minimal scenes score low and are listed by mistake. So the threshold can be changed in the Check step (0 skips blur) and the result is only a hint.
