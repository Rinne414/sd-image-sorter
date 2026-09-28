# 考虑过但暂时没加的模型 / Models we considered but have not added (yet)

[简体中文](#简体中文) · [English](#english)

## 简体中文

这些模型我们都知道，也读过它们的模型卡、源码或做过实测。暂时没加，不是因为不知道，而是出于下面写明的考量。
如果你需要其中某一个，请开 issue 说明你的用途，我们会按新的需求重新评估。

最后更新：2026-09-28。

### 美学评分

已经有的：LAION 美学评分（照片取向，已内置）。选定要加、正在加入的：**Waifu Scorer V3**（二次元，0–10 分，只多约 11 MB，和 LAION 共用同一个 CLIP 模型）和 **deepghs anime_aesthetic**（二次元，masterpiece 到 worst 共 7 档，ONNX，不需要 torch），完成后会出现在模型中心。
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

---

## English

We know these models and have read their model cards or source, or tested them. Leaving them out is not an oversight; the reasons are written below.
If you need one of them, open an issue with your use case and we will look at it again.

Last updated: 2026-09-28.

### Aesthetic scoring

Already in the app: the LAION aesthetic score (photo-oriented, built in). Chosen and being added: **Waifu Scorer V3** (anime, 0–10, about 11 MB extra, sharing the CLIP model LAION already uses) and **deepghs anime_aesthetic** (anime, seven grades from masterpiece to worst, ONNX, no torch); they will appear in the Model Center when done.
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
