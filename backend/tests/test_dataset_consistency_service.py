"""Tests for the BE-5' pre-training dataset health check."""
from __future__ import annotations


def _add_image(db, tmp_path, name, tags):
    image_path = tmp_path / name
    image_path.write_bytes(b"not a real image")
    image_id = db.add_image(path=str(image_path), filename=image_path.name)
    if tags:
        db.add_tags(image_id, [{"tag": t, "confidence": 0.9} for t in tags])
    return image_id


def test_consistency_report_flags_trigger_and_variants(test_client, tmp_path):
    import database as db

    ids = [
        _add_image(db, tmp_path, "hc-0.png", ["ohwx_kayo", "1girl", "blue_eyes", "general", "portrait"]),
        _add_image(db, tmp_path, "hc-1.png", ["ohwx_kayo", "1girl", "Blue Eyes", "general", "portrait"]),
        # trigger missing + duplicate ratings on this one
        _add_image(db, tmp_path, "hc-2.png", ["1girl", "blue_eyes", "general", "sensitive", "full_body"]),
    ]

    response = test_client.post("/api/tags/consistency/report", json={
        "image_ids": ids,
        "trigger": "ohwx_kayo",
        "training_purpose": "character",
        "effective_captions": [
            {"image_id": ids[0], "caption": "ohwx_kayo, 1girl, blue_eyes"},
            {"image_id": ids[1], "caption": "ohwx kayo, 1girl, Blue Eyes"},
            {"image_id": ids[2], "caption": "1girl, blue_eyes"},
        ],
    })
    assert response.status_code == 200
    report = response.json()
    assert report["images"] == 3

    findings = {f["id"]: f for f in report["findings"]}

    coverage = findings["trigger-coverage"]
    assert coverage["severity"] == "high"
    assert coverage["data"]["missing"] == 1
    assert coverage["fix"] == {
        "action": "add_trigger_to_captions",
        "image_ids": [ids[2]],
        "trigger": "ohwx_kayo",
    }
    assert coverage["detail_zh"]  # bilingual guidance present

    variants = findings["spelling-variants"]
    groups = {g["canonical"]: g["spellings"] for g in variants["data"]["groups"]}
    assert "blue eyes" in groups
    assert len(groups["blue eyes"]) >= 2

    ratings = findings["rating-duplicates"]
    assert ids[2] in ratings["data"]["image_ids"]

    # A made-up trigger must NOT be reported as a danbooru collision.
    assert "trigger-collision" not in findings

    # Frequency table is present, folded and categorized.
    freq = {row["tag"]: row for row in report["tag_frequencies"]}
    assert freq["1girl"]["count"] == 3
    assert "category" in freq["1girl"]

    # Shot distribution counted the framing tags.
    assert report["shot_distribution"]["portrait"] == 2
    assert report["shot_distribution"]["full body"] == 1


def test_consistency_report_flags_common_word_trigger(test_client, tmp_path):
    import database as db

    ids = [
        _add_image(db, tmp_path, "hc-col-0.png", ["smile", "1girl", "general"]),
    ]
    response = test_client.post("/api/tags/consistency/report", json={
        "image_ids": ids,
        "trigger": "smile",
        "training_purpose": "character",
        "effective_captions": [
            {"image_id": ids[0], "caption": "smile, 1girl"},
        ],
    })
    assert response.status_code == 200
    findings = {f["id"]: f for f in response.json()["findings"]}
    assert "trigger-collision" in findings


def test_consistency_report_uses_effective_captions_for_trigger_coverage(
    test_client,
    tmp_path,
):
    import database as db

    ids = [
        _add_image(db, tmp_path, "hc-caption-0.png", ["1girl", "general"]),
        _add_image(db, tmp_path, "hc-caption-1.png", ["1girl", "general"]),
    ]
    response = test_client.post("/api/tags/consistency/report", json={
        "image_ids": ids,
        "trigger": "project_token",
        "training_purpose": "character",
        "effective_captions": [
            {"image_id": ids[0], "caption": "project_token, 1girl"},
            {"image_id": ids[1], "caption": "1girl, Project Token"},
        ],
    })

    assert response.status_code == 200
    findings = {finding["id"]: finding for finding in response.json()["findings"]}
    assert "trigger-coverage" not in findings
    tag_map = db.get_image_tags_map(ids)
    assert all(
        "project token" not in {
            str(row["tag"]).strip().lower().replace("_", " ")
            for row in tag_map[image_id]
        }
        for image_id in ids
    )


def test_consistency_report_returns_project_caption_fix_for_missing_trigger(
    test_client,
    tmp_path,
):
    import database as db

    ids = [
        _add_image(db, tmp_path, "hc-caption-missing-0.png", ["project_token", "1girl"]),
        _add_image(db, tmp_path, "hc-caption-missing-1.png", ["1girl"]),
    ]
    response = test_client.post("/api/tags/consistency/report", json={
        "image_ids": ids,
        "trigger": "project_token",
        "training_purpose": "character",
        "effective_captions": [
            {"image_id": ids[0], "caption": "project_token, 1girl"},
            {"image_id": ids[1], "caption": "1girl"},
        ],
    })

    assert response.status_code == 200
    findings = {finding["id"]: finding for finding in response.json()["findings"]}
    coverage = findings["trigger-coverage"]
    assert coverage["data"]["missing"] == 1
    assert coverage["fix"] == {
        "action": "add_trigger_to_captions",
        "image_ids": [ids[1]],
        "trigger": "project_token",
    }


def test_consistency_report_requires_scope(test_client):
    response = test_client.post("/api/tags/consistency/report", json={})
    assert response.status_code == 400


def test_consistency_report_rejects_trigger_check_without_effective_captions(
    test_client,
    tmp_path,
):
    import database as db

    image_id = _add_image(db, tmp_path, "hc-no-caption-contract.png", ["project_token"])
    response = test_client.post("/api/tags/consistency/report", json={
        "image_ids": [image_id],
        "trigger": "project_token",
        "training_purpose": "character",
    })

    assert response.status_code == 400
    assert "effective_captions is required" in response.text
