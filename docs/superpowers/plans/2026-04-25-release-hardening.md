# Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the current release blockers while preserving large-library Stable Diffusion workflows, advanced model support, precomputed similarity indexing, isolated destructive-task scopes, and detector-plus-refiner censor architecture.

**Architecture:** Implement one shared backend safety layer first, then wire the affected endpoints and frontend flows to that layer. Keep changes focused in existing modules, adding small helpers only where they make behavior testable and prevent large-file churn.

**Tech Stack:** Python 3.9+, FastAPI, pytest, Pillow, SQLite/raw SQL, vanilla JavaScript/CSS/HTML, Playwright/manual browser smoke where available.

---

## Scope note

The approved spec spans multiple subsystems. Execute this as wave-based work, not one giant edit. Each task below should end with targeted tests passing and a review checkpoint before starting the next task.

## File map

### Backend safety and shared helpers

- Modify `backend/utils/path_validation.py`
  - Own shared output image path validation.
  - Add structured output validation result or dict.
  - Keep existing path validation APIs stable unless all callers are updated.
- Modify `backend/routers/obfuscation.py`
  - Replace local `_validate_output_path()` behavior with shared validator.
  - Require explicit overwrite flag for existing outputs.
- Modify `backend/services/censor_service.py`
  - Add decoded base64/image guard use.
  - Enforce no silent overwrite for save paths where endpoint supports output files.
- Modify `backend/metadata_parser.py`
  - Guard oversized metadata text chunks before JSON parsing.
- Modify `backend/routers/images.py`
  - Add upload read size guard.
  - Add reader metadata edit/save endpoint if no better existing router exists.
- Modify `backend/services/image_service.py`
  - Add reader metadata edit/save service function if needed.
- Modify `backend/services/tagging_service.py`, `backend/model_health.py`, `backend/routers/artists.py`, and `backend/services/censor_service.py`
  - Reuse model path validation rules for model loading paths.
- Modify `backend/database.py` and `backend/services/image_service.py`
  - Fix pagination/count correctness.
- Modify `backend/image_manager.py` and `backend/services/sorting_service.py`
  - Investigate and apply scan performance changes.

### Backend tests

- Modify `backend/tests/test_path_validation.py`.
- Modify `backend/tests/test_routers/test_obfuscation.py`.
- Modify `backend/tests/test_metadata_parser.py` or `backend/tests/test_metadata_parser_errors.py`.
- Modify `backend/tests/test_routers/test_images.py`.
- Modify `backend/tests/test_model_health.py` and/or `backend/tests/test_tagging_service.py`.
- Modify `backend/tests/test_database.py`.
- Modify `backend/tests/test_image_manager.py`.

### Frontend

- Modify `frontend/js/censor-edit.js`
  - Metadata default, warnings, latest-request-wins, mobile settings, SAM3/route gating, model setup guidance.
- Modify `frontend/css/censor-v2.css`
  - Mobile settings button/sidebar/backdrop styling.
- Modify `frontend/index.html`
  - Add missing controls/panels for censor, reader metadata editor, gallery delete/quick select, task scope status.
- Modify `frontend/js/lang/en.js` and `frontend/js/lang/zh-CN.js`
  - Add UI strings in English and Chinese.
- Modify `frontend/js/image-reader.js`
  - Metadata editor and save-as-new flow with format conversion options.
- Modify `frontend/js/gallery.js` and `frontend/js/app.js`
  - Delete selected files, quick select, selection UI, browse duplicate trigger cleanup if located there.
- Modify `frontend/js/similar.js`
  - Missing embeddings/indexing-running guidance.
- Modify `frontend/js/autosep.js` and `frontend/js/manual-sort.js`
  - Explicit saved task scope state and actions.
- Modify `frontend/js/folder-browser.js` only if browse duplicate handling belongs there.

---

## Task 1: Shared image output path validator

**Files:**
- Modify: `backend/utils/path_validation.py`
- Test: `backend/tests/test_path_validation.py`

- [ ] **Step 1: Write failing tests for image output validation**

Add tests like this near existing output path tests in `backend/tests/test_path_validation.py`:

```python
from pathlib import Path

import pytest

from backend.utils.path_validation import PathValidationError, validate_image_output_path


def test_validate_image_output_path_allows_new_png_in_valid_parent(tmp_path):
    output = validate_image_output_path(str(tmp_path / "edited image.png"))

    assert output.path == (tmp_path / "edited image.png").resolve()
    assert output.exists is False
    assert output.extension == ".png"


def test_validate_image_output_path_rejects_non_image_extension(tmp_path):
    with pytest.raises(PathValidationError, match="Unsupported image output extension"):
        validate_image_output_path(str(tmp_path / "payload.txt"))


def test_validate_image_output_path_reports_existing_file_without_overwrite(tmp_path):
    target = tmp_path / "existing.webp"
    target.write_bytes(b"not really webp")

    output = validate_image_output_path(str(target))

    assert output.path == target.resolve()
    assert output.exists is True
    assert output.overwrite_allowed is False


def test_validate_image_output_path_allows_existing_file_only_when_explicit(tmp_path):
    target = tmp_path / "existing.jpg"
    target.write_bytes(b"not really jpg")

    output = validate_image_output_path(str(target), allow_overwrite=True)

    assert output.exists is True
    assert output.overwrite_allowed is True


def test_validate_image_output_path_rejects_output_symlink(tmp_path):
    target = tmp_path / "real.png"
    target.write_bytes(b"data")
    link = tmp_path / "link.png"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation not available")

    with pytest.raises(PathValidationError, match="Output path cannot be a symlink"):
        validate_image_output_path(str(link), allow_overwrite=True)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pytest backend/tests/test_path_validation.py -k image_output_path -v
```

Expected: FAIL because `validate_image_output_path` does not exist or does not enforce these rules.

- [ ] **Step 3: Implement the validator**

Add this focused API to `backend/utils/path_validation.py`, reusing existing `PathValidationError` if present. If the project already has the exception class, do not duplicate it.

```python
from dataclasses import dataclass
from pathlib import Path

ALLOWED_IMAGE_OUTPUT_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})


@dataclass(frozen=True)
class ImageOutputPath:
    path: Path
    parent: Path
    extension: str
    exists: bool
    overwrite_allowed: bool


def validate_image_output_path(output_path: str, allow_overwrite: bool = False) -> ImageOutputPath:
    if not output_path or not output_path.strip():
        raise PathValidationError("Output path is required")

    raw_path = Path(output_path).expanduser()
    extension = raw_path.suffix.lower()
    if extension not in ALLOWED_IMAGE_OUTPUT_EXTENSIONS:
        raise PathValidationError("Unsupported image output extension. Use PNG, JPG, JPEG, or WebP.")

    raw_parent = raw_path.parent
    if not raw_parent.exists() or not raw_parent.is_dir():
        raise PathValidationError("Output folder does not exist")

    if raw_path.is_symlink():
        raise PathValidationError("Output path cannot be a symlink")

    resolved_parent = raw_parent.resolve()
    resolved_path = raw_path.resolve(strict=False)
    if resolved_path.parent != resolved_parent:
        raise PathValidationError("Output path escapes the selected folder")

    return ImageOutputPath(
        path=resolved_path,
        parent=resolved_parent,
        extension=extension,
        exists=resolved_path.exists(),
        overwrite_allowed=allow_overwrite,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pytest backend/tests/test_path_validation.py -k image_output_path -v
```

Expected: PASS.

- [ ] **Step 5: Review before moving on**

Check that the validator does not restrict total library size, does not reject spaces/Chinese characters, and only validates one output path.

---

## Task 2: Wire obfuscation output validation and overwrite behavior

**Files:**
- Modify: `backend/routers/obfuscation.py`
- Test: `backend/tests/test_routers/test_obfuscation.py`

- [ ] **Step 1: Write failing route tests**

Add tests that call the existing obfuscation endpoint or the local validator helper. Use the endpoint if test fixtures already exist; otherwise test `_validate_output_path` directly.

```python
import pytest

from backend.routers.obfuscation import _validate_output_path
from backend.utils.path_validation import PathValidationError


def test_obfuscation_output_rejects_invalid_extension(tmp_path):
    with pytest.raises(PathValidationError, match="Unsupported image output extension"):
        _validate_output_path(str(tmp_path / "out.txt"), allow_overwrite=False)


def test_obfuscation_output_requires_explicit_overwrite_for_existing_file(tmp_path):
    target = tmp_path / "out.png"
    target.write_bytes(b"existing")

    with pytest.raises(PathValidationError, match="already exists"):
        _validate_output_path(str(target), allow_overwrite=False)

    result = _validate_output_path(str(target), allow_overwrite=True)
    assert result == str(target.resolve())
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pytest backend/tests/test_routers/test_obfuscation.py -k "output and overwrite" -v
```

Expected: FAIL because obfuscation does not require explicit overwrite yet.

- [ ] **Step 3: Update request models and helper**

In `backend/routers/obfuscation.py`, add `allow_overwrite: bool = False` to request models that include an output path. Update `_validate_output_path` to call the shared validator.

```python
from backend.utils.path_validation import PathValidationError, validate_image_output_path


def _validate_output_path(output_path: str, allow_overwrite: bool = False) -> str:
    validated = validate_image_output_path(output_path, allow_overwrite=allow_overwrite)
    if validated.exists and not validated.overwrite_allowed:
        raise PathValidationError("Output file already exists. Confirm overwrite before saving.")
    return str(validated.path)
```

Then update endpoint calls:

```python
output_path = _validate_output_path(request.output_path, allow_overwrite=request.allow_overwrite)
```

- [ ] **Step 4: Convert validation errors to clear HTTP errors**

If the router currently catches path errors, preserve the pattern. If not, wrap endpoint validation like this:

```python
try:
    output_path = _validate_output_path(request.output_path, allow_overwrite=request.allow_overwrite)
except PathValidationError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
```

- [ ] **Step 5: Run obfuscation tests**

Run:

```bash
pytest backend/tests/test_routers/test_obfuscation.py -v
```

Expected: PASS.

---

## Task 3: Add upload, base64, image pixel, and metadata guards

**Files:**
- Modify: `backend/routers/images.py`
- Modify: `backend/services/censor_service.py`
- Modify: `backend/metadata_parser.py`
- Test: `backend/tests/test_routers/test_images.py`
- Test: `backend/tests/test_metadata_parser_errors.py`

- [ ] **Step 1: Add failing metadata chunk guard test**

In `backend/tests/test_metadata_parser_errors.py`:

```python
from PIL import Image, PngImagePlugin

from backend.metadata_parser import parse_metadata


def test_metadata_parser_skips_oversized_text_chunk(tmp_path):
    image_path = tmp_path / "oversized_metadata.png"
    image = Image.new("RGB", (8, 8), "white")
    pnginfo = PngImagePlugin.PngInfo()
    pnginfo.add_text("prompt", "{" + ("x" * (8 * 1024 * 1024)) + "}")
    image.save(image_path, pnginfo=pnginfo)

    metadata = parse_metadata(str(image_path))

    assert metadata is not None
    assert metadata.get("metadata_warning") == "metadata chunk too large"
```

- [ ] **Step 2: Run metadata test to verify failure**

Run:

```bash
pytest backend/tests/test_metadata_parser_errors.py -k oversized_text_chunk -v
```

Expected: FAIL because oversized chunks are not guarded or warning shape differs.

- [ ] **Step 3: Implement metadata chunk guard**

In `backend/metadata_parser.py`, add a module constant and helper near parser helpers:

```python
MAX_METADATA_TEXT_CHUNK_BYTES = 8 * 1024 * 1024


def _metadata_text_too_large(value) -> bool:
    if not isinstance(value, str):
        return False
    return len(value.encode("utf-8", errors="ignore")) > MAX_METADATA_TEXT_CHUNK_BYTES
```

Before any `json.loads()` or expensive parser call on PNG/WebP text values, guard:

```python
if _metadata_text_too_large(text_value):
    return {"metadata_warning": "metadata chunk too large"}
```

If the parser returns a richer existing dict shape, merge the warning into that shape rather than replacing unrelated known fields.

- [ ] **Step 4: Add decoded base64 helper tests**

In the existing censor service tests or `backend/tests/test_routers/test_images.py`, add:

```python
import pytest

from backend.services.censor_service import _estimate_base64_decoded_size, _validate_decoded_base64_size


def test_estimate_base64_decoded_size_handles_padding():
    assert _estimate_base64_decoded_size("AAAA") == 3
    assert _estimate_base64_decoded_size("AAA=") == 2
    assert _estimate_base64_decoded_size("AA==") == 1


def test_validate_decoded_base64_size_rejects_large_payload():
    with pytest.raises(ValueError, match="Decoded image payload is too large"):
        _validate_decoded_base64_size("A" * 120, max_decoded_bytes=10)
```

- [ ] **Step 5: Implement decoded base64 guard**

In `backend/services/censor_service.py`, add:

```python
MAX_DECODED_BASE64_IMAGE_BYTES = 80 * 1024 * 1024
MAX_DECODED_IMAGE_PIXELS = 120_000_000


def _estimate_base64_decoded_size(data: str) -> int:
    compact = data.strip()
    if "," in compact and compact.lower().startswith("data:"):
        compact = compact.split(",", 1)[1]
    padding = compact[-2:].count("=") if compact else 0
    return (len(compact) * 3 // 4) - padding


def _validate_decoded_base64_size(data: str, max_decoded_bytes: int = MAX_DECODED_BASE64_IMAGE_BYTES) -> None:
    if _estimate_base64_decoded_size(data) > max_decoded_bytes:
        raise ValueError("Decoded image payload is too large")
```

Call `_validate_decoded_base64_size(data_url)` at the start of `_decode_base64_image()` before `base64.b64decode()`.

- [ ] **Step 6: Add image pixel check**

After opening the decoded image but before converting or saving:

```python
if image.width * image.height > MAX_DECODED_IMAGE_PIXELS:
    raise ValueError("Image dimensions are too large")
```

- [ ] **Step 7: Add upload compressed byte guard**

In `backend/routers/images.py`, near upload parsing:

```python
MAX_COMPRESSED_UPLOAD_BYTES = 128 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024


async def _copy_upload_with_limit(upload_file, destination_path: Path, max_bytes: int = MAX_COMPRESSED_UPLOAD_BYTES) -> int:
    total = 0
    with destination_path.open("wb") as output:
        while True:
            chunk = await upload_file.read(UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail="Uploaded image file is too large")
            output.write(chunk)
    return total
```

Replace any `await file.read()` upload path with `_copy_upload_with_limit()` where practical.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
pytest backend/tests/test_metadata_parser_errors.py backend/tests/test_routers/test_images.py -k "oversized or base64 or upload" -v
```

Expected: PASS.

---

## Task 4: Harden model path validation without removing custom models

**Files:**
- Modify: `backend/model_health.py`
- Modify: `backend/services/tagging_service.py`
- Modify: `backend/services/censor_service.py`
- Modify: `backend/routers/artists.py`
- Test: `backend/tests/test_model_health.py`
- Test: `backend/tests/test_tagging_service.py`

- [ ] **Step 1: Write model path validation tests**

Add to `backend/tests/test_model_health.py`:

```python
import pytest

from backend.model_health import ModelPathError, validate_model_file_path


def test_validate_model_file_path_rejects_invalid_extension(tmp_path):
    model = tmp_path / "model.exe"
    model.write_bytes(b"bad")

    with pytest.raises(ModelPathError, match="Unsupported model extension"):
        validate_model_file_path(str(model), allowed_extensions={".onnx"}, trusted_roots=[tmp_path])


def test_validate_model_file_path_rejects_missing_file(tmp_path):
    with pytest.raises(ModelPathError, match="Model file does not exist"):
        validate_model_file_path(str(tmp_path / "missing.onnx"), allowed_extensions={".onnx"}, trusted_roots=[tmp_path])


def test_validate_model_file_path_rejects_symlink(tmp_path):
    target = tmp_path / "real.onnx"
    target.write_bytes(b"model")
    link = tmp_path / "link.onnx"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation not available")

    with pytest.raises(ModelPathError, match="Model path cannot be a symlink"):
        validate_model_file_path(str(link), allowed_extensions={".onnx"}, trusted_roots=[tmp_path])


def test_validate_model_file_path_allows_trusted_project_model(tmp_path):
    model = tmp_path / "model.onnx"
    model.write_bytes(b"model")

    assert validate_model_file_path(str(model), allowed_extensions={".onnx"}, trusted_roots=[tmp_path]) == model.resolve()


def test_validate_model_file_path_rejects_untrusted_root_without_ack(tmp_path):
    trusted = tmp_path / "trusted"
    external = tmp_path / "external"
    trusted.mkdir()
    external.mkdir()
    model = external / "model.onnx"
    model.write_bytes(b"model")

    with pytest.raises(ModelPathError, match="outside trusted model folders"):
        validate_model_file_path(str(model), allowed_extensions={".onnx"}, trusted_roots=[trusted])
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest backend/tests/test_model_health.py -k validate_model_file_path -v
```

Expected: FAIL because `validate_model_file_path` is missing or incomplete.

- [ ] **Step 3: Implement model path validator**

In `backend/model_health.py`:

```python
from pathlib import Path


class ModelPathError(ValueError):
    pass


def validate_model_file_path(
    model_path: str,
    *,
    allowed_extensions: set[str],
    trusted_roots: list[Path],
    allow_untrusted_ack: bool = False,
) -> Path:
    path = Path(model_path).expanduser()
    if path.suffix.lower() not in allowed_extensions:
        raise ModelPathError("Unsupported model extension")
    if not path.exists():
        raise ModelPathError("Model file does not exist")
    if not path.is_file():
        raise ModelPathError("Model path is not a file")
    if path.is_symlink():
        raise ModelPathError("Model path cannot be a symlink")

    resolved = path.resolve()
    resolved_roots = [root.expanduser().resolve() for root in trusted_roots]
    if not any(resolved == root or root in resolved.parents for root in resolved_roots):
        if not allow_untrusted_ack:
            raise ModelPathError("Model path is outside trusted model folders")

    return resolved
```

- [ ] **Step 4: Wire validator into model-loading paths**

For each custom model path accepted from API/user input, validate with the correct extension set:

```python
validate_model_file_path(
    model_path,
    allowed_extensions={".onnx", ".pt", ".pth", ".safetensors"},
    trusted_roots=[PROJECT_MODELS_DIR, *configured_custom_roots],
    allow_untrusted_ack=request.allow_untrusted_model if the request has that explicit field else False,
)
```

Do not silently enable `allow_untrusted_ack=True`; only pass it from an explicit request/setup flow.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pytest backend/tests/test_model_health.py backend/tests/test_tagging_service.py -k "model_path or custom_model or validate_model" -v
```

Expected: PASS.

---

## Task 5: Fix pagination and count correctness

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/services/image_service.py`
- Test: `backend/tests/test_database.py`

- [ ] **Step 1: Add failing pagination tests**

In `backend/tests/test_database.py`, add tests using existing DB setup helpers. If helpers differ, keep the assertions and adapt only setup names.

```python

def test_unfiltered_offset_pagination_reaches_second_page(test_db):
    ids = [test_db.add_image(f"/tmp/image_{i}.png", metadata={}) for i in range(5)]

    page1 = test_db.get_images(limit=2, offset=0)
    page2 = test_db.get_images(limit=2, offset=2)

    assert [row["id"] for row in page1] != [row["id"] for row in page2]
    assert len(page2) == 2


def test_prompt_terms_post_filter_pagination_does_not_repeat_page_one(test_db):
    for i in range(6):
        prompt = "cat portrait" if i < 4 else "dog portrait"
        test_db.add_image(f"/tmp/prompt_{i}.png", metadata={"prompt": prompt})

    page1 = test_db.get_images(limit=2, offset=0, prompt_terms=["cat"])
    page2 = test_db.get_images(limit=2, offset=2, prompt_terms=["cat"])

    assert len(page1) == 2
    assert len(page2) == 2
    assert {row["id"] for row in page1}.isdisjoint({row["id"] for row in page2})


def test_lora_post_filter_pagination_does_not_repeat_page_one(test_db):
    for i in range(6):
        loras = ["detailer"] if i < 4 else ["other"]
        test_db.add_image(f"/tmp/lora_{i}.png", metadata={"loras": loras})

    page1 = test_db.get_images(limit=2, offset=0, loras=["detailer"])
    page2 = test_db.get_images(limit=2, offset=2, loras=["detailer"])

    assert len(page1) == 2
    assert len(page2) == 2
    assert {row["id"] for row in page1}.isdisjoint({row["id"] for row in page2})


def test_aesthetic_filter_affects_total_count(test_db):
    test_db.add_image("/tmp/low.png", metadata={"aesthetic_score": 3.0})
    test_db.add_image("/tmp/high.png", metadata={"aesthetic_score": 8.5})

    assert test_db.get_filtered_image_count(min_aesthetic=8.0) == 1
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest backend/tests/test_database.py -k "pagination or aesthetic" -v
```

Expected: at least one FAIL for current post-filter/count behavior.

- [ ] **Step 3: Fix count query filters**

In `backend/database.py`, ensure `get_filtered_image_count()` applies all active filters, including min/max aesthetic. The SQL should use parameterized clauses:

```python
if min_aesthetic is not None:
    where_clauses.append("aesthetic_score >= ?")
    params.append(min_aesthetic)
if max_aesthetic is not None:
    where_clauses.append("aesthetic_score <= ?")
    params.append(max_aesthetic)
```

Use the actual column name already used by the project.

- [ ] **Step 4: Fix post-filter pagination semantics**

If prompt/LoRA filters cannot be pushed into SQL, apply offset after collecting matching rows, not before. Use deterministic candidate expansion:

```python
def _page_post_filtered_rows(fetch_candidates, row_matches, *, offset: int, limit: int):
    matches = []
    candidate_offset = 0
    batch_size = max(limit * 4, 200)
    needed = offset + limit + 1

    while len(matches) < needed:
        candidates = fetch_candidates(candidate_offset, batch_size)
        if not candidates:
            break
        matches.extend(row for row in candidates if row_matches(row))
        candidate_offset += len(candidates)
        if len(candidates) < batch_size:
            break

    page = matches[offset : offset + limit]
    has_more = len(matches) > offset + limit
    return page, has_more
```

Adapt this into the existing service/database structure. Do not fetch all rows from a 100k library.

- [ ] **Step 5: Verify service response metadata**

In `backend/services/image_service.py`, ensure `has_more`, `next_offset`, and cursor fields reflect the corrected page result. `limit` remains per-request batch size.

- [ ] **Step 6: Run pagination tests**

Run:

```bash
pytest backend/tests/test_database.py backend/tests/test_routers/test_images.py -k "pagination or aesthetic or has_more or cursor" -v
```

Expected: PASS.

---

## Task 6: Add Single Image Reader metadata editor backend

**Files:**
- Modify: `backend/routers/images.py`
- Modify: `backend/services/image_service.py`
- Test: `backend/tests/test_routers/test_images.py`

- [ ] **Step 1: Write failing API tests for save-as-new metadata edit**

Add to `backend/tests/test_routers/test_images.py`:

```python
from PIL import Image


def test_reader_metadata_edit_saves_new_png_without_overwriting(client, tmp_path):
    source = tmp_path / "source.png"
    output = tmp_path / "source.metadata-edited.png"
    Image.new("RGB", (16, 16), "white").save(source)

    response = client.post("/api/image-metadata/save-edited", json={
        "source_path": str(source),
        "output_path": str(output),
        "format": "png",
        "metadata": {"prompt": "cat", "negative_prompt": "bad", "seed": "123"},
        "allow_overwrite": False,
    })

    assert response.status_code == 200
    assert output.exists()
    assert response.json()["output_path"] == str(output.resolve())


def test_reader_metadata_edit_refuses_existing_output_without_confirmation(client, tmp_path):
    source = tmp_path / "source.png"
    output = tmp_path / "existing.png"
    Image.new("RGB", (16, 16), "white").save(source)
    Image.new("RGB", (16, 16), "black").save(output)

    response = client.post("/api/image-metadata/save-edited", json={
        "source_path": str(source),
        "output_path": str(output),
        "format": "png",
        "metadata": {"prompt": "cat"},
        "allow_overwrite": False,
    })

    assert response.status_code == 409
    assert "already exists" in response.json()["detail"]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pytest backend/tests/test_routers/test_images.py -k image_metadata -v
```

Expected: FAIL because endpoint is missing.

- [ ] **Step 3: Add request/response models**

In `backend/routers/images.py`:

```python
class SaveEditedMetadataRequest(BaseModel):
    source_path: str
    output_path: str
    format: str = "png"
    quality: int | None = None
    metadata: dict[str, str | int | float | None]
    allow_overwrite: bool = False


class SaveEditedMetadataResponse(BaseModel):
    output_path: str
    format: str
    warnings: list[str] = []
```

If Python 3.9 typing rejects `|`, use `Optional` and `Union` imports instead.

- [ ] **Step 4: Implement service function**

In `backend/services/image_service.py`:

```python
from PIL import Image, PngImagePlugin

from backend.utils.path_validation import validate_file_path, validate_image_output_path


def save_image_with_edited_metadata(source_path: str, output_path: str, image_format: str, metadata: dict, allow_overwrite: bool, quality: int | None = None) -> dict:
    source = validate_file_path(source_path)
    output = validate_image_output_path(output_path, allow_overwrite=allow_overwrite)
    if output.exists and not allow_overwrite:
        raise FileExistsError("Output file already exists. Confirm overwrite before saving.")

    normalized_format = image_format.lower()
    if normalized_format not in {"png", "webp", "jpg", "jpeg"}:
        raise ValueError("Unsupported output format")

    warnings = []
    with Image.open(source) as image:
        save_kwargs = {}
        if normalized_format == "png":
            pnginfo = PngImagePlugin.PngInfo()
            for key, value in metadata.items():
                if value is not None:
                    pnginfo.add_text(str(key), str(value))
            save_kwargs["pnginfo"] = pnginfo
            pil_format = "PNG"
        elif normalized_format == "webp":
            save_kwargs["exif"] = image.getexif().tobytes()
            warnings.append("WebP metadata support may vary by viewer.")
            pil_format = "WEBP"
        else:
            warnings.append("JPG metadata support is limited; prompt fields may not be preserved fully.")
            pil_format = "JPEG"
        if quality is not None and normalized_format in {"webp", "jpg", "jpeg"}:
            save_kwargs["quality"] = quality
        image.save(output.path, format=pil_format, **save_kwargs)

    return {"output_path": str(output.path), "format": normalized_format, "warnings": warnings}
```

- [ ] **Step 5: Add router endpoint**

In `backend/routers/images.py`:

```python
@router.post("/image-metadata/save-edited", response_model=SaveEditedMetadataResponse)
async def save_edited_image_metadata(request: SaveEditedMetadataRequest):
    try:
        return image_service.save_image_with_edited_metadata(
            source_path=request.source_path,
            output_path=request.output_path,
            image_format=request.format,
            metadata=request.metadata,
            allow_overwrite=request.allow_overwrite,
            quality=request.quality,
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
```

Use the actual imported service object/function style in this router.

- [ ] **Step 6: Run endpoint tests**

Run:

```bash
pytest backend/tests/test_routers/test_images.py -k image_metadata -v
```

Expected: PASS.

---

## Task 7: Add Single Image Reader metadata editor frontend

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/image-reader.js`
- Modify: `frontend/js/lang/en.js`
- Modify: `frontend/js/lang/zh-CN.js`

- [ ] **Step 1: Add static UI controls**

In `frontend/index.html`, inside the Single Image Reader result panel, add a collapsed metadata editor section:

```html
<section id="reader-metadata-editor" class="reader-editor hidden">
  <h3 data-i18n="reader.editMetadata">Edit metadata</h3>
  <label>Prompt<textarea id="reader-edit-prompt"></textarea></label>
  <label>Negative prompt<textarea id="reader-edit-negative"></textarea></label>
  <label>Seed<input id="reader-edit-seed" type="text"></label>
  <label>Model<input id="reader-edit-model" type="text"></label>
  <label>Sampler<input id="reader-edit-sampler" type="text"></label>
  <label>Steps<input id="reader-edit-steps" type="number" min="0"></label>
  <label>CFG<input id="reader-edit-cfg" type="number" step="0.1" min="0"></label>
  <label>Output format
    <select id="reader-edit-format">
      <option value="png">PNG</option>
      <option value="webp">WebP</option>
      <option value="jpg">JPG</option>
    </select>
  </label>
  <label>Output path<input id="reader-edit-output-path" type="text"></label>
  <p id="reader-edit-format-warning" class="warning-text hidden"></p>
  <button id="reader-save-metadata-as" type="button" data-i18n="reader.saveAsNewImage">Save as new image</button>
</section>
```

Use existing classes if equivalent styles exist.

- [ ] **Step 2: Add reader state and fill helper**

In `frontend/js/image-reader.js`, add state fields near the existing reader state object:

```javascript
metadataEditor: {
  sourcePath: null,
  originalOutputPath: null,
}
```

Add helper:

```javascript
function buildSuggestedMetadataOutputPath(sourcePath, format) {
  const dotIndex = sourcePath.lastIndexOf('.')
  const base = dotIndex >= 0 ? sourcePath.slice(0, dotIndex) : sourcePath
  return `${base}.metadata-edited.${format}`
}
```

- [ ] **Step 3: Populate editor from parse result**

After `_renderResult` has normalized metadata available, set fields:

```javascript
function populateMetadataEditor(result) {
  const metadata = result?.metadata || {}
  document.getElementById('reader-edit-prompt').value = metadata.prompt || ''
  document.getElementById('reader-edit-negative').value = metadata.negative_prompt || metadata.negative || ''
  document.getElementById('reader-edit-seed').value = metadata.seed || ''
  document.getElementById('reader-edit-model').value = metadata.model || metadata.checkpoint || ''
  document.getElementById('reader-edit-sampler').value = metadata.sampler || ''
  document.getElementById('reader-edit-steps').value = metadata.steps || ''
  document.getElementById('reader-edit-cfg').value = metadata.cfg_scale || metadata.cfg || ''
  document.getElementById('reader-metadata-editor').classList.remove('hidden')
}
```

- [ ] **Step 4: Add format warning behavior**

```javascript
function updateReaderMetadataFormatWarning() {
  const format = document.getElementById('reader-edit-format').value
  const warning = document.getElementById('reader-edit-format-warning')
  if (format === 'jpg') {
    warning.textContent = 'JPG metadata support is limited; prompt fields may not be preserved fully.'
    warning.classList.remove('hidden')
    return
  }
  if (format === 'webp') {
    warning.textContent = 'WebP metadata support may vary by viewer.'
    warning.classList.remove('hidden')
    return
  }
  warning.textContent = ''
  warning.classList.add('hidden')
}
```

- [ ] **Step 5: Add save-as-new request**

```javascript
async function saveReaderMetadataAsNewImage({ allowOverwrite = false } = {}) {
  const sourcePath = ReaderState.metadataEditor.sourcePath
  const outputPath = document.getElementById('reader-edit-output-path').value.trim()
  const payload = {
    source_path: sourcePath,
    output_path: outputPath,
    format: document.getElementById('reader-edit-format').value,
    metadata: {
      prompt: document.getElementById('reader-edit-prompt').value,
      negative_prompt: document.getElementById('reader-edit-negative').value,
      seed: document.getElementById('reader-edit-seed').value,
      model: document.getElementById('reader-edit-model').value,
      sampler: document.getElementById('reader-edit-sampler').value,
      steps: document.getElementById('reader-edit-steps').value,
      cfg_scale: document.getElementById('reader-edit-cfg').value,
    },
    allow_overwrite: allowOverwrite,
  }

  const response = await fetch('/api/image-metadata/save-edited', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (response.status === 409 && !allowOverwrite) {
    const confirmed = await window.App.showConfirm(
      'Overwrite existing image?',
      `This will replace ${outputPath}. Save as a different file if you do not want to overwrite it.`
    )
    if (confirmed) {
      return saveReaderMetadataAsNewImage({ allowOverwrite: true })
    }
    return null
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to save edited metadata.' }))
    throw new Error(error.detail || 'Failed to save edited metadata.')
  }

  return response.json()
}
```

If `showConfirm` uses callback style, adapt the call to the existing modal API instead of introducing a new modal.

- [ ] **Step 6: Manually smoke the reader flow**

Run the app, open a PNG with metadata, edit prompt, save as PNG, save as WebP, save as JPG, and attempt to overwrite the original path. Expected: default save-as works; JPG/WebP warnings appear; overwrite requires confirmation and can be canceled.

---

## Task 8: Censor metadata default, latest-request-wins, mobile settings, and route gating

**Files:**
- Modify: `frontend/js/censor-edit.js`
- Modify: `frontend/css/censor-v2.css`
- Modify: `frontend/index.html`
- Modify: `frontend/js/lang/en.js`
- Modify: `frontend/js/lang/zh-CN.js`

- [ ] **Step 1: Change default metadata save mode to strip**

In `frontend/js/censor-edit.js`, locate save option state. Set default to strip metadata, not keep metadata:

```javascript
saveOptions: {
  metadataMode: 'strip',
}
```

If the existing field is named differently, keep existing name and set the value that maps to Strip All Metadata.

- [ ] **Step 2: Add keep-metadata warning**

Add handler:

```javascript
function updateMetadataPrivacyWarning() {
  const warning = document.getElementById('censor-metadata-warning')
  const keepMetadata = getSelectedMetadataMode() === 'keep'
  warning.textContent = keepMetadata
    ? 'Original prompt/model/seed metadata may be preserved.'
    : ''
  warning.classList.toggle('hidden', !keepMetadata)
}
```

Wire it to metadata mode radio/select changes.

- [ ] **Step 3: Add latest request state**

In `CensorState`:

```javascript
latestLoadRequestId: 0,
pendingLoadImageId: null,
```

- [ ] **Step 4: Modify `loadCanvasImage()` to ignore stale loads**

At the start of `loadCanvasImage(imageId)`:

```javascript
const requestId = CensorState.latestLoadRequestId + 1
CensorState.latestLoadRequestId = requestId
CensorState.pendingLoadImageId = imageId
```

Before mutating canvas, selected items, current image, or history after any await:

```javascript
if (requestId !== CensorState.latestLoadRequestId) {
  return
}
```

Only finalize selection after the newest image has loaded:

```javascript
if (requestId === CensorState.latestLoadRequestId) {
  CensorState.currentImageId = imageId
  CensorState.pendingLoadImageId = null
  syncQueueSelection(imageId)
}
```

- [ ] **Step 5: Add mobile settings controls**

In `frontend/index.html`, add:

```html
<button id="censor-mobile-settings-toggle" class="censor-mobile-settings-button" type="button">Settings</button>
<div id="censor-settings-backdrop" class="censor-settings-backdrop hidden"></div>
```

In `frontend/js/censor-edit.js`:

```javascript
function openCensorMobileSettings() {
  document.querySelector('.censor-right-panel')?.classList.add('mobile-visible')
  document.getElementById('censor-settings-backdrop')?.classList.remove('hidden')
}

function closeCensorMobileSettings() {
  document.querySelector('.censor-right-panel')?.classList.remove('mobile-visible')
  document.getElementById('censor-settings-backdrop')?.classList.add('hidden')
}
```

Bind button, backdrop, and Escape key.

- [ ] **Step 6: Split detector/SAM3 labels and no-box refine guard**

Rename refine button text to `Refine Existing Detection Boxes` and Chinese `精修已有检测框`.

Before refine execution:

```javascript
if (!CensorState.boxes || CensorState.boxes.length === 0) {
  showCensorInlineMessage('Refine Existing Detection Boxes only improves boxes you already detected. Use Detect first or run One-click Auto Censor.')
  return
}
```

- [ ] **Step 7: Add non-silent route switch confirmation**

Before Quick Auto Censor runs:

```javascript
if (!isSelectedRouteRecommendedForAutoCensor()) {
  showRouteSwitchPrompt({
    message: 'The selected route is not recommended for privacy auto-censor. Switch to the recommended privacy route and continue?',
    onConfirm: () => {
      selectRecommendedPrivacyRoute()
      runQuickAutoCensor()
    },
  })
  return
}
```

Do not call `selectRecommendedPrivacyRoute()` without user confirmation.

- [ ] **Step 8: Manual smoke test**

Test rapid queue clicks, rapid left/right, switching while loading, metadata default strip, keep warning, mobile settings open/close, SAM3 refine no boxes, and route switch confirmation.

---

## Task 9: Model setup panel for YOLO/SAM3

**Files:**
- Modify: `backend/model_health.py`
- Modify: `backend/routers/models.py`
- Modify: `frontend/js/censor-edit.js`
- Modify: `frontend/index.html`
- Modify: `frontend/js/lang/en.js`
- Modify: `frontend/js/lang/zh-CN.js`
- Test: `backend/tests/test_model_health.py`

- [ ] **Step 1: Add backend status test**

```python
from backend.model_health import build_censor_model_setup_status


def test_censor_model_setup_status_reports_missing_yolo_and_sam3(tmp_path):
    status = build_censor_model_setup_status(models_root=tmp_path)

    assert status["yolo"]["installed"] is False
    assert "destination_folder" in status["yolo"]
    assert status["sam3"]["installed"] is False
    assert "accepted_extensions" in status["sam3"]
```

- [ ] **Step 2: Implement model setup status helper**

In `backend/model_health.py`:

```python
def build_censor_model_setup_status(models_root: Path) -> dict:
    yolo_root = models_root / "yolo"
    sam3_root = models_root / "sam3"
    yolo_files = list(yolo_root.glob("*.onnx")) + list(yolo_root.glob("*.pt")) if yolo_root.exists() else []
    sam3_files = list(sam3_root.glob("*.pt")) + list(sam3_root.glob("*.safetensors")) if sam3_root.exists() else []
    return {
        "yolo": {
            "installed": bool(yolo_files),
            "path": str(yolo_files[0]) if yolo_files else None,
            "destination_folder": str(yolo_root),
            "accepted_extensions": [".onnx", ".pt"],
        },
        "sam3": {
            "installed": bool(sam3_files),
            "path": str(sam3_files[0]) if sam3_files else None,
            "destination_folder": str(sam3_root),
            "accepted_extensions": [".pt", ".safetensors"],
        },
    }
```

- [ ] **Step 3: Add API endpoint or extend existing model status endpoint**

In `backend/routers/models.py`, add:

```python
@router.get("/censor/setup-status")
async def get_censor_setup_status():
    return build_censor_model_setup_status(PROJECT_MODELS_DIR)
```

Use the actual models directory constant in the file.

- [ ] **Step 4: Add frontend panel**

In `frontend/index.html` near censor model controls:

```html
<section id="censor-model-setup-panel" class="model-setup-panel">
  <h3>Model setup</h3>
  <div id="censor-yolo-status"></div>
  <div id="censor-sam3-status"></div>
  <button id="censor-rescan-models" type="button">Rescan models</button>
</section>
```

- [ ] **Step 5: Load and render setup status**

In `frontend/js/censor-edit.js`:

```javascript
async function loadCensorSetupStatus() {
  const response = await fetch('/api/models/censor/setup-status')
  if (!response.ok) throw new Error('Failed to load censor model setup status')
  const status = await response.json()
  renderCensorSetupStatus(status)
}

function renderCensorSetupStatus(status) {
  renderModelStatusLine('censor-yolo-status', 'YOLO', status.yolo)
  renderModelStatusLine('censor-sam3-status', 'SAM3', status.sam3)
}

function renderModelStatusLine(elementId, label, modelStatus) {
  const element = document.getElementById(elementId)
  const installed = modelStatus.installed ? 'Installed' : 'Missing'
  const path = modelStatus.path || modelStatus.destination_folder
  element.textContent = `${label}: ${installed}. Folder: ${path}. Accepted: ${modelStatus.accepted_extensions.join(', ')}`
}
```

- [ ] **Step 6: Gate dead-end buttons**

If YOLO missing, disable auto-censor/detect buttons requiring YOLO and set title/help text:

```javascript
button.disabled = true
button.title = `YOLO model is missing. Place .onnx or .pt model files in ${status.yolo.destination_folder}, then click Rescan models.`
```

- [ ] **Step 7: Run backend test and manual UI check**

Run:

```bash
pytest backend/tests/test_model_health.py -k censor_model_setup_status -v
```

Expected: PASS. Then open censor UI with missing model folder and confirm exact guidance appears.

---

## Task 10: Similarity missing-index guidance

**Files:**
- Modify: `frontend/js/similar.js`
- Modify: `frontend/js/lang/en.js`
- Modify: `frontend/js/lang/zh-CN.js`
- Test: existing E2E/manual smoke

- [ ] **Step 1: Add state renderer helper**

In `frontend/js/similar.js`:

```javascript
function getSimilarityIndexState(stats) {
  if (stats.indexing && stats.indexing.status === 'running') return 'indexing'
  if (!stats.total_embeddings || stats.total_embeddings === 0) return 'missing'
  return 'ready'
}
```

- [ ] **Step 2: Render missing-index call to action**

```javascript
function renderSimilarityIndexGuidance(stats) {
  const state = getSimilarityIndexState(stats)
  const panel = document.getElementById('similarity-index-guidance')
  const searchButtons = document.querySelectorAll('[data-similarity-search]')

  if (state === 'ready') {
    panel.classList.add('hidden')
    searchButtons.forEach((button) => { button.disabled = false })
    return
  }

  panel.classList.remove('hidden')
  searchButtons.forEach((button) => { button.disabled = true })

  if (state === 'indexing') {
    panel.textContent = `Indexing is running: ${stats.indexing.current || 0}/${stats.indexing.total || 0}`
    return
  }

  panel.innerHTML = '<p>Similarity search needs indexing first.</p><button id="start-similarity-indexing" type="button">Start indexing</button>'
}
```

- [ ] **Step 3: Wire Start indexing button**

Bind the button to the existing embeddings/indexing endpoint. If no function exists, add a thin wrapper using the existing API route already used elsewhere:

```javascript
async function startSimilarityIndexing() {
  const response = await fetch('/api/similarity/compute-embeddings', { method: 'POST' })
  if (!response.ok) throw new Error('Failed to start similarity indexing')
  await loadStats()
}
```

Use the actual endpoint name from `backend/routers/similarity.py`.

- [ ] **Step 4: Manual smoke**

Test three states: no embeddings, indexing running, embeddings ready. Expected: search disabled only for missing/running; ready search stays fast.

---

## Task 11: Auto-Separate and Manual Sort saved scope UI

**Files:**
- Modify: `frontend/js/autosep.js`
- Modify: `frontend/js/manual-sort.js`
- Modify: `frontend/index.html`
- Modify: `frontend/js/lang/en.js`
- Modify: `frontend/js/lang/zh-CN.js`

- [ ] **Step 1: Add scope status containers**

In `frontend/index.html`, add containers in Auto-Separate and Manual Sort panels:

```html
<div id="autosep-scope-status" class="task-scope-status"></div>
<button id="autosep-use-gallery-filters" type="button">Use current Gallery filters</button>
<button id="autosep-resync-gallery-filters" type="button">Resync from Gallery</button>
<button id="autosep-keep-saved-scope" type="button">Keep using saved task scope</button>

<div id="manual-sort-scope-status" class="task-scope-status"></div>
<button id="manual-sort-use-gallery-filters" type="button">Use current Gallery filters</button>
<button id="manual-sort-resync-gallery-filters" type="button">Resync from Gallery</button>
<button id="manual-sort-keep-saved-scope" type="button">Keep using saved task scope</button>
```

- [ ] **Step 2: Add scope timestamp state**

In both `AutoSepState` and `ManualSortState`, add:

```javascript
scopeSyncedAt: null,
usingSavedScope: true,
```

Persist `scopeSyncedAt` in the same localStorage record as saved filters.

- [ ] **Step 3: Render Auto-Separate scope status**

```javascript
function renderAutoSepScopeStatus() {
  const element = document.getElementById('autosep-scope-status')
  const time = AutoSepState.scopeSyncedAt ? new Date(AutoSepState.scopeSyncedAt).toLocaleString() : 'not synced yet'
  element.textContent = `Using saved Auto-Separate scope. Synced from current Gallery filters at ${time}.`
}
```

- [ ] **Step 4: Render Manual Sort scope status**

```javascript
function renderManualSortScopeStatus() {
  const element = document.getElementById('manual-sort-scope-status')
  const time = ManualSortState.scopeSyncedAt ? new Date(ManualSortState.scopeSyncedAt).toLocaleString() : 'not synced yet'
  element.textContent = `Using saved Manual Sort scope. Synced from current Gallery filters at ${time}.`
}
```

- [ ] **Step 5: Wire resync actions**

For each workflow:

```javascript
function resyncAutoSepScopeFromGallery() {
  AutoSepState.filters = structuredClone(window.AppState.filters)
  AutoSepState.scopeSyncedAt = new Date().toISOString()
  AutoSepState.usingSavedScope = true
  saveAutoSepFilters()
  renderAutoSepScopeStatus()
}
```

Use object spread/JSON clone if `structuredClone` is unavailable in target browsers.

- [ ] **Step 6: Include scope in preview/execution summaries**

When rendering preview and before executing destructive actions, include:

```javascript
summary.scope = {
  type: 'saved_task_scope',
  synced_at: AutoSepState.scopeSyncedAt,
}
```

For frontend-only summaries, display this text near the preview/confirm modal.

- [ ] **Step 7: Manual smoke**

Set Gallery filters, enter Auto-Separate, verify saved scope text; change Gallery filters, verify task scope does not silently change; click Resync and verify timestamp updates. Repeat for Manual Sort.

---

## Task 12: Gallery delete selected files and quick select

**Files:**
- Modify: `backend/routers/images.py` or `backend/routers/sorting.py`
- Modify: `backend/image_manager.py`
- Modify: `backend/database.py`
- Modify: `frontend/js/gallery.js`
- Modify: `frontend/js/app.js`
- Modify: `frontend/index.html`
- Test: `backend/tests/test_routers/test_images.py`

- [ ] **Step 1: Add backend delete selected test**

```python
from PIL import Image


def test_delete_selected_images_removes_files_and_database_rows(client, test_db, tmp_path):
    path = tmp_path / "delete_me.png"
    Image.new("RGB", (8, 8), "white").save(path)
    image_id = test_db.add_image(str(path), metadata={})

    response = client.post("/api/images/delete-selected", json={"image_ids": [image_id], "confirm_delete_files": True})

    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] == 1
    assert not path.exists()
    assert test_db.get_image(image_id) is None
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pytest backend/tests/test_routers/test_images.py -k delete_selected -v
```

Expected: FAIL because endpoint is missing.

- [ ] **Step 3: Implement backend endpoint**

Add request/response models:

```python
class DeleteSelectedImagesRequest(BaseModel):
    image_ids: list[int]
    confirm_delete_files: bool = False


class DeleteSelectedImagesResponse(BaseModel):
    deleted: int
    failed: list[dict]
    permanent_delete: bool = True
```

Endpoint:

```python
@router.post("/images/delete-selected", response_model=DeleteSelectedImagesResponse)
async def delete_selected_images(request: DeleteSelectedImagesRequest):
    if not request.confirm_delete_files:
        raise HTTPException(status_code=400, detail="Deleting image files requires explicit confirmation")
    return image_service.delete_selected_image_files(request.image_ids)
```

- [ ] **Step 4: Implement service delete with partial failures**

```python
def delete_selected_image_files(image_ids: list[int]) -> dict:
    deleted = 0
    failed = []
    for image_id in image_ids:
        row = db.get_image(image_id)
        if not row:
            failed.append({"image_id": image_id, "error": "Image not found"})
            continue
        try:
            Path(row["path"]).unlink()
            db.delete_image(image_id)
            deleted += 1
        except Exception as exc:
            failed.append({"image_id": image_id, "filename": Path(row["path"]).name, "error": str(exc)})
    return {"deleted": deleted, "failed": failed, "permanent_delete": True}
```

If OS trash support already exists or is added, replace `unlink()` with trash move and set `permanent_delete=False`.

- [ ] **Step 5: Add Gallery buttons**

In `frontend/index.html` select-mode toolbar:

```html
<button id="gallery-select-visible" type="button">Select all visible</button>
<button id="gallery-invert-visible" type="button">Invert visible</button>
<button id="gallery-deselect-all" type="button">Deselect all</button>
<button id="gallery-delete-selected" class="danger-button" type="button">Delete selected image files</button>
```

- [ ] **Step 6: Implement quick select helpers**

In `frontend/js/gallery.js`:

```javascript
function selectAllVisibleGalleryItems() {
  document.querySelectorAll('.gallery-item[data-image-id]').forEach((item) => {
    window.AppState.selectedImages.add(Number(item.dataset.imageId))
  })
  window.App.updateSelectionUI()
}

function invertVisibleGallerySelection() {
  document.querySelectorAll('.gallery-item[data-image-id]').forEach((item) => {
    const id = Number(item.dataset.imageId)
    if (window.AppState.selectedImages.has(id)) {
      window.AppState.selectedImages.delete(id)
    } else {
      window.AppState.selectedImages.add(id)
    }
  })
  window.App.updateSelectionUI()
}

function deselectAllGalleryItems() {
  window.AppState.selectedImages.clear()
  window.App.updateSelectionUI()
}
```

- [ ] **Step 7: Implement shift-click range**

Track last clicked id/index:

```javascript
let lastSelectedGalleryIndex = null

function handleGallerySelectionClick(event, imageId, index) {
  if (event.shiftKey && lastSelectedGalleryIndex !== null) {
    selectGalleryRange(lastSelectedGalleryIndex, index)
  } else {
    toggleSelection(imageId)
  }
  lastSelectedGalleryIndex = index
}
```

- [ ] **Step 8: Implement delete confirmation frontend**

```javascript
async function deleteSelectedGalleryImages() {
  const ids = Array.from(window.AppState.selectedImages)
  if (ids.length === 0) return
  const examples = ids.slice(0, 5).map((id) => getImageFilenameById(id)).join(', ')
  const confirmed = await window.App.showConfirm(
    'Delete selected image files?',
    `This deletes ${ids.length} files from disk permanently. Examples: ${examples}`
  )
  if (!confirmed) return

  const response = await fetch('/api/images/delete-selected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_ids: ids, confirm_delete_files: true }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail || 'Failed to delete selected image files')
  showDeleteSummary(result)
  result.failed.forEach((failure) => window.AppState.selectedImages.delete(failure.image_id))
  await window.App.loadImages({ reset: true })
}
```

- [ ] **Step 9: Run tests and manual smoke**

Run:

```bash
pytest backend/tests/test_routers/test_images.py -k delete_selected -v
```

Then manually test select visible, invert visible, deselect, shift-click, delete cancel, delete confirm, and partial failure summary.

---

## Task 13: Browse duplicate trigger cleanup

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/app.js`
- Modify: `frontend/js/autosep.js`
- Modify: `frontend/js/manual-sort.js`
- Modify: `frontend/js/folder-browser.js` if needed

- [ ] **Step 1: Search for duplicate browse handlers**

Run:

```bash
python - <<'PY'
from pathlib import Path
for path in Path('frontend').rglob('*.js'):
    text = path.read_text(encoding='utf-8')
    if 'browse' in text.lower() or 'showFolderBrowser' in text:
        print(path)
PY
```

Expected: list includes folder browser, app, autosep, manual-sort.

- [ ] **Step 2: Remove inline duplicate handlers**

In `frontend/index.html`, remove `onclick` / `onmousedown` from browse buttons where a JS listener exists. Keep stable IDs.

- [ ] **Step 3: Centralize listener guard**

For each browse button binding:

```javascript
const browseButton = document.getElementById('scan-browse-button')
if (browseButton && !browseButton.dataset.boundBrowse) {
  browseButton.dataset.boundBrowse = 'true'
  browseButton.addEventListener('click', () => window.FolderBrowser.showFolderBrowser({ targetInputId: 'scan-folder-path' }))
}
```

Use the actual button IDs and existing folder browser API.

- [ ] **Step 4: Manual smoke**

Click browse rapidly in Gallery scan, Auto-Separate, and Manual Sort. Expected: one folder browser action per click, no double request/flicker.

---

## Task 14: First scan performance investigation and safe improvements

**Files:**
- Modify: `backend/image_manager.py`
- Modify: `backend/services/sorting_service.py`
- Modify: `backend/database.py`
- Modify: `frontend/js/app.js`
- Test: `backend/tests/test_image_manager.py`

- [ ] **Step 1: Add scan stage fields to progress tests**

In `backend/tests/test_image_manager.py`, add or adapt:

```python

def test_scan_progress_reports_stages(tmp_path):
    progress_events = []

    def on_progress(event):
        progress_events.append(event)

    scan_folder(str(tmp_path), progress_callback=on_progress)

    stages = {event.get('stage') for event in progress_events if isinstance(event, dict)}
    assert 'discovering' in stages or 'finished' in stages
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pytest backend/tests/test_image_manager.py -k scan_progress_reports_stages -v
```

Expected: FAIL if progress callback does not include stage dicts.

- [ ] **Step 3: Add progress stages without changing scan semantics**

In `backend/image_manager.py`, emit progress events like:

```python
progress_callback({"stage": "discovering", "current": discovered, "total": None})
progress_callback({"stage": "reading_metadata", "current": processed, "total": total})
progress_callback({"stage": "updating_database", "current": processed, "total": total})
progress_callback({"stage": "finished", "current": total, "total": total})
```

If the existing callback expects positional values, preserve it by accepting both shapes in the service adapter.

- [ ] **Step 4: Batch DB writes where existing API supports it**

Inspect `backend/database.py` for transaction helpers. If none exist, add a minimal context manager:

```python
@contextmanager
def transaction(self):
    try:
        self.conn.execute('BEGIN')
        yield
        self.conn.commit()
    except Exception:
        self.conn.rollback()
        raise
```

Wrap scan insert/update batches in a transaction. Do not keep huge in-memory image lists; batch in small chunks.

- [ ] **Step 5: Skip unchanged files using path + mtime + size**

Before parsing metadata for a file, check existing DB row fields if available:

```python
if existing and existing['mtime'] == stat.st_mtime and existing['file_size'] == stat.st_size:
    mark_skipped_unchanged()
    continue
```

If DB columns are missing, add a migration only if the project already has schema migration patterns; otherwise defer this substep and document why in the final summary.

- [ ] **Step 6: Update frontend progress labels**

In `frontend/js/app.js`, update scan progress rendering to show stage:

```javascript
const stageLabel = {
  discovering: 'Discovering files',
  reading_metadata: 'Reading metadata',
  updating_database: 'Updating database',
  finished: 'Finished',
}[progress.stage] || progress.message || 'Scanning'
```

- [ ] **Step 7: Run scan tests**

Run:

```bash
pytest backend/tests/test_image_manager.py backend/tests/test_routers/test_sorting.py -k scan -v
```

Expected: PASS.

---

## Task 15: Final integration checks and reviews

**Files:**
- Review all modified files.

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
pytest backend/tests/test_path_validation.py backend/tests/test_routers/test_obfuscation.py backend/tests/test_metadata_parser_errors.py backend/tests/test_routers/test_images.py backend/tests/test_model_health.py backend/tests/test_tagging_service.py backend/tests/test_database.py backend/tests/test_image_manager.py -v
```

Expected: PASS.

- [ ] **Step 2: Run broader CI if practical**

Run:

```bash
python scripts/run_ci.py
```

Expected: PASS. If it fails, fix the root cause rather than bypassing checks.

- [ ] **Step 3: Run JS syntax check**

If no npm script exists, run a syntax-only check with the available runtime:

```bash
node --check frontend/js/censor-edit.js
node --check frontend/js/image-reader.js
node --check frontend/js/gallery.js
node --check frontend/js/app.js
node --check frontend/js/similar.js
node --check frontend/js/autosep.js
node --check frontend/js/manual-sort.js
```

Expected: all commands exit 0.

- [ ] **Step 4: Start app and browser-smoke UI changes**

Run the app using the project’s normal launcher, then smoke these flows:

- Censor rapid queue clicks.
- Censor rapid keyboard navigation.
- Censor keep metadata warning and default strip metadata.
- Censor missing YOLO/SAM3 guidance.
- Censor SAM3 refine with no boxes.
- Censor quick auto-censor route switch prompt.
- Reader metadata edit save-as PNG/WebP/JPG.
- Reader attempted original overwrite cancel.
- Gallery select visible, invert visible, deselect all, shift range.
- Gallery delete selected cancel and confirm on disposable files.
- Similarity no embeddings and indexing-running states.
- Auto-Separate and Manual Sort saved scope display/resync.
- Browse buttons do not duplicate-trigger.

- [ ] **Step 5: Request code review**

Use the project-required reviewers:

- code-reviewer for all changed code,
- python-reviewer for backend Python,
- security-reviewer for output paths, uploads, model paths, deletes, and overwrite behavior.

- [ ] **Step 6: Fix critical/high review findings**

Address CRITICAL and HIGH findings before reporting completion. Fix MEDIUM findings when they are local and low-risk.

- [ ] **Step 7: Final summary**

Report:

- bugs fixed,
- architectures preserved,
- UX changes,
- limits added and why they do not weaken 1TB/100k-image workflows,
- tests/checks run,
- remaining risks or manual-only verification gaps.
