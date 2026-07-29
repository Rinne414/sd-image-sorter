/**
 * Dataset Project training-caption revisions.
 * Load last so saved content can participate in the effective caption helpers.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const SOURCE_VALUES = new Set([
        'legacy_snapshot', 'manual', 'metadata', 'wd14', 'vlm',
        'translation', 'sidecar_import', 'restore',
    ]);
    const AUTHOR_VALUES = new Set(['user', 'ai', 'system', 'import']);
    const CAPTION_TYPES = new Set(['booru', 'nl', 'both']);
    const SOURCE_LABELS = Object.freeze({
        legacy_snapshot: ['dataset.annotationSourceLegacySnapshot', 'Legacy snapshot'],
        manual: ['dataset.annotationSourceManual', 'Manual save'],
        metadata: ['dataset.annotationSourceMetadata', 'Image metadata'],
        wd14: ['dataset.annotationSourceWd14', 'WD14'],
        vlm: ['dataset.annotationSourceVlm', 'VLM'],
        translation: ['dataset.annotationSourceTranslation', 'Translation'],
        sidecar_import: ['dataset.annotationSourceSidecarImport', 'Sidecar import'],
        restore: ['dataset.annotationSourceRestore', 'Restore'],
    });
    const AUTHOR_LABELS = Object.freeze({
        system: ['dataset.annotationAuthorSystem', 'System'],
        user: ['dataset.annotationAuthorUser', 'User'],
        ai: ['dataset.annotationAuthorAi', 'AI'],
        import: ['dataset.annotationAuthorImport', 'Import'],
    });

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function countUnsavedProjectManifestImages(datasetMaker) {
        if (!datasetMaker._activeProject) return 0;
        let count = 0;
        for (const source of datasetMaker.localManifestTokens.values()) {
            const total = Number(source.total);
            if (!Number.isSafeInteger(total) || total < 0) {
                throw new TypeError('Dataset folder manifest total must be a non-negative safe integer.');
            }
            const excludedCount = source.excludedPaths?.size || 0;
            count += Math.max(0, total - excludedCount);
        }
        return count;
    }

    function projectManifestRevisionRequiredReason(datasetMaker) {
        const count = countUnsavedProjectManifestImages(datasetMaker);
        if (count === 0) return '';
        return datasetMaker._t(
            'dataset.projectManifestRevisionRequired',
            'Click Save to materialize {count} manifest image(s) into a new Dataset Project revision before preview, Readiness, or export.',
            { count },
        );
    }

    function requirePositiveInteger(value, fieldName) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new TypeError(`${fieldName} must be a positive safe integer.`);
        }
        return value;
    }

    function requireNonNegativeInteger(value, fieldName) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
        }
        return value;
    }

    function requireNullablePositiveInteger(value, fieldName) {
        return value === null ? null : requirePositiveInteger(value, fieldName);
    }

    function requireString(value, fieldName) {
        if (typeof value !== 'string') {
            throw new TypeError(`${fieldName} must be a string.`);
        }
        return value;
    }

    function requireNonEmptyString(value, fieldName) {
        const text = requireString(value, fieldName);
        if (!text.trim()) throw new TypeError(`${fieldName} must not be empty.`);
        return text;
    }

    function requireNullableProvenanceIdentity(value, fieldName) {
        if (value === null) return null;
        const text = requireString(value, fieldName);
        if (!text || text.length > 512 || text !== text.trim()) {
            throw new TypeError(
                `${fieldName} must be a trimmed non-empty string of at most 512 characters.`,
            );
        }
        return text;
    }

    function parseContent(value, fieldName) {
        if (!isRecord(value)) throw new TypeError(`${fieldName} must be an object.`);
        if (value.content_version !== 1) {
            throw new TypeError(`${fieldName}.content_version must be 1.`);
        }
        const captionType = requireString(value.caption_type, `${fieldName}.caption_type`);
        if (!CAPTION_TYPES.has(captionType)) {
            throw new TypeError(`${fieldName}.caption_type is unsupported.`);
        }
        return Object.freeze({
            content_version: 1,
            booru_caption: requireString(value.booru_caption, `${fieldName}.booru_caption`),
            nl_caption: requireString(value.nl_caption, `${fieldName}.nl_caption`),
            caption_type: captionType,
        });
    }

    function parseItem(value, fieldName) {
        if (!isRecord(value)) throw new TypeError(`${fieldName} must be an object.`);
        if (value.item_type === 'library') {
            return Object.freeze({
                item_type: 'library',
                image_id: requirePositiveInteger(value.image_id, `${fieldName}.image_id`),
            });
        }
        if (value.item_type === 'local') {
            return Object.freeze({
                item_type: 'local',
                path: requireNonEmptyString(value.path, `${fieldName}.path`),
            });
        }
        throw new TypeError(`${fieldName}.item_type must be library or local.`);
    }

    function parseRevision(value, fieldName) {
        if (!isRecord(value)) throw new TypeError(`${fieldName} must be an object.`);
        const source = requireString(value.source, `${fieldName}.source`);
        const authorClass = requireString(value.author_class, `${fieldName}.author_class`);
        if (!SOURCE_VALUES.has(source)) throw new TypeError(`${fieldName}.source is unsupported.`);
        if (!AUTHOR_VALUES.has(authorClass)) {
            throw new TypeError(`${fieldName}.author_class is unsupported.`);
        }
        const hash = requireString(value.content_sha256, `${fieldName}.content_sha256`);
        if (!/^[a-f0-9]{64}$/.test(hash)) {
            throw new TypeError(`${fieldName}.content_sha256 is invalid.`);
        }
        if (value.annotation_kind !== 'training_caption') {
            throw new TypeError(`${fieldName}.annotation_kind is unsupported.`);
        }
        const restoredFromRevisionId = requireNullablePositiveInteger(
            value.restored_from_revision_id,
            `${fieldName}.restored_from_revision_id`,
        );
        if ((source === 'restore') !== (restoredFromRevisionId !== null)) {
            throw new TypeError(
                `${fieldName}.source must be restore if and only if restored_from_revision_id is present.`,
            );
        }
        return Object.freeze({
            id: requirePositiveInteger(value.id, `${fieldName}.id`),
            subject_id: requirePositiveInteger(value.subject_id, `${fieldName}.subject_id`),
            annotation_kind: 'training_caption',
            parent_revision_id: requireNullablePositiveInteger(
                value.parent_revision_id,
                `${fieldName}.parent_revision_id`,
            ),
            restored_from_revision_id: restoredFromRevisionId,
            content: parseContent(value.content, `${fieldName}.content`),
            content_sha256: hash,
            source,
            provider: requireNullableProvenanceIdentity(
                value.provider,
                `${fieldName}.provider`,
            ),
            model: requireNullableProvenanceIdentity(value.model, `${fieldName}.model`),
            author_class: authorClass,
            created_at: requireNonEmptyString(value.created_at, `${fieldName}.created_at`),
        });
    }

    function parseHead(value, fieldName) {
        if (!isRecord(value)) throw new TypeError(`${fieldName} must be an object.`);
        const subjectId = requireNullablePositiveInteger(value.subject_id, `${fieldName}.subject_id`);
        const generation = requireNonNegativeInteger(value.generation, `${fieldName}.generation`);
        const activeRevision = value.active_revision === null
            ? null
            : parseRevision(value.active_revision, `${fieldName}.active_revision`);
        if ((subjectId === null) !== (activeRevision === null) || (subjectId === null) !== (generation === 0)) {
            throw new TypeError(`${fieldName} has inconsistent subject, revision, or generation state.`);
        }
        if (activeRevision !== null && activeRevision.subject_id !== subjectId) {
            throw new TypeError(`${fieldName}.active_revision belongs to another subject.`);
        }
        return Object.freeze({
            subject_id: subjectId,
            subject_key: requireNonEmptyString(value.subject_key, `${fieldName}.subject_key`),
            item: parseItem(value.item, `${fieldName}.item`),
            generation,
            active_revision: activeRevision,
            reviewed_revision_id: requireNullablePositiveInteger(
                value.reviewed_revision_id,
                `${fieldName}.reviewed_revision_id`,
            ),
            export_revision_id: requireNullablePositiveInteger(
                value.export_revision_id,
                `${fieldName}.export_revision_id`,
            ),
        });
    }

    function parseHeadsPage(value, projectId) {
        if (!isRecord(value)) throw new TypeError('Annotation heads response must be an object.');
        if (requirePositiveInteger(value.project_id, 'project_id') !== projectId) {
            throw new TypeError('Annotation heads response belongs to another project.');
        }
        if (!Array.isArray(value.items)) throw new TypeError('Annotation heads items must be an array.');
        if (typeof value.has_more !== 'boolean') throw new TypeError('Annotation heads has_more must be boolean.');
        return Object.freeze({
            project_id: projectId,
            items: value.items.map((item, index) => parseHead(item, `items[${index}]`)),
            has_more: value.has_more,
            next_after_subject_id: requireNullablePositiveInteger(
                value.next_after_subject_id,
                'next_after_subject_id',
            ),
        });
    }

    function parseHistoryPage(value, subjectId) {
        if (!isRecord(value)) throw new TypeError('Annotation history response must be an object.');
        if (requirePositiveInteger(value.subject_id, 'subject_id') !== subjectId) {
            throw new TypeError('Annotation history response belongs to another subject.');
        }
        if (!Array.isArray(value.revisions)) {
            throw new TypeError('Annotation history revisions must be an array.');
        }
        if (typeof value.has_more !== 'boolean') {
            throw new TypeError('Annotation history has_more must be boolean.');
        }
        return Object.freeze({
            subject_id: subjectId,
            revisions: value.revisions.map((item, index) => (
                parseRevision(item, `revisions[${index}]`)
            )),
            has_more: value.has_more,
            next_before_revision_id: requireNullablePositiveInteger(
                value.next_before_revision_id,
                'next_before_revision_id',
            ),
        });
    }

    async function requestAnnotationJson(requestPath, requestInit, retryCount) {
        let lastError = null;
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            try {
                const response = await fetch(requestPath, requestInit);
                let payload = null;
                try {
                    payload = await response.json();
                } catch (error) {
                    throw new Error(
                        `Annotation API returned non-JSON content: path=${requestPath}, `
                        + `status=${response.status}, error=${String(error)}`,
                    );
                }
                if (!response.ok) {
                    const error = new Error(
                        String(payload?.message || payload?.error || `HTTP ${response.status}`),
                    );
                    error.status = response.status;
                    error.payload = payload;
                    if (response.status < 500 || attempt >= retryCount) throw error;
                    lastError = error;
                } else {
                    return payload;
                }
            } catch (error) {
                lastError = error;
                if (error?.status && error.status < 500) throw error;
                if (attempt >= retryCount) throw error;
            }
            window.Logger?.warn?.('dataset_annotation_request_retry', {
                path: requestPath,
                attempt: attempt + 1,
                error: String(lastError),
            });
        }
        throw lastError || new Error(`Annotation request failed: path=${requestPath}`);
    }

    function annotationPathKey(value) {
        const path = String(value || '');
        if (/^[a-zA-Z]:[\\/]/.test(path)) return path.replace(/\//g, '\\').toLowerCase();
        return path.replace(/\\/g, '/');
    }

    function localizedAnnotationLabel(datasetMaker, labels, value) {
        const entry = labels[value];
        if (!entry) throw new RangeError(`Unsupported annotation provenance label: ${value}`);
        return datasetMaker._t(entry[0], entry[1]);
    }

    function annotationRevisionProvenanceParts(datasetMaker, revision) {
        const rawSource = revision.source === 'restore'
            && revision.restored_from_revision_id !== null
            ? datasetMaker._t(
                'dataset.annotationProvenanceRestoredFrom',
                'Restored from #{revision}',
                { revision: revision.restored_from_revision_id },
            )
            : localizedAnnotationLabel(datasetMaker, SOURCE_LABELS, revision.source);
        const parts = [
            datasetMaker._t(
                'dataset.annotationProvenanceSource',
                'Revision source: {source}',
                { source: rawSource },
            ),
            datasetMaker._t(
                'dataset.annotationProvenanceAuthor',
                'Author: {author}',
                {
                    author: localizedAnnotationLabel(
                        datasetMaker,
                        AUTHOR_LABELS,
                        revision.author_class,
                    ),
                },
            ),
        ];
        if (revision.provider !== null) {
            parts.push(datasetMaker._t(
                'dataset.annotationProvenanceProvider',
                'Provider: {provider}',
                { provider: revision.provider },
            ));
        }
        if (revision.model !== null) {
            parts.push(datasetMaker._t(
                'dataset.annotationProvenanceModel',
                'Model: {model}',
                { model: revision.model },
            ));
        }
        return parts;
    }

    function showAnnotationConflict(datasetMaker, targetId, targetProjectId, targetProjectRevision) {
        if (datasetMaker._activeProject?.id !== targetProjectId
            || datasetMaker._activeProject?.revision !== targetProjectRevision) return;
        const numericTargetId = Number(targetId);
        if (Number.isSafeInteger(numericTargetId)) datasetMaker.annotationConflicts.add(numericTargetId);
        if (Number(datasetMaker.activeId) === numericTargetId) {
            datasetMaker._setAnnotationStatus(
                'conflict',
                'dataset.annotationConflict',
                'This caption changed elsewhere. Reload its history before saving.',
                {},
            );
        }
        datasetMaker._toast(
            datasetMaker._t(
                'dataset.annotationConflict',
                'This caption changed elsewhere. Reload its history before saving.',
            ),
            'error',
            6000,
        );
    }

    Object.assign(DM, {
        annotationHeads: new Map(),
        _annotationHeadsStatus: 'idle',
        _annotationHeadsOwner: null,
        _annotationHeadsLoadToken: 0,
        _annotationHistorySubjectId: null,
        _annotationHistoryRows: [],
        _annotationHistoryCursor: null,
        _annotationHistoryHasMore: false,
        _annotationBusy: false,
        annotationConflicts: new Set(),

        _annotationNumericIdForItem(item) {
            if (item.item_type === 'library') {
                return this.imageIds.includes(item.image_id) ? item.image_id : null;
            }
            const expected = annotationPathKey(item.path);
            for (const [id, path] of this.localItemPaths || []) {
                if (annotationPathKey(path) === expected && this.imageIds.includes(Number(id))) {
                    return Number(id);
                }
            }
            return null;
        },

        _annotationSubjectForId(id) {
            const numericId = Number(id);
            if (!Number.isSafeInteger(numericId)) {
                throw new TypeError('Annotation image id must be a safe integer.');
            }
            if (this.isLocalId?.(numericId)) {
                const path = this.localItemPaths?.get?.(numericId);
                if (!path) throw new Error(`Local annotation path is unavailable: id=${numericId}`);
                return { item_type: 'local', path: String(path) };
            }
            if (numericId <= 0) throw new TypeError('Library annotation id must be positive.');
            return { item_type: 'library', image_id: numericId };
        },

        _annotationSelectionKey(id) {
            const numericId = Number(id);
            if (this.isLocalId?.(numericId)) {
                const path = this.localItemPaths?.get?.(numericId);
                if (!path) throw new Error(`Local annotation path is unavailable: id=${numericId}`);
                return String(path);
            }
            return String(numericId);
        },

        _hasAnnotationDraft(id) {
            const numericId = Number(id);
            return this._pendingCaptionEdit?.id === numericId
                || this._pendingNlCaptionEdit?.id === numericId
                || this.captionEdits.has(numericId)
                || this.nlEdits.has(numericId)
                || this.captionType.has(numericId);
        },

        _annotationRevisionProvenanceParts(revision) {
            return annotationRevisionProvenanceParts(this, revision);
        },

        _renderAnnotationProvenance(active, head) {
            const target = document.getElementById('dataset-annotation-provenance');
            if (!target) return;
            if (this._annotationHeadsStatus === 'loading' || this._annotationHeadsStatus === 'error') {
                target.textContent = '';
                target.hidden = true;
                target.removeAttribute('data-kind');
                return;
            }
            if (this._hasAnnotationDraft(active)) {
                target.textContent = this._t(
                    'dataset.annotationFrozenDraftUnsaved',
                    'Export input: Frozen draft · Unsaved changes',
                );
                target.dataset.kind = 'frozen_draft';
            } else if (head?.active_revision) {
                target.textContent = this._annotationRevisionProvenanceParts(
                    head.active_revision,
                ).join(' · ');
                target.dataset.kind = 'revision_ref';
            } else {
                target.textContent = this._t(
                    'dataset.annotationFrozenDraftNoVersion',
                    'Export input: Frozen draft · No saved version',
                );
                target.dataset.kind = 'frozen_draft';
            }
            target.hidden = false;
        },

        _annotationDraftSignature(id) {
            const numericId = Number(id);
            const entry = (map) => (map.has(numericId)
                ? [true, map.get(numericId)]
                : [false, null]);
            return JSON.stringify({
                booru: entry(this.captionEdits),
                nl: entry(this.nlEdits),
                type: entry(this.captionType),
            });
        },

        _activeTrainingCaptionContent(id) {
            const numericId = Number(id);
            return {
                content_version: 1,
                booru_caption: String(this._booruTextFor(numericId) || ''),
                nl_caption: String(this._nlTextFor(numericId) || ''),
                caption_type: String(this._captionTypeFor(numericId) || 'booru'),
            };
        },

        _setAnnotationStatus(state, key, fallback, params) {
            const status = document.getElementById('dataset-annotation-status');
            if (!status) return;
            status.dataset.state = state;
            status.removeAttribute('data-i18n');
            status.textContent = this._t(key, fallback, params);
        },

        _renderAnnotationLedger() {
            const wrap = document.getElementById('dataset-annotation-ledger');
            const save = document.getElementById('btn-dataset-save-caption-version');
            const history = document.getElementById('btn-dataset-caption-history');
            const active = Number(this.activeId);
            const project = this._activeProject;
            const visible = project !== null
                && project !== undefined
                && Number.isSafeInteger(active)
                && this.imageIds.includes(active);
            if (wrap) wrap.hidden = !visible;
            if (!visible) return;
            const loading = this._annotationHeadsStatus === 'loading';
            const failed = this._annotationHeadsStatus === 'error';
            const head = this.annotationHeads.get(active) || null;
            if (save) save.disabled = this._annotationBusy || loading || failed;
            if (history) history.disabled = this._annotationBusy || loading || failed || !head;
            this._renderAnnotationProvenance(active, head);
            if (loading) {
                this._setAnnotationStatus('loading', 'dataset.annotationLoading', 'Loading versions...', {});
            } else if (failed) {
                this._setAnnotationStatus('error', 'dataset.annotationUnavailable', 'Version history unavailable', {});
            } else if (this.annotationConflicts.has(active)) {
                this._setAnnotationStatus(
                    'conflict',
                    'dataset.annotationConflict',
                    'This caption changed elsewhere. Reload its history before saving.',
                    {},
                );
            } else if (this._hasAnnotationDraft(active)) {
                this._setAnnotationStatus('draft', 'dataset.annotationDraft', 'Unsaved changes', {});
            } else if (head?.active_revision) {
                this._setAnnotationStatus(
                    'saved',
                    'dataset.annotationSaved',
                    'Version {revision} saved',
                    { revision: head.active_revision.id },
                );
            } else {
                this._setAnnotationStatus('empty', 'dataset.annotationNoVersion', 'No saved version', {});
            }
        },

        async _loadProjectAnnotationHeads(project) {
            const projectId = requirePositiveInteger(project?.id, 'project.id');
            const revision = requirePositiveInteger(project?.revision, 'project.revision');
            const token = this._annotationHeadsLoadToken + 1;
            this._annotationHeadsLoadToken = token;
            this._annotationHeadsStatus = 'loading';
            this._annotationHeadsOwner = Object.freeze({
                project_id: projectId,
                project_revision: revision,
            });
            this.annotationHeads.clear();
            this.annotationConflicts.clear();
            this._renderAnnotationLedger();
            const nextHeads = new Map();
            let cursor = null;
            try {
                do {
                    const query = new URLSearchParams({
                        expected_project_revision: String(revision),
                        limit: '200',
                    });
                    if (cursor !== null) query.set('after_subject_id', String(cursor));
                    const payload = await requestAnnotationJson(
                        `/api/annotations/projects/${projectId}/training-captions/heads?${query}`,
                        { method: 'GET' },
                        1,
                    );
                    const page = parseHeadsPage(payload, projectId);
                    for (const head of page.items) {
                        const numericId = this._annotationNumericIdForItem(head.item);
                        if (numericId !== null) nextHeads.set(numericId, head);
                    }
                    cursor = page.next_after_subject_id;
                    if (page.has_more && cursor === null) {
                        throw new TypeError('Annotation heads pagination omitted its next cursor.');
                    }
                    if (!page.has_more) break;
                } while (true);
                if (token !== this._annotationHeadsLoadToken) return;
                if (
                    this._activeProject?.id !== projectId
                    || this._activeProject?.revision !== revision
                ) {
                    this.annotationHeads.clear();
                    this._annotationHeadsStatus = 'error';
                    return;
                }
                this.annotationHeads = nextHeads;
                this._annotationHeadsStatus = 'ready';
            } catch (error) {
                if (token !== this._annotationHeadsLoadToken) return;
                this.annotationHeads.clear();
                this._annotationHeadsStatus = 'error';
                window.Logger?.error?.('dataset_annotation_heads_load_failed', {
                    project_id: projectId,
                    revision,
                    error: String(error),
                });
                this._toast(
                    this._t(
                        'dataset.annotationSaveFailed',
                        'Could not load caption versions: {error}',
                        { error: String(error) },
                    ),
                    'error',
                    6000,
                );
                return;
            } finally {
                if (token === this._annotationHeadsLoadToken) {
                    this._renderAnnotationLedger();
                    this._refreshActiveCaptionBoxes?.();
                    if (this.activeId !== null) {
                        const ta = document.getElementById('dataset-editor-textarea');
                        if (ta) ta.value = this._booruTextFor(this.activeId);
                    }
                }
            }
        },

        _clearAnnotationHeads() {
            this._annotationHeadsLoadToken += 1;
            this.annotationHeads.clear();
            this.annotationConflicts.clear();
            this._annotationHeadsStatus = 'idle';
            this._annotationHeadsOwner = null;
            this._annotationHistorySubjectId = null;
            this._annotationHistoryRows = [];
            this._annotationHistoryCursor = null;
            this._annotationHistoryHasMore = false;
            const history = document.getElementById('dataset-annotation-history');
            const toggle = document.getElementById('btn-dataset-caption-history');
            if (history) history.hidden = true;
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            this._renderAnnotationLedger();
        },

        _annotationHeadsReadyForProject(project) {
            const owner = this._annotationHeadsOwner;
            return this._annotationHeadsStatus === 'ready'
                && Number(owner?.project_id) === Number(project?.id)
                && Number(owner?.project_revision) === Number(project?.revision);
        },

        _beginProjectAnnotationSwitch(project) {
            const projectId = requirePositiveInteger(project?.id, 'project.id');
            const revision = requirePositiveInteger(project?.revision, 'project.revision');
            this._clearAnnotationHeads();
            this._annotationHeadsStatus = 'loading';
            this._annotationHeadsOwner = Object.freeze({
                project_id: projectId,
                project_revision: revision,
            });
            this._renderAnnotationLedger();
        },

        _applySavedAnnotationHead(id, head, draftSignature) {
            const numericId = Number(id);
            this.annotationHeads.set(numericId, head);
            this.annotationConflicts.delete(numericId);
            if (this._annotationDraftSignature(numericId) === draftSignature) {
                this.captionEdits.delete(numericId);
                this.nlEdits.delete(numericId);
                this.captionType.delete(numericId);
            }
            this._saveSession?.();
            this._markReadinessStale?.();
            this._renderReadiness?.();
            this._refreshExportPreview?.();
            if (Number(this.activeId) === numericId) {
                const ta = document.getElementById('dataset-editor-textarea');
                if (ta) ta.value = this._booruTextFor(numericId);
                this._refreshActiveCaptionBoxes?.();
            }
            this._refreshQueueItem?.(numericId);
            this._renderAnnotationLedger();
        },

        async _saveActiveAnnotationVersion() {
            this._flushPendingDatasetEdits?.();
            const project = this._activeProject;
            const id = Number(this.activeId);
            if (!project || !Number.isSafeInteger(id) || !this.imageIds.includes(id)) return;
            if (this._annotationHeadsStatus !== 'ready') {
                throw new Error('Annotation heads must finish loading before Save Version.');
            }
            const head = this.annotationHeads.get(id) || null;
            const draftSignature = this._annotationDraftSignature(id);
            const requestBody = {
                expected_project_revision: project.revision,
                expected_head_generation: head?.generation || 0,
                subject: this._annotationSubjectForId(id),
                content: this._activeTrainingCaptionContent(id),
            };
            this._annotationBusy = true;
            this._renderAnnotationLedger();
            let conflict = false;
            try {
                const payload = await requestAnnotationJson(
                    `/api/annotations/projects/${project.id}/training-captions/revisions`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                    },
                    0,
                );
                const saved = parseHead(payload, 'saved_annotation');
                if (this._activeProject?.id === project.id
                    && this._activeProject?.revision === project.revision
                    && this.imageIds.includes(id)) {
                    const savedId = this._annotationNumericIdForItem(saved.item);
                    if (savedId === null || savedId !== id) {
                        throw new TypeError('Saved annotation response belongs to another item.');
                    }
                    this._applySavedAnnotationHead(id, saved, draftSignature);
                }
                this._toast(
                    this._t('dataset.annotationSavedToast', 'Caption version saved.'),
                    'success',
                    2500,
                );
            } catch (error) {
                if (error?.status === 409 && error?.payload?.code === 'annotation_head_conflict') {
                    conflict = true;
                    showAnnotationConflict(this, id, project.id, project.revision);
                    return;
                }
                this._toast(
                    this._t(
                        'dataset.annotationSaveFailed',
                        'Could not save caption version: {error}',
                        { error: String(error) },
                    ),
                    'error',
                    6000,
                );
                throw error;
            } finally {
                this._annotationBusy = false;
                this._renderAnnotationLedger();
                if (conflict
                    && this._activeProject?.id === project.id
                    && this._activeProject?.revision === project.revision
                    && Number(this.activeId) === id) {
                    this._setAnnotationStatus(
                        'conflict',
                        'dataset.annotationConflict',
                        'This caption changed elsewhere. Reload its history before saving.',
                        {},
                    );
                }
            }
        },

        _renderAnnotationHistory() {
            const list = document.getElementById('dataset-annotation-history-list');
            const more = document.getElementById('btn-dataset-annotation-history-more');
            if (!list) return;
            list.replaceChildren();
            if (this._annotationHistoryRows.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'dataset-annotation-history-row';
                empty.textContent = this._t(
                    'dataset.annotationHistoryEmpty',
                    'No saved versions yet.',
                );
                list.appendChild(empty);
            } else {
                const activeRevisionId = this.annotationHeads.get(Number(this.activeId))
                    ?.active_revision?.id || null;
                for (const revision of this._annotationHistoryRows) {
                    const row = document.createElement('div');
                    row.className = 'dataset-annotation-history-row';
                    row.dataset.revisionId = String(revision.id);
                    row.dataset.testid = 'dataset-annotation-history-row';
                    const copy = document.createElement('div');
                    copy.className = 'dataset-annotation-history-copy';
                    const meta = document.createElement('span');
                    meta.className = 'dataset-annotation-history-meta';
                    meta.textContent = [
                        `#${revision.id}`,
                        ...this._annotationRevisionProvenanceParts(revision),
                        revision.created_at,
                    ].join(' · ');
                    const preview = document.createElement('span');
                    preview.className = 'dataset-annotation-history-preview';
                    preview.textContent = revision.content.booru_caption
                        || revision.content.nl_caption
                        || '(empty)';
                    copy.appendChild(meta);
                    copy.appendChild(preview);
                    row.appendChild(copy);
                    if (revision.id !== activeRevisionId) {
                        const restore = document.createElement('button');
                        restore.type = 'button';
                        restore.className = 'btn btn-ghost btn-small';
                        restore.dataset.testid = `dataset-annotation-restore-${revision.id}`;
                        restore.textContent = this._t('dataset.annotationRestore', 'Restore');
                        restore.addEventListener('click', () => {
                            this._restoreAnnotationRevision(revision.id).catch((error) => {
                                window.Logger?.error?.('dataset_annotation_restore_failed', {
                                    revision_id: revision.id,
                                    error: String(error),
                                });
                            });
                        });
                        row.appendChild(restore);
                    }
                    list.appendChild(row);
                }
            }
            if (more) more.hidden = !this._annotationHistoryHasMore;
        },

        async _loadAnnotationHistory(reset) {
            const project = this._activeProject;
            const id = Number(this.activeId);
            const head = this.annotationHeads.get(id) || null;
            if (!project || !head?.subject_id) return;
            const subjectId = head.subject_id;
            const before = reset ? null : this._annotationHistoryCursor;
            const query = new URLSearchParams({
                expected_project_revision: String(project.revision),
                limit: '50',
            });
            if (before !== null) query.set('before_revision_id', String(before));
            const payload = await requestAnnotationJson(
                `/api/annotations/projects/${project.id}/subjects/${subjectId}`
                + `/training-captions/revisions?${query}`,
                { method: 'GET' },
                1,
            );
            const page = parseHistoryPage(payload, subjectId);
            if (this._activeProject?.id !== project.id || Number(this.activeId) !== id) return;
            this._annotationHistorySubjectId = subjectId;
            this._annotationHistoryRows = reset
                ? [...page.revisions]
                : [...this._annotationHistoryRows, ...page.revisions];
            this._annotationHistoryCursor = page.next_before_revision_id;
            this._annotationHistoryHasMore = page.has_more;
            this._renderAnnotationHistory();
        },

        async _restoreAnnotationRevision(revisionId) {
            const project = this._activeProject;
            const id = Number(this.activeId);
            const head = this.annotationHeads.get(id) || null;
            if (!project || !head?.subject_id) return;
            const confirmed = await this._confirmProjectAction(
                this._t('dataset.annotationRestoreTitle', 'Restore caption version'),
                this._t(
                    'dataset.annotationRestorePrompt',
                    'Restore version {revision} as a new version?',
                    { revision: revisionId },
                ),
            );
            if (!confirmed) return;
            const draftSignature = this._annotationDraftSignature(id);
            this._annotationBusy = true;
            this._renderAnnotationLedger();
            let conflict = false;
            try {
                const payload = await requestAnnotationJson(
                    `/api/annotations/projects/${project.id}/subjects/${head.subject_id}`
                    + '/training-captions/restore',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            expected_project_revision: project.revision,
                            expected_head_generation: head.generation,
                            revision_id: revisionId,
                        }),
                    },
                    0,
                );
                const restored = parseHead(payload, 'restored_annotation');
                if (this._activeProject?.id === project.id
                    && this._activeProject?.revision === project.revision
                    && this.imageIds.includes(id)) {
                    this._applySavedAnnotationHead(id, restored, draftSignature);
                    if (Number(this.activeId) === id) await this._loadAnnotationHistory(true);
                }
                this._toast(
                    this._t(
                        'dataset.annotationRestoredToast',
                        'Caption version restored as a new version.',
                    ),
                    'success',
                    3000,
                );
            } catch (error) {
                if (error?.status === 409 && error?.payload?.code === 'annotation_head_conflict') {
                    conflict = true;
                    showAnnotationConflict(this, id, project.id, project.revision);
                    return;
                }
                this._toast(
                    this._t(
                        'dataset.annotationRestoreFailed',
                        'Could not restore caption version: {error}',
                        { error: String(error) },
                    ),
                    'error',
                    6000,
                );
                throw error;
            } finally {
                this._annotationBusy = false;
                this._renderAnnotationLedger();
                if (conflict
                    && this._activeProject?.id === project.id
                    && this._activeProject?.revision === project.revision
                    && Number(this.activeId) === id) {
                    this._setAnnotationStatus(
                        'conflict',
                        'dataset.annotationConflict',
                        'This caption changed elsewhere. Reload its history before saving.',
                        {},
                    );
                }
            }
        },
    });

    const originalBooruTextFor = DM._booruTextFor;
    DM._booruTextFor = function (id) {
        const numericId = Number(id);
        if (this.captionEdits.has(numericId)) return originalBooruTextFor.call(this, numericId);
        const saved = this.annotationHeads.get(numericId)?.active_revision?.content;
        if (saved) return saved.booru_caption;
        return originalBooruTextFor.call(this, numericId);
    };

    const originalNlTextFor = DM._nlTextFor;
    DM._nlTextFor = function (id) {
        const numericId = Number(id);
        if (this.nlEdits.has(numericId)) return originalNlTextFor.call(this, numericId);
        const saved = this.annotationHeads.get(numericId)?.active_revision?.content;
        if (saved) return saved.nl_caption;
        return originalNlTextFor.call(this, numericId);
    };

    const originalCaptionTypeFor = DM._captionTypeFor;
    DM._captionTypeFor = function (id) {
        const numericId = Number(id);
        if (this.captionType.has(numericId)) return originalCaptionTypeFor.call(this, numericId);
        const saved = this.annotationHeads.get(numericId)?.active_revision?.content;
        if (saved) return saved.caption_type;
        return originalCaptionTypeFor.call(this, numericId);
    };

    const originalSetCaptionType = DM._setCaptionType;
    DM._setCaptionType = function (id, type, options) {
        originalSetCaptionType.call(this, id, type, options);
        this._renderAnnotationLedger();
    };

    const originalRevertActiveCaption = DM._revertActiveCaption;
    DM._revertActiveCaption = function () {
        originalRevertActiveCaption.call(this);
        this._renderAnnotationLedger();
    };

    const originalBaseExportDisabledReason = DM._baseExportDisabledReason;
    DM._baseExportDisabledReason = function () {
        const manifestReason = projectManifestRevisionRequiredReason(this);
        return manifestReason || originalBaseExportDisabledReason.call(this);
    };

    const originalBuildExportPayload = DM._buildExportPayload;
    DM._buildExportPayload = function () {
        const manifestReason = projectManifestRevisionRequiredReason(this);
        if (manifestReason) throw new Error(manifestReason);
        this._flushPendingDatasetEdits?.();
        const payload = originalBuildExportPayload.call(this);
        const project = this._activeProject;
        if (!project) return payload;
        if (!this._annotationHeadsReadyForProject(project)) {
            throw new Error(
                'Saved caption versions are not loaded. Wait for version history and retry.',
            );
        }
        const selections = {};
        for (const rawId of this.imageIds) {
            const id = Number(rawId);
            const key = this._annotationSelectionKey(id);
            const head = this.annotationHeads.get(id) || null;
            if (head?.active_revision && !this._hasAnnotationDraft(id)) {
                selections[key] = {
                    kind: 'revision_ref',
                    revision_id: head.active_revision.id,
                };
            } else if (!this._hasAnnotationDraft(id)) {
                selections[key] = { kind: 'dynamic_source' };
            } else {
                selections[key] = {
                    kind: 'frozen_draft',
                    content: this._activeTrainingCaptionContent(id),
                };
            }
        }
        return {
            ...payload,
            dataset_project_id: project.id,
            dataset_project_revision: project.revision,
            annotation_selections: selections,
            image_overrides: {},
            image_types: {},
            image_nl_overrides: {},
        };
    };

    const originalReplaceQueueWithProject = DM._replaceQueueWithProject;
    DM._replaceQueueWithProject = async function (project) {
        try {
            await originalReplaceQueueWithProject.call(this, project);
        } catch (error) {
            const owner = this._annotationHeadsOwner;
            if (
                this._activeProject?.id === project?.id
                && this._activeProject?.revision === project?.revision
                && Number(owner?.project_id) === Number(project?.id)
                && Number(owner?.project_revision) === Number(project?.revision)
            ) {
                this._annotationHeadsStatus = 'error';
                this._renderAnnotationLedger();
            }
            throw error;
        }
        await this._loadProjectAnnotationHeads(project);
    };

    const originalReplaceQueueWithUnsavedDraft = DM._replaceQueueWithUnsavedDraft;
    DM._replaceQueueWithUnsavedDraft = async function () {
        this._clearAnnotationHeads();
        await originalReplaceQueueWithUnsavedDraft.call(this);
    };

    const originalReplaceProjectState = DM._replaceProjectState;
    DM._replaceProjectState = function (project) {
        originalReplaceProjectState.call(this, project);
        this._annotationHeadsReady = this._loadProjectAnnotationHeads(project);
        this._annotationHeadsReady.catch((error) => {
            window.Logger?.error?.('dataset_annotation_heads_reload_failed', {
                project_id: project.id,
                error: String(error),
            });
        });
    };

    if (Array.isArray(DM._activeChangedHooks)) {
        DM._activeChangedHooks.push(function (id) {
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) ta.value = this._booruTextFor(id);
            this._renderAnnotationLedger();
            const history = document.getElementById('dataset-annotation-history');
            const toggle = document.getElementById('btn-dataset-caption-history');
            if (history) history.hidden = true;
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
    }

    function bind() {
        document.addEventListener('languageChanged', () => {
            DM._renderAnnotationLedger();
            DM._renderAnnotationHistory();
            DM._renderReadiness?.();
            DM._updateExportEnabled?.();
        });
        document.getElementById('dataset-editor-textarea')
            ?.addEventListener('input', () => DM._renderAnnotationLedger());
        document.getElementById('dataset-editor-nl')
            ?.addEventListener('input', () => DM._renderAnnotationLedger());
        document.getElementById('btn-dataset-save-caption-version')
            ?.addEventListener('click', () => {
                DM._saveActiveAnnotationVersion().catch((error) => {
                    window.Logger?.error?.('dataset_annotation_save_failed', {
                        error: String(error),
                    });
                });
            });
        document.getElementById('btn-dataset-caption-history')
            ?.addEventListener('click', async (event) => {
                const button = event.currentTarget;
                const panel = document.getElementById('dataset-annotation-history');
                if (!panel) return;
                const opening = panel.hidden;
                panel.hidden = !opening;
                button.setAttribute('aria-expanded', opening ? 'true' : 'false');
                if (opening) {
                    try {
                        await DM._loadAnnotationHistory(true);
                    } catch (error) {
                        window.Logger?.error?.('dataset_annotation_history_failed', {
                            error: String(error),
                        });
                        DM._toast(String(error), 'error', 6000);
                    }
                }
            });
        document.getElementById('btn-dataset-annotation-history-more')
            ?.addEventListener('click', () => {
                DM._loadAnnotationHistory(false).catch((error) => {
                    window.Logger?.error?.('dataset_annotation_history_more_failed', {
                        error: String(error),
                    });
                });
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})();
