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

阈值怎么定的（诚实地说）：清晰度默认低于 60 提示，这和那个工具的参考值同量级，并且在 3 张照片和 1 张合成图（scikit-learn 和 matplotlib 自带的示例图）上对照过：高斯模糊 σ≈1 像素（512 尺度）时分数约 30–230，σ≈1.5 约 12–62，σ≥2 都在 30 以下，没糊的原图都在 500 以上。过平按"几乎全是同色或平滑渐变的 8x8 块"≥92% 提示；合成的二次元风格图里，主体占画面 20% 以上就不会被提示，占 10% 以下会被提示。
没有验证的地方：没有拿大量真实二次元图做过标定；大片平滑色块、柔和上色的二次元图清晰度分数天生偏低，会被误报为"可能糊"。所以阈值可以在检查步骤里改（0 为不查糊图），也只是提示。边缘占比只显示、不参与判断。

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

How the thresholds were chosen, honestly: a blur score under 60 is listed by default, the same order of magnitude as that tool's review value, and checked on 3 photos and 1 synthetic picture (the sample images bundled with scikit-learn and matplotlib). A Gaussian blur of about 1 px (at the 512 scale) scores about 30-230, about 1.5 px scores 12-62, 2 px or more is under 30, and the unblurred originals are all above 500. "Very flat" means at least 92% of the 8x8 blocks are one colour or a smooth gradient; on synthetic anime-style pictures a subject filling 20% of the frame or more is not listed, one filling 10% or less is.
What is not validated: it was not calibrated on a large set of real anime pictures. Anime with large smooth colour areas and soft shading naturally scores low and will be listed as "possibly blurry" by mistake, so the threshold can be changed in the Check step (0 skips blur) and the result is only a hint. The edge share is shown for the reader and does not decide a flag.
