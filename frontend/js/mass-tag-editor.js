/**
 * SD Image Sorter — Mass Tag Editor (v3.2.1+)
 *
 * Bulk operations on stored tags. Wraps the 4 backend endpoints under
 * /api/tags/bulk/* with a UI that requires dry-run preview and inserts a
 * 2-second confirm dialog for any operation touching > MAX_NOCONFIRM images.
 *
 * Scope is sent as the smallest backend contract available:
 *   - "selection" — explicit small image_ids[] or an active selection_token
 *   - "filter"    — current gallery filter converted to a selection_token
 *
 * Backend hard caps:
 *   - image_ids: max_length=1000000 (see routers/tags_bulk.py)
 *   - tags:      max_length=200 per request
 */
(function () {
    "use strict";

    const ENDPOINTS = {
        find_replace: "/api/tags/bulk/find-replace",
        add:          "/api/tags/bulk/add",
        remove:       "/api/tags/bulk/remove",
        cleanup:      "/api/tags/bulk/cleanup",
    };

    const RESULT_OPERATIONS = {
        find_replace: "find_replace",
        add:          "bulk_add",
        remove:       "bulk_remove",
        cleanup:      "cleanup",
    };

    const RESULT_COUNT_FIELDS = {
        find_replace: ["affected_tags"],
        add:          ["total_tags_added"],
        remove:       ["total_tags_removed"],
        cleanup:      ["total_low_conf_removed", "total_duplicates_removed"],
    };

    const TAB_TITLES_EN = {
        find_replace: "Find & Replace",
        add:          "Bulk Add",
        remove:       "Bulk Remove",
        cleanup:      "Cleanup",
    };
    const TAB_TITLES_ZH = {
        find_replace: "查找替换",
        add:          "批量添加",
        remove:       "批量删除",
        cleanup:      "清理",
    };

    const MAX_NOCONFIRM = 1000;          // scope above this requires confirm dialog
    const BACKEND_MAX_IDS = 1000000;     // matches Pydantic Field max_length
    const CONFIRM_DELAY_MS = 2000;       // 2-second countdown on Apply button

    function responseErrorMessage(payload, response) {
        const structuredMessages = [
            payload?.error,
            payload?.detail,
            payload?.message,
        ];
        for (const value of structuredMessages) {
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }
        const status = Number(response.status);
        const statusText = typeof response.statusText === "string"
            ? response.statusText.trim()
            : "";
        return statusText
            ? `Request failed with HTTP ${status}: ${statusText}.`
            : `Request failed with HTTP ${status}.`;
    }

    function responseWarningMessage(payload) {
        const warnings = payload?.warnings;
        if (warnings === undefined) {
            return "";
        }
        if (!Array.isArray(warnings)) {
            return "Tags were applied, but the server returned invalid warning data.";
        }

        const messages = [];
        for (const warning of warnings) {
            if (
                !warning
                || typeof warning !== "object"
                || typeof warning.code !== "string"
                || !warning.code.trim()
                || typeof warning.message !== "string"
                || !warning.message.trim()
            ) {
                return "Tags were applied, but the server returned invalid warning data.";
            }
            messages.push(warning.message.trim());
        }
        return messages.join(" ");
    }

    function isNonNegativeInteger(value) {
        return Number.isInteger(value) && value >= 0;
    }

    function isPositiveInteger(value) {
        return Number.isInteger(value) && value > 0;
    }

    function isTagArray(value) {
        return Array.isArray(value)
            && value.every(tag => typeof tag === "string" && tag.trim().length > 0);
    }

    function isValidSampleChange(sample, operationTab) {
        if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false;
        if (!isPositiveInteger(sample.image_id)) return false;
        if (operationTab === "find_replace") {
            return isTagArray(sample.before)
                && sample.before.length > 0
                && isTagArray(sample.after);
        }
        if (operationTab === "add") {
            return isTagArray(sample.added)
                && sample.added.length > 0
                && isNonNegativeInteger(sample.before_count)
                && isNonNegativeInteger(sample.after_count)
                && sample.after_count === sample.before_count + sample.added.length;
        }
        if (operationTab === "remove") {
            return isTagArray(sample.removed)
                && sample.removed.length > 0
                && isNonNegativeInteger(sample.remaining_count);
        }
        if (operationTab === "cleanup") {
            const removedCount = sample.removed_low_conf + sample.removed_dupes;
            return isNonNegativeInteger(sample.before_count)
                && isNonNegativeInteger(sample.after_count)
                && isNonNegativeInteger(sample.removed_low_conf)
                && isNonNegativeInteger(sample.removed_dupes)
                && removedCount > 0
                && sample.after_count <= sample.before_count
                && sample.before_count - sample.after_count === removedCount;
        }
        return false;
    }

    const MassTagEditor = {
        activeTab: "find_replace",
        scopeLabel: "",
        confirmTimer: null,
        lastDryRunResult: null,
        previewEpoch: 0,
        _pendingApplyBody: null,
        _pendingApplySignature: null,
        _pendingApplyTab: null,

        t(en, zh) {
            return window.I18n?.getLang?.() === "zh-CN" ? zh : en;
        },

        // ---- Lifecycle ----------------------------------------------------

        init() {
            this.bindEvents();
        },

        bindEvents() {
            document.getElementById("btn-mass-tag-editor")?.addEventListener("click", () => this.openModal());
            document.getElementById("mobile-btn-mass-tag-editor")?.addEventListener("click", () => {
                if (typeof window.closeMobileMenu === "function") window.closeMobileMenu();
                this.openModal();
            });
            // P16: Filter sidebar entry
            document.getElementById("btn-filter-mass-tag-editor")?.addEventListener("click", () => this.openModal("filter"));
            // P16: Selection panel entry
            document.getElementById("btn-selection-mass-tag-editor")?.addEventListener("click", () => this.openModal("selection"));

            document.getElementById("btn-mass-tag-close")?.addEventListener("click", () => this.closeModal());
            document.querySelector("#mass-tag-modal .modal-backdrop")?.addEventListener("click", () => this.closeModal());
            document.querySelectorAll(".mass-tag-tab").forEach(tab => {
                tab.addEventListener("click", () => this.switchTab(tab.dataset.massTagTab));
            });
            document.querySelectorAll('input[name="mass-tag-scope"]').forEach(radio => {
                radio.addEventListener("change", () => {
                    this._invalidateOpenPreview();
                    this.refreshScopeLabels();
                });
            });
            document.getElementById("mass-tag-modal")?.addEventListener("input", () => {
                this._resetResult();
                this._setStatus("");
            });
            document.addEventListener("selection-state-changed", () => this._invalidateOpenPreview());
            document.addEventListener("gallery-filters-changed", () => this._invalidateOpenPreview());
            document.getElementById("btn-mass-tag-dry-run")?.addEventListener("click", () => this.runDryRun());
            document.getElementById("btn-mass-tag-apply")?.addEventListener("click", () => this.tryApply());

            // Confirm dialog
            document.getElementById("btn-mass-tag-confirm-cancel")?.addEventListener("click", () => this.closeConfirm());
            document.querySelector("#mass-tag-confirm-modal .modal-backdrop")?.addEventListener("click", () => this.closeConfirm());
            document.getElementById("btn-mass-tag-confirm-apply")?.addEventListener("click", () => this.runApply());
        },

        // ---- Modal open / close ------------------------------------------

        _getSelectionBoundary() {
            const state = window.AppFilterAccess?.getSelectionState?.();
            return {
                pending: state?.selectionTokenPending === true,
                tokenScoped: state?.scope === "filtered" && Boolean(state?.selectionToken),
            };
        },

        async openModal(preferredScope = null) {
            this._resetResult();
            this._setStatus("");
            const selectionBoundary = this._getSelectionBoundary();
            const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
            const selectionIds = window.AppFilterAccess?.getSelectedImageIds?.() || [];
            const scope = preferredScope
                || (selectionBoundary.tokenScoped || selectionToken || selectionIds.length ? "selection" : "filter");
            const scopeRadio = document.querySelector(`input[name="mass-tag-scope"][value="${scope}"]`);
            if (scopeRadio) scopeRadio.checked = true;
            await this.refreshScopeLabels();
            if (selectionBoundary.pending) {
                this._setStatus(
                    this.t("Updating filtered selection...", "正在更新筛选选择范围..."),
                    "info",
                );
            }
            // v3.2.2: prefer the global showModal so this modal gets the
            // same Escape-key handler, focus trap, and focus restore as
            // every other modal in the app. Falls back to the manual
            // class toggle if the helper isn't loaded yet (defensive).
            if (typeof window.showModal === "function") {
                window.showModal("mass-tag-modal");
            } else {
                document.getElementById("mass-tag-modal")?.classList.add("visible");
            }
        },

        closeModal() {
            // v3.2.2: use the global hideModal so the focus-trap and
            // Escape-listener cleanup matches every other modal.
            if (typeof window.hideModal === "function") {
                window.hideModal("mass-tag-modal");
            } else {
                document.getElementById("mass-tag-modal")?.classList.remove("visible");
            }
            // Reset any leftover "Resolving scope…" status from a prior open
            // so the next open starts clean.
            this._setStatus("");
            this.closeConfirm();
        },

        // ---- Tab switch ---------------------------------------------------

        switchTab(tabId) {
            if (!tabId || !ENDPOINTS[tabId]) return;
            this.activeTab = tabId;
            document.querySelectorAll(".mass-tag-tab").forEach(tab => {
                const isActive = tab.dataset.massTagTab === tabId;
                tab.classList.toggle("active", isActive);
                tab.setAttribute("aria-selected", String(isActive));
            });
            document.querySelectorAll(".mass-tag-panel").forEach(panel => {
                panel.hidden = panel.dataset.panel !== tabId;
            });
            this._resetResult();
            this._setStatus("");
        },

        // ---- Scope --------------------------------------------------------

        async refreshScopeLabels() {
            const selectionBoundary = this._getSelectionBoundary();
            const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
            const selectionIds = window.AppFilterAccess?.getSelectedImageIds?.() || [];
            const selCount = selectionToken
                ? Number(window.AppFilterAccess?.getSelectionTotal?.() || 0)
                : selectionIds.length;
            const selEl = document.getElementById("mass-tag-scope-selection-count");
            if (selEl) {
                if (selectionBoundary.pending) {
                    selEl.textContent = this.t(
                        "— updating filtered selection...",
                        "— 正在更新筛选选择范围...",
                    );
                } else {
                    const suffix = selectionToken
                        ? this.t(" filtered-token selection", " 个筛选 token 选择")
                        : this.t(" images", " 张");
                    selEl.textContent = `— ${selCount.toLocaleString()}${suffix}`;
                }
            }
            const filterEl = document.getElementById("mass-tag-scope-filter-count");
            if (filterEl) {
                // Don't pre-fetch — wait until user picks filter scope or hits dry-run.
                filterEl.textContent = this.t("— resolved when previewed", "— 预览时计算");
            }
        },

        getScopeValue() {
            const checked = document.querySelector('input[name="mass-tag-scope"]:checked');
            return checked?.value || "selection";
        },

        _getExplicitSelectionIds() {
            const rawIds = window.AppFilterAccess?.getSelectedImageIds?.() || [];
            return rawIds
                .map(id => Number(id))
                .filter(id => Number.isFinite(id) && id > 0)
                .slice(0, BACKEND_MAX_IDS);
        },

        /** Resolve the current scope choice to backend scope fields. */
        async resolveScopePayload() {
            if (this._getSelectionBoundary().pending) {
                this._setStatus(
                    this.t("Updating filtered selection...", "正在更新筛选选择范围..."),
                    "warning",
                );
                return null;
            }
            const scope = this.getScopeValue();
            if (scope === "selection") {
                const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
                if (selectionToken) {
                    const total = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
                    this.scopeLabel = this.t(
                        `${total.toLocaleString()} selected images`,
                        `已选 ${total.toLocaleString()} 张`,
                    );
                    return {
                        scopeFields: { selection_token: selectionToken },
                        scopeSize: total,
                        source: "selection_token",
                    };
                }

                const rawIds = window.AppFilterAccess?.getSelectedImageIds?.() || [];
                const ids = this._getExplicitSelectionIds();
                this.scopeLabel = this.t(
                    `${ids.length.toLocaleString()} selected images`,
                    `已选 ${ids.length.toLocaleString()} 张`,
                );
                if (rawIds.length > ids.length) {
                    this._setStatus(
                        this.t(
                            `Selection was capped at ${BACKEND_MAX_IDS.toLocaleString()} explicit IDs. Use filtered selection for larger scopes.`,
                            `显式选择已截断到 ${BACKEND_MAX_IDS.toLocaleString()} 个 ID。更大范围请使用筛选选择。`,
                        ),
                        "warning",
                    );
                }
                return {
                    scopeFields: { image_ids: ids },
                    scopeSize: ids.length,
                    source: "image_ids",
                };
            }
            // Filter scope: create a stateless token and let the bulk-tag
            // backend consume it in DB chunks. Do not expand it in the browser.
            try {
                const tokenBody = this._buildSelectionTokenBody();
                const tokenResp = await fetch("/api/images/selection-token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(tokenBody),
                });
                if (!tokenResp.ok) {
                    throw new Error(`/api/images/selection-token returned ${tokenResp.status}`);
                }
                const tokenData = await tokenResp.json();
                const selectionToken = tokenData.selection_token;
                const total = tokenData.total_estimate ?? 0;
                const countText = tokenData.exact_total === false
                    ? this.t(
                        `${Number(total).toLocaleString()} estimated images`,
                        `约 ${Number(total).toLocaleString()} 张`,
                    )
                    : this.t(
                        `${Number(total).toLocaleString()} images`,
                        `${Number(total).toLocaleString()} 张`,
                    );
                this.scopeLabel = this.t(
                    `current filter — ${countText}`,
                    `当前筛选 — ${countText}`,
                );
                return {
                    scopeFields: { selection_token: selectionToken },
                    scopeSize: Number(total) || 0,
                    source: "selection_token",
                };
            } catch (e) {
                this._setStatus(String(e.message || e), "error");
                return null;
            }
        },

        /** Build the request body for /api/images/selection-token from current filter state. */
        _buildSelectionTokenBody() {
            const filters = window.AppFilterStore?.getState?.() || {};
            const request = window.App?.buildSelectionFilterRequest
                ? window.App.buildSelectionFilterRequest(filters)
                : {
                    generators: Array.isArray(filters.generators) ? filters.generators : [],
                    tags: Array.isArray(filters.tags) ? filters.tags : [],
                    tagMode: filters.tagMode === "or" ? "or" : "and",
                    ratings: Array.isArray(filters.ratings) ? filters.ratings : [],
                    checkpoints: Array.isArray(filters.checkpoints) ? filters.checkpoints : [],
                    loras: Array.isArray(filters.loras) ? filters.loras : [],
                    prompts: Array.isArray(filters.prompts) ? filters.prompts : [],
                    promptMatchMode: filters.promptMatchMode || "exact",
                    artist: filters.artist || null,
                    search: filters.search || "",
                    sortBy: filters.sortBy || "newest",
                    minWidth: filters.minWidth ?? null,
                    maxWidth: filters.maxWidth ?? null,
                    minHeight: filters.minHeight ?? null,
                    maxHeight: filters.maxHeight ?? null,
                    aspectRatio: filters.aspectRatio || null,
                    minAesthetic: filters.minAesthetic ?? null,
                    maxAesthetic: filters.maxAesthetic ?? null,
                    brightnessMin: filters.brightnessMin ?? null,
                    brightnessMax: filters.brightnessMax ?? null,
                    colorTemperature: filters.colorTemperature || null,
                    brightnessDistribution: filters.brightnessDistribution || null,
                    excludeTags: Array.isArray(filters.excludeTags) ? filters.excludeTags : [],
                    excludeGenerators: Array.isArray(filters.excludeGenerators) ? filters.excludeGenerators : [],
                    excludeRatings: Array.isArray(filters.excludeRatings) ? filters.excludeRatings : [],
                    excludeCheckpoints: Array.isArray(filters.excludeCheckpoints) ? filters.excludeCheckpoints : [],
                    excludeLoras: Array.isArray(filters.excludeLoras) ? filters.excludeLoras : [],
                };
            return {
                ...request,
                excludedImageIds: [],
                chunkSize: 5000,
            };
        },

        // ---- Build request body ------------------------------------------

        _collectFindReplace(scopeFields, dryRun) {
            return {
                ...scopeFields,
                find: document.getElementById("mass-tag-find")?.value || "",
                replace: document.getElementById("mass-tag-replace")?.value || "",
                case_sensitive: !!document.getElementById("mass-tag-find-replace-case")?.checked,
                regex: !!document.getElementById("mass-tag-find-replace-regex")?.checked,
                dry_run: !!dryRun,
            };
        },

        _collectAdd(scopeFields, dryRun) {
            const raw = document.getElementById("mass-tag-add-tags")?.value || "";
            const tags = raw.split(",").map(t => t.trim()).filter(Boolean);
            return {
                ...scopeFields,
                tags,
                confidence: parseFloat(document.getElementById("mass-tag-add-confidence")?.value) || 0.85,
                dry_run: !!dryRun,
            };
        },

        _collectRemove(scopeFields, dryRun) {
            const raw = document.getElementById("mass-tag-remove-tags")?.value || "";
            const tags = raw.split(",").map(t => t.trim()).filter(Boolean);
            return {
                ...scopeFields,
                tags,
                case_sensitive: !!document.getElementById("mass-tag-remove-case")?.checked,
                dry_run: !!dryRun,
            };
        },

        _collectCleanup(scopeFields, dryRun) {
            return {
                ...scopeFields,
                min_confidence: parseFloat(document.getElementById("mass-tag-cleanup-confidence")?.value) || 0.20,
                dedupe: !!document.getElementById("mass-tag-cleanup-dedupe")?.checked,
                dry_run: !!dryRun,
            };
        },

        _collectBody(scopeFields, dryRun) {
            switch (this.activeTab) {
                case "find_replace": return this._collectFindReplace(scopeFields, dryRun);
                case "add":          return this._collectAdd(scopeFields, dryRun);
                case "remove":       return this._collectRemove(scopeFields, dryRun);
                case "cleanup":      return this._collectCleanup(scopeFields, dryRun);
                default: return null;
            }
        },

        _buildPreviewSignature() {
            const scope = this.getScopeValue();
            let scopeContract;
            if (scope === "selection") {
                const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
                scopeContract = selectionToken
                    ? { selection_token: selectionToken }
                    : { image_ids: [...this._getExplicitSelectionIds()].sort((left, right) => left - right) };
            } else {
                scopeContract = { filter: this._buildSelectionTokenBody() };
            }
            const { dry_run: _dryRun, ...operation } = this._collectBody({}, /*dryRun=*/ true);
            return JSON.stringify({
                active_tab: this.activeTab,
                scope,
                scope_contract: scopeContract,
                operation,
            });
        },

        _setApplyEnabled(enabled) {
            const button = document.getElementById("btn-mass-tag-apply");
            if (button) button.disabled = !enabled;
        },

        _invalidateOpenPreview() {
            if (!document.getElementById("mass-tag-modal")?.classList.contains("visible")) return;
            this._resetResult();
            this._setStatus("");
        },

        _rejectStalePreview() {
            this._resetResult();
            this._setStatus(
                this.t(
                    "Operation or scope changed — run the dry-run preview again.",
                    "操作或范围已改变 — 请重新试算预览。",
                ),
                "warning",
            );
        },

        _validateResult(data, operationTab, expectedDryRun) {
            const expectedOperation = RESULT_OPERATIONS[operationTab];
            const countFields = RESULT_COUNT_FIELDS[operationTab] || [];
            const valid = data
                && typeof data === "object"
                && data.operation === expectedOperation
                && data.dry_run === expectedDryRun
                && isNonNegativeInteger(data.total_images_checked)
                && isNonNegativeInteger(data.affected_images)
                && data.affected_images <= data.total_images_checked
                && Array.isArray(data.sample_changes)
                && data.sample_changes.length <= 5
                && data.sample_changes.every(sample => isValidSampleChange(sample, operationTab))
                && countFields.every(field => isNonNegativeInteger(data[field]));
            if (valid) return null;
            return expectedDryRun
                ? this.t(
                    "The server returned invalid preview data for the Mass Tag operation.",
                    "服务器返回了无效的批量标签预览数据。",
                )
                : this.t(
                    "The operation may have been applied, but the server returned invalid result data. Reload Gallery before deciding whether to retry.",
                    "操作可能已经应用，但服务器返回了无效结果数据。请先重新加载图库，再决定是否重试。",
                );
        },

        // ---- Validation ---------------------------------------------------

        /** Returns string error or null if valid. */
        _validate(body) {
            const hasImageIds = Array.isArray(body.image_ids) && body.image_ids.length > 0;
            const hasSelectionToken = typeof body.selection_token === "string" && body.selection_token.trim().length > 0;
            const hasFilters = body.filters && typeof body.filters === "object";
            if (!hasImageIds && !hasSelectionToken && !hasFilters) {
                return this.t(
                    "Scope is empty — select some images or pick a filter that matches at least one image.",
                    "范围为空 — 请先选中图片或选一个能匹配的筛选条件。",
                );
            }
            if (this.activeTab === "find_replace") {
                if (!body.find?.trim()) return this.t("Enter a tag to find.", "请输入要查找的标签。");
            }
            if (this.activeTab === "add" && (!body.tags || body.tags.length === 0)) {
                return this.t("Enter at least one tag to add.", "请输入至少一个要添加的标签。");
            }
            if (this.activeTab === "add" && body.tags.length > 200) {
                return this.t("Too many tags — 200 max per request.", "标签太多 — 每次最多 200 个。");
            }
            if (this.activeTab === "remove" && (!body.tags || body.tags.length === 0)) {
                return this.t("Enter at least one tag to remove.", "请输入至少一个要删除的标签。");
            }
            if (this.activeTab === "remove" && body.tags.length > 200) {
                return this.t("Too many tags — 200 max per request.", "标签太多 — 每次最多 200 个。");
            }
            return null;
        },

        // ---- Dry-run ------------------------------------------------------

        async runDryRun() {
            this._resetResult();
            const previewEpoch = this.previewEpoch;
            const operationTab = this.activeTab;
            this._setStatus(this.t("Resolving scope…", "正在计算范围..."), "info");
            const scope = await this.resolveScopePayload();
            if (previewEpoch !== this.previewEpoch) return;
            if (!scope || scope.scopeSize === 0) {
                this._setStatus(
                    this.t(
                        "Scope is empty — select some images or pick a filter that matches at least one image.",
                        "范围为空 — 请先选中图片或选一个能匹配的筛选条件。",
                    ),
                    "error",
                );
                return;
            }

            const body = this._collectBody(scope.scopeFields, /*dryRun=*/ true);
            const previewSignature = this._buildPreviewSignature();
            const validation = this._validate(body);
            if (validation) {
                this._setStatus(validation, "error");
                return;
            }

            this._setStatus(this.t("Running dry-run…", "正在试算..."), "info");
            try {
                const resp = await fetch(ENDPOINTS[operationTab], {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await resp.json().catch(() => ({}));
                if (previewEpoch !== this.previewEpoch) return;
                if (!resp.ok) {
                    this._setStatus(responseErrorMessage(data, resp), "error");
                    return;
                }
                const resultValidation = this._validateResult(data, operationTab, /*expectedDryRun=*/ true);
                if (resultValidation) {
                    this._setStatus(resultValidation, "error");
                    return;
                }
                if (previewSignature !== this._buildPreviewSignature()) {
                    this._rejectStalePreview();
                    return;
                }
                this.lastDryRunResult = {
                    ...data,
                    _scope: scope,
                    _previewSignature: previewSignature,
                };
                this._renderResult(data);
                this._setApplyEnabled(true);
                this._setStatus(this.t("Dry-run complete — review the summary, then click Apply.", "试算完成 — 请检查摘要后再点 Apply。"), "success");
            } catch (e) {
                if (previewEpoch !== this.previewEpoch) return;
                this._setStatus(String(e.message || e), "error");
            }
        },

        // ---- Apply path ---------------------------------------------------

        async tryApply() {
            const operationTab = this.activeTab;
            const previewSignature = this._buildPreviewSignature();
            const previewEpoch = this.previewEpoch;
            if (this.lastDryRunResult?._previewSignature !== previewSignature) {
                this._rejectStalePreview();
                return;
            }
            this._setApplyEnabled(false);
            // Always force a fresh resolve so we capture the *current* selection,
            // not whatever the user previewed five minutes ago.
            this._setStatus(this.t("Resolving scope…", "正在计算范围..."), "info");
            const scope = await this.resolveScopePayload();
            if (
                previewEpoch !== this.previewEpoch
                || this.lastDryRunResult?._previewSignature !== previewSignature
                || previewSignature !== this._buildPreviewSignature()
            ) {
                this._rejectStalePreview();
                return;
            }
            if (!scope || scope.scopeSize === 0) {
                this._setStatus(
                    this.t(
                        "Scope is empty — select some images or pick a filter that matches at least one image.",
                        "范围为空 — 请先选中图片或选一个能匹配的筛选条件。",
                    ),
                    "error",
                );
                return;
            }

            const body = this._collectBody(scope.scopeFields, /*dryRun=*/ false);
            const validation = this._validate(body);
            if (validation) {
                this._setStatus(validation, "error");
                return;
            }

            const scopeSize = scope.scopeSize;
            if (scopeSize > MAX_NOCONFIRM) {
                this._openConfirm(body, scopeSize, previewSignature, operationTab);
                return;
            }
            // Small scope — just run it.
            await this._performApply(body, operationTab);
        },

        /**
         * Open the secondary confirm dialog with a 2-second delayed primary button.
         * Stores `body` on the editor so the confirm-button handler can read it back.
         */
        _openConfirm(body, scopeSize, previewSignature, operationTab) {
            this._pendingApplyBody = body;
            this._pendingApplySignature = previewSignature;
            this._pendingApplyTab = operationTab;
            const dl = document.getElementById("mass-tag-confirm-summary");
            if (dl) {
                const lang = window.I18n?.getLang?.();
                const tabTitle = (lang === "zh-CN" ? TAB_TITLES_ZH : TAB_TITLES_EN)[this.activeTab] || this.activeTab;
                const detailLines = [
                    [this.t("Operation", "操作"), tabTitle],
                    [this.t("Scope", "范围"), this.scopeLabel || `${scopeSize.toLocaleString()} images`],
                ];
                if (this.activeTab === "find_replace") {
                    detailLines.push([this.t("Find", "查找"), body.find]);
                    detailLines.push([this.t("Replace", "替换"), body.replace || this.t("(remove tag)", "（删除标签）")]);
                } else if (this.activeTab === "add") {
                    detailLines.push([this.t("Add tags", "添加"), body.tags.join(", ")]);
                    detailLines.push([this.t("Confidence", "置信度"), String(body.confidence)]);
                } else if (this.activeTab === "remove") {
                    detailLines.push([this.t("Remove tags", "删除"), body.tags.join(", ")]);
                } else if (this.activeTab === "cleanup") {
                    detailLines.push([this.t("Min confidence", "最小置信度"), String(body.min_confidence)]);
                    detailLines.push([this.t("Dedupe", "去重"), body.dedupe ? this.t("yes", "是") : this.t("no", "否")]);
                }
                if (this.lastDryRunResult && this.lastDryRunResult.affected_images != null) {
                    detailLines.push([
                        this.t("Dry-run affected", "试算影响"),
                        this.t(`${this.lastDryRunResult.affected_images.toLocaleString()} images`,
                              `${this.lastDryRunResult.affected_images.toLocaleString()} 张`),
                    ]);
                }
                // Build DOM with textContent so user values cannot inject HTML.
                dl.innerHTML = "";
                detailLines.forEach(([k, v]) => {
                    const dt = document.createElement("dt");
                    const dd = document.createElement("dd");
                    dt.textContent = k;
                    dd.textContent = v;
                    dl.appendChild(dt);
                    dl.appendChild(dd);
                });
            }
            document.getElementById("mass-tag-confirm-modal")?.classList.add("visible");

            // Disable Apply for 2s; update label with countdown.
            const btn = document.getElementById("btn-mass-tag-confirm-apply");
            const label = document.getElementById("mass-tag-confirm-apply-label");
            if (!btn || !label) return;
            btn.disabled = true;
            this._tickCountdown(CONFIRM_DELAY_MS / 1000);
        },

        _tickCountdown(secondsRemaining) {
            const btn = document.getElementById("btn-mass-tag-confirm-apply");
            const label = document.getElementById("mass-tag-confirm-apply-label");
            if (!btn || !label) return;
            if (secondsRemaining <= 0) {
                btn.disabled = false;
                label.textContent = this.t("Apply now", "立即应用");
                return;
            }
            label.textContent = this.t(`Apply in ${secondsRemaining}s…`, `${secondsRemaining} 秒后可应用…`);
            this.confirmTimer = setTimeout(() => this._tickCountdown(secondsRemaining - 1), 1000);
        },

        closeConfirm() {
            document.getElementById("mass-tag-confirm-modal")?.classList.remove("visible");
            if (this.confirmTimer) {
                clearTimeout(this.confirmTimer);
                this.confirmTimer = null;
            }
            this._pendingApplyBody = null;
            this._pendingApplySignature = null;
            this._pendingApplyTab = null;
            this._setApplyEnabled(
                this.lastDryRunResult?._previewSignature === this._buildPreviewSignature(),
            );
        },

        async runApply() {
            const body = this._pendingApplyBody;
            const previewSignature = this._pendingApplySignature;
            const operationTab = this._pendingApplyTab;
            this.closeConfirm();
            if (!body || !operationTab) return;
            if (
                !previewSignature
                || this.lastDryRunResult?._previewSignature !== previewSignature
                || this._buildPreviewSignature() !== previewSignature
            ) {
                this._rejectStalePreview();
                return;
            }
            this._setApplyEnabled(false);
            await this._performApply(body, operationTab);
        },

        async _performApply(body, operationTab) {
            this._setStatus(this.t("Applying…", "正在应用..."), "info");
            try {
                const resp = await fetch(ENDPOINTS[operationTab], {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    this._resetResult();
                    this._setStatus(responseErrorMessage(data, resp), "error");
                    return;
                }
                const resultValidation = this._validateResult(data, operationTab, /*expectedDryRun=*/ false);
                if (resultValidation) {
                    this._resetResult();
                    this._setStatus(resultValidation, "error");
                    return;
                }
                this._resetResult();
                this._renderResult(data, /*applied=*/ true);
                const warning = responseWarningMessage(data);
                if (warning) {
                    this._setStatus(warning, "warning");
                } else {
                    this._setStatus(this.t("Applied. Gallery will reflect changes on next load.", "已应用，下次加载图库时生效。"), "success");
                }
                try { window.dispatchEvent(new CustomEvent("massTagOperationApplied", { detail: data })); } catch (_) {}
            } catch (e) {
                this._resetResult();
                this._setStatus(String(e.message || e), "error");
            }
        },

        // ---- Result rendering --------------------------------------------

        _renderResult(data, applied = false) {
            const box = document.getElementById("mass-tag-result");
            const summary = document.getElementById("mass-tag-result-summary");
            const samples = document.getElementById("mass-tag-result-samples");
            const samplesBody = document.getElementById("mass-tag-result-samples-body");
            if (!box || !summary) return;

            const prefix = applied
                ? this.t("Applied", "已应用")
                : this.t("Dry-run", "试算");
            const lines = [
                `${prefix} — ${data.operation || this.activeTab}`,
                `${this.t("Checked:", "检查:")} ${data.total_images_checked?.toLocaleString?.() ?? "?"} ${this.t("images", "张")}`,
                `${this.t("Affected:", "影响:")} ${data.affected_images?.toLocaleString?.() ?? 0} ${this.t("images", "张")}`,
            ];
            if (data.affected_tags != null) lines.push(`${this.t("Tag rows:", "标签行:")} ${data.affected_tags.toLocaleString()}`);
            if (data.total_tags_added != null) lines.push(`${this.t("Tags added:", "新增标签:")} ${data.total_tags_added.toLocaleString()}`);
            if (data.total_tags_removed != null) lines.push(`${this.t("Tags removed:", "删除标签:")} ${data.total_tags_removed.toLocaleString()}`);
            if (data.total_low_conf_removed != null) lines.push(`${this.t("Low-confidence removed:", "低置信删除:")} ${data.total_low_conf_removed.toLocaleString()}`);
            if (data.total_duplicates_removed != null) lines.push(`${this.t("Duplicates removed:", "去重删除:")} ${data.total_duplicates_removed.toLocaleString()}`);
            summary.textContent = lines.join("  ·  ");

            if (samples && samplesBody && Array.isArray(data.sample_changes) && data.sample_changes.length > 0) {
                samplesBody.textContent = data.sample_changes
                    .map(s => JSON.stringify(s, null, 2))
                    .join("\n\n");
                samples.hidden = false;
                samples.open = false;
            } else if (samples) {
                samples.hidden = true;
            }
            this._renderUndoButton(box, applied ? data : null);
            box.hidden = false;
            box.classList.toggle("danger", (data.affected_images || 0) > MAX_NOCONFIRM);
        },

        // FE-2s: applied ops are journaled server-side — offer one-click undo.
        _renderUndoButton(box, data) {
            let btn = document.getElementById("mass-tag-undo-op");
            if (!data || !data.op_id || !data.undo_available) {
                if (btn) btn.remove();
                return;
            }
            if (!btn) {
                btn = document.createElement("button");
                btn.id = "mass-tag-undo-op";
                btn.type = "button";
                btn.className = "btn btn-ghost btn-small";
                box.appendChild(btn);
            }
            btn.disabled = false;
            btn.textContent = this.t("↩ Undo this operation", "↩ 撤销这次操作");
            btn.onclick = async () => {
                btn.disabled = true;
                try {
                    const resp = await fetch(`/api/tags/bulk/undo/${encodeURIComponent(data.op_id)}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({}),
                    });
                    const result = await resp.json().catch(() => ({}));
                    if (!resp.ok) {
                        this._setStatus(responseErrorMessage(result, resp), "error");
                        btn.disabled = false;
                        return;
                    }
                    const skipped = (result.skipped_conflicts || []).length;
                    const msg = skipped > 0
                        ? this.t(
                            `Undone: ${result.restored} images restored, ${skipped} skipped (edited since).`,
                            `已撤销：恢复 ${result.restored} 张，跳过 ${skipped} 张（此后被编辑过）。`)
                        : this.t(
                            `Undone: ${result.restored} images restored.`,
                            `已撤销：恢复 ${result.restored} 张。`);
                    const warning = responseWarningMessage(result);
                    this._setStatus(
                        warning ? `${msg} ${warning}` : msg,
                        warning ? "warning" : "success",
                    );
                    btn.textContent = this.t("Undone", "已撤销");
                    try { window.dispatchEvent(new CustomEvent("massTagOperationApplied", { detail: result })); } catch (_) {}
                } catch (e) {
                    this._setStatus(String(e.message || e), "error");
                    btn.disabled = false;
                }
            };
        },

        _resetResult() {
            const box = document.getElementById("mass-tag-result");
            if (box) box.hidden = true;
            this.lastDryRunResult = null;
            this.previewEpoch += 1;
            this._setApplyEnabled(false);
        },

        // ---- Status banner -----------------------------------------------

        _setStatus(message, level) {
            const el = document.getElementById("mass-tag-status");
            if (!el) return;
            if (!message) {
                el.style.display = "none";
                el.textContent = "";
                el.className = "vlm-status";
                return;
            }
            el.style.display = "block";
            el.textContent = message;
            el.className = `vlm-status vlm-status-${level || "info"}`;
        },
    };

    window.MassTagEditor = MassTagEditor;
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => MassTagEditor.init());
    } else {
        MassTagEditor.init();
    }
})();
