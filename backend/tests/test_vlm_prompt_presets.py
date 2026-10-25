"""Saved VLM prompt presets (GitHub issue #21): add, change, rename, delete.

What a user sees: presets they save appear after the built-in ones, survive a
restart, can be renamed, updated and deleted, and a deleted one can be brought
back by Undo. Built-in presets cannot be changed, and a damaged presets file is
reported and never overwritten.
"""

from __future__ import annotations

import json

from services import vlm_prompt_presets as store
from vlm_providers.registry import PROMPT_PRESETS

SAMPLE = {
    "output_format": "both",
    "system_prompt": "You caption pictures for my cat LoRA.",
    "user_prompt": "Describe the cat.",
    "user_prompt_with_tags": "Tags: {tags}. Describe the cat.",
}


def _create(client, name="My cat preset", **overrides):
    body = {"name": name, **SAMPLE, **overrides}
    return client.post("/api/vlm/presets", json=body)


def test_listing_starts_with_every_builtin_preset_marked_builtin(test_client):
    payload = test_client.get("/api/vlm/presets").json()

    presets = payload["presets"]
    assert list(presets)[: len(PROMPT_PRESETS)] == list(PROMPT_PRESETS)
    assert all(presets[pid]["builtin"] is True for pid in PROMPT_PRESETS)
    assert payload["custom_presets_problem"] == ""


def test_saved_preset_is_listed_after_builtins_with_all_its_prompts(test_client):
    created = _create(test_client).json()["preset"]

    presets = test_client.get("/api/vlm/presets").json()["presets"]
    assert list(presets)[-1] == created["id"]
    saved = presets[created["id"]]
    assert created["id"].startswith("custom-")
    assert saved["builtin"] is False
    assert saved["name"] == "My cat preset"
    for field, value in SAMPLE.items():
        assert saved[field] == value


def test_saved_presets_survive_a_restart(test_client):
    created = _create(test_client).json()["preset"]

    on_disk = json.loads(store.PRESETS_PATH.read_text(encoding="utf-8"))
    assert [row["id"] for row in on_disk["presets"]] == [created["id"]]
    assert "builtin" not in on_disk["presets"][0]
    presets, problem = store.list_all_presets()
    assert problem == ""
    assert presets[created["id"]]["system_prompt"] == SAMPLE["system_prompt"]


def test_names_are_trimmed_and_must_be_unique_ignoring_case(test_client):
    first = _create(test_client, name="  Cat   preset ").json()["preset"]
    assert first["name"] == "Cat preset"

    clash = _create(test_client, name="CAT PRESET")

    assert clash.status_code == 409
    body = clash.json()
    assert body["code"] == "vlm_preset_name_taken"
    assert body["params"]["existing_id"] == first["id"]


def test_blank_name_is_refused(test_client):
    response = _create(test_client, name="   ")

    assert response.status_code == 400
    assert response.json()["code"] == "vlm_preset_name_required"


def test_update_replaces_prompts_and_keeps_omitted_fields(test_client):
    created = _create(test_client).json()["preset"]

    response = test_client.patch(
        f"/api/vlm/presets/{created['id']}",
        json={"system_prompt": "New system prompt.", "output_format": "nl_caption"},
    )

    assert response.status_code == 200
    updated = response.json()["preset"]
    assert updated["system_prompt"] == "New system prompt."
    assert updated["output_format"] == "nl_caption"
    assert updated["user_prompt"] == SAMPLE["user_prompt"]
    assert updated["name"] == "My cat preset"


def test_rename_keeps_prompts_and_refuses_a_name_in_use(test_client):
    first = _create(test_client, name="First").json()["preset"]
    second = _create(test_client, name="Second").json()["preset"]

    renamed = test_client.patch(
        f"/api/vlm/presets/{first['id']}", json={"name": "Renamed"}
    ).json()["preset"]
    clash = test_client.patch(
        f"/api/vlm/presets/{second['id']}", json={"name": "renamed"}
    )

    assert renamed["name"] == "Renamed"
    assert renamed["user_prompt"] == SAMPLE["user_prompt"]
    assert clash.status_code == 409


def test_renaming_to_its_own_name_in_another_case_is_allowed(test_client):
    created = _create(test_client, name="cat").json()["preset"]

    response = test_client.patch(
        f"/api/vlm/presets/{created['id']}", json={"name": "Cat"}
    )

    assert response.status_code == 200
    assert response.json()["preset"]["name"] == "Cat"


def test_delete_removes_the_preset_and_undo_brings_it_back_with_its_id(test_client):
    created = _create(test_client).json()["preset"]

    deleted = test_client.delete(f"/api/vlm/presets/{created['id']}").json()["deleted"]
    after_delete = test_client.get("/api/vlm/presets").json()["presets"]
    restored = _create(
        test_client,
        name=deleted["name"],
        id=deleted["id"],
        output_format=deleted["output_format"],
    ).json()["preset"]

    assert created["id"] not in after_delete
    assert restored["id"] == created["id"]
    assert created["id"] in test_client.get("/api/vlm/presets").json()["presets"]


def test_builtin_presets_cannot_be_changed_or_deleted(test_client):
    patch = test_client.patch("/api/vlm/presets/lora_training", json={"name": "Mine"})
    delete = test_client.delete("/api/vlm/presets/lora_training")
    reuse_id = _create(test_client, id="lora_training")

    assert patch.status_code == 403
    assert delete.status_code == 403
    assert reuse_id.status_code == 403
    assert patch.json()["code"] == "vlm_preset_builtin"
    assert "lora_training" in PROMPT_PRESETS


def test_unknown_preset_answers_not_found(test_client):
    response = test_client.delete("/api/vlm/presets/custom-0123abcd")

    assert response.status_code == 404
    assert response.json()["code"] == "vlm_preset_not_found"


def test_unknown_output_format_is_refused(test_client):
    response = _create(test_client, output_format="poetry")

    # The app answers every request-validation error with 400.
    assert response.status_code == 400


def test_listing_never_hands_out_the_shared_builtin_dicts():
    presets, _ = store.list_all_presets()
    presets["lora_training"]["system_prompt"] = "changed by a caller"

    assert PROMPT_PRESETS["lora_training"]["system_prompt"] != "changed by a caller"


def test_damaged_file_is_reported_and_never_overwritten(test_client):
    store.PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    store.PRESETS_PATH.write_text("{ not json", encoding="utf-8")

    listing = test_client.get("/api/vlm/presets").json()
    create = _create(test_client)

    assert set(PROMPT_PRESETS) <= set(listing["presets"])
    assert "not valid JSON" in listing["custom_presets_problem"]
    assert create.status_code == 409
    assert create.json()["code"] == "vlm_preset_file_unreadable"
    assert store.PRESETS_PATH.read_text(encoding="utf-8") == "{ not json"


def test_unusable_rows_are_skipped_without_losing_good_ones():
    store.PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    store.PRESETS_PATH.write_text(
        json.dumps(
            {
                "version": 1,
                "presets": [
                    {"id": "custom-aaaaaaaa", "name": "Good", "user_prompt": "hi"},
                    {"id": "not-a-custom-id", "name": "Bad id"},
                    {"id": "custom-bbbbbbbb", "name": ""},
                    "garbage",
                ],
            }
        ),
        encoding="utf-8",
    )

    presets, problem = store.list_all_presets()

    custom = [p for p in presets.values() if not p["builtin"]]
    assert problem == ""
    assert [p["id"] for p in custom] == ["custom-aaaaaaaa"]
    assert custom[0]["output_format"] == "nl_caption"


def test_settings_remember_which_preset_the_prompts_came_from(
    test_client, tmp_path, monkeypatch
):
    import routers.vlm as vlm

    monkeypatch.setattr(vlm, "VLM_SETTINGS_PATH", tmp_path / "vlm-settings.json")
    monkeypatch.setattr(vlm, "CONFIG_DIR", tmp_path)

    test_client.post("/api/vlm/settings", json={"prompt_preset_id": "custom-0123abcd"})

    assert (
        test_client.get("/api/vlm/settings").json()["prompt_preset_id"]
        == "custom-0123abcd"
    )


def _write_file(payload) -> None:
    store.PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    store.PRESETS_PATH.write_text(json.dumps(payload), encoding="utf-8")


def test_saving_keeps_rows_fields_and_keys_this_version_does_not_use(test_client):
    _write_file({
        "version": 1,
        "note": "kept by hand",
        "presets": [
            {"id": "custom-aaaaaaaa", "name": "Mine", "user_prompt": "hi", "color": "red"},
            {"id": "my-own-id", "name": "Hand made"},
            "garbage",
        ],
    })

    _create(test_client, name="New one")

    on_disk = json.loads(store.PRESETS_PATH.read_text(encoding="utf-8"))
    assert on_disk["note"] == "kept by hand"
    rows = on_disk["presets"]
    assert rows[0]["color"] == "red" and rows[0]["user_prompt"] == "hi"
    assert {"id": "my-own-id", "name": "Hand made"} in rows and "garbage" in rows
    assert [r.get("name") for r in rows if isinstance(r, dict)][:2] == ["Mine", "New one"]


def test_a_file_with_an_unknown_layout_is_refused_not_overwritten(test_client):
    for payload in ([{"id": "custom-abcdef12", "name": "x"}], {"presets": None}, {"version": 99, "presets": []}):
        _write_file(payload)
        before = store.PRESETS_PATH.read_text(encoding="utf-8")

        listing = test_client.get("/api/vlm/presets").json()
        create = _create(test_client)

        assert listing["custom_presets_problem"], payload
        assert create.status_code == 409, payload
        assert store.PRESETS_PATH.read_text(encoding="utf-8") == before
