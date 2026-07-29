/**
 * Dataset Maker named-project persistence and optimistic concurrency UI.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
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

    function requireString(value, fieldName) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new TypeError(`${fieldName} must be a non-empty string.`);
        }
        return value;
    }

    function requireDecimalString(value, fieldName) {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
            throw new TypeError(`${fieldName} must be a non-negative decimal string.`);
        }
        return value;
    }

    function parseProjectItem(value, index) {
        if (!isRecord(value)) {
            throw new TypeError(`items[${index}] must be an object.`);
        }
        if (value.item_type === 'local') {
            if (!['available', 'missing', 'changed'].includes(value.source_status)) {
                throw new TypeError(
                    `items[${index}].source_status must be available, missing, or changed.`,
                );
            }
            const dsId = requireString(value.ds_id, `items[${index}].ds_id`);
            if (!/^ds:[0-9a-f]{16}$/.test(dsId)) {
                throw new TypeError(`items[${index}].ds_id has an invalid format.`);
            }
            if (value.sidecar_caption !== null && typeof value.sidecar_caption !== 'string') {
                throw new TypeError(`items[${index}].sidecar_caption must be a string or null.`);
            }
            return Object.freeze({
                position: requireNonNegativeInteger(value.position, `items[${index}].position`),
                item_type: 'local',
                ds_id: dsId,
                path: requireString(value.path, `items[${index}].path`),
                size: requireNonNegativeInteger(value.size, `items[${index}].size`),
                mtime_ns: requireDecimalString(value.mtime_ns, `items[${index}].mtime_ns`),
                device: requireDecimalString(value.device, `items[${index}].device`),
                inode: requireDecimalString(value.inode, `items[${index}].inode`),
                source_status: value.source_status,
                sidecar_caption: value.sidecar_caption,
            });
        }
        if (value.item_type !== 'library') {
            throw new TypeError(`items[${index}].item_type must be library or local.`);
        }
        const imageId = value.image_id === null
            ? null
            : requirePositiveInteger(value.image_id, `items[${index}].image_id`);
        if (typeof value.missing !== 'boolean') {
            throw new TypeError(`items[${index}].missing must be a boolean.`);
        }
        if (value.missing !== (imageId === null)) {
            throw new TypeError(`items[${index}] has inconsistent missing state.`);
        }
        return Object.freeze({
            position: requireNonNegativeInteger(value.position, `items[${index}].position`),
            item_type: 'library',
            source_image_id: requirePositiveInteger(
                value.source_image_id,
                `items[${index}].source_image_id`,
            ),
            image_id: imageId,
            missing: value.missing,
        });
    }

    function parseDatasetProject(value) {
        if (!isRecord(value)) throw new TypeError('Dataset project response must be an object.');
        if (typeof DM._parseProjectSettings !== 'function') {
            throw new TypeError('Dataset project settings parser is unavailable.');
        }
        if (!Array.isArray(value.items)) throw new TypeError('Dataset project items must be an array.');
        if (!Array.isArray(value.missing_image_ids)) {
            throw new TypeError('Dataset project missing_image_ids must be an array.');
        }
        const archivedAt = value.archived_at;
        if (archivedAt !== null && typeof archivedAt !== 'string') {
            throw new TypeError('Dataset project archived_at must be a string or null.');
        }
        const items = value.items.map((item, index) => parseProjectItem(item, index));
        if (items.some((item, index) => item.position !== index)) {
            throw new TypeError(
                'Dataset project item positions must be unique and contiguous from zero.',
            );
        }
        const missingImageIds = value.missing_image_ids.map((imageId, index) => (
            requirePositiveInteger(imageId, `missing_image_ids[${index}]`)
        ));
        const derivedMissing = items
            .filter((item) => item.item_type === 'library' && item.missing)
            .map((item) => item.source_image_id);
        if (JSON.stringify(missingImageIds) !== JSON.stringify(derivedMissing)) {
            throw new TypeError('Dataset project missing_image_ids does not match its ordered items.');
        }
        return Object.freeze({
            id: requirePositiveInteger(value.id, 'id'),
            name: requireString(value.name, 'name'),
            revision: requirePositiveInteger(value.revision, 'revision'),
            archived_at: archivedAt,
            created_at: requireString(value.created_at, 'created_at'),
            updated_at: requireString(value.updated_at, 'updated_at'),
            settings: DM._parseProjectSettings(value.settings),
            items: Object.freeze(items),
            missing_image_ids: Object.freeze(missingImageIds),
        });
    }

    function parseDatasetProjectSummary(value) {
        if (!isRecord(value)) throw new TypeError('Dataset project summary must be an object.');
        const archivedAt = value.archived_at;
        if (archivedAt !== null && typeof archivedAt !== 'string') {
            throw new TypeError('Dataset project summary archived_at must be a string or null.');
        }
        return Object.freeze({
            id: requirePositiveInteger(value.id, 'id'),
            name: requireString(value.name, 'name'),
            revision: requirePositiveInteger(value.revision, 'revision'),
            archived_at: archivedAt,
            created_at: requireString(value.created_at, 'created_at'),
            updated_at: requireString(value.updated_at, 'updated_at'),
            item_count: requireNonNegativeInteger(value.item_count, 'item_count'),
            missing_image_count: requireNonNegativeInteger(
                value.missing_image_count,
                'missing_image_count',
            ),
        });
    }

    function parseProjectList(value) {
        if (!isRecord(value) || !Array.isArray(value.projects)) {
            throw new TypeError('Dataset project list response must contain a projects array.');
        }
        return value.projects.map(parseDatasetProjectSummary);
    }

    async function readJsonResponse(response, requestPath) {
        let body;
        try {
            body = await response.json();
        } catch (error) {
            throw new TypeError(
                `Dataset project request ${requestPath} returned invalid JSON: ${String(error)}`,
            );
        }
        if (response.ok) return body;
        const detail = isRecord(body) && isRecord(body.detail)
            ? body.detail
            : (isRecord(body) ? body : null);
        const detailMessage = isRecord(detail) && typeof detail.message === 'string'
            ? detail.message
            : (typeof detail === 'string' ? detail : `HTTP ${response.status}`);
        const requestError = new Error(
            `Dataset project request ${requestPath} failed with HTTP ${response.status}: ${detailMessage}`,
        );
        requestError.status = response.status;
        requestError.body = body;
        throw requestError;
    }

    async function requestProjectJson(requestPath, requestInit, retryCount) {
        let lastError = null;
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            try {
                const response = await fetch(requestPath, requestInit);
                return await readJsonResponse(response, requestPath);
            } catch (error) {
                lastError = error;
                if (attempt >= retryCount) throw error;
                window.Logger?.warn?.('dataset_project_request_retry', {
                    path: requestPath,
                    method: requestInit.method,
                    attempt: attempt + 1,
                    error: String(error),
                });
            }
        }
        throw lastError;
    }

    function collectProjectItems(imageIds, isLocalId, localItemPaths) {
        const result = [];
        const seenLibraryIds = new Set();
        const seenLocalPaths = new Set();
        for (const imageId of imageIds) {
            if (isLocalId(imageId)) {
                const localPath = requireString(
                    localItemPaths.get(Number(imageId)),
                    `localItemPaths[${imageId}]`,
                );
                if (seenLocalPaths.has(localPath)) {
                    throw new TypeError(
                        `Dataset project queue contains duplicate local path ${localPath}.`,
                    );
                }
                seenLocalPaths.add(localPath);
                result.push(Object.freeze({ item_type: 'local', path: localPath }));
                continue;
            }
            const validId = requirePositiveInteger(imageId, 'imageIds[]');
            if (seenLibraryIds.has(validId)) {
                throw new TypeError(`Dataset project queue contains duplicate Library image id ${validId}.`);
            }
            seenLibraryIds.add(validId);
            result.push(Object.freeze({ item_type: 'library', image_id: validId }));
        }
        return result;
    }

    function storedProjectRequestItems(items) {
        return items.map((item) => item.item_type === 'library'
            ? Object.freeze({
                item_type: 'library',
                image_id: requirePositiveInteger(item.image_id, 'items[].image_id'),
            })
            : Object.freeze({ item_type: 'local', path: item.path }));
    }

    function projectItemHasIssue(item) {
        return item.item_type === 'library'
            ? item.missing
            : item.source_status !== 'available';
    }

    function replaceProject(projects, archivedProjects, nextProject) {
        const withoutProject = (items) => items.filter((item) => item.id !== nextProject.id);
        const nextActive = withoutProject(projects);
        const nextArchived = withoutProject(archivedProjects);
        if (nextProject.archived_at === null) nextActive.push(nextProject);
        else nextArchived.push(nextProject);
        return {
            projects: nextActive,
            archivedProjects: nextArchived,
        };
    }

    function summarizeProject(project) {
        return Object.freeze({
            id: project.id,
            name: project.name,
            revision: project.revision,
            archived_at: project.archived_at,
            created_at: project.created_at,
            updated_at: project.updated_at,
            item_count: project.items.length,
            missing_image_count: project.missing_image_ids.length,
        });
    }

    function removeProject(projects, archivedProjects, projectId) {
        return {
            projects: projects.filter((item) => item.id !== projectId),
            archivedProjects: archivedProjects.filter((item) => item.id !== projectId),
        };
    }

    function orderedProjectItemsMatch(left, right) {
        return left.length === right.length && left.every((value, index) => {
            const other = right[index];
            if (value.item_type !== other?.item_type) return false;
            return value.item_type === 'library'
                ? value.image_id === other.image_id
                : value.path === other.path;
        });
    }

    function responseDetail(error) {
        if (!isRecord(error?.body)) return null;
        return isRecord(error.body.detail) ? error.body.detail : error.body;
    }

    Object.assign(DM, {
        _projects: [],
        _archivedProjects: [],
        _activeProject: null,
        _projectMissingItems: [],
        _projectStoreInitialized: false,
        _projectBusy: false,

        _setProjectStatus(state, key, fallback) {
            const status = document.querySelector('[data-testid="dataset-project-status"]');
            if (!status) return;
            status.dataset.state = state;
            status.dataset.i18n = key;
            status.textContent = this._t(key, fallback);
        },

        _projectBrowserOnlyDraftDetails() {
            const editCount = (this.captionEdits?.size || 0)
                + (this.nlEdits?.size || 0)
                + (this.captionType?.size || 0)
                + (this._undoStacks?.size || 0);
            const parts = [];
            if (editCount > 0) {
                parts.push(this._t(
                    'dataset.projectCaptionEdits',
                    '{count} caption or caption-mode edit(s)',
                    { count: editCount },
                ));
            }
            return parts.join(', ');
        },

        _projectDraftDetails() {
            const browserOnlyDetails = this._projectBrowserOnlyDraftDetails();
            const parts = browserOnlyDetails ? [browserOnlyDetails] : [];
            const currentItems = this._projectItems();
            const storedItems = this._activeProject
                ? storedProjectRequestItems(
                    this._activeProject.items.filter((item) => !projectItemHasIssue(item)),
                )
                : [];
            if (!orderedProjectItemsMatch(currentItems, storedItems)) {
                parts.push(this._t(
                    'dataset.projectQueueChanges',
                    'Project queue changes',
                ));
            }
            if (this._activeProject && typeof this._serializeProjectSettings === 'function') {
                const currentSettings = this._serializeProjectSettings();
                if (
                    this._projectSettingsSignature(currentSettings)
                    !== this._projectSettingsSignature(this._activeProject.settings)
                ) {
                    parts.push(this._t(
                        'dataset.projectSettingsChanges',
                        'Project settings changes',
                    ));
                }
            }
            return parts.join(', ');
        },

        _flushProjectDraftPersistence() {
            this._flushPendingDatasetEdits?.();
            if (this._saveSessionTimer) {
                clearTimeout(this._saveSessionTimer);
                this._saveSessionTimer = null;
            }
            this._saveSession();
        },

        _flushScheduledProjectDraftPersistence() {
            this._flushPendingDatasetEdits?.();
            if (!this._saveSessionTimer) return;
            clearTimeout(this._saveSessionTimer);
            this._saveSessionTimer = null;
            this._saveSession();
        },

        _confirmProjectAction(title, message) {
            return new Promise((resolve, reject) => {
                if (typeof window.App?.showConfirm !== 'function') {
                    reject(new Error('The application confirmation dialog is unavailable.'));
                    return;
                }
                window.App.showConfirm(title, message, () => resolve(true), () => resolve(false));
            });
        },

        async _confirmProjectDraftScope() {
            const details = this._projectBrowserOnlyDraftDetails();
            if (!details) return true;
            return this._confirmProjectAction(
                this._t('dataset.projectDraftWarningTitle', 'Browser draft stays local'),
                this._t(
                    'dataset.projectDraftWarning',
                    '{details} remain only in this browser draft and are not saved in the named project. Continue?',
                    { details },
                ),
            );
        },

        async _requestProjectName(titleKey, titleFallback, messageKey, messageFallback, currentName) {
            if (typeof window.App?.showInputModal !== 'function') {
                throw new Error('The application input dialog is unavailable.');
            }
            const value = await window.App.showInputModal(
                this._t(titleKey, titleFallback),
                this._t(messageKey, messageFallback),
                currentName,
            );
            if (value === null) return null;
            const name = String(value).trim();
            if (!name) {
                this._toast(
                    this._t('dataset.projectNameRequired', 'Enter a non-empty project name.'),
                    'error',
                    4000,
                );
                return null;
            }
            return name;
        },

        _projectItems() {
            return collectProjectItems(
                this.imageIds || [],
                (imageId) => Boolean(this.isLocalId?.(imageId)),
                this.localItemPaths || new Map(),
            );
        },

        _renderProjectMissing() {
            const notice = document.querySelector('[data-testid="dataset-project-missing"]');
            if (!notice) return;
            const issues = (this._projectMissingItems || []).map((item) => {
                if (item.item_type === 'library') {
                    return this._t(
                        'dataset.projectSourceLibraryMissing',
                        'missing Library image #{id}',
                        { id: item.source_image_id },
                    );
                }
                if (item.source_status === 'missing') {
                    return this._t(
                        'dataset.projectSourceLocalMissing',
                        'missing local file {path}',
                        { path: item.path },
                    );
                }
                return this._t(
                    'dataset.projectSourceLocalChanged',
                    'changed local file {path}',
                    { path: item.path },
                );
            });
            notice.hidden = issues.length === 0;
            notice.textContent = issues.length === 0
                ? ''
                : this._t(
                    'dataset.projectMissing',
                    'Project source issues: {issues}. Save is disabled to prevent accidental removal.',
                    { issues: issues.join('; ') },
                );
        },

        _renderProjectControls() {
            const selector = document.getElementById('dataset-project-selector');
            if (!selector) return;
            const selectedId = this._activeProject ? String(this._activeProject.id) : '';
            selector.replaceChildren();
            const draftOption = document.createElement('option');
            draftOption.value = '';
            draftOption.textContent = this._t('dataset.projectUnsavedDraft', 'Unsaved draft');
            selector.appendChild(draftOption);

            const appendGroup = (label, projects, archived) => {
                if (projects.length === 0) return;
                const group = document.createElement('optgroup');
                group.label = label;
                for (const project of projects) {
                    const option = document.createElement('option');
                    option.value = String(project.id);
                    option.textContent = archived
                        ? `${project.name} (${this._t('dataset.projectArchivedSuffix', 'archived')})`
                        : project.name;
                    group.appendChild(option);
                }
                selector.appendChild(group);
            };
            appendGroup(
                this._t('dataset.projectActiveGroup', 'Active projects'),
                this._projects,
                false,
            );
            appendGroup(
                this._t('dataset.projectArchivedGroup', 'Archived projects'),
                this._archivedProjects,
                true,
            );
            selector.value = selectedId;
            selector.disabled = this._projectBusy;

            const active = this._activeProject;
            const hasMissing = (this._projectMissingItems || []).length > 0;
            const save = document.getElementById('btn-dataset-project-save');
            const rename = document.getElementById('btn-dataset-project-rename');
            const archive = document.getElementById('btn-dataset-project-archive');
            const restore = document.getElementById('btn-dataset-project-restore');
            const remove = document.getElementById('btn-dataset-project-delete');
            const saveAs = document.getElementById('btn-dataset-project-save-as');
            if (saveAs) saveAs.disabled = this._projectBusy;
            if (save) save.disabled = !active || active.archived_at !== null || hasMissing || this._projectBusy;
            if (rename) {
                rename.disabled = !active || active.archived_at !== null || hasMissing || this._projectBusy;
            }
            if (archive) archive.disabled = !active || active.archived_at !== null || this._projectBusy;
            if (restore) restore.disabled = !active || active.archived_at === null || this._projectBusy;
            if (remove) remove.disabled = !active || this._projectBusy;
            this._renderProjectMissing();
        },

        _replaceProjectState(nextProject) {
            this._supersedeCaptionFetch?.();
            const previousProject = this._activeProject;
            const state = replaceProject(
                this._projects,
                this._archivedProjects,
                summarizeProject(nextProject),
            );
            this._projects = state.projects;
            this._archivedProjects = state.archivedProjects;
            this._activeProject = nextProject;
            this._projectMissingItems = nextProject.items.filter(projectItemHasIssue);
            this._saveSession();
            if (
                previousProject
                && previousProject.id === nextProject.id
                && previousProject.revision !== nextProject.revision
            ) {
                this._removeDatasetSession(previousProject);
            }
            this._renderProjectControls();
        },

        _replaceProjectStateFromQueueSave(nextProject) {
            if (typeof this._applySavedProjectLocalIdentities !== 'function') {
                throw new TypeError('Dataset local identity reconciliation is unavailable.');
            }
            this._applySavedProjectLocalIdentities(nextProject.items);
            this._replaceProjectState(nextProject);
            this._renderQueue();
            this._renderImportGallery?.();
            if (this.activeId !== null) this._setActive?.(this.activeId);
            this._updateCount();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            this._syncOutputModeUi?.();
        },

        _handleProjectRequestError(error) {
            const detail = responseDetail(error);
            if (error?.status === 409 && detail?.code === 'dataset_project_revision_conflict') {
                this._setProjectStatus(
                    'conflict',
                    'dataset.projectStatusConflict',
                    'Reload required',
                );
                this._toast(
                    this._t(
                        'dataset.projectConflict',
                        'This project changed elsewhere. Reload it before saving again.',
                    ),
                    'error',
                    6000,
                );
                return;
            }
            this._setProjectStatus('error', 'dataset.projectStatusError', 'Project error');
            this._toast(
                this._t(
                    'dataset.projectSaveFailed',
                    'Could not save Dataset project: {error}',
                    { error: String(error) },
                ),
                'error',
                6000,
            );
        },

        _handleProjectLoadError(error) {
            this._setProjectStatus('error', 'dataset.projectStatusError', 'Project error');
            this._toast(
                this._t(
                    'dataset.projectLoadFailed',
                    'Could not load Dataset projects: {error}',
                    { error: String(error) },
                ),
                'error',
                6000,
            );
        },

        async _refreshProjectLists() {
            try {
                const [activeResponse, archivedResponse] = await Promise.all([
                    requestProjectJson('/api/dataset/projects', { method: 'GET' }, 1),
                    requestProjectJson('/api/dataset/projects/archived', { method: 'GET' }, 1),
                ]);
                this._projects = parseProjectList(activeResponse);
                this._archivedProjects = parseProjectList(archivedResponse);
                this._renderProjectControls();
            } catch (error) {
                this._setProjectStatus('error', 'dataset.projectStatusError', 'Project error');
                this._toast(
                    this._t(
                        'dataset.projectLoadFailed',
                        'Could not load Dataset projects: {error}',
                        { error: String(error) },
                    ),
                    'error',
                    6000,
                );
                throw error;
            }
        },

        async _replaceQueueWithProject(project) {
            if (typeof this._supersedeCaptionFetch !== 'function') {
                throw new TypeError('Dataset caption transaction invalidation is unavailable.');
            }
            this._supersedeCaptionFetch();
            this._flushScheduledProjectDraftPersistence();
            if (typeof this._prepareProjectSettingsRestore !== 'function') {
                throw new TypeError('Dataset Project settings restoration is unavailable.');
            }
            let preparedSettings = await this._prepareProjectSettingsRestore(project.settings);
            if (typeof this._readDatasetSession !== 'function'
                || typeof this._applyDatasetSession !== 'function') {
                throw new TypeError('Dataset Project draft restoration is unavailable.');
            }
            const draftSession = this._readDatasetSession(project);
            if (draftSession) {
                preparedSettings = await this._prepareProjectSettingsRestore(draftSession.settings);
            }
            if (!draftSession && typeof this._inferLegacyQuickfilledTrigger !== 'function') {
                throw new TypeError('Dataset managed trigger inference is unavailable.');
            }
            const projectManagedTrigger = draftSession
                ? ''
                : this._inferLegacyQuickfilledTrigger(project.settings);
            const availableLocalItems = project.items.filter((item) => (
                item.item_type === 'local' && item.source_status === 'available'
            ));
            let imageIds = [];
            const restoreAuthoritativeMembership = () => {
                for (const imageId of Array.from(this.meta.keys())) {
                    if (this.isLocalId?.(imageId)) this.meta.delete(imageId);
                }
                this._clearLocalDatasetState?.();
                const localRestore = this._restoreProjectLocalItems?.(
                    availableLocalItems,
                ) || { idsByPosition: new Map(), restoredCaptionOwners: new Map() };
                const localIdsByPosition = localRestore.idsByPosition;
                imageIds = project.items.flatMap((item) => {
                    if (item.item_type === 'library') {
                        return item.image_id === null ? [] : [item.image_id];
                    }
                    const localId = localIdsByPosition.get(item.position);
                    return Number.isSafeInteger(localId) && localId < 0 ? [localId] : [];
                });
                this.imageIds = imageIds;
            };
            this._restoringSession = true;
            try {
                this.meta.clear();
                this.captions.clear();
                this.captionEdits.clear();
                this.nlCaptions.clear();
                this.nlEdits.clear();
                this.captionType.clear();
                this._quickfilledTrigger = projectManagedTrigger;
                this._undoStacks.clear();
                this._queueSelection.clear();
                restoreAuthoritativeMembership();
                this.activeId = imageIds.length > 0 ? imageIds[0] : null;
            } finally {
                this._restoringSession = false;
            }
            this._activeProject = project;
            if (draftSession) {
                this._applyDatasetSession(draftSession);
                const draftActiveId = this.activeId;
                this._restoringSession = true;
                try {
                    restoreAuthoritativeMembership();
                    this.activeId = imageIds.includes(draftActiveId)
                        ? draftActiveId
                        : (imageIds[0] ?? null);
                } finally {
                    this._restoringSession = false;
                }
            }
            preparedSettings.apply();
            this._pendingProjectSettings = null;
            if (typeof this._beginProjectAnnotationSwitch !== 'function') {
                throw new TypeError('Dataset Project annotation switch boundary is unavailable.');
            }
            this._beginProjectAnnotationSwitch(project);
            this._projectMissingItems = project.items.filter(projectItemHasIssue);
            this._renderProjectControls();
            this._renderQueue();
            this._renderImportGallery?.();
            if (this.activeId === null) this._renderEmptyEditor();
            await this._fetchMissingMeta?.();
            await this._fetchMissingCaptions?.();
            this._renderQueue();
            if (this.activeId !== null) this._setActive?.(this.activeId);
            this._saveSession();
            this._markReadinessStale?.();
            this._renderReadiness?.();
            this._refreshExportPreview?.();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            window.dispatchEvent(new CustomEvent('dataset:changed', {
                detail: { projectLoad: project.id },
            }));
        },

        async _replaceQueueWithUnsavedDraft() {
            if (typeof this._supersedeCaptionFetch !== 'function') {
                throw new TypeError('Dataset caption transaction invalidation is unavailable.');
            }
            this._supersedeCaptionFetch();
            if (typeof this._readDatasetSession !== 'function'
                || typeof this._applyDatasetSession !== 'function'
                || typeof this._prepareProjectSettingsRestore !== 'function') {
                throw new TypeError('Dataset Project draft restoration is unavailable.');
            }
            const draftSession = this._readDatasetSession(null);
            const settings = draftSession
                ? draftSession.settings
                : this._defaultProjectSettings();
            const preparedSettings = await this._prepareProjectSettingsRestore(settings);
            this._restoringSession = true;
            try {
                this.imageIds = [];
                this.meta.clear();
                this.captions.clear();
                this.captionEdits.clear();
                this.nlCaptions.clear();
                this.nlEdits.clear();
                this.captionType.clear();
                this._quickfilledTrigger = '';
                this._undoStacks.clear();
                this._queueSelection.clear();
                this._clearLocalDatasetState?.();
                this.activeId = null;
            } finally {
                this._restoringSession = false;
            }
            this._activeProject = null;
            this._projectMissingItems = [];
            if (draftSession) this._applyDatasetSession(draftSession);
            preparedSettings.apply();
            this._pendingProjectSettings = null;
            this._renderProjectControls();
            this._renderQueue();
            this._renderImportGallery?.();
            if (this.activeId === null) this._renderEmptyEditor();
            await this._fetchMissingMeta?.();
            await this._fetchMissingCaptions?.();
            this._renderQueue();
            if (this.activeId !== null) this._setActive?.(this.activeId);
            this._saveSession();
            this._markReadinessStale?.();
            this._renderReadiness?.();
            this._refreshExportPreview?.();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            window.dispatchEvent(new CustomEvent('dataset:changed', {
                detail: { unsavedDraftRestore: true },
            }));
        },

        async _loadProject(projectId) {
            this._projectBusy = true;
            this._setProjectStatus('loading', 'dataset.projectStatusLoading', 'Loading...');
            this._renderProjectControls();
            try {
                const body = await requestProjectJson(
                    `/api/dataset/projects/${projectId}`,
                    { method: 'GET' },
                    1,
                );
                const project = parseDatasetProject(body);
                await this._replaceQueueWithProject(project);
                this._setProjectStatus('loaded', 'dataset.projectStatusLoaded', 'Loaded');
            } catch (error) {
                this._handleProjectLoadError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        async _selectProject(projectId) {
            if (this._activeProject?.id === projectId) return;
            this._flushPendingDatasetEdits?.();
            const previousId = this._activeProject ? String(this._activeProject.id) : '';
            const details = this._projectDraftDetails();
            if (details) {
                const confirmed = await this._confirmProjectAction(
                    this._t('dataset.projectReplaceTitle', 'Replace browser draft'),
                    this._t(
                        'dataset.projectReplaceWarning',
                        'Loading this project will replace the current browser draft containing {details}. Continue?',
                        { details },
                    ),
                );
                if (!confirmed) {
                    const selector = document.getElementById('dataset-project-selector');
                    if (selector) selector.value = previousId;
                    return;
                }
            }
            await this._loadProject(projectId);
        },

        async _selectUnsavedDraft() {
            const active = this._activeProject;
            if (!active) return;
            this._flushPendingDatasetEdits?.();
            const details = this._projectDraftDetails();
            if (details) {
                const confirmed = await this._confirmProjectAction(
                    this._t('dataset.projectReplaceTitle', 'Replace browser draft'),
                    this._t(
                        'dataset.projectReplaceWarning',
                        'Switching drafts will replace the current browser draft containing {details}. Continue?',
                        { details },
                    ),
                );
                if (!confirmed) {
                    const selector = document.getElementById('dataset-project-selector');
                    if (selector) selector.value = String(active.id);
                    return;
                }
            }
            this._flushProjectDraftPersistence();
            try {
                await this._replaceQueueWithUnsavedDraft();
                this._setProjectStatus('idle', 'dataset.projectStatusIdle', 'No saved project');
            } catch (error) {
                this._handleProjectLoadError(error);
                this._renderProjectControls();
            }
        },

        async _saveAsProject() {
            this._flushPendingDatasetEdits?.();
            const name = await this._requestProjectName(
                'dataset.projectNameTitle',
                'Save dataset project',
                'dataset.projectNameMessage',
                'Enter a unique project name.',
                '',
            );
            if (name === null) return;
            this._flushProjectDraftPersistence();
            this._projectBusy = true;
            this._setProjectStatus('saving', 'dataset.projectStatusSaving', 'Saving...');
            this._renderProjectControls();
            try {
                if (typeof this._captureProjectSettingsSnapshot !== 'function') {
                    throw new TypeError('Dataset Project settings serialization is unavailable.');
                }
                const settingsSnapshot = this._captureProjectSettingsSnapshot();
                if (typeof this._materializeProjectLocalItems !== 'function') {
                    throw new TypeError('Dataset local manifest materialization is unavailable.');
                }
                await this._materializeProjectLocalItems();
                if (!(await this._confirmProjectDraftScope())) return;
                this._requireUnchangedProjectSettings(settingsSnapshot);
                const items = this._projectItems();
                const body = await requestProjectJson(
                    '/api/dataset/projects',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name,
                            items,
                            settings: settingsSnapshot.settings,
                        }),
                    },
                    0,
                );
                this._replaceProjectStateFromQueueSave(parseDatasetProject(body));
                this._setProjectStatus('saved', 'dataset.projectStatusSaved', 'Saved');
            } catch (error) {
                this._handleProjectRequestError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        async _saveActiveProject() {
            const active = this._activeProject;
            if (!active || active.archived_at !== null) return;
            this._flushPendingDatasetEdits?.();
            if ((this._projectMissingItems || []).length > 0) {
                this._toast(
                    this._t(
                        'dataset.projectMissingSaveBlocked',
                        'This project has unresolved sources. Resolve them before saving or renaming.',
                    ),
                    'error',
                    5000,
                );
                return;
            }
            this._flushProjectDraftPersistence();
            this._projectBusy = true;
            this._setProjectStatus('saving', 'dataset.projectStatusSaving', 'Saving...');
            this._renderProjectControls();
            try {
                if (typeof this._captureProjectSettingsSnapshot !== 'function') {
                    throw new TypeError('Dataset Project settings serialization is unavailable.');
                }
                const settingsSnapshot = this._captureProjectSettingsSnapshot();
                if (typeof this._materializeProjectLocalItems !== 'function') {
                    throw new TypeError('Dataset local manifest materialization is unavailable.');
                }
                await this._materializeProjectLocalItems();
                if (!(await this._confirmProjectDraftScope())) return;
                this._requireUnchangedProjectSettings(settingsSnapshot);
                const items = this._projectItems();
                const body = await requestProjectJson(
                    `/api/dataset/projects/${active.id}`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: active.name,
                            items,
                            settings: settingsSnapshot.settings,
                            expected_revision: active.revision,
                        }),
                    },
                    0,
                );
                this._replaceProjectStateFromQueueSave(parseDatasetProject(body));
                this._setProjectStatus('saved', 'dataset.projectStatusSaved', 'Saved');
            } catch (error) {
                this._handleProjectRequestError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        async _renameActiveProject() {
            const active = this._activeProject;
            if (!active) return;
            this._flushProjectDraftPersistence();
            if ((this._projectMissingItems || []).length > 0) {
                this._toast(
                    this._t(
                        'dataset.projectMissingSaveBlocked',
                        'This project has unresolved sources. Resolve them before saving or renaming.',
                    ),
                    'error',
                    5000,
                );
                return;
            }
            const name = await this._requestProjectName(
                'dataset.projectRenameTitle',
                'Rename dataset project',
                'dataset.projectRenameMessage',
                'Enter a new unique project name.',
                active.name,
            );
            if (name === null || name === active.name) return;
            const items = storedProjectRequestItems(active.items);
            this._projectBusy = true;
            this._renderProjectControls();
            try {
                const body = await requestProjectJson(
                    `/api/dataset/projects/${active.id}`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name,
                            items,
                            settings: active.settings,
                            expected_revision: active.revision,
                        }),
                    },
                    0,
                );
                this._replaceProjectState(parseDatasetProject(body));
                this._setProjectStatus('saved', 'dataset.projectStatusSaved', 'Saved');
            } catch (error) {
                this._handleProjectRequestError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        async _archiveActiveProject() {
            const active = this._activeProject;
            if (!active || active.archived_at !== null) return;
            this._flushProjectDraftPersistence();
            const confirmed = await this._confirmProjectAction(
                this._t('dataset.projectArchive', 'Archive'),
                this._t(
                    'dataset.projectArchiveConfirm',
                    'Archive "{name}"? You can restore it later.',
                    { name: active.name },
                ),
            );
            if (!confirmed) return;
            await this._mutateProjectStatus('archive', active);
        },

        async _restoreActiveProject() {
            const active = this._activeProject;
            if (!active || active.archived_at === null) return;
            this._flushProjectDraftPersistence();
            await this._mutateProjectStatus('restore', active);
        },

        async _mutateProjectStatus(action, active) {
            this._projectBusy = true;
            this._renderProjectControls();
            try {
                const body = await requestProjectJson(
                    `/api/dataset/projects/${active.id}/${action}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ expected_revision: active.revision }),
                    },
                    0,
                );
                this._replaceProjectState(parseDatasetProject(body));
                this._setProjectStatus('saved', 'dataset.projectStatusSaved', 'Saved');
            } catch (error) {
                this._handleProjectRequestError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        async _deleteActiveProject() {
            const active = this._activeProject;
            if (!active) return;
            this._flushProjectDraftPersistence();
            const confirmed = await this._confirmProjectAction(
                this._t('dataset.projectDelete', 'Delete'),
                this._t(
                    'dataset.projectDeleteConfirm',
                    'Permanently delete project "{name}"? Library images and local files will not be deleted.',
                    { name: active.name },
                ),
            );
            if (!confirmed) return;
            this._projectBusy = true;
            this._renderProjectControls();
            try {
                await requestProjectJson(
                    `/api/dataset/projects/${active.id}`,
                    {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ expected_revision: active.revision }),
                    },
                    0,
                );
                const state = removeProject(this._projects, this._archivedProjects, active.id);
                this._projects = state.projects;
                this._archivedProjects = state.archivedProjects;
                this._removeDatasetSession(active);
                await this._replaceQueueWithUnsavedDraft();
                this._setProjectStatus('idle', 'dataset.projectStatusIdle', 'No saved project');
            } catch (error) {
                this._handleProjectRequestError(error);
            } finally {
                this._projectBusy = false;
                this._renderProjectControls();
            }
        },

        _closeProjectMenu() {
            const menu = document.getElementById('dataset-project-menu');
            if (menu) menu.open = false;
        },

        _initProjectStore() {
            if (this._projectStoreInitialized) return;
            this._projectStoreInitialized = true;
            document.getElementById('dataset-project-selector')?.addEventListener('change', (event) => {
                const value = String(event.currentTarget.value || '');
                if (!value) {
                    void this._selectUnsavedDraft();
                    return;
                }
                const projectId = Number(value);
                if (!Number.isSafeInteger(projectId) || projectId <= 0) {
                    this._handleProjectRequestError(new TypeError(`Invalid Dataset project id ${value}.`));
                    return;
                }
                void this._selectProject(projectId);
            });
            document.getElementById('btn-dataset-project-save-as')?.addEventListener('click', () => {
                void this._saveAsProject();
            });
            document.getElementById('btn-dataset-project-save')?.addEventListener('click', () => {
                void this._saveActiveProject();
            });
            document.getElementById('btn-dataset-project-rename')?.addEventListener('click', () => {
                this._closeProjectMenu();
                void this._renameActiveProject();
            });
            document.getElementById('btn-dataset-project-archive')?.addEventListener('click', () => {
                this._closeProjectMenu();
                void this._archiveActiveProject();
            });
            document.getElementById('btn-dataset-project-restore')?.addEventListener('click', () => {
                this._closeProjectMenu();
                void this._restoreActiveProject();
            });
            document.getElementById('btn-dataset-project-delete')?.addEventListener('click', () => {
                this._closeProjectMenu();
                void this._deleteActiveProject();
            });
            this._renderProjectControls();
            void this._refreshProjectLists().catch((error) => {
                window.Logger?.error?.('dataset_project_list_failed', { error: String(error) });
            });
        },
    });
})();
