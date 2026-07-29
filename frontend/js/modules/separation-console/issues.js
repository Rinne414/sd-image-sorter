/**
 * Review Cockpit issue queue. This module reads the current Dataset Maker
 * session and renders only backend-verified, read-only findings.
 */
'use strict';

(() => {
    const REVIEW_SCHEMA_VERSION = 1;
    const REVIEW_PAGE_LIMIT = 25;
    const REVIEW_ISSUE_KINDS = Object.freeze([
        'file_missing',
        'image_unreadable',
        'empty_caption',
        'small_image',
        'low_aesthetic',
        'duplicate_group',
        'rating_conflict',
        'low_tag_confidence',
        'metadata_provenance_risk',
        'sidecar_metadata_dependency',
    ]);
    const REVIEW_SEVERITIES = new Set(['high', 'medium', 'low']);
    const REVIEW_SOURCE_PROVIDERS = new Set([
        'database',
        'caption_states',
        'persisted_duplicates',
        'metadata_provenance',
    ]);
    const REVIEW_EVIDENCE_STATUSES = new Set(['available', 'partial', 'not_available']);
    const REVIEW_PROVIDER_STATUSES = new Set(['available', 'partial', 'not_available', 'not_requested']);
    const REVIEW_ACTION_AVAILABILITY = new Set(['available', 'not_available']);
    const REVIEW_PROVIDERS = Object.freeze([
        'scope',
        'file_integrity',
        'caption_integrity',
        'dimensions',
        'aesthetic_scores',
        'persisted_duplicates',
        'tag_integrity',
        'metadata_provenance',
    ]);
    const REVIEW_PROVIDER_NAMES = new Set(REVIEW_PROVIDERS);
    const REVIEW_SEVERITY_LABELS = Object.freeze({
        high: ['High', '高'],
        medium: ['Medium', '中'],
        low: ['Low', '低'],
    });
    const REVIEW_SOURCE_LABELS = Object.freeze({
        database: ['Database', '数据库'],
        caption_states: ['Current caption', '当前 Caption'],
        persisted_duplicates: ['Saved duplicate scan', '已存重复扫描'],
        metadata_provenance: ['Metadata provenance', '元数据来源'],
    });
    const REVIEW_PROVIDER_LABELS = Object.freeze({
        scope: ['Scope', '范围'],
        file_integrity: ['File integrity', '文件完整性'],
        caption_integrity: ['Caption integrity', 'Caption 完整性'],
        dimensions: ['Dimensions', '图片尺寸'],
        aesthetic_scores: ['Stored aesthetics', '已存美学评分'],
        persisted_duplicates: ['Saved duplicate scan', '已存重复扫描'],
        tag_integrity: ['Tag integrity', '标签完整性'],
        metadata_provenance: ['Metadata provenance', '元数据来源'],
    });
    const REVIEW_STATUS_LABELS = Object.freeze({
        available: ['Available', '可用'],
        partial: ['Partial', '部分可用'],
        not_available: ['Not available', '不可用'],
        not_requested: ['Not requested', '未请求'],
    });
    const REVIEW_FILTER_KINDS = Object.freeze({
        all: REVIEW_ISSUE_KINDS,
        file: ['file_missing', 'image_unreadable'],
        caption: ['empty_caption'],
        size: ['small_image'],
        quality: ['low_aesthetic'],
        duplicate: ['duplicate_group'],
        tag_integrity: ['rating_conflict'],
        low_tag_confidence: ['low_tag_confidence'],
        metadata_provenance: ['metadata_provenance_risk'],
        sidecar_fallback: ['sidecar_metadata_dependency'],
    });

    function reviewRequireObject(value, context) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError(`Review queue response is invalid: ${context} must be an object.`);
        }
        return value;
    }

    function reviewRequireString(value, context) {
        if (typeof value !== 'string') {
            throw new TypeError(`Review queue response is invalid: ${context} must be a string.`);
        }
        return value;
    }

    function reviewRequireNullableString(value, context) {
        if (value === null) return null;
        return reviewRequireString(value, context);
    }

    function reviewRequireInteger(value, context, minimum) {
        if (!Number.isInteger(value) || value < minimum) {
            throw new TypeError(`Review queue response is invalid: ${context} must be an integer >= ${minimum}.`);
        }
        return value;
    }

    function reviewRequireEnum(value, allowed, context) {
        if (typeof value !== 'string' || !allowed.has(value)) {
            throw new TypeError(`Review queue response is invalid: ${context} is unsupported.`);
        }
        return value;
    }

    function reviewLocalizedLabel(labels, value, context) {
        const pair = labels[value];
        if (!Array.isArray(pair) || pair.length !== 2) {
            throw new TypeError(`Review queue response is invalid: ${context} has no localized label.`);
        }
        return sepconT(pair[0], pair[1]);
    }

    function reviewParseSubject(value, index) {
        const subject = reviewRequireObject(value, `subjects[${index}]`);
        return {
            image_id: reviewRequireInteger(subject.image_id, `subjects[${index}].image_id`, 1),
            filename: reviewRequireNullableString(subject.filename, `subjects[${index}].filename`),
            source_path: reviewRequireNullableString(subject.source_path, `subjects[${index}].source_path`),
        };
    }

    function reviewParseEvidence(value, index) {
        const evidence = reviewRequireObject(value, `evidence[${index}]`);
        return {
            label_en: reviewRequireString(evidence.label_en, `evidence[${index}].label_en`),
            label_zh: reviewRequireString(evidence.label_zh, `evidence[${index}].label_zh`),
            value_en: reviewRequireString(evidence.value_en, `evidence[${index}].value_en`),
            value_zh: reviewRequireString(evidence.value_zh, `evidence[${index}].value_zh`),
        };
    }

    function reviewParseIssue(value, index) {
        const issue = reviewRequireObject(value, `issues[${index}]`);
        const subjects = issue.subjects;
        const evidence = issue.evidence;
        if (!Array.isArray(subjects) || subjects.length === 0) {
            throw new TypeError(`Review queue response is invalid: issues[${index}].subjects must be non-empty.`);
        }
        if (!Array.isArray(evidence) || evidence.length === 0) {
            throw new TypeError(`Review queue response is invalid: issues[${index}].evidence must be non-empty.`);
        }
        const action = reviewRequireObject(issue.action, `issues[${index}].action`);
        if (action.kind !== 'open_image') {
            throw new TypeError(`Review queue response is invalid: issues[${index}].action.kind is unsupported.`);
        }
        return {
            issue_id: reviewRequireString(issue.issue_id, `issues[${index}].issue_id`),
            kind: reviewRequireEnum(issue.kind, new Set(REVIEW_ISSUE_KINDS), `issues[${index}].kind`),
            severity: reviewRequireEnum(issue.severity, REVIEW_SEVERITIES, `issues[${index}].severity`),
            title_en: reviewRequireString(issue.title_en, `issues[${index}].title_en`),
            title_zh: reviewRequireString(issue.title_zh, `issues[${index}].title_zh`),
            detail_en: reviewRequireString(issue.detail_en, `issues[${index}].detail_en`),
            detail_zh: reviewRequireString(issue.detail_zh, `issues[${index}].detail_zh`),
            subjects: subjects.map(reviewParseSubject),
            evidence: evidence.map(reviewParseEvidence),
            source_provider: reviewRequireEnum(
                issue.source_provider,
                REVIEW_SOURCE_PROVIDERS,
                `issues[${index}].source_provider`,
            ),
            evidence_status: reviewRequireEnum(
                issue.evidence_status,
                REVIEW_EVIDENCE_STATUSES,
                `issues[${index}].evidence_status`,
            ),
            heuristic: typeof issue.heuristic === 'boolean'
                ? issue.heuristic
                : (() => { throw new TypeError(`Review queue response is invalid: issues[${index}].heuristic must be boolean.`); })(),
            action: {
                kind: 'open_image',
                availability: reviewRequireEnum(
                    action.availability,
                    REVIEW_ACTION_AVAILABILITY,
                    `issues[${index}].action.availability`,
                ),
                reason_en: reviewRequireString(action.reason_en, `issues[${index}].action.reason_en`),
                reason_zh: reviewRequireString(action.reason_zh, `issues[${index}].action.reason_zh`),
            },
        };
    }

    function reviewParseProviderState(value, index) {
        const state = reviewRequireObject(value, `provider_states[${index}]`);
        const observedAt = state.observed_at;
        if (observedAt !== null && typeof observedAt !== 'string') {
            throw new TypeError(`Review queue response is invalid: provider_states[${index}].observed_at must be a string or null.`);
        }
        return {
            provider: reviewRequireEnum(
                state.provider,
                REVIEW_PROVIDER_NAMES,
                `provider_states[${index}].provider`,
            ),
            status: reviewRequireEnum(
                state.status,
                REVIEW_PROVIDER_STATUSES,
                `provider_states[${index}].status`,
            ),
            reason_en: reviewRequireString(state.reason_en, `provider_states[${index}].reason_en`),
            reason_zh: reviewRequireString(state.reason_zh, `provider_states[${index}].reason_zh`),
            observed_at: observedAt,
        };
    }

    function reviewParseResponse(value) {
        const response = reviewRequireObject(value, 'root');
        if (response.schema_version !== REVIEW_SCHEMA_VERSION) {
            throw new TypeError('Review queue response is invalid: unsupported schema_version.');
        }
        const scopeFingerprint = reviewRequireString(response.scope_fingerprint, 'scope_fingerprint');
        if (!/^[a-f0-9]{64}$/.test(scopeFingerprint)) {
            throw new TypeError('Review queue response is invalid: scope_fingerprint must be SHA-256 hex.');
        }
        if (!Array.isArray(response.issues) || !Array.isArray(response.provider_states)) {
            throw new TypeError('Review queue response is invalid: issues and provider_states must be arrays.');
        }
        const total = reviewRequireInteger(response.total, 'total', 0);
        const issues = response.issues.map(reviewParseIssue);
        if (issues.length > total || issues.length > REVIEW_PAGE_LIMIT) {
            throw new TypeError('Review queue response is invalid: page length exceeds total or requested limit.');
        }
        if (total > 0 && issues.length === 0) {
            throw new TypeError('Review queue response is invalid: positive total requires issues on every page.');
        }
        if (new Set(issues.map((issue) => issue.issue_id)).size !== issues.length) {
            throw new TypeError('Review queue response is invalid: issue_id values must be unique within a page.');
        }
        if (typeof response.has_more !== 'boolean') {
            throw new TypeError('Review queue response is invalid: has_more must be boolean.');
        }
        const nextCursor = response.next_cursor;
        if (response.has_more && (typeof nextCursor !== 'string' || !nextCursor)) {
            throw new TypeError('Review queue response is invalid: has_more requires next_cursor.');
        }
        if (!response.has_more && nextCursor !== null) {
            throw new TypeError('Review queue response is invalid: terminal page next_cursor must be null.');
        }
        const providerStates = response.provider_states.map(reviewParseProviderState);
        const providerNames = new Set(providerStates.map((state) => state.provider));
        if (
            providerStates.length !== REVIEW_PROVIDERS.length
            || providerNames.size !== REVIEW_PROVIDERS.length
            || !REVIEW_PROVIDERS.every((provider) => providerNames.has(provider))
        ) {
            throw new TypeError('Review queue response is invalid: provider_states must contain each provider exactly once.');
        }
        return {
            schema_version: REVIEW_SCHEMA_VERSION,
            scope_fingerprint: scopeFingerprint,
            issues,
            total,
            has_more: response.has_more,
            next_cursor: nextCursor,
            provider_states: providerStates,
        };
    }

    function reviewOptionalInteger(elementId) {
        const input = document.getElementById(elementId);
        const raw = String(input?.value || '').trim();
        if (!raw) return null;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 8192) {
            throw new RangeError(sepconT(
                'Minimum image side must be an integer from 1 to 8192.',
                '最短边下限必须是 1 到 8192 之间的整数。',
            ));
        }
        return value;
    }

    function reviewOptionalAesthetic(elementId) {
        const input = document.getElementById(elementId);
        const raw = String(input?.value || '').trim();
        if (!raw) return null;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 10) {
            throw new RangeError(sepconT(
                'Minimum stored aesthetic must be from 0 to 10.',
                '已存美学分下限必须介于 0 到 10。',
            ));
        }
        return value;
    }

    function reviewIssueKindsForFilter(filter) {
        const kinds = REVIEW_FILTER_KINDS[filter];
        if (!kinds) throw new RangeError(`Unsupported Review Cockpit filter: ${filter}`);
        return [...kinds];
    }

    function reviewHttpMessage(response, body) {
        if (body && typeof body === 'object') {
            if (typeof body.detail === 'string' && body.detail) return body.detail;
            if (typeof body.error === 'string' && body.error) return body.error;
            if (typeof body.message === 'string' && body.message) return body.message;
        }
        return `Review queue request failed with HTTP ${response.status}.`;
    }

    const REVIEW_ERROR_EMPTY_DATABASE_SCOPE = 'empty_database_scope';

    function reviewLocalError(code) {
        if (code !== REVIEW_ERROR_EMPTY_DATABASE_SCOPE) {
            throw new RangeError(`Unsupported Review Cockpit local error code: ${code}`);
        }
        const error = new RangeError(`Review Cockpit local error: ${code}`);
        Object.defineProperty(error, 'reviewCode', {
            value: code,
            enumerable: false,
            writable: false,
        });
        return error;
    }

    function reviewErrorState(error) {
        const message = String(error?.message || error);
        return {
            code: error?.reviewCode === REVIEW_ERROR_EMPTY_DATABASE_SCOPE
                ? REVIEW_ERROR_EMPTY_DATABASE_SCOPE
                : null,
            message,
        };
    }

    function reviewErrorMessage(errorState) {
        if (errorState.code === REVIEW_ERROR_EMPTY_DATABASE_SCOPE) {
            return sepconT(
                'Review Cockpit needs at least one loaded database image.',
                '审阅驾驶舱至少需要一张已加载的数据库图片。',
            );
        }
        return errorState.message;
    }

    Object.assign(SeparationConsole, {
        _reviewState: {
            initialized: false,
            loaded: false,
            dirty: true,
            loading: false,
            requestSequence: 0,
            currentCursor: null,
            previousCursors: [],
            page: null,
            error: null,
            refreshTimer: null,
        },

        _initReviewIssues(details) {
            const state = this._reviewState;
            if (state.initialized) return;
            state.initialized = true;
            document.getElementById('sepcon-tab-issues')?.addEventListener(
                'click', () => this._activateReviewView('issues'));
            document.getElementById('sepcon-tab-tags')?.addEventListener(
                'click', () => this._activateReviewView('tags'));
            document.querySelector('.sepcon-view-tabs')?.addEventListener('keydown', (event) => {
                const tabs = [
                    document.getElementById('sepcon-tab-issues'),
                    document.getElementById('sepcon-tab-tags'),
                ].filter(Boolean);
                const currentIndex = tabs.indexOf(event.target);
                if (currentIndex < 0) return;
                let targetIndex = null;
                if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % tabs.length;
                if (event.key === 'Home') targetIndex = 0;
                if (event.key === 'End') targetIndex = tabs.length - 1;
                if (targetIndex === null) return;
                event.preventDefault();
                const target = tabs[targetIndex];
                target.focus();
                this._activateReviewView(target.id === 'sepcon-tab-issues' ? 'issues' : 'tags');
            });
            document.getElementById('sepcon-issue-filter')?.addEventListener('change', () => {
                void this._loadFirstReviewPage();
            });
            document.getElementById('sepcon-issues-refresh')?.addEventListener('click', () => {
                void this._loadFirstReviewPage();
            });
            document.getElementById('sepcon-issues-retry')?.addEventListener('click', () => {
                void this._retryReviewPage();
            });
            document.getElementById('sepcon-issues-next')?.addEventListener('click', () => {
                void this._loadNextReviewPage();
            });
            document.getElementById('sepcon-issues-prev')?.addEventListener('click', () => {
                void this._loadPreviousReviewPage();
            });
            window.addEventListener('dataset:changed', () => this._markReviewDirty());
            document.addEventListener('languageChanged', () => {
                document.getElementById('sepcon-issue-filter')?.dispatchEvent(
                    new Event('dataset:select-sync'),
                );
                if (state.loading) this._renderReviewLoading();
                else if (state.error) this._renderReviewError(state.error);
                else if (state.page) this._renderReviewPage(state.page);
            });
            details.addEventListener('toggle', () => {
                if (details.open && !document.getElementById('sepcon-issues-panel')?.hidden && state.dirty) {
                    void this._loadFirstReviewPage();
                }
            });
        },

        _activateReviewView(view) {
            this._showReviewView(view);
            const state = this._reviewState;
            if (view === 'issues') {
                if (!state.loaded || state.dirty) void this._loadFirstReviewPage();
                return;
            }
            this.refresh();
        },

        _showReviewView(view) {
            if (view !== 'issues' && view !== 'tags') {
                throw new RangeError(`Unsupported Review Cockpit view: ${view}`);
            }
            const issuesActive = view === 'issues';
            const issuesTab = document.getElementById('sepcon-tab-issues');
            const tagsTab = document.getElementById('sepcon-tab-tags');
            const issuesPanel = document.getElementById('sepcon-issues-panel');
            const tagsPanel = document.getElementById('sepcon-tags-panel');
            if (issuesTab) {
                issuesTab.classList.toggle('is-active', issuesActive);
                issuesTab.setAttribute('aria-selected', String(issuesActive));
                issuesTab.tabIndex = issuesActive ? 0 : -1;
            }
            if (tagsTab) {
                tagsTab.classList.toggle('is-active', !issuesActive);
                tagsTab.setAttribute('aria-selected', String(!issuesActive));
                tagsTab.tabIndex = issuesActive ? -1 : 0;
            }
            if (issuesPanel) issuesPanel.hidden = !issuesActive;
            if (tagsPanel) tagsPanel.hidden = issuesActive;
        },

        _reviewRequest(cursor) {
            const queueIds = this._queueIds();
            const imageIds = queueIds.filter((imageId) => Number.isInteger(imageId) && imageId > 0);
            const localPathCount = queueIds.filter((imageId) => (
                Boolean(this.dm?.isLocalId?.(imageId))
                && !Boolean(this.dm?._localIdUsesManifest?.(imageId))
            )).length;
            const logicalCount = Math.max(
                Number(this.dm?._getLogicalDatasetCount?.() || queueIds.length),
                queueIds.length,
            );
            const filter = String(document.getElementById('sepcon-issue-filter')?.value || 'all');
            return {
                schema_version: REVIEW_SCHEMA_VERSION,
                image_ids: imageIds,
                caption_states: imageIds.map((imageId) => ({
                    image_id: imageId,
                    has_content: this._reviewCaptionText(imageId).trim().length > 0,
                })),
                logical_count: logicalCount,
                local_path_count: localPathCount,
                minimum_dimension: reviewOptionalInteger('sepcon-min-dimension'),
                minimum_aesthetic: reviewOptionalAesthetic('sepcon-min-aesthetic'),
                include_persisted_duplicates: Boolean(
                    document.getElementById('sepcon-include-duplicates')?.checked,
                ),
                issue_kinds: reviewIssueKindsForFilter(filter),
                cursor,
                limit: REVIEW_PAGE_LIMIT,
            };
        },

        _reviewCaptionText(imageId) {
            const dm = this.dm;
            if (!dm || typeof dm._captionTypeFor !== 'function') {
                throw new TypeError('Review Cockpit requires Dataset Maker caption-type support.');
            }
            if (!window.CaptionCore || typeof window.CaptionCore.compose !== 'function') {
                throw new TypeError('Review Cockpit requires CaptionCore.compose.');
            }
            return window.CaptionCore.compose(
                this._effectiveCaption(imageId),
                this._effectiveNl(imageId),
                dm._captionTypeFor(imageId),
            );
        },

        _markReviewDirty() {
            const state = this._reviewState;
            state.dirty = true;
            state.loading = false;
            state.requestSequence += 1;
            if (state.refreshTimer !== null) {
                clearTimeout(state.refreshTimer);
                state.refreshTimer = null;
            }
            const details = document.getElementById('dataset-separation-console');
            const issuesPanel = document.getElementById('sepcon-issues-panel');
            if (!details?.open || issuesPanel?.hidden) return;
            state.refreshTimer = setTimeout(() => {
                state.refreshTimer = null;
                if (state.dirty && !state.loading) void this._loadFirstReviewPage();
            }, 400);
        },

        async _fetchReviewPage(cursor, offset) {
            const state = this._reviewState;
            if (state.refreshTimer !== null) {
                clearTimeout(state.refreshTimer);
                state.refreshTimer = null;
            }
            const sequence = state.requestSequence + 1;
            state.requestSequence = sequence;
            state.loading = true;
            this._renderReviewLoading();
            try {
                const payload = this._reviewRequest(cursor);
                if (payload.image_ids.length === 0) {
                    throw reviewLocalError(REVIEW_ERROR_EMPTY_DATABASE_SCOPE);
                }
                const response = await fetch('/api/dataset/review-queue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                let body = null;
                try {
                    body = await response.json();
                } catch (error) {
                    throw new TypeError(
                        `Review queue returned invalid JSON with HTTP ${response.status}: ${error.message}`,
                    );
                }
                if (!response.ok) throw new Error(reviewHttpMessage(response, body));
                const parsed = reviewParseResponse(body);
                const pageEnd = offset + parsed.issues.length;
                if (parsed.has_more && parsed.issues.length !== REVIEW_PAGE_LIMIT) {
                    throw new TypeError('Review queue response is invalid: non-terminal pages must fill the requested limit.');
                }
                if (parsed.has_more && pageEnd >= parsed.total) {
                    throw new TypeError('Review queue response is invalid: non-terminal page exceeds total.');
                }
                if (!parsed.has_more && pageEnd !== parsed.total) {
                    throw new TypeError('Review queue response is invalid: terminal page does not complete total.');
                }
                if (sequence !== state.requestSequence) return null;
                state.loading = false;
                return parsed;
            } catch (error) {
                if (sequence !== state.requestSequence) return null;
                state.loading = false;
                this._renderReviewError(reviewErrorState(error));
                return null;
            }
        },

        async _loadFirstReviewPage() {
            const page = await this._fetchReviewPage(null, 0);
            if (!page) return;
            const state = this._reviewState;
            state.currentCursor = null;
            state.previousCursors = [];
            state.page = page;
            state.loaded = true;
            state.dirty = false;
            this._renderReviewPage(page);
        },

        async _retryReviewPage() {
            const state = this._reviewState;
            const page = await this._fetchReviewPage(
                state.currentCursor,
                state.previousCursors.length * REVIEW_PAGE_LIMIT,
            );
            if (!page) return;
            state.page = page;
            state.loaded = true;
            state.dirty = false;
            this._renderReviewPage(page);
        },

        async _loadNextReviewPage() {
            const state = this._reviewState;
            const nextCursor = state.page?.next_cursor;
            if (!nextCursor) return;
            const page = await this._fetchReviewPage(
                nextCursor,
                (state.previousCursors.length + 1) * REVIEW_PAGE_LIMIT,
            );
            if (!page) return;
            state.previousCursors.push(state.currentCursor);
            state.currentCursor = nextCursor;
            state.page = page;
            this._renderReviewPage(page);
        },

        async _loadPreviousReviewPage() {
            const state = this._reviewState;
            if (state.previousCursors.length === 0) return;
            const targetCursor = state.previousCursors[state.previousCursors.length - 1];
            const page = await this._fetchReviewPage(
                targetCursor,
                (state.previousCursors.length - 1) * REVIEW_PAGE_LIMIT,
            );
            if (!page) return;
            state.previousCursors.pop();
            state.currentCursor = targetCursor;
            state.page = page;
            this._renderReviewPage(page);
        },

        _renderReviewLoading() {
            this._reviewState.error = null;
            const panel = document.getElementById('sepcon-issues-panel');
            const state = document.getElementById('sepcon-issues-state');
            const rows = document.getElementById('sepcon-issue-rows');
            const error = document.getElementById('sepcon-issues-error');
            const empty = document.getElementById('sepcon-issues-empty');
            if (panel) panel.setAttribute('aria-busy', 'true');
            if (state) state.textContent = sepconT('Loading issues...', '正在载入问题...');
            if (rows) rows.textContent = '';
            if (error) error.hidden = true;
            if (empty) empty.hidden = true;
            this._renderReviewProviderStates([]);
            this._syncReviewPagination(null);
        },

        _renderReviewError(errorState) {
            this._reviewState.error = errorState;
            const panel = document.getElementById('sepcon-issues-panel');
            const state = document.getElementById('sepcon-issues-state');
            const rows = document.getElementById('sepcon-issue-rows');
            const empty = document.getElementById('sepcon-issues-empty');
            const errorBox = document.getElementById('sepcon-issues-error');
            const message = document.getElementById('sepcon-issues-error-message');
            if (panel) panel.setAttribute('aria-busy', 'false');
            if (state) state.textContent = '';
            if (rows) rows.textContent = '';
            if (empty) empty.hidden = true;
            if (message) message.textContent = reviewErrorMessage(errorState);
            if (errorBox) errorBox.hidden = false;
            this._renderReviewProviderStates([]);
            this._syncReviewPagination(null);
        },

        _renderReviewPage(page) {
            this._reviewState.error = null;
            const panel = document.getElementById('sepcon-issues-panel');
            const state = document.getElementById('sepcon-issues-state');
            const rows = document.getElementById('sepcon-issue-rows');
            const error = document.getElementById('sepcon-issues-error');
            const empty = document.getElementById('sepcon-issues-empty');
            if (panel) panel.setAttribute('aria-busy', 'false');
            if (state) {
                state.textContent = sepconT(
                    `${page.total} issues`,
                    `${page.total} 个问题`,
                );
            }
            if (error) error.hidden = true;
            if (rows) {
                rows.textContent = '';
                const fragment = document.createDocumentFragment();
                for (const issue of page.issues) fragment.appendChild(this._buildReviewIssue(issue));
                rows.appendChild(fragment);
            }
            if (empty) empty.hidden = page.total !== 0;
            this._renderReviewProviderStates(page.provider_states);
            this._syncReviewPagination(page);
        },

        _buildReviewIssue(issue) {
            const row = document.createElement('article');
            row.className = `sepcon-issue sepcon-issue-${issue.severity}`;
            row.dataset.kind = issue.kind;
            row.dataset.testid = 'review-cockpit-issue';

            const head = document.createElement('div');
            head.className = 'sepcon-issue-head';
            const severity = document.createElement('span');
            severity.className = `sepcon-issue-severity is-${issue.severity}`;
            severity.textContent = reviewLocalizedLabel(
                REVIEW_SEVERITY_LABELS,
                issue.severity,
                'severity',
            );
            const title = document.createElement('strong');
            title.className = 'sepcon-issue-title';
            title.textContent = sepconT(issue.title_en, issue.title_zh);
            head.append(severity, title);

            const detail = document.createElement('p');
            detail.className = 'sepcon-issue-detail';
            detail.textContent = sepconT(issue.detail_en, issue.detail_zh);

            const evidence = document.createElement('dl');
            evidence.className = 'sepcon-issue-evidence';
            for (const item of issue.evidence) {
                const term = document.createElement('dt');
                term.textContent = sepconT(item.label_en, item.label_zh);
                const value = document.createElement('dd');
                value.textContent = sepconT(item.value_en, item.value_zh);
                evidence.append(term, value);
            }

            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'btn btn-ghost btn-small sepcon-issue-open';
            action.dataset.testid = 'review-cockpit-open-image';
            action.textContent = sepconT('Open image', '打开图片');
            const subjectId = issue.subjects[0].image_id;
            const canOpen = issue.action.availability === 'available'
                && this._queueIds().includes(subjectId);
            action.disabled = !canOpen;
            action.title = canOpen
                ? sepconT('Select this image in Dataset Maker', '在 Dataset Maker 中选择此图片')
                : sepconT(issue.action.reason_en, issue.action.reason_zh);
            action.addEventListener('click', () => {
                if (!canOpen) return;
                this.dm._setActive(subjectId);
            });

            const footer = document.createElement('div');
            footer.className = 'sepcon-issue-footer';
            const source = document.createElement('span');
            source.className = 'sepcon-issue-source';
            source.textContent = `${reviewLocalizedLabel(
                REVIEW_SOURCE_LABELS,
                issue.source_provider,
                'source_provider',
            )} · ${reviewLocalizedLabel(
                REVIEW_STATUS_LABELS,
                issue.evidence_status,
                'evidence_status',
            )}`;
            footer.append(source, action);
            row.append(head, detail, evidence, footer);
            return row;
        },

        _renderReviewProviderStates(providerStates) {
            const target = document.getElementById('sepcon-provider-states');
            if (!target) return;
            target.textContent = '';
            const visibleStates = providerStates.filter((state) => (
                state.status !== 'available'
                || (
                    state.provider === 'metadata_provenance'
                    && Boolean(state.reason_en || state.reason_zh)
                )
            ));
            target.hidden = visibleStates.length === 0;
            for (const state of visibleStates) {
                const line = document.createElement('div');
                line.className = `sepcon-provider-state is-${state.status}`;
                line.dataset.testid = 'review-cockpit-provider-state';
                const provider = reviewLocalizedLabel(
                    REVIEW_PROVIDER_LABELS,
                    state.provider,
                    'provider',
                );
                const status = reviewLocalizedLabel(
                    REVIEW_STATUS_LABELS,
                    state.status,
                    'provider status',
                );
                const reason = sepconT(state.reason_en, state.reason_zh);
                line.textContent = `${provider} · ${status}${reason ? ` · ${reason}` : ''}`;
                target.appendChild(line);
            }
        },

        _syncReviewPagination(page) {
            const previous = document.getElementById('sepcon-issues-prev');
            const next = document.getElementById('sepcon-issues-next');
            const label = document.getElementById('sepcon-issues-page');
            const state = this._reviewState;
            if (previous) previous.disabled = !page || state.previousCursors.length === 0;
            if (next) next.disabled = !page || !page.has_more;
            if (label) {
                label.textContent = page
                    ? sepconT(`Page ${state.previousCursors.length + 1}`, `第 ${state.previousCursors.length + 1} 页`)
                    : '';
            }
        },
    });
})();
