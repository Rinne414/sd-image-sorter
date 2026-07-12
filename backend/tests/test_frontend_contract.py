"""
Frontend contract tests that guard shared state boundaries.
"""

from __future__ import annotations

import os
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


FORBIDDEN_APPSTATE_ASSIGN_RE = re.compile(
    r"(?:window\.)?(?:App\.)?AppState\.[A-Za-z_][A-Za-z0-9_]*\s*=",
    re.MULTILINE,
)
FORBIDDEN_WINDOW_APP_ASSIGN_RE = re.compile(
    r"window\.App\.[A-Za-z_$][A-Za-z0-9_$]*\s*=(?!=)",
    re.MULTILINE,
)

ALLOWED_DIRECT_WRITER_FILES = {"app.js", "gallery.js"}
SKIPPED_DIRS = {"__pycache__", "node_modules"}


def _iter_frontend_js_files(frontend_root: Path):
    for root, dirs, files in os.walk(frontend_root):
        dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
        root_path = Path(root)
        for filename in files:
            if filename.endswith(".js"):
                yield root_path / filename


def test_frontend_feature_modules_do_not_directly_assign_appstate():
    repo_root = Path(__file__).resolve().parents[2]
    frontend_root = repo_root / "frontend" / "js"
    violations: list[str] = []

    for file_path in sorted(_iter_frontend_js_files(frontend_root)):
        if file_path.name in ALLOWED_DIRECT_WRITER_FILES:
            continue
        source = file_path.read_text(encoding="utf-8")
        for match in FORBIDDEN_APPSTATE_ASSIGN_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            relative_path = file_path.relative_to(repo_root).as_posix()
            violations.append(f"{relative_path}:{line_number}: {match.group(0)}")

    assert not violations, (
        "Feature modules must not directly assign `AppState.*`.\n"
        "Use narrow app APIs (for example `markGalleryNeedsRefresh`) instead.\n"
        + "\n".join(violations)
    )

def test_frontend_feature_modules_do_not_mutate_window_app_namespace():
    repo_root = Path(__file__).resolve().parents[2]
    frontend_root = repo_root / "frontend" / "js"
    violations: list[str] = []

    for file_path in sorted(_iter_frontend_js_files(frontend_root)):
        if file_path.name == "app.js":
            continue
        source = file_path.read_text(encoding="utf-8")
        for match in FORBIDDEN_WINDOW_APP_ASSIGN_RE.finditer(source):
            line_number = source.count("\n", 0, match.start()) + 1
            relative_path = file_path.relative_to(repo_root).as_posix()
            violations.append(f"{relative_path}:{line_number}: {match.group(0)}")

    assert not violations, (
        "Feature modules must not mutate `window.App.*`; use named module bridges or narrow app APIs.\n"
        + "\n".join(violations)
    )


def test_window_app_context_is_sealed_after_creation():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "window.App = buildAppContext();" in source
    assert "Object.seal(window.App);" in source


def test_load_images_options_are_passed_as_second_argument():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "loadImages({" not in source
    assert "loadImages(false, {" in source


def test_cancelled_gallery_load_marks_refresh_intent():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "function cancelGalleryImageLoad()" in source
    assert "hadPendingGalleryLoad" in source
    assert "AppState.galleryNeedsRefresh = true;" in source


def test_selection_store_clears_filtered_token_for_non_filtered_scopes():
    if shutil.which("node") is None:
        return

    repo_root = Path(__file__).resolve().parents[2]
    script = f"""
const fs = require('fs');
global.window = {{}};
const source = fs.readFileSync({str(repo_root / 'frontend' / 'js' / 'stores' / 'selection-store.js')!r}, 'utf8');
eval(source);
const visibleState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'visible',
  filterKey: 'stale-filter',
  selectionToken: 'stale-token',
}});
if (visibleState.filterKey !== null || visibleState.selectionToken !== null) {{
  throw new Error('visible selection retained filtered token state');
}}
const loadedState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'loaded',
  filterKey: 'stale-filter',
  selectionToken: 'stale-token',
}});
if (loadedState.filterKey !== null || loadedState.selectionToken !== null) {{
  throw new Error('loaded selection retained filtered token state');
}}
const filteredState = window.SelectionStore.cloneState({{
  selectionMode: true,
  selectedIds: [1, 2],
  scope: 'filtered',
  filterKey: 'active-filter',
  selectionToken: 'active-token',
}});
if (filteredState.filterKey !== 'active-filter' || filteredState.selectionToken !== 'active-token') {{
  throw new Error('filtered selection lost active token state');
}}
"""
    subprocess.run(["node", "-e", script], check=True)


def test_v321_modules_read_runtime_selection_store_from_window_app():
    repo_root = Path(__file__).resolve().parents[2]
    v321_source = (repo_root / "frontend" / "js" / "v321-ui.js").read_text(encoding="utf-8")
    vlm_source = (repo_root / "frontend" / "js" / "vlm-caption.js").read_text(encoding="utf-8")

    combined_source = v321_source + "\n" + vlm_source
    assert "window.SelectionStore?.getSelectedIds" not in combined_source
    assert "window.SelectionStore.getSelectedIds" not in combined_source
    assert "window.App?.SelectionStore?.getState?.()" in combined_source
    assert "/api/tags/export-combined" in v321_source
    assert "_buildCombinedExportPayload" in v321_source


def test_dataset_maker_large_queues_use_virtualized_rendering():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-part2.js").read_text(encoding="utf-8")

    assert "DATASET_VIRTUAL_THRESHOLD" in source
    assert "_renderVirtualQueue" in source
    assert "_renderVirtualImportGallery" in source
    assert "dataset-virtual-spacer" in source


def test_dataset_folder_import_has_paged_large_folder_controls():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    part2_source = (repo_root / "frontend" / "js" / "dataset-maker-part2.js").read_text(encoding="utf-8")
    pipeline_source = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert 'id="btn-dataset-folder-import-more"' in html
    assert "_folderScanToken" in source
    assert "const FOLDER_SCAN_PAGE_SIZE = 5000;" in source
    assert "include_thumbnails: false" in source
    assert "/api/dataset/local-thumbnail" in source
    assert "encodeURIComponent(path)" in source
    assert "LARGE_BROWSER_DROP_WARNING_FILES" in source
    assert ".slice(0, LARGE_BROWSER_DROP_WARNING_FILES)" not in source
    assert "scan_token" in source
    assert "dataset_scan_tokens" in source
    assert "manifest_items" not in source
    assert "folderImportAddedManifest" in source
    assert "_markLocalManifestExcluded?.(id)" in part2_source
    assert "exportPreviewManifestNote" in pipeline_source
    assert "confirmSummaryManifestPreview" in zh_source
    assert "dataset.importGalleryManifestCount" in zh_source
    assert "Object.entries(params)" in app_source


def test_dataset_folder_import_append_keeps_current_tab_and_shows_busy_state():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "dataset-pipeline.css").read_text(encoding="utf-8")

    assert "const focusImportTab = options.focusImportTab === true;" in source
    assert "focusImportTab: !append" in source
    assert "this._setFolderImportBusy(true);" in source
    assert "this._setFolderImportBusy(false);" in source
    assert ".dataset-folder-import-status-row.is-loading::before" in css
    assert "@keyframes dataset-spin" in css


def test_dataset_audit_results_have_next_step_actions():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "dataset-pipeline.css").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "dataset-audit-next-steps" in source
    assert "selectAuditMatches" in source
    assert "removeAuditMatches" in source
    assert "dataset.auditBadgeMissing" in source
    assert "dataset.auditNextTruncated" in source
    assert "item_limit: 50000" in source
    assert "dataset.auditActionWorkbench" in zh_source
    assert ".dataset-audit-next-steps" in css
    assert ".dataset-audit-next-warning" in css


def test_dataset_browser_uploads_reuse_folder_import_busy_spinner():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")

    assert "dataset.uploadImporting" in source
    assert "DM._setFolderImportBusy?.(true);" in source
    assert "DM._setFolderImportBusy?.(false);" in source
    assert "'dataset.uploadImporting'" in en_source


def test_gallery_order_badge_moves_away_from_selection_circle():
    repo_root = Path(__file__).resolve().parents[2]
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")

    assert ".gallery-grid.selection-mode .gallery-item-order" in css
    assert "left: 42px;" in css
    assert ".gallery-grid.selection-mode .gallery-item::before" in css
    assert "z-index: 6;" in css


def test_dataset_local_ids_use_safe_52_bit_hash_slice():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")

    assert ".slice(0, 13)" in source
    assert "Number.MAX_SAFE_INTEGER" in source


def test_full_selection_workflows_do_not_fallback_to_gallery_dom():
    repo_root = Path(__file__).resolve().parents[2]
    checked = {
        "frontend/js/v321-ui.js": (repo_root / "frontend" / "js" / "v321-ui.js").read_text(encoding="utf-8"),
        "frontend/js/vlm-caption.js": (repo_root / "frontend" / "js" / "vlm-caption.js").read_text(encoding="utf-8"),
        "frontend/js/mass-tag-editor.js": (repo_root / "frontend" / "js" / "mass-tag-editor.js").read_text(encoding="utf-8"),
    }

    violations = [
        path for path, source in checked.items()
        if ".gallery-item[data-id]" in source or "gallery-item[data-id]" in source
    ]

    assert not violations, (
        "Full-selection workflows must use SelectionStore/selection-token resolvers, "
        "not currently rendered gallery DOM nodes: " + ", ".join(violations)
    )


def test_selection_filter_payload_preserves_full_gallery_scope():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    selection_match = re.search(
        r"function buildSelectionFilterRequest\(.*?\) \{\n(?P<body>.*?)\n\}",
        source,
        re.DOTALL,
    )
    assert selection_match is not None
    selection_body = selection_match.group("body")

    advanced_match = re.search(
        r"function buildAdvancedFilterContract\(.*?\) \{\n(?P<body>.*?)\n\}",
        source,
        re.DOTALL,
    )
    assert advanced_match is not None
    advanced_body = advanced_match.group("body")

    for field in (
        "minUserRating",
        "excludePrompts",
        "excludeColors",
        "collectionId",
        "folder",
        "hasMetadata",
    ):
        assert f"{field}:" in selection_body
        assert f"{field}:" in advanced_body


def test_batch_caption_export_requires_selection_not_loaded_gallery_fallback():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "v321-ui.js").read_text(encoding="utf-8")

    assert "allowLoadedFallback = false" in source
    assert "const source = await this._loadQueueSource();" in source
    assert "return allowLoadedFallback ? this._getLoadedGalleryImageIds(normalizedCap) : [];" in source
    assert "return this._getLoadedGalleryImageIds(1000000);" not in source


def test_mass_tag_entry_is_visible_on_desktop_and_mobile():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "mass-tag-editor.js").read_text(encoding="utf-8")

    assert 'id="mobile-btn-mass-tag-editor"' in html
    assert 'document.getElementById("mobile-btn-mass-tag-editor")' in source
    assert ".nav-actions #btn-mass-tag-editor" not in css


def test_mass_tag_does_not_expand_selection_tokens_in_browser():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "mass-tag-editor.js").read_text(encoding="utf-8")

    assert "resolveScopePayload" in source
    assert "selection_token" in source
    assert "/api/images/selection-chunk" not in source
    assert "getSelectionChunk" not in source
    assert "resolveSelectedImageIds" not in source


def test_native_checkbox_radio_are_not_forced_to_button_size():
    repo_root = Path(__file__).resolve().parents[2]
    css = (repo_root / "frontend" / "css" / "styles.css").read_text(encoding="utf-8")

    start = css.index("/* Ensure interactive elements have proper touch targets */")
    end = css.index("/* View buttons in gallery */", start)
    body = css[start:end]
    touch_rule = body.split("}", 1)[0]
    assert 'input[type="checkbox"],' not in touch_rule
    assert 'input[type="radio"],' not in touch_rule
    assert "accent-color: var(--accent-primary);" in css


def test_app_filter_access_exposes_selection_token_resolver():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "resolveSelectedImageIds" in source
    assert "getActiveSelectionToken" in source
    assert "getSelectionChunk(token" in source


def test_censor_filtered_selection_uses_token_backed_queue_window():
    repo_root = Path(__file__).resolve().parents[2]
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    censor_source = (repo_root / "frontend" / "js" / "censor-edit.js").read_text(encoding="utf-8")

    send_block = re.search(
        r"\$\('#btn-send-to-censor'\).*?addEventListener\('click', async \(e\) => \{(?P<body>.*?)\n    \}\);",
        app_source,
        re.DOTALL,
    )
    assert send_block is not None
    body = send_block.group("body")

    assert "selectionToken: token" in body
    assert "visibleImageIds:" in body
    assert "API.getSelectionChunk" not in body
    assert "while (!done)" not in body

    assert "CENSOR_TOKEN_QUEUE_WINDOW_SIZE" in censor_source
    assert "tokenQueueSource" in censor_source
    assert "loadSelectionDataByToken" in censor_source
    assert "processCensorBatchItems" in censor_source
    assert "selection_token" not in body


def test_vlm_caption_uses_selection_token_without_resolving_full_id_list():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "vlm-caption.js").read_text(encoding="utf-8")

    assert "getActiveSelectionToken" in source
    assert "selection_token" in source
    assert "resolveSelectedImageIds" not in source
    assert "JSON.stringify(batchTarget.payload)" in source


def test_mass_tag_editor_reuses_gallery_filter_contract_for_filter_scope():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "mass-tag-editor.js").read_text(encoding="utf-8")

    assert "window.App.buildSelectionFilterRequest(filters)" in source
    assert "tagMode" in source
    assert "excludeTags" in source
    assert "excludeGenerators" in source
    assert "excludeRatings" in source
    assert "excludeCheckpoints" in source
    assert "excludeLoras" in source


def test_dataset_caption_refresh_batches_without_silent_500_cap():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")

    assert "const batchSize = 500;" in source
    assert "targetIds.slice(i, i + batchSize)" in source
    assert "image_ids: ids.slice(0, 500)" not in source


def test_dataset_export_uses_background_progress_job():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    part3 = (repo_root / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")
    local_import = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")

    assert "/api/dataset/export/start" in part3
    assert "/api/dataset/export/progress" in part3
    assert "/api/dataset/export/cancel" in part3
    assert "id=\"dataset-export-progress-text\"" in html
    assert "id=\"btn-dataset-export-cancel\"" in html
    assert "DM._buildExportPayload" in local_import
    assert "/api/dataset/export'" not in part3
    assert "/api/dataset/export'" not in local_import


def test_dataset_maker_guards_session_preview_and_heavy_audit_ux():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    dataset_js = (repo_root / "frontend" / "js" / "dataset-maker.js").read_text(encoding="utf-8")
    local_import = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    part2 = (repo_root / "frontend" / "js" / "dataset-maker-part2.js").read_text(encoding="utf-8")
    pipeline = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    onboarding = (repo_root / "frontend" / "js" / "modules" / "components" / "onboarding.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "dataset-pipeline.css").read_text(encoding="utf-8")
    maker_css = (repo_root / "frontend" / "css" / "dataset-maker.css").read_text(encoding="utf-8")

    assert 'id="dataset-audit-check-phash" checked' not in html
    assert ".dataset-audit-modal-card" in css
    assert "dataset-export-action-bar" in html
    assert "#view-dataset .dataset-export-action-bar" in maker_css
    assert "position: sticky" in maker_css
    assert "top: -12px" in maker_css
    assert "max-height: none" in maker_css
    assert "#view-dataset .dataset-export-preview-list" in maker_css
    assert "overflow: visible" in maker_css
    assert "_flushPendingCaptionEdit" in dataset_js
    assert "const value = ta.value;" in dataset_js
    assert "_serializeLocalDatasetState" in local_import
    assert "_restoreLocalSession" in local_import
    assert "let previewRequestSeq" in pipeline
    assert "previewAbortController.abort()" in pipeline
    assert "renderPreviewError" in pipeline
    assert "Fall through to the old lightweight filename-only preview" not in pipeline
    assert "_queueIdsForCurrentFilter" in part2
    assert "list.classList.contains('is-virtualized')" in part2
    assert "document.elementFromPoint" in onboarding
    assert "navTarget.click()" in onboarding
    # QA P3-4: the tour's auto-start (and its view guards) is formally retired;
    # the tour must only be reachable programmatically via the guide's 🎓 Tour.
    assert "AUTO_START_ENABLED" not in onboarding
    assert "markHasSeenImages" not in onboarding
    assert "cleanupResidualTourUi();" in onboarding


def test_dataset_new_i18n_keys_are_translated():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    en = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    keys = set(re.findall(r'data-i18n(?:-[a-z-]+)?="(dataset\.[^"]+)"', html))
    keys |= {
        "dataset.exportPreviewLoading",
        "dataset.exportPreviewFailed",
        "dataset.translationEmpty",
        "dataset.queueFilterEmpty",
        "dataset.sessionRestorePartial",
        "dataset.confirmClearTitle",
        "dataset.keepBadge",
        "dataset.dedupeNoSelection",
        "dataset.dedupeDone",
        "dataset.auditPhashUnavailable",
        "dataset.auditPhashChecked",
        "dataset.auditPhashUnavailableShort",
        "dataset.auditPhashCheckedShort",
        "dataset.exportPreviewLoadedOnlyEdit",
    }
    missing = [key for key in sorted(keys) if f"'{key}'" not in en or f"'{key}'" not in zh]

    assert not missing


def test_dataset_maker_ui_removes_confusing_external_tool_copy():
    repo_root = Path(__file__).resolve().parents[2]
    checked_files = [
        repo_root / "frontend" / "index.html",
        repo_root / "frontend" / "js" / "lang" / "en.js",
        repo_root / "frontend" / "js" / "lang" / "zh-CN.js",
    ]

    violations = [
        file_path.relative_to(repo_root).as_posix()
        for file_path in checked_files
        if "LoraHub" in file_path.read_text(encoding="utf-8")
    ]

    assert not violations, "Dataset Maker UI must not mention external tools: " + ", ".join(violations)


def test_dataset_export_tab_does_not_show_workbench_find_replace():
    repo_root = Path(__file__).resolve().parents[2]
    css = (repo_root / "frontend" / "css" / "dataset-pipeline.css").read_text(encoding="utf-8")

    assert '[data-active-tab="export"] #dataset-step-findreplace' in css


def test_dataset_folder_and_output_browse_buttons_are_real_click_buttons():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    dataset_js = (repo_root / "frontend" / "js" / "dataset-maker.js").read_text(encoding="utf-8")
    local_import = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")

    assert 'type="button" class="btn btn-ghost btn-small" id="btn-dataset-folder-import-browse"' in html
    assert 'type="button" class="btn btn-ghost btn-small" id="btn-dataset-browse-output"' in html
    assert "btn-dataset-folder-import-browse" in local_import
    # PR #18 (issue 4): browse button is a toggle — mousedown opens or closes
    # the folder browser depending on whether it's already showing.
    assert "addEventListener('mousedown'" in local_import
    assert "window.showFolderBrowser(pathInput)" in local_import
    assert "btn-dataset-browse-output" in dataset_js
    assert "showFolderBrowser(input)" in dataset_js


def test_dataset_maker_sidecar_export_limits_are_visible_before_caption_work():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    local_import = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    en = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert 'id="dataset-sidecar-import-notice"' in html
    assert 'id="dataset-sidecar-source-status"' in html
    assert "Gallery" in html and "folder path" in html
    # v3.2.2: drag/drop folders, ZIP, and RAR also support beside_image
    # by writing the .txt next to the imported copy in the upload dir.
    assert "next to the imported copy" in html
    assert "rarfile" in html and "unrar" in html
    assert "dataset.sidecarNoticeTitle" in en and "dataset.sidecarNoticeTitle" in zh
    assert "dataset.sidecarSourceStatus" in en and "dataset.sidecarSourceStatus" in zh
    # RAR + ZIP both flow through the server-side upload route; the
    # legacy ``unsupportedRarFiles`` client-side helper was removed (it
    # always returned []), so only the server-side handling remains.
    assert "ARCHIVE_EXTS" in local_import
    assert "upload-files" in local_import


def test_dataset_maker_step2_owns_caption_formatting_and_translation_settings():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    dataset_js = (repo_root / "frontend" / "js" / "dataset-maker.js").read_text(encoding="utf-8")

    setup_start = html.index('id="dataset-step-setup"')
    caption_start = html.index('data-i18n="dataset.cardCaptionTitle"')
    find_replace_start = html.index('id="dataset-step-findreplace"', caption_start)
    setup_block = html[setup_start:caption_start]
    caption_block = html[caption_start:find_replace_start]
    export_start = html.index('id="dataset-step-export"')
    export_end = html.index('id="dataset-export-preview"', export_start)
    export_block = html[export_start:export_end]

    for marker in [
        'id="dataset-trigger"',
        'id="dataset-lora-type"',
        'id="dataset-common-tags"',
        'id="btn-dataset-quickfill-trigger"',
        'id="btn-dataset-quickfill-quality"',
    ]:
        assert marker in setup_block
        assert marker not in caption_block
        assert marker not in export_block

    for marker in [
        'id="dataset-export-prefix"',
        'id="dataset-template-options"',
        'id="dataset-template-override"',
        'id="btn-dataset-clear-prefix"',
        'id="btn-dataset-reset-template"',
        'id="btn-dataset-refresh-zh-aid"',
        'id="dataset-replace-rules"',
        'id="dataset-max-tags"',
        'id="dataset-translation-options"',
        'id="dataset-translation-provider-mode"',
        'id="dataset-translation-external-provider"',
        'id="dataset-translation-prompt"',
    ]:
        assert marker in caption_block
        assert marker not in export_block

    assert 'id="dataset-naming-pattern"' in export_block
    assert 'id="dataset-naming-pattern"' not in setup_block
    assert 'id="dataset-naming-pattern"' not in caption_block
    assert 'id="dataset-export-content-mode"' in html
    assert 'type="hidden" id="dataset-export-content-mode"' in html
    assert 'data-i18n="dataset.exportContentMode"' not in export_block
    assert 'data-i18n="dataset.namingLegend"' not in export_block
    assert "btn-dataset-clear-prefix" in dataset_js
    assert "btn-dataset-reset-template" in dataset_js
    assert "btn-dataset-refresh-zh-aid" in dataset_js


def test_smart_tag_has_visible_booru_to_captioner_grounding_control():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    smart_tag_js = (repo_root / "frontend" / "js" / "smart-tag.js").read_text(encoding="utf-8")

    assert 'id="smart-tag-vlm-grounding"' in html
    assert 'data-i18n="smartTag.vlmGrounding"' in html
    assert "vlm_grounding" in smart_tag_js
    assert "toriigate_grounding" in smart_tag_js


def test_dataset_export_tab_is_export_only_with_output_mode_payload():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    part3 = (repo_root / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")
    local_import = (repo_root / "frontend" / "js" / "dataset-maker-local-import.js").read_text(encoding="utf-8")
    pipeline = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")

    assert 'name="dataset-output-mode"' in html
    assert 'value="folder"' in html
    assert 'value="beside_image"' in html
    assert 'id="dataset-beside-image-warning"' in html
    assert 'data-export-folder-only' in html
    assert "DM._outputMode" in part3
    # FE-1 2b: _buildExportPayload has ONE implementation, hosted in
    # local-import (it reads local-source state); the part3 copy was dead
    # code (wholesale redefined at load time) and was removed.
    assert "output_mode: outputMode" not in part3
    assert "output_mode: outputMode" in local_import
    assert "_sidecarCapabilityStats" in part3
    assert "_exportDisabledReason" in part3
    assert "!this._exportDisabledReason?.()" in local_import
    assert "{ ...this, imageIds:" not in local_import
    assert "_syncOutputModeUi" in part3
    assert "output_mode" in pipeline


def test_dataset_audit_is_modal_not_inline_details():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    pipeline = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "dataset-pipeline.css").read_text(encoding="utf-8")

    assert '<details class="dataset-audit-inline"' not in html
    assert 'id="dataset-audit-modal"' in html
    assert 'dataset-audit-modal-card' in html
    assert "DM._showAuditModal" in pipeline
    assert "DM._hideAuditModal" in pipeline
    assert "panel.open = true" not in pipeline
    assert ".dataset-audit-modal-card" in css
    assert ".dataset-audit-inline:not([open]) .dataset-audit-body" not in css


def test_dataset_global_caption_scope_and_tag_categories_are_available():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    part2 = (repo_root / "frontend" / "js" / "dataset-maker-part2.js").read_text(encoding="utf-8")
    part3 = (repo_root / "frontend" / "js" / "dataset-maker-part3.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "dataset-maker.css").read_text(encoding="utf-8")

    assert 'id="dataset-caption-scope"' in html
    assert 'id="dataset-dedupe-scope"' not in html
    assert "_captionScopeIds" in part3
    assert "dataset-caption-scope" in part3
    assert "dataset-dedupe-scope" not in part3
    assert "_classifyTagCategory" in part2
    assert "dataset-tag-pill-category-" in part2
    # Every tag must resolve to a real danbooru group + color: the frontend pulls
    # authoritative categories from the backend 14-class classifier and caches them
    # so pills recolor away from the local first-paint guess.
    assert "_ensureTagCategories" in part2
    assert "/api/prompts/categorize" in part2
    # The 14 backend categories (tag_rules.categorize_tag) each need a pill color.
    for category in [
        "quality", "meta", "rating", "character", "body", "outfit", "expression",
        "pose", "action", "angle", "background", "style", "artist", "unknown",
    ]:
        assert f"dataset-tag-pill-category-{category}" in css


def test_dataset_custom_dropdown_does_not_close_when_its_own_list_scrolls():
    repo_root = Path(__file__).resolve().parents[2]
    pipeline = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")

    # The custom dropdown registers its outside-interaction listeners ONCE
    # (shared across every wrapped select) instead of per-select, which
    # previously leaked 3 permanent listeners + a body-appended node on
    # every init. The scroll handler must still keep an open list open
    # when the user scrolls INSIDE it.
    assert "ensureSharedListeners" in pipeline
    assert "SHARED_LISTENERS_INSTALLED" in pipeline
    assert "list.contains(target)" in pipeline
    # The old per-select leak pattern must be gone.
    assert "function handleOutsideScroll(e)" not in pipeline
    assert "document.addEventListener('click', closeList)" not in pipeline


def test_gallery_send_to_dataset_maker_button_tracks_selection_state():
    repo_root = Path(__file__).resolve().parents[2]
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "'btn-send-selection-to-dataset-maker'" in app_source
    button_block = re.search(r"const buttonIds = \[(?P<body>.*?)\];", app_source, re.DOTALL)
    assert button_block is not None
    assert "'btn-send-selection-to-dataset-maker'" in button_block.group("body")


def test_dataset_init_syncs_current_naming_preset_ui():
    repo_root = Path(__file__).resolve().parents[2]
    dataset_js = (repo_root / "frontend" / "js" / "dataset-maker.js").read_text(encoding="utf-8")

    assert "this._onPresetChange?.();" in dataset_js
    assert dataset_js.index("this._onPresetChange?.();") < dataset_js.index("this._updateNamingPreview();")


def test_dataset_vocab_uses_explicit_actions_not_hidden_click_cycle():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "dataset-maker-pipeline.js").read_text(encoding="utf-8")
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")

    assert "function cycleTag" not in source
    assert "dataset-vocab-action" in source
    assert "dataset.vocabAddCommon" in source
    assert "Third click clears" not in html


def test_smart_tag_supports_path_source_dataset_items():
    repo_root = Path(__file__).resolve().parents[2]
    frontend = (repo_root / "frontend" / "js" / "smart-tag.js").read_text(encoding="utf-8")
    router = (repo_root / "backend" / "routers" / "smart_tag.py").read_text(encoding="utf-8")
    service = (repo_root / "backend" / "services" / "smart_tag_service.py").read_text(encoding="utf-8")

    assert "image_paths: sources.imagePaths" in frontend
    assert "selection_token: sources.selectionToken" in frontend
    assert "dataset_scan_token: sources.datasetScanToken" in frontend
    assert "/api/smart-tag/results" in frontend
    assert "selection_token: Optional[str]" in router
    assert "dataset_scan_token: Optional[str]" in router
    assert "image_paths: List[str]" in router
    assert "get_caption_results_page" in service
    assert "caption_result_count" in service


def test_smart_tag_uses_model_specific_tagger_defaults():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    frontend = (repo_root / "frontend" / "js" / "smart-tag.js").read_text(encoding="utf-8")
    service = (repo_root / "backend" / "services" / "smart_tag_service.py").read_text(encoding="utf-8")
    tagger_service = (repo_root / "backend" / "services" / "tagging_service.py").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert 'id="smart-tag-max-tags"' in html
    assert 'data-i18n="smartTag.maxTags"' in html
    assert "smartTag.maxTags" in en_source
    assert "smartTag.maxTags" in zh_source
    assert "model?.default_threshold" in frontend
    assert "model?.default_character_threshold" in frontend
    assert "model?.default_copyright_threshold" in frontend
    assert "model?.default_max_tags_per_image" in frontend
    assert "function maxTagsInputWasTouched()" in frontend
    assert "return toFiniteMaxTags(input?.value, 0);" in frontend
    assert "getPayloadThresholdsForModel(model, sharedThresholds)" in frontend
    assert "const maxTagsPerImage = getPayloadMaxTagsForModels(uniqueTaggers)" in frontend
    assert "max_tags_per_image: maxTagsPerImage" in frontend
    assert "default_copyright_threshold" in tagger_service
    assert "default_max_tags_per_image" in tagger_service
    assert "def _tagger_defaults(model_name: str)" in service
    assert "multi_max_tag_defaults" in service


def test_manual_sort_resume_failure_does_not_render_null_visible_banner():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "manual-sort.js").read_text(encoding="utf-8")

    assert "renderManualSortResumeBanner(null, { visible: true })" not in source
    assert "previousResumeSnapshot" in source



def test_tagger_ui_does_not_market_cpu_as_safe_mode():
    repo_root = Path(__file__).resolve().parents[2]
    checked_files = [
        repo_root / "frontend" / "js" / "app.js",
        repo_root / "frontend" / "js" / "lang" / "en.js",
        repo_root / "frontend" / "js" / "lang" / "zh-CN.js",
        repo_root / "backend" / "services" / "tagging_service.py",
        repo_root / "backend" / "tagger.py",
        repo_root / "backend" / "toriigate_tagger.py",
    ]
    forbidden_phrases = [
        "CPU " + "Safe " + "Mode",
        "Safe " + "Mode",
        "较慢" + "但" + "更" + "稳",
        "避免" + "崩溃",
        "stable " + "CPU " + "run",
    ]
    violations: list[str] = []

    for file_path in checked_files:
        source = file_path.read_text(encoding="utf-8")
        for phrase in forbidden_phrases:
            if phrase in source:
                relative_path = file_path.relative_to(repo_root).as_posix()
                violations.append(f"{relative_path}: contains {phrase!r}")

    assert not violations, "Tagger UI/runtime wording must not market CPU as safer.\n" + "\n".join(violations)

def test_manual_sort_start_uses_json_body_not_query_string_filters():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "async startSortSession(" in source
    assert "return this.post('/api/sort/start', {" in source
    assert "params.set('tags', tags.join(','))" not in source
    assert "this.post(`/api/sort/start?${params}`)" not in source


def test_gallery_load_finally_clears_only_active_sequence():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "let _activeImageLoadSequence = 0;" in source
    assert "const isActiveLoad = _activeImageLoadSequence === loadSequence;" in source
    assert "RequestManager.complete(IMAGE_LOAD_KEY, controller);" in source


def test_autosep_critical_action_settings_are_visible_on_main_panel():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "autosep.js").read_text(encoding="utf-8")

    assert "autosep-action-settings" in html
    assert 'name="autosep-operation-mode-main"' in html
    assert 'data-autosep-setting="confirmBeforeMove"' in html
    assert 'data-autosep-setting="rememberDestination"' in html
    assert "setAutoSepOperationMode(input.value, { persist: true })" in source


def test_metadata_resolving_chip_is_driven_by_stats_contract():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "metadata-status-chip" in html
    assert "stats.metadata_pending" in source
    assert "stats.scan_status" in source
    assert "stats.scan_library_ready" in source
    assert "const countsResolving = metadataPending > 0 || (scanRunning && !scanLibraryReady);" in source
    assert "gallery.metadataResolving" in source
    assert "gallery.scanResolving" in source
    assert "countEl.textContent = countsResolving && count === 0 ? '…' : String(count);" in source


def test_filter_facet_search_uses_backend_queries_not_prelimited_local_cache():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "const FACET_SUGGESTION_LIMIT = 24;" in source
    assert "API.getTagsLibrary('frequency', {" in source
    assert "API.getPromptsLibrary({" in source
    assert "API.getAnalyticsFacet(facet, {" in source
    assert "selectedCheckpointValues.forEach((checkpointValue)" in source
    assert "(filterState.loras || []).forEach((lora)" in source
    assert "tagsLibraryCache" not in source
    assert "promptsLibraryCache" not in source
    assert "return this.get(`/api/tags/library?sort_by=${sortBy}&limit=${limit}`);" not in source
    assert "return this.get(`/api/prompts/library?limit=${limit}`);" not in source
    assert "return this.get(`/api/loras/library?limit=${limit}`);" not in source


def test_gallery_delete_key_removes_from_gallery_not_disk():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    match = re.search(r"else if \(e\.key === 'Delete'\) \{(?P<body>.*?)\n        \}", source, re.DOTALL)
    assert match is not None
    body = match.group("body")
    assert "removeSelectedGalleryImages();" in body
    assert "deleteSelectedGalleryImages();" not in body


def test_manual_sort_start_routes_unfinished_sessions_to_resume():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "manual-sort.js").read_text(encoding="utf-8")

    assert "confirmResumeSavedSessionFromStart(savedSession)" in source
    assert "resumeSavedSession(savedSession)" in source
    assert "discard the saved session first" in source
    assert "replaceExisting = false" in source

def test_gallery_context_menu_has_workflow_actions_and_trash_is_explicit():
    repo_root = Path(__file__).resolve().parents[2]
    gallery_source = (repo_root / "frontend" / "js" / "gallery.js").read_text(encoding="utf-8")
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    match = re.search(r"_showContextMenu\(e, image\) \{(?P<body>.*?)\n    \},\n\n    // Cleanup", gallery_source, re.DOTALL)
    assert match is not None
    body = match.group("body")

    expected_keys = [
        "gallery.contextPreview",
        "gallery.contextSelectImage",
        "gallery.contextMoveImage",
        "gallery.contextCopyImage",
        "gallery.contextSendToCensor",
        "gallery.contextFindSimilar",
        "gallery.contextPromptHelper",
        "gallery.contextReadMetadata",
        "gallery.contextFilterCheckpoint",
        "gallery.contextOpenFolder",
        "gallery.contextCopyPath",
        "gallery.contextRemoveFromGallery",
        "gallery.contextMoveToTrash",
        "gallery.contextApplyToSelected",
    ]
    for key in expected_keys:
        assert key in body
        assert key in en_source
        assert key in zh_source

    assert "const actionImageIds = isSelected && selectedImageIds.length > 1 ? selectedImageIds : [imageId];" in body
    assert "app.moveOrCopyGalleryImages?.(actionImageIds, 'move', { source: 'context' })" in body
    assert "app.moveOrCopyGalleryImages?.(actionImageIds, 'copy', { source: 'context' })" in body
    assert "openPromptBuildFromImage?.(image.id)" in body
    assert "openReaderFromImage?.(image.id" in body
    assert "app.removeGalleryImagesByIds?.(actionImageIds)" in body
    assert "app.deleteGalleryImagesByIds?.(actionImageIds)" in body
    assert "contextDelete" not in body
    assert "Delete from Disk" not in body

    assert "moveOrCopyGalleryImages" in app_source
    assert "deleteGalleryImagesByIds" in app_source
    assert "removeGalleryImagesByIds" in app_source
    assert "operating system Trash / Recycle Bin" in app_source
    assert "emitSelectionStateChanged" in app_source


def test_gallery_single_color_action_patches_frontend_color_fields():
    repo_root = Path(__file__).resolve().parents[2]
    gallery_source = (repo_root / "frontend" / "js" / "gallery.js").read_text(encoding="utf-8")

    assert "_buildColorAnalysisPatch" in gallery_source
    for field in [
        "dominant_colors",
        "avg_brightness",
        "color_temperature",
        "color_saturation",
        "brightness_distribution",
    ]:
        assert f"'{field}'" in gallery_source

    assert "this._patchImageState(id, { color_data: result.color_data });" not in gallery_source
    assert "this._patchImageState(id, colorPatch);" in gallery_source


def test_queue_manager_gallery_filters_use_backend_selection_contract():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "queue-solitaire.js").read_text(encoding="utf-8")

    assert "resolveGalleryFilterMatches" in source
    assert "api.createSelectionToken(filters" in source
    assert "api.getSelectionChunk(selectionToken" in source
    assert "selection_token" in source
    assert "queueSet.has(normalized)" in source
    assert "if (fromGallery)" in source


def test_gallery_selection_panel_is_desktop_user_facing_not_visible_dom_jargon():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    ui_refresh = (repo_root / "frontend" / "js" / "ui-refresh.js").read_text(encoding="utf-8")
    filter_store = (repo_root / "frontend" / "js" / "stores" / "filter-store.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "btn-select-visible" not in html
    assert "selection-panel-more" not in html
    assert "selection.selectVisible" not in ui_refresh
    assert "selection.invertVisible" not in ui_refresh
    assert "selection.moreActions" not in en_source
    assert "selection.selectVisible" not in zh_source
    assert "selection-panel-section" in html
    assert "selection.selectAllFilteredHelp" in html
    assert "选择当前筛选全部" in zh_source
    assert "作用域" not in zh_source[zh_source.find("'scope.useGallery'"):zh_source.find("// ========================", zh_source.find("'scope.useGallery'"))]
    assert "const VALID_ASPECT_RATIO_FILTERS = new Set(['square', 'landscape', 'portrait']);" in source
    assert "aspectRatio: normalizeAspectRatioFilter(source.aspectRatio) || null" in source
    assert "normalizeAspectRatioFilter(filters.aspectRatio)" in source
    assert "normalizeAspectRatioFilter(dimensions?.aspectRatio)" in source
    assert "const savedFilters = cloneFilterState(loadSavedFilterState());" in source
    assert "['square', 'landscape', 'portrait'].includes" in filter_store
    assert ".selection-panel-section" in css


def test_gallery_setup_button_lives_in_nav_not_floating():
    """Setup button should be in the nav-actions bar, not a floating FAB."""
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")

    assert 'id="btn-open-model-manager"' in html
    assert "gallery-model-manager-fab" not in html
    assert "gallery-model-manager-fab" not in css


def test_export_ui_explains_output_formats_before_action():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "export-format-description" in html
    assert "batch-export-content-description" in html
    assert 'value="prompt_numbered"' in html
    assert 'data-i18n="export.groupAdvanced"' in html
    assert 'data-i18n="batchExport.groupAdvanced"' in html
    assert "function getExportFormatDescription" in source
    assert "function getBatchExportContentDescription" in source
    assert "export.descPromptNumbered" in en_source
    assert "export.descPromptNumbered" in zh_source
    assert "Combined Export..." in en_source
    assert "合并导出..." in zh_source
    assert "Training captions..." in en_source
    assert "训练 caption..." in zh_source
    assert "训练 caption" in zh_source
    assert "可选 Class Token + AI caption + Prompt + Tags" in zh_source
    assert "训练用 .txt" in zh_source
    assert "Prompt Sheet..." not in en_source
    assert "Caption Files..." not in en_source


def test_scan_modal_advanced_summary_does_not_break_chinese_label():
    repo_root = Path(__file__).resolve().parents[2]
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")

    assert '#scan-modal .guided-advanced-summary > [data-i18n="scan.advancedSummary"]' in css
    assert "white-space: nowrap;" in css
    assert "word-break: keep-all;" in css
    assert "#scan-modal .guided-advanced-hint" in css
    assert "grid-template-columns: max-content minmax(0, 1fr) max-content;" in css
    assert "text-overflow: ellipsis;" in css
    assert "min-width: 0;" in css


def test_scan_progress_eta_uses_real_counted_totals_and_separate_metadata_totals():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "function getScanProgressMetrics(progress)" in source
    assert "const totalFinal = progress?.total_final === true;" in source
    assert "const metadataTotalFinal = progress?.metadata_total_final === true;" in source
    assert "const showingMetadata = progress?.step === 'metadata' && importComplete;" in source
    assert "const showEta = showingMetadata" in source
    assert "scan-import:${totalFinal ? total : 'counting'}" in source
    assert "scan-metadata:${metadataTotalFinal ? metadataTotal : 'growing'}" in source
    assert "progress.countingImages" in source
    assert "progress.detailsStillCounting" in source
    assert "Counting images... {count} found" in en_source
    assert "checking the final detail count" in en_source
    assert "正在统计图片... 已找到 {count} 张" in zh_source
    assert "正在确认详细信息总数" in zh_source


def test_queue_solitaire_escapes_file_and_section_values_before_inner_html():
    repo_root = Path(__file__).resolve().parents[2]
    source = (repo_root / "frontend" / "js" / "queue-solitaire.js").read_text(encoding="utf-8")

    assert "function escapeQueueHtml" in source
    assert 'value="${escapeQueueHtml(section.name)}"' in source
    assert '<option value="${escapeQueueHtml(s.id)}">${escapeQueueHtml(s.name)}' in source
    assert "escapeQueueHtml(item?.outputFilename || item?.originalFilename || state.previewId)" in source
    assert "${item?.outputFilename || item?.originalFilename || state.previewId}" not in source


def test_custom_tagger_profile_ui_and_payload_contract():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert 'id="tag-custom-profile-select"' in html
    assert 'value="wd14"' in html
    assert 'value="camie-tagger-v2"' in html
    assert 'value="pixai-tagger-v0.9"' in html
    assert "custom_profile: options.customProfile || null" in source
    assert "options.customProfile = customProfile;" in source
    assert "options.modelName = customProfile;" in source
    assert "if (tagsPath)" in source
    assert "options.tagsPath = tagsPath;" in source
    assert "showToast(appT('tag.tagsMetadataRequired'" not in source
    assert "if (applyModelDefaults && meta && (!isCustom || effectiveModelForUi !== 'custom'))" in source
    assert "batchSelect?.dataset.userChosen === '1'" in source
    assert "modal.tagCustomProfile" in en_source
    assert "modal.tagCustomProfile" in zh_source
    assert "tagger.customCamieHelp" in en_source
    assert "tagger.customCamieHelp" in zh_source
    assert "tag.tagsMetadataRequired" in en_source
    assert "tag.tagsMetadataRequired" in zh_source
    assert "Optional if the file sits next to the model" in en_source
    assert "如果文件就在模型旁边可不填" in zh_source



def test_feature_setup_explains_lightweight_startup_and_cache_limit():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")

    assert "model-manager-summary" in html
    assert "renderFeatureAvailabilityNotice" in source
    assert "features.prepare.wd14" in source
    assert "features.ready.wd14" not in source
    assert "thumbnail-cache-limit-input" in source
    assert "saveDiskSettings" in source
    assert "requestCoreRuntimeRebuild" in source
    assert "disk.thumbnailTradeoffHint" in source
    assert "/api/disk/runtime/rebuild-core" in source
    assert "models.restartAfterInstallWithPackages" in source


def test_scan_stalled_diagnostics_are_visible_and_copyable_from_frontend():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "scan-diagnostics-card" in html
    assert "btn-copy-scan-diagnostics" in html
    assert "btn-open-scan-log" in html
    assert "btn-copy-scan-log-path" in html
    assert "btn-stop-scan-from-diagnostics" in html
    assert "scan-diagnostics-meta" in html
    assert "data-i18n-aria=\"scan.diagnosticsMetaLabel\"" in html
    assert "scan-storage-hint" in html
    assert 'id="scan-diagnostics-message" data-i18n' not in html
    assert "messageEl.removeAttribute('data-i18n')" in source
    assert "stepEl.removeAttribute('data-i18n')" in source
    assert "currentEl.removeAttribute('data-i18n')" in source
    assert "updateScanDiagnosticsCard(progress)" in source
    assert "_scanLastProgress" in source
    assert "_updateBgScanProgress(_scanLastProgress)" in source
    assert "progress?.attention_required" in source
    assert "API.getSupportDiagnostics(200)" in source
    assert "API.getSupportDiagnostics(1)" in source
    assert "payload?.log_file_path_redacted" in source
    assert "rememberScanLogPath" in source
    assert "progress?.attention_required" in source
    assert "buildScanAttentionMessage(progress" in source
    assert "SCAN_DIAGNOSTICS_HOLD_MS" in source
    assert "pathEl.title = result.path_redacted" in source
    assert "result.message || appT('scan.openLogUnavailable'" not in source
    assert "scan.backgroundStalledDetailed" in source
    assert "copyScanDiagnostics" in source
    assert "openScanLogFile" in source
    assert "copyScanLogPath" in source
    assert "/api/support/diagnostics" in source
    assert "/api/support/open-log" in source
    assert ".scan-diagnostics-card" in css
    for key in [
        "scan.diagnosticsTitle",
        "scan.backgroundStalledDetailed",
        "scan.copyLogPath",
        "scan.logPathCopied",
        "scan.logPathCopyFailed",
        "scan.copyLogPathUnavailable",
        "scan.diagnosticsMetaLabel",
    ]:
        assert key in en_source
        assert key in zh_source


def test_tag_category_copy_and_promptlab_board_are_wired():
    repo_root = Path(__file__).resolve().parents[2]
    html = (repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
    gallery_source = (repo_root / "frontend" / "js" / "gallery.js").read_text(encoding="utf-8")
    reader_source = (repo_root / "frontend" / "js" / "image-reader.js").read_text(encoding="utf-8")
    promptlab_source = (repo_root / "frontend" / "js" / "prompt-lab.js").read_text(encoding="utf-8")
    copy_source = (repo_root / "frontend" / "js" / "tag-category-copy.js").read_text(encoding="utf-8")
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    css = (repo_root / "frontend" / "css" / "ui-refresh.css").read_text(encoding="utf-8")
    en_source = (repo_root / "frontend" / "js" / "lang" / "en.js").read_text(encoding="utf-8")
    zh_source = (repo_root / "frontend" / "js" / "lang" / "zh-CN.js").read_text(encoding="utf-8")

    assert "/static/js/tag-category-copy.js" in html
    assert html.index("/static/js/tag-category-copy.js") < html.index("/static/js/gallery.js")
    assert 'id="btn-copy-tags-category"' in html
    assert 'id="reader-copy-prompt-category"' in html
    assert 'id="reader-category-tags-section"' in html
    assert 'id="promptlab-category-board-modal"' in html
    assert 'id="btn-promptlab-category-board"' in html
    assert 'id="pl-build-category-workbench"' in html
    assert 'id="pl-build-use-checked"' in html
    assert 'id="pl-build-copy-caption"' in html
    assert 'id="pl-build-clean-prompt"' in html
    assert 'id="pl-build-drop-quality"' in html
    assert 'id="pl-build-space-tags"' in html
    assert 'id="pl-build-reorder"' in html

    assert "window.TagCategoryCopy" in copy_source
    assert "/api/prompts/categorize" in copy_source
    assert "CORE_BOARD_GROUPS" in copy_source
    assert "PURPOSE_PRESETS" in copy_source
    assert "buildPurposePrompt" in copy_source
    assert "CATEGORY_ALIASES" in copy_source
    assert "normalizeCategoryName" in copy_source
    assert "findGalleryByTags" in copy_source
    assert "gallery.contextCopyTagCategory" in gallery_source
    assert "TagCategoryCopy.showMenu" in gallery_source
    assert "_copyPromptCategory" in reader_source
    assert "_renderReaderCategoryTags" in reader_source
    assert "openCategoryBoard" in promptlab_source
    assert "submitCategoryBoard" in promptlab_source
    assert "_renderBuildCategoryWorkbench" in promptlab_source
    assert "_useCheckedBuildCategories" in promptlab_source
    assert "_cleanBuildPrompt" in promptlab_source
    assert "/api/prompts/recategorize" in promptlab_source
    assert "applyTagFiltersFromExternal" in app_source
    assert ".tag-category-copy-menu" in css
    assert ".tag-category-copy-purpose" in css
    assert ".reader-category-tags" in css
    assert ".promptlab-build-category-workbench" in css
    assert ".promptlab-category-board-columns" in css

    for key in [
        "tagCategory.copyOptions",
        "tagCategory.purposePrompts",
        "tagCategory.findSimilarByCategory",
        "tagCategory.trainingCaption",
        "tagCategory.appearance",
        "tagCategory.clothing",
        "tagCategory.pose",
        "tagCategory.scenery",
        "tagCategory.unclassified",
        "promptlab.categoryBoardTitle",
        "promptlab.submitCategoryBoard",
        "promptlab.imagePromptRecipe",
        "promptlab.useCheckedCategories",
        "promptlab.copyTrainingCaption",
        "promptlab.cleanPrompt",
        "reader.categoryTags",
        "gallery.contextCopyTagCategory",
    ]:
        assert key in en_source
        assert key in zh_source


def test_sorting_payloads_carry_v33x_gallery_scope_filters():
    """Regression: Auto-Separate batch-move and Manual Sort session starts must
    send the v3.3.x gallery-scope fields (collection/folder/star-rating/
    exclude-prompts/colors/brightness). Before this fix the serializers and
    API payload builders silently dropped them, so "Copy from Gallery" moved
    or sorted a WIDER set than the gallery displayed."""
    repo_root = Path(__file__).resolve().parents[2]
    app_source = (repo_root / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
    autosep_source = (repo_root / "frontend" / "js" / "autosep.js").read_text(encoding="utf-8")
    manual_sort_source = (repo_root / "frontend" / "js" / "manual-sort.js").read_text(encoding="utf-8")

    # API.batchMove AND API.startSortSession must put every scope field on the
    # wire (snake_case payload keys, hence count >= 2 across the two builders).
    for wire_key in (
        "exclude_prompts:",
        "exclude_colors:",
        "min_user_rating:",
        "brightness_min:",
        "brightness_max:",
        "color_temperature:",
        "brightness_distribution:",
        "collection_id:",
        "has_metadata:",
    ):
        assert app_source.count(wire_key) >= 2, f"app.js payload builders miss {wire_key}"

    # Auto-Separate's serializer keeps the fields when copying gallery filters,
    # so the saved scope, the preview query, and the executed move all match.
    for field in (
        "excludePrompts:",
        "excludeColors:",
        "minUserRating:",
        "brightnessMin:",
        "brightnessMax:",
        "colorTemperature:",
        "brightnessDistribution:",
        "collectionId:",
        "hasMetadata:",
    ):
        assert field in autosep_source, f"serializeAutoSepFilters misses {field}"

    # Manual Sort routes the same scope bundle through every start path
    # (slot/bracket/cull) and the minimap preview query.
    assert "function buildManualSortScopeFilters" in manual_sort_source
    assert manual_sort_source.count("buildManualSortScopeFilters(f)") >= 4


def test_frontend_control_audit_script_reports_inventory():
    repo_root = Path(__file__).resolve().parents[2]
    script = repo_root / "scripts" / "audit_frontend_controls.py"

    result = subprocess.run(
        [sys.executable, str(script), "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    summary = report["summary"]

    assert summary["source"] == "frontend/index.html"
    assert summary["buttons"] >= 400
    assert summary["total_controls"] >= summary["buttons"]
    for category in (
        "referenced-by-id",
        "referenced-by-data",
        "delegate-only",
        "static-only",
        "needs-runtime-check",
    ):
        assert category in summary["categories"]
    assert "deletion recommendations" in " ".join(report["notes"])


def test_frontend_control_audit_keeps_known_delegated_controls_out_of_static_only_bucket():
    repo_root = Path(__file__).resolve().parents[2]
    script = repo_root / "scripts" / "audit_frontend_controls.py"

    result = subprocess.run(
        [sys.executable, str(script), "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    controls_by_id = {
        control["id"]: control
        for control in report["controls"]
        if control.get("id")
    }

    known_delegated = [
        "reader-tool-tab-reader",
        "reader-tool-tab-obfuscation",
        "dataset-tab-import",
        "dataset-tab-workbench",
        "dataset-tab-export",
        "btn-dataset-queue-grid",
        "btn-dataset-queue-list",
        "btn-filter-vivid",
    ]
    for control_id in known_delegated:
        assert control_id in controls_by_id
        control = controls_by_id[control_id]
        assert control["category"] not in {"static-only", "needs-runtime-check"}, control
        assert control["evidence"], control
