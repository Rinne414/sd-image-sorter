/**
 * Strict Dataset Project settings serialization and restoration.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const SETTINGS_VERSION = 1;
    const TARGET_MODELS = Object.freeze(['', 'sdxl', 'flux', 'krea2', 'anima']);
    const NAMING_PRESETS = Object.freeze(['keep', 'renumber', 'custom']);
    const OUTPUT_MODES = Object.freeze(['folder', 'beside_image']);
    const IMAGE_OPERATIONS = Object.freeze(['copy', 'move']);
    const OVERWRITE_POLICIES = Object.freeze(['unique', 'overwrite', 'skip']);
    const TRAINER_CONFIGS = Object.freeze(['none', 'kohya_toml', 'anima_lora_toml']);
    const MASK_EXPORTS = Object.freeze(['none', 'onetrainer', 'kohya', 'anima_lora']);
    const GENERIC_MASK_EXPORTS = Object.freeze(['none', 'onetrainer', 'kohya']);
    const MAX_TEXT_LENGTH = 4096;
    const MAX_TRIGGER_LENGTH = 100;
    const MAX_TAG_LENGTH = 500;
    const MAX_LIST_LENGTH = 1000;
    const DATASET_TRIGGER_EDGE_WHITESPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/gu;
    const DATASET_TRIGGER_INTERNAL_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;

    const DEFAULT_SETTINGS_SOURCE = Object.freeze({
        settings_version: SETTINGS_VERSION,
        target_model: '',
        caption_render: Object.freeze({
            trigger: '',
            common_tags: Object.freeze([]),
            blacklist: Object.freeze([]),
            normalize_tag_underscores: true,
            content_mode: 'template',
            prefix: '',
            template: Object.freeze({
                template_override: '{trigger}, {tags:filtered}, {append}',
                replace_rules: Object.freeze({}),
                max_tags: 0,
            }),
        }),
        naming: Object.freeze({
            preset: 'keep',
            custom_pattern: '{trigger}_{index:03d}',
        }),
        output: Object.freeze({
            mode: 'folder',
            folder: '',
            image_op: 'copy',
            overwrite_policy: 'unique',
        }),
        trainer: Object.freeze({
            config: 'none',
            contract_version: null,
            mask_export: 'none',
            repeats: 10,
            batch: 2,
            resolution: 1024,
            keep_tokens: 0,
        }),
        planning: Object.freeze({ epochs: 10 }),
    });

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function requireRecord(value, label, expectedKeys) {
        if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
        const actualKeys = Object.keys(value).sort();
        const requiredKeys = [...expectedKeys].sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
            throw new TypeError(
                `${label} fields must be exactly ${requiredKeys.join(', ')}; ` +
                `received ${actualKeys.join(', ')}.`,
            );
        }
        return value;
    }

    function requireLiteral(value, label, allowed) {
        if (typeof value !== 'string' || !allowed.includes(value)) {
            throw new TypeError(`${label} must be one of ${allowed.map(JSON.stringify).join(', ')}.`);
        }
        return value;
    }

    function requireString(value, label, allowEmpty, maximumLength) {
        if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
        if (value.length > maximumLength) {
            throw new RangeError(`${label} must contain at most ${maximumLength} characters.`);
        }
        if (!allowEmpty && value.length === 0) throw new RangeError(`${label} must not be empty.`);
        return value;
    }

    function canonicalDatasetTrigger(value) {
        if (typeof value !== 'string') throw new TypeError('Dataset trigger must be a string.');
        return value.replace(DATASET_TRIGGER_EDGE_WHITESPACE, '');
    }

    function datasetTriggerIssue(value) {
        const rawTrigger = String(value || '');
        const trigger = canonicalDatasetTrigger(rawTrigger);
        if (!rawTrigger) return 'empty';
        if (
            rawTrigger.length > MAX_TRIGGER_LENGTH
            || trigger.includes(',')
            || DATASET_TRIGGER_INTERNAL_WHITESPACE.test(trigger)
        ) return 'format';
        if (!canonicalDatasetTrigger(trigger.replace(/_/g, ' '))) return 'normalized-empty';
        return null;
    }

    function requireDatasetTrigger(value, label) {
        const rawTrigger = requireString(value, label, true, MAX_TRIGGER_LENGTH);
        const trigger = canonicalDatasetTrigger(rawTrigger);
        const issue = datasetTriggerIssue(rawTrigger);
        if (issue === 'format') {
            throw new RangeError(
                `${label} cannot contain commas or line breaks, or internal whitespace.`,
            );
        }
        if (issue === 'normalized-empty') {
            throw new RangeError(
                `${label} must contain characters other than spaces or underscores.`,
            );
        }
        return trigger;
    }

    function requireBoolean(value, label) {
        if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
        return value;
    }

    function requireInteger(value, label, minimum, maximum) {
        if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`);
        if (value < minimum || value > maximum) {
            throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
        }
        return value;
    }

    function requireTrimmedList(value, label) {
        if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
        if (value.length > MAX_LIST_LENGTH) {
            throw new RangeError(`${label} must contain at most ${MAX_LIST_LENGTH} entries.`);
        }
        return Object.freeze(value.map((item, index) => {
            const parsed = requireString(item, `${label}[${index}]`, false, MAX_TAG_LENGTH);
            if (parsed !== parsed.trim()) {
                throw new RangeError(`${label}[${index}] must not have surrounding whitespace.`);
            }
            return parsed;
        }));
    }

    function requireReplaceRules(value, label) {
        if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
        const entries = Object.entries(value);
        if (entries.length > MAX_LIST_LENGTH) {
            throw new RangeError(`${label} must contain at most ${MAX_LIST_LENGTH} entries.`);
        }
        const parsed = {};
        for (const [rawKey, rawValue] of entries) {
            const key = requireString(rawKey, `${label} key`, false, MAX_TAG_LENGTH);
            const replacement = requireString(rawValue, `${label}.${key}`, true, MAX_TAG_LENGTH);
            if (key !== key.trim() || replacement !== replacement.trim()) {
                throw new RangeError(`${label} keys and values must not have surrounding whitespace.`);
            }
            parsed[key] = replacement;
        }
        return Object.freeze(parsed);
    }

    function parseCaptionRender(value) {
        const record = requireRecord(value, 'settings.caption_render', [
            'trigger', 'common_tags', 'blacklist', 'normalize_tag_underscores',
            'content_mode', 'prefix', 'template',
        ]);
        const template = requireRecord(record.template, 'settings.caption_render.template', [
            'template_override', 'replace_rules', 'max_tags',
        ]);
        return Object.freeze({
            trigger: requireDatasetTrigger(
                record.trigger, 'settings.caption_render.trigger',
            ),
            common_tags: requireTrimmedList(
                record.common_tags, 'settings.caption_render.common_tags',
            ),
            blacklist: requireTrimmedList(
                record.blacklist, 'settings.caption_render.blacklist',
            ),
            normalize_tag_underscores: requireBoolean(
                record.normalize_tag_underscores,
                'settings.caption_render.normalize_tag_underscores',
            ),
            content_mode: requireLiteral(
                record.content_mode, 'settings.caption_render.content_mode', ['template'],
            ),
            prefix: requireString(
                record.prefix, 'settings.caption_render.prefix', true, MAX_TEXT_LENGTH,
            ),
            template: Object.freeze({
                template_override: requireString(
                    template.template_override,
                    'settings.caption_render.template.template_override',
                    false,
                    MAX_TEXT_LENGTH,
                ),
                replace_rules: requireReplaceRules(
                    template.replace_rules,
                    'settings.caption_render.template.replace_rules',
                ),
                max_tags: requireInteger(
                    template.max_tags,
                    'settings.caption_render.template.max_tags',
                    0,
                    200,
                ),
            }),
        });
    }

    function parseNaming(value) {
        const record = requireRecord(value, 'settings.naming', ['preset', 'custom_pattern']);
        return Object.freeze({
            preset: requireLiteral(record.preset, 'settings.naming.preset', NAMING_PRESETS),
            custom_pattern: requireString(
                record.custom_pattern, 'settings.naming.custom_pattern', false, MAX_TEXT_LENGTH,
            ),
        });
    }

    function parseOutput(value) {
        const record = requireRecord(
            value,
            'settings.output',
            ['mode', 'folder', 'image_op', 'overwrite_policy'],
        );
        return Object.freeze({
            mode: requireLiteral(record.mode, 'settings.output.mode', OUTPUT_MODES),
            folder: requireString(record.folder, 'settings.output.folder', true, MAX_TEXT_LENGTH),
            image_op: requireLiteral(
                record.image_op, 'settings.output.image_op', IMAGE_OPERATIONS,
            ),
            overwrite_policy: requireLiteral(
                record.overwrite_policy,
                'settings.output.overwrite_policy',
                OVERWRITE_POLICIES,
            ),
        });
    }

    function parseTrainer(value, output) {
        const record = requireRecord(value, 'settings.trainer', [
            'config', 'contract_version', 'mask_export', 'repeats', 'batch',
            'resolution', 'keep_tokens',
        ]);
        const config = requireLiteral(record.config, 'settings.trainer.config', TRAINER_CONFIGS);
        const contractVersion = record.contract_version;
        if (config === 'none' && contractVersion !== null) {
            throw new TypeError('settings.trainer.contract_version must be null when config is none.');
        }
        if (config !== 'none' && (
            typeof contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(contractVersion)
        )) {
            throw new TypeError(
                'settings.trainer.contract_version must be a semantic version for a verified trainer.',
            );
        }
        if (config !== 'none' && (output.mode !== 'folder' || output.image_op !== 'copy')) {
            throw new RangeError(
                'Verified trainer settings require folder output with the copy image operation.',
            );
        }
        const maskExport = requireLiteral(
            record.mask_export, 'settings.trainer.mask_export', MASK_EXPORTS,
        );
        const allowedMasks = config === 'kohya_toml'
            ? ['none', 'kohya']
            : (config === 'anima_lora_toml' ? ['none', 'anima_lora'] : GENERIC_MASK_EXPORTS);
        if (!allowedMasks.includes(maskExport)) {
            throw new RangeError(
                `settings.trainer.mask_export=${JSON.stringify(maskExport)} is invalid for ${config}.`,
            );
        }
        const repeats = requireInteger(record.repeats, 'settings.trainer.repeats', 1, 1000);
        const batch = requireInteger(record.batch, 'settings.trainer.batch', 1, 64);
        const resolution = requireInteger(
            record.resolution, 'settings.trainer.resolution', 256, 4096,
        );
        const keepTokens = requireInteger(
            record.keep_tokens, 'settings.trainer.keep_tokens', 0, 50,
        );
        if (
            (config === 'none' || config === 'anima_lora_toml')
            && (resolution !== 1024 || keepTokens !== 0)
        ) {
            throw new RangeError(
                `${config} requires trainer.resolution=1024 and trainer.keep_tokens=0.`,
            );
        }
        return Object.freeze({
            config,
            contract_version: contractVersion,
            mask_export: maskExport,
            repeats,
            batch,
            resolution,
            keep_tokens: keepTokens,
        });
    }

    function parseProjectSettings(value) {
        const record = requireRecord(value, 'settings', [
            'settings_version', 'target_model', 'caption_render', 'naming',
            'output', 'trainer', 'planning',
        ]);
        if (record.settings_version !== SETTINGS_VERSION) {
            throw new RangeError(`settings.settings_version must be ${SETTINGS_VERSION}.`);
        }
        const output = parseOutput(record.output);
        const planning = requireRecord(record.planning, 'settings.planning', ['epochs']);
        return Object.freeze({
            settings_version: SETTINGS_VERSION,
            target_model: requireLiteral(
                record.target_model, 'settings.target_model', TARGET_MODELS,
            ),
            caption_render: parseCaptionRender(record.caption_render),
            naming: parseNaming(record.naming),
            output,
            trainer: parseTrainer(record.trainer, output),
            planning: Object.freeze({
                epochs: requireInteger(
                    planning.epochs, 'settings.planning.epochs', 1, 1000,
                ),
            }),
        });
    }

    function requireElement(elementId) {
        const element = document.getElementById(elementId);
        if (!element) throw new Error(`Dataset Project settings require #${elementId}.`);
        return element;
    }

    function checkedRadioValue(name) {
        const input = document.querySelector(`input[name="${name}"]:checked`);
        if (!input) throw new Error(`Dataset Project settings require a selected ${name} radio.`);
        return input.value;
    }

    function splitList(value) {
        return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    }

    function selectedTrainerContract(dm, config) {
        if (config === 'none') return null;
        const state = dm._trainerContractState;
        if (!state || state.status !== 'ready') {
            throw new Error('Dataset Project trainer settings require verified trainer contracts.');
        }
        const contract = state.contracts.find((item) => item.wireValue === config);
        if (!contract) throw new Error(`Verified trainer contract ${config} is unavailable.`);
        return contract;
    }

    function serializeProjectSettings(dm, trigger) {
        const trainerConfig = requireElement('dataset-trainer-package').value;
        const contract = selectedTrainerContract(dm, trainerConfig);
        return parseProjectSettings({
            settings_version: SETTINGS_VERSION,
            target_model: requireElement('dataset-target-model').value,
            caption_render: {
                trigger,
                common_tags: splitList(requireElement('dataset-common-tags').value),
                blacklist: splitList(requireElement('dataset-blacklist').value),
                normalize_tag_underscores: requireElement(
                    'dataset-underscore-to-space',
                ).checked,
                content_mode: requireElement('dataset-export-content-mode').value,
                prefix: requireElement('dataset-export-prefix').value,
                template: {
                    template_override: requireElement('dataset-template-override').value.trim()
                        || DEFAULT_SETTINGS_SOURCE.caption_render.template.template_override,
                    replace_rules: dm._parseDatasetReplaceRules?.() || {},
                    max_tags: Number(requireElement('dataset-max-tags').value),
                },
            },
            naming: {
                preset: checkedRadioValue('dataset-naming-preset'),
                custom_pattern: requireElement('dataset-naming-pattern').value,
            },
            output: {
                mode: checkedRadioValue('dataset-output-mode'),
                folder: requireElement('dataset-output-folder').value.trim(),
                image_op: requireElement('dataset-image-op').value,
                overwrite_policy: requireElement('dataset-overwrite').value,
            },
            trainer: {
                config: trainerConfig,
                contract_version: contract?.contractVersion || null,
                mask_export: requireElement('dataset-mask-export').value,
                repeats: Number(requireElement('dataset-est-repeats').value),
                batch: Number(requireElement('dataset-est-batch').value),
                resolution: Number(requireElement('dataset-trainer-resolution').value),
                keep_tokens: Number(requireElement('dataset-trainer-keep-tokens').value),
            },
            planning: {
                epochs: Number(requireElement('dataset-est-epochs').value),
            },
        });
    }

    function serializeCurrentProjectSettings(dm) {
        const trigger = dm._datasetTriggerComposing
            ? String(dm._lastValidDatasetTrigger || '')
            : requireElement('dataset-trigger').value;
        return serializeProjectSettings(dm, trigger);
    }

    function validateTrainerContract(dm, settings) {
        const trainer = settings.trainer;
        const contract = selectedTrainerContract(dm, trainer.config);
        const allowedMasks = contract?.maskExportModes || GENERIC_MASK_EXPORTS;
        const bounds = contract?.bounds || {
            repeats: { minimum: 1, maximum: 1000 },
            batchSize: { minimum: 1, maximum: 64 },
            resolution: { minimum: 1024, maximum: 1024 },
            keepTokens: { minimum: 0, maximum: 0 },
        };
        if (contract && contract.contractVersion !== trainer.contract_version) {
            throw new Error(
                `Dataset Project trainer contract ${trainer.config} version mismatch: ` +
                `saved=${trainer.contract_version}, available=${contract.contractVersion}.`,
            );
        }
        if (!allowedMasks.includes(trainer.mask_export)) {
            throw new RangeError(
                `Dataset Project mask ${trainer.mask_export} is not supported by ${trainer.config}.`,
            );
        }
        for (const [label, value, limit] of [
            ['repeats', trainer.repeats, bounds.repeats],
            ['batch', trainer.batch, bounds.batchSize],
            ['resolution', trainer.resolution, bounds.resolution],
            ['keep_tokens', trainer.keep_tokens, bounds.keepTokens],
        ]) {
            if (value < limit.minimum || value > limit.maximum) {
                throw new RangeError(
                    `Dataset Project trainer ${label}=${value} is outside ` +
                    `${limit.minimum}..${limit.maximum} for ${trainer.config}.`,
                );
            }
        }
    }

    function setRadioValue(name, value) {
        const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (!input) throw new Error(`Dataset Project settings cannot select ${name}=${value}.`);
        input.checked = true;
    }

    function assertRequiredControls() {
        for (const id of [
            'dataset-target-model', 'dataset-trigger', 'dataset-common-tags',
            'dataset-blacklist', 'dataset-underscore-to-space',
            'dataset-export-content-mode', 'dataset-export-prefix',
            'dataset-template-override', 'dataset-replace-rules', 'dataset-max-tags',
            'dataset-naming-pattern', 'dataset-output-folder', 'dataset-image-op',
            'dataset-overwrite', 'dataset-trainer-package', 'dataset-mask-export',
            'dataset-est-repeats', 'dataset-est-batch', 'dataset-trainer-resolution',
            'dataset-trainer-keep-tokens', 'dataset-est-epochs',
        ]) requireElement(id);
    }

    function applyPreparedSettings(dm, settings) {
        const caption = settings.caption_render;
        const trainer = settings.trainer;
        const targetModel = requireElement('dataset-target-model');
        targetModel.value = settings.target_model;
        targetModel.dispatchEvent(new Event('dataset:select-sync'));
        requireElement('dataset-trigger').value = caption.trigger;
        dm._lastValidDatasetTrigger = caption.trigger;
        requireElement('dataset-common-tags').value = caption.common_tags.join(', ');
        requireElement('dataset-blacklist').value = caption.blacklist.join('\n');
        requireElement('dataset-underscore-to-space').checked = caption.normalize_tag_underscores;
        requireElement('dataset-export-content-mode').value = caption.content_mode;
        requireElement('dataset-export-prefix').value = caption.prefix;
        requireElement('dataset-template-override').value = caption.template.template_override;
        requireElement('dataset-replace-rules').value = Object.entries(
            caption.template.replace_rules,
        ).map(([from, to]) => `${from}->${to}`).join('\n');
        requireElement('dataset-max-tags').value = String(caption.template.max_tags);
        setRadioValue('dataset-naming-preset', settings.naming.preset);
        requireElement('dataset-naming-pattern').value = settings.naming.custom_pattern;
        setRadioValue('dataset-output-mode', settings.output.mode);
        requireElement('dataset-output-folder').value = settings.output.folder;
        setRadioValue('dataset-image-op-radio', settings.output.image_op);
        requireElement('dataset-image-op').value = settings.output.image_op;
        const overwrite = requireElement('dataset-overwrite');
        overwrite.value = settings.output.overwrite_policy;
        overwrite.dispatchEvent(new Event('dataset:select-sync'));
        requireElement('dataset-est-repeats').value = String(trainer.repeats);
        requireElement('dataset-est-batch').value = String(trainer.batch);
        requireElement('dataset-trainer-resolution').value = String(trainer.resolution);
        requireElement('dataset-trainer-keep-tokens').value = String(trainer.keep_tokens);
        requireElement('dataset-est-epochs').value = String(settings.planning.epochs);
        dm._installTrainerContractOptions(trainer.config);
        requireElement('dataset-trainer-package').value = trainer.config;
        dm._applyTrainerSelection(false);
        requireElement('dataset-mask-export').value = trainer.mask_export;
        window.TargetModel?.refresh?.();
        window.DatasetEstimator?.refresh?.();
        dm._onPresetChange?.();
        dm._syncOutputModeUi?.();
        dm._syncTriggerQuickfillButton?.();
        dm._renderTrainerSettingError?.();
        dm._markReadinessStale?.();
        dm._renderReadiness?.();
        dm._updateExportEnabled?.();
        dm._refreshExportPreview?.();
    }

    async function prepareProjectSettingsRestore(dm, rawSettings) {
        const settings = parseProjectSettings(rawSettings);
        assertRequiredControls();
        const loadPromise = dm._trainerContractLoadPromise;
        if (!loadPromise || typeof loadPromise.then !== 'function') {
            throw new Error('Dataset Project settings require trainer contract initialization.');
        }
        await loadPromise;
        if (dm._trainerContractState?.status !== 'ready') {
            const reason = dm._trainerContractState?.errorMessage || 'trainer contracts are unavailable';
            throw new Error(`Dataset Project settings cannot be restored: ${reason}.`);
        }
        validateTrainerContract(dm, settings);
        return Object.freeze({
            settings,
            apply() {
                applyPreparedSettings(dm, settings);
            },
        });
    }

    function settingsSignature(settings) {
        return JSON.stringify(parseProjectSettings(settings));
    }

    function bindSettingsPersistence(dm) {
        if (dm._projectSettingsPersistenceBound) return;
        dm._projectSettingsPersistenceBound = true;
        dm._lastValidDatasetTrigger = requireDatasetTrigger(
            requireElement('dataset-trigger').value,
            'settings.caption_render.trigger',
        );
        const fieldIds = [
            'dataset-target-model', 'dataset-trigger', 'dataset-common-tags',
            'dataset-blacklist', 'dataset-underscore-to-space',
            'dataset-export-prefix', 'dataset-template-override',
            'dataset-replace-rules', 'dataset-max-tags', 'dataset-naming-pattern',
            'dataset-output-folder', 'dataset-overwrite', 'dataset-trainer-package',
            'dataset-mask-export', 'dataset-est-repeats', 'dataset-est-batch',
            'dataset-trainer-resolution', 'dataset-trainer-keep-tokens',
            'dataset-est-epochs',
        ];
        const persist = (event) => {
            if (event.currentTarget?.id === 'dataset-trigger') {
                if (event.isComposing || dm._datasetTriggerComposing) return;
                try {
                    dm._lastValidDatasetTrigger = requireDatasetTrigger(
                        event.currentTarget.value,
                        'settings.caption_render.trigger',
                    );
                } catch {
                    for (const timer of dm._datasetFieldTimers?.values?.() || []) {
                        clearTimeout(timer);
                    }
                    dm._datasetFieldTimers?.clear?.();
                    return;
                }
            }
            dm._projectSettingsMutationGeneration = Number.isSafeInteger(
                dm._projectSettingsMutationGeneration,
            ) ? dm._projectSettingsMutationGeneration + 1 : 1;
            dm._pendingProjectSettings = null;
            if (event.type === 'change') dm._saveSession();
            else dm._scheduleSaveSession?.();
        };
        for (const id of fieldIds) {
            const element = requireElement(id);
            const eventName = element.tagName.toLowerCase() === 'select'
                || element.type === 'checkbox'
                ? 'change'
                : 'input';
            element.addEventListener(eventName, persist);
        }
        for (const name of [
            'dataset-naming-preset', 'dataset-output-mode', 'dataset-image-op-radio',
        ]) {
            const radios = document.querySelectorAll(`input[name="${name}"]`);
            if (radios.length === 0) {
                throw new Error(`Dataset Project settings require ${name} radios.`);
            }
            radios.forEach((radio) => radio.addEventListener('change', persist));
        }
    }

    Object.assign(DM, {
        _defaultProjectSettings() {
            return parseProjectSettings(DEFAULT_SETTINGS_SOURCE);
        },

        _parseProjectSettings(value) {
            return parseProjectSettings(value);
        },

        _requireDatasetTrigger(value, label) {
            return requireDatasetTrigger(value, label);
        },

        _canonicalDatasetTrigger(value) {
            return canonicalDatasetTrigger(value);
        },

        _datasetTriggerIssue(value) {
            return datasetTriggerIssue(value);
        },

        _serializeProjectSettings() {
            return serializeCurrentProjectSettings(this);
        },

        _serializeDatasetDraftSettings() {
            const rawTrigger = this._datasetTriggerComposing
                ? String(this._lastValidDatasetTrigger || '')
                : requireElement('dataset-trigger').value;
            let trigger;
            try {
                trigger = requireDatasetTrigger(rawTrigger, 'settings.caption_render.trigger');
            } catch (error) {
                if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
                trigger = String(this._lastValidDatasetTrigger || '');
            }
            return serializeProjectSettings(this, trigger);
        },

        _projectSettingsSignature(settings) {
            return settingsSignature(settings);
        },

        _captureProjectSettingsSnapshot() {
            const settings = serializeCurrentProjectSettings(this);
            return Object.freeze({ settings, signature: settingsSignature(settings) });
        },

        _requireUnchangedProjectSettings(snapshot) {
            const currentSignature = settingsSignature(serializeCurrentProjectSettings(this));
            if (currentSignature !== snapshot.signature) {
                throw new Error(
                    'Dataset Project settings changed while local sources were being prepared. ' +
                    'Review the current settings and save again.',
                );
            }
        },

        async _prepareProjectSettingsRestore(settings) {
            return prepareProjectSettingsRestore(this, settings);
        },

        _initProjectSettingsPersistence() {
            bindSettingsPersistence(this);
        },

        async _restorePendingProjectSettings() {
            const settings = this._pendingProjectSettings || this._defaultProjectSettings();
            const generation = Number.isSafeInteger(this._projectSettingsMutationGeneration)
                ? this._projectSettingsMutationGeneration
                : 0;
            const prepared = await prepareProjectSettingsRestore(this, settings);
            if (this._projectSettingsMutationGeneration !== undefined
                && this._projectSettingsMutationGeneration !== generation) {
                return;
            }
            prepared.apply();
            this._pendingProjectSettings = null;
        },
    });
})();
