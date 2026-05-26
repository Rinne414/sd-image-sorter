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

    const MassTagEditor = {
        activeTab: "find_replace",
        scopeLabel: "",
        confirmTimer: null,
        lastDryRunResult: null,
        _pendingApplyBody: null,

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
            document.getElementById("btn-mass-tag-close")?.addEventListener("click", () => this.closeModal());
            document.querySelector("#mass-tag-modal .modal-backdrop")?.addEventListener("click", () => this.closeModal());
            document.querySelectorAll(".mass-tag-tab").forEach(tab => {
                tab.addEventListener("click", () => this.switchTab(tab.dataset.massTagTab));
            });
            document.querySelectorAll('input[name="mass-tag-scope"]').forEach(radio => {
                radio.addEventListener("change", () => this.refreshScopeLabels());
            });
            document.getElementById("btn-mass-tag-dry-run")?.addEventListener("click", () => this.runDryRun());
            document.getElementById("btn-mass-tag-apply")?.addEventListener("click", () => this.tryApply());

            // Confirm dialog
            document.getElementById("btn-mass-tag-confirm-cancel")?.addEventListener("click", () => this.closeConfirm());
            document.querySelector("#mass-tag-confirm-modal .modal-backdrop")?.addEventListener("click", () => this.closeConfirm());
            document.getElementById("btn-mass-tag-confirm-apply")?.addEventListener("click", () => this.runApply());
        },

        // ---- Modal open / close ------------------------------------------

        async openModal() {
            this._resetResult();
            this._setStatus("");
            await this.refreshScopeLabels();
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
        },

        // ---- Scope --------------------------------------------------------

        async refreshScopeLabels() {
            const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
            const selectionIds = window.AppFilterAccess?.getSelectedImageIds?.() || [];
            const selCount = selectionToken
                ? Number(window.AppFilterAccess?.getSelectionTotal?.() || 0)
                : selectionIds.length;
            const selEl = document.getElementById("mass-tag-scope-selection-count");
            if (selEl) {
                const suffix = selectionToken
                    ? this.t(" filtered-token selection", " 个筛选 token 选择")
                    : this.t(" images", " 张");
                selEl.textContent = `— ${selCount.toLocaleString()}${suffix}`;
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

        /** Resolve the current scope choice to backend scope fields. */
        async resolveScopePayload() {
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
                const ids = rawIds
                    .map(id => Number(id))
                    .filter(id => Number.isFinite(id) && id > 0)
                    .slice(0, BACKEND_MAX_IDS);
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
            this._setStatus(this.t("Resolving scope…", "正在计算范围..."), "info");
            const scope = await this.resolveScopePayload();
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
            const validation = this._validate(body);
            if (validation) {
                this._setStatus(validation, "error");
                return;
            }

            this._setStatus(this.t("Running dry-run…", "正在试算..."), "info");
            try {
                const resp = await fetch(ENDPOINTS[this.activeTab], {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    this._setStatus(data.detail || resp.statusText, "error");
                    return;
                }
                this.lastDryRunResult = { ...data, _scope: scope };
                this._renderResult(data);
                this._setStatus(this.t("Dry-run complete — review the summary, then click Apply.", "试算完成 — 请检查摘要后再点 Apply。"), "success");
            } catch (e) {
                this._setStatus(String(e.message || e), "error");
            }
        },

        // ---- Apply path ---------------------------------------------------

        async tryApply() {
            // Always force a fresh resolve so we capture the *current* selection,
            // not whatever the user previewed five minutes ago.
            this._setStatus(this.t("Resolving scope…", "正在计算范围..."), "info");
            const scope = await this.resolveScopePayload();
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
                this._openConfirm(body, scopeSize);
                return;
            }
            // Small scope — just run it.
            await this._performApply(body);
        },

        /**
         * Open the secondary confirm dialog with a 2-second delayed primary button.
         * Stores `body` on the editor so the confirm-button handler can read it back.
         */
        _openConfirm(body, scopeSize) {
            this._pendingApplyBody = body;
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
        },

        async runApply() {
            const body = this._pendingApplyBody;
            this.closeConfirm();
            if (!body) return;
            await this._performApply(body);
        },

        async _performApply(body) {
            this._setStatus(this.t("Applying…", "正在应用..."), "info");
            try {
                const resp = await fetch(ENDPOINTS[this.activeTab], {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    this._setStatus(data.detail || resp.statusText, "error");
                    return;
                }
                this._renderResult(data, /*applied=*/ true);
                this._setStatus(this.t("Applied. Gallery will reflect changes on next load.", "已应用，下次加载图库时生效。"), "success");
                try { window.dispatchEvent(new CustomEvent("massTagOperationApplied", { detail: data })); } catch (_) {}
            } catch (e) {
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
            box.hidden = false;
            box.classList.toggle("danger", (data.affected_images || 0) > MAX_NOCONFIRM);
        },

        _resetResult() {
            const box = document.getElementById("mass-tag-result");
            if (box) box.hidden = true;
            this.lastDryRunResult = null;
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
