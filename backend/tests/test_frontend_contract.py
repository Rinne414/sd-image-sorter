"""
Frontend contract tests that guard shared state boundaries.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
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
    assert "Same-name .txt..." in en_source
    assert "同名 .txt..." in zh_source
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
