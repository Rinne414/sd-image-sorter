"""Pre-training dataset health check (BE-5\', needs-model N4/N5/N6).

A LoRA trainer\'s deepest pain is discovering a dataset problem AFTER hours
of GPU time. This service runs the checks an experienced trainer performs
by eye — trigger hygiene, composition balance, tag-set consistency — and
attaches symptom -> cause -> fix guidance to every finding so the report
teaches while it audits. Read-only: fixes are ready-made payloads for the
existing bulk endpoints, never applied here.
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

import database as db
from tag_rules import categorize_tag

logger = logging.getLogger(__name__)

# Danbooru framing vocabulary used for the composition-balance check (N4).
SHOT_DISTANCE_TAGS = (
    "close-up",
    "portrait",
    "upper body",
    "cowboy shot",
    "lower body",
    "full body",
    "wide shot",
)
RATING_TAG_NAMES = ("general", "sensitive", "questionable", "explicit")

MAX_REPORT_IMAGES = 20_000
TOP_FREQUENCY_ROWS = 500
COOCCURRENCE_TOP_TAGS = 150
COOCCURRENCE_MIN_JACCARD = 0.9
MAX_PAYLOAD_IDS = 10_000


class ConsistencyReportRequest(BaseModel):
    """Scope + context for one health-check run."""

    image_ids: Optional[List[int]] = Field(default=None, max_length=MAX_REPORT_IMAGES)
    selection_token: Optional[str] = Field(default=None, min_length=1)
    trigger: str = Field(default="", max_length=256)
    training_purpose: str = Field(default="", max_length=32)


def _fold(tag: str) -> str:
    return str(tag or "").strip().lower().replace("_", " ")


def _resolve_scope_ids(request: ConsistencyReportRequest) -> List[int]:
    if request.image_ids:
        seen = set()
        ids: List[int] = []
        for value in request.image_ids:
            image_id = int(value)
            if image_id > 0 and image_id not in seen:
                seen.add(image_id)
                ids.append(image_id)
        return ids[:MAX_REPORT_IMAGES]
    if request.selection_token:
        from services.tag_export_service import iter_selection_token_id_chunks

        ids = []
        for chunk in iter_selection_token_id_chunks(
            request.selection_token, chunk_size=500, snapshot=True
        ):
            ids.extend(int(v) for v in chunk)
            if len(ids) >= MAX_REPORT_IMAGES:
                break
        return ids[:MAX_REPORT_IMAGES]
    return []


def _finding(
    finding_id: str,
    severity: str,
    title_en: str,
    title_zh: str,
    detail_en: str,
    detail_zh: str,
    *,
    fix: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "id": finding_id,
        "severity": severity,
        "title_en": title_en,
        "title_zh": title_zh,
        "detail_en": detail_en,
        "detail_zh": detail_zh,
        "fix": fix,
        "data": data or {},
    }


def build_consistency_report(request: ConsistencyReportRequest) -> Dict[str, Any]:
    ids = _resolve_scope_ids(request)
    total = len(ids)
    if total == 0:
        return {"images": 0, "findings": [], "tag_frequencies": [], "shot_distribution": {}}

    trigger_fold = _fold(request.trigger)
    purpose = str(request.training_purpose or "").strip().lower()

    tags_by_image: Dict[int, List[str]] = {}
    raw_spellings: Dict[str, set] = {}
    tag_counts: Counter = Counter()
    trigger_missing: List[int] = []
    rating_zero: List[int] = []
    rating_multi: List[int] = []
    shot_counts: Counter = Counter()

    for start in range(0, total, 500):
        chunk = ids[start : start + 500]
        tag_map = db.get_image_tags_map(chunk)
        for image_id in chunk:
            rows = tag_map.get(image_id) or []
            folded: List[str] = []
            rating_rows = 0
            shot_bucket = None
            for row in rows:
                raw = str(row.get("tag") or "")
                key = _fold(raw)
                if not key:
                    continue
                folded.append(key)
                raw_spellings.setdefault(key, set()).add(raw.strip())
                if key in RATING_TAG_NAMES:
                    rating_rows += 1
                if shot_bucket is None and key in SHOT_DISTANCE_TAGS:
                    shot_bucket = key
            unique = sorted(set(folded))
            tags_by_image[image_id] = unique
            tag_counts.update(unique)
            shot_counts[shot_bucket or "unspecified"] += 1
            if rating_rows == 0:
                rating_zero.append(image_id)
            elif rating_rows > 1:
                rating_multi.append(image_id)
            if trigger_fold and trigger_fold not in unique:
                trigger_missing.append(image_id)

    findings: List[Dict[str, Any]] = []

    # ---- N5 trigger hygiene -------------------------------------------------
    if not trigger_fold and purpose in {"character", "concept"}:
        findings.append(_finding(
            "trigger-missing", "high",
            "No trigger word provided",
            "未提供触发词",
            "A character/concept LoRA absorbs the identity into the trigger word. Without one, the identity smears across whatever tags remain and cannot be summoned reliably at inference.",
            "角色/概念 LoRA 依赖触发词吸收身份特征。没有触发词时，身份会分散到其余标签上，推理时无法稳定唤出。",
        ))
    if trigger_fold:
        covered = total - len(trigger_missing)
        if trigger_missing:
            findings.append(_finding(
                "trigger-coverage", "high",
                f"Trigger only present in {covered}/{total} images",
                f"触发词只出现在 {covered}/{total} 张图中",
                "Every caption must carry the trigger, or the images without it teach the model that the character appears WITHOUT being asked — identity bleeds into unrelated prompts.",
                "每张图的 caption 都必须带触发词；缺少触发词的图会教模型“不用提示也出现这个角色”，导致身份渗漏到无关提示词里。",
                fix={
                    "endpoint": "/api/tags/bulk/add",
                    "body": {
                        "image_ids": trigger_missing[:MAX_PAYLOAD_IDS],
                        "tags": [request.trigger.strip()],
                        "dry_run": True,
                    },
                },
                data={"missing": len(trigger_missing)},
            ))
        try:
            from services.tag_suggest_service import get_vocab_tag_index

            vocab_index = get_vocab_tag_index() or {}
            vocab_key = trigger_fold.replace(" ", "_")
            if vocab_key in vocab_index or trigger_fold in vocab_index:
                findings.append(_finding(
                    "trigger-collision", "high",
                    "Trigger word collides with a known danbooru tag",
                    "触发词与已知 danbooru 标签撞名",
                    "The base model already has strong associations for this token, so training tugs against existing knowledge. Pick a rare token (e.g. a made-up word like 'ohwx' or 'kayokoBA').",
                    "基础模型对这个词已有强关联，训练会与既有知识互相拉扯。请改用罕见词（如自造词 'ohwx'、'kayokoBA'）。",
                    data={"trigger": request.trigger},
                ))
        except Exception as exc:
            logger.warning("trigger vocab check failed: %s", exc)

    # ---- N4 composition balance --------------------------------------------
    shot_distribution = {key: int(shot_counts.get(key, 0)) for key in
                         list(SHOT_DISTANCE_TAGS) + ["unspecified"]}
    full_body = shot_counts.get("full body", 0) + shot_counts.get("wide shot", 0)
    if purpose == "character" and total >= 10 and full_body < max(1, round(total * 0.1)):
        findings.append(_finding(
            "composition-fullbody", "medium",
            f"Full-body shots are only {full_body}/{total}",
            f"全身图只有 {full_body}/{total} 张",
            "A LoRA trained mostly on portraits cannot draw the character's full body — legs, feet and proportions were never seen. Add full-body images or up-weight them with kohya folder repeats.",
            "以大头照为主训练的 LoRA 画不好全身——腿、脚和身体比例从未被学习。请补全身图，或用 kohya 目录 repeats 加权现有全身图。",
            data={"distribution": shot_distribution},
        ))

    # ---- rating noise --------------------------------------------------------
    if rating_multi:
        findings.append(_finding(
            "rating-duplicates", "medium",
            f"{len(rating_multi)} images carry more than one rating tag",
            f"{len(rating_multi)} 张图带有多个 rating 标签",
            "Multiple rating rows usually mean mixed tagger runs. Conflicting ratings are noise in training captions and confuse rating filters.",
            "多个 rating 行通常来自多次不同的打标。互相矛盾的 rating 在训练 caption 中是噪声，也会干扰评级过滤。",
            fix={"endpoint": "/api/tags/fix-ratings", "body": {}},
            data={"image_ids": rating_multi[:50]},
        ))
    if rating_zero and len(rating_zero) < total:
        findings.append(_finding(
            "rating-missing", "info",
            f"{len(rating_zero)} images have no rating tag",
            f"{len(rating_zero)} 张图没有 rating 标签",
            "Not harmful for training, but rating-based filtering and export rating tokens skip these images.",
            "对训练无害，但基于评级的过滤和导出 rating 变量会跳过这些图。",
            data={"image_ids": rating_zero[:50]},
        ))

    # ---- low-frequency junk ---------------------------------------------------
    singleton_floor = max(1, round(total * 0.02))
    low_freq = sorted(
        [
            (tag, count) for tag, count in tag_counts.items()
            if count <= min(1, singleton_floor) or count == 1
        ],
        key=lambda item: item[0],
    )
    if total >= 10 and low_freq:
        findings.append(_finding(
            "low-frequency-tags", "info",
            f"{len(low_freq)} tags appear on exactly one image",
            f"{len(low_freq)} 个标签只出现在一张图上",
            "One-off tags contribute almost nothing and are often tagger noise or misspellings. Review and prune the meaningless ones — keep genuinely rare but real attributes.",
            "只出现一次的标签几乎没有训练贡献，常是打标噪声或拼写错误。请检查并清除无意义的；真实存在的罕见特征可以保留。",
            data={"tags": [tag for tag, _ in low_freq[:100]]},
        ))

    # ---- spelling variants ------------------------------------------------------
    variant_groups = [
        {"canonical": key, "spellings": sorted(spellings)}
        for key, spellings in raw_spellings.items()
        if len({s.lower() for s in spellings}) > 1
    ]
    if variant_groups:
        findings.append(_finding(
            "spelling-variants", "medium",
            f"{len(variant_groups)} tags exist in multiple spellings",
            f"{len(variant_groups)} 个标签存在多种拼写",
            "The trainer treats 'blue_eyes' and 'Blue Eyes' as different words — each spelling learns separately and both stay weak. Unify with find & replace.",
            "训练器把 'blue_eyes' 与 'Blue Eyes' 当成不同词——每种拼写各学一半，都学不好。请用批量查找替换统一拼写。",
            fix={"endpoint": "/api/tags/bulk/find-replace", "body": None},
            data={"groups": variant_groups[:50]},
        ))

    # ---- co-occurrence near-duplicates ---------------------------------------
    duplicate_pairs: List[Dict[str, Any]] = []
    if 3 <= total <= MAX_REPORT_IMAGES:
        top_tags = [
            tag for tag, count in tag_counts.most_common(COOCCURRENCE_TOP_TAGS)
            if count >= 3 and tag != trigger_fold
        ]
        tag_sets = {tag: set() for tag in top_tags}
        for image_id, unique in tags_by_image.items():
            for tag in unique:
                if tag in tag_sets:
                    tag_sets[tag].add(image_id)
        for i, tag_a in enumerate(top_tags):
            set_a = tag_sets[tag_a]
            for tag_b in top_tags[i + 1:]:
                set_b = tag_sets[tag_b]
                union = len(set_a | set_b)
                if union == 0:
                    continue
                jaccard = len(set_a & set_b) / union
                if jaccard >= COOCCURRENCE_MIN_JACCARD:
                    duplicate_pairs.append({
                        "a": tag_a, "b": tag_b, "jaccard": round(jaccard, 3),
                    })
    if duplicate_pairs:
        findings.append(_finding(
            "cooccurring-duplicates", "info",
            f"{len(duplicate_pairs)} tag pairs always appear together",
            f"{len(duplicate_pairs)} 组标签总是成对出现",
            "Tags that co-occur on (almost) every image are redundant to the model — consider keeping one, or check whether they are alias spellings/implications.",
            "几乎总是成对出现的标签对模型是冗余信息——考虑留一个，或检查它们是否是别名拼写/蕴含关系。",
            data={"pairs": duplicate_pairs[:50]},
        ))

    severity_order = {"critical": 0, "high": 1, "medium": 2, "info": 3}
    findings.sort(key=lambda f: severity_order.get(f["severity"], 9))

    tag_frequencies = [
        {
            "tag": tag,
            "count": int(count),
            "category": categorize_tag(tag),
        }
        for tag, count in tag_counts.most_common(TOP_FREQUENCY_ROWS)
    ]

    return {
        "images": total,
        "trigger": request.trigger,
        "training_purpose": purpose,
        "findings": findings,
        "tag_frequencies": tag_frequencies,
        "shot_distribution": shot_distribution,
    }
