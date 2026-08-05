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
    const SUBJECT_CROP_BACKGROUND_MODES = Object.freeze([
        'keep_background', 'transparent_rgba', 'solid_color',
    ]);
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
        subject_crop: Object.freeze({
            enabled: false,
            alpha_threshold: 1,
            padding_percent: 0,
            background_mode: 'keep_background',
            solid_color: '#000000',
        }),
        bucket_resize: Object.freeze({
            enabled: false,
            subject_aware: false,
            alpha_threshold: 128,
        }),
        watermark_removal: Object.freeze({
            enabled: false,
            method: 'telea',
            radius: 3,
            padding_percent: 0,
            regions: Object.freeze([]),
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

    function parseTrainer(value, output, bucketResize) {
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
            ((config === 'none' && !bucketResize.enabled) || config === 'anima_lora_toml')
            && (resolution !== 1024 || keepTokens !== 0)
        ) {
            throw new RangeError(
                `${config} requires trainer.resolution=1024 and trainer.keep_tokens=0.`,
            );
        }
        if (bucketResize.enabled) {
            if (config !== 'none') {
                throw new RangeError(
                    'settings.bucket_resize is not supported by verified trainer packages.',
                );
            }
            if (resolution % 64 !== 0) {
                throw new RangeError(
                    'settings.trainer.resolution must be a multiple of 64 for bucket resize.',
                );
            }
            if (output.mode !== 'folder' || output.image_op !== 'copy') {
                throw new RangeError(
                    'settings.bucket_resize requires folder output with the copy image operation.',
                );
            }
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

    function parseSubjectCrop(value) {
        const record = requireRecord(value, 'settings.subject_crop', [
            'enabled', 'alpha_threshold', 'padding_percent',
            'background_mode', 'solid_color',
        ]);
        if (typeof record.enabled !== 'boolean') {
            throw new TypeError('settings.subject_crop.enabled must be a boolean.');
        }
        const solidColor = requireString(
            record.solid_color, 'settings.subject_crop.solid_color', false, 7,
        ).toUpperCase();
        if (!/^#[0-9A-F]{6}$/.test(solidColor)) {
            throw new TypeError('settings.subject_crop.solid_color must be #RRGGBB.');
        }
        return Object.freeze({
            enabled: record.enabled,
            alpha_threshold: requireInteger(
                record.alpha_threshold, 'settings.subject_crop.alpha_threshold', 1, 255,
            ),
            padding_percent: requireInteger(
                record.padding_percent, 'settings.subject_crop.padding_percent', 0, 100,
            ),
            background_mode: requireLiteral(
                record.background_mode,
                'settings.subject_crop.background_mode',
                SUBJECT_CROP_BACKGROUND_MODES,
            ),
            solid_color: solidColor,
        });
    }

    function parseBucketResize(value) {
        const record = requireRecord(value, 'settings.bucket_resize', [
            'enabled', 'subject_aware', 'alpha_threshold',
        ]);
        return Object.freeze({
            enabled: requireBoolean(record.enabled, 'settings.bucket_resize.enabled'),
            subject_aware: requireBoolean(
                record.subject_aware,
                'settings.bucket_resize.subject_aware',
            ),
            alpha_threshold: requireInteger(
                record.alpha_threshold,
                'settings.bucket_resize.alpha_threshold',
                1,
                255,
            ),
        });
    }

    function parseWatermarkRemoval(value) {
        const record = requireRecord(value, 'settings.watermark_removal', [
            'enabled', 'method', 'radius', 'padding_percent', 'regions',
        ]);
        if (!Array.isArray(record.regions) || record.regions.length > 1) {
            throw new RangeError(
                'settings.watermark_removal.regions must contain zero or one region.',
            );
        }
        const regions = record.regions.map((region, index) => {
            const parsed = requireRecord(region, `settings.watermark_removal.regions[${index}]`, [
                'x', 'y', 'width', 'height',
            ]);
            const result = {
                x: requireInteger(
                    parsed.x,
                    `settings.watermark_removal.regions[${index}].x`,
                    0,
                    10000,
                ),
                y: requireInteger(
                    parsed.y,
                    `settings.watermark_removal.regions[${index}].y`,
                    0,
                    10000,
                ),
                width: requireInteger(
                    parsed.width,
                    `settings.watermark_removal.regions[${index}].width`,
                    1,
                    10000,
                ),
                height: requireInteger(
                    parsed.height,
                    `settings.watermark_removal.regions[${index}].height`,
                    1,
                    10000,
                ),
            };
            if (result.x + result.width > 10000 || result.y + result.height > 10000) {
                throw new RangeError(
                    `settings.watermark_removal.regions[${index}] must stay within 0..10000.`,
                );
            }
            return Object.freeze(result);
        });
        const enabled = requireBoolean(
            record.enabled,
            'settings.watermark_removal.enabled',
        );
        if (enabled && regions.length === 0) {
            throw new RangeError(
                'settings.watermark_removal.regions must contain one region when enabled.',
            );
        }
        return Object.freeze({
            enabled,
            method: requireLiteral(
                record.method,
                'settings.watermark_removal.method',
                ['telea', 'ns'],
            ),
            radius: requireInteger(
                record.radius,
                'settings.watermark_removal.radius',
                1,
                20,
            ),
            padding_percent: requireInteger(
                record.padding_percent,
                'settings.watermark_removal.padding_percent',
                0,
                10,
            ),
            regions: Object.freeze(regions),
        });
    }

    function parseProjectSettings(value) {
        const compatibleValue = isRecord(value)
            ? {
                ...value,
                subject_crop: Object.hasOwn(value, 'subject_crop')
                    ? value.subject_crop
                    : DEFAULT_SETTINGS_SOURCE.subject_crop,
                bucket_resize: Object.hasOwn(value, 'bucket_resize')
                    ? value.bucket_resize
                    : DEFAULT_SETTINGS_SOURCE.bucket_resize,
                watermark_removal: Object.hasOwn(value, 'watermark_removal')
                    ? value.watermark_removal
                    : DEFAULT_SETTINGS_SOURCE.watermark_removal,
            }
            : value;
        const record = requireRecord(compatibleValue, 'settings', [
            'settings_version', 'target_model', 'caption_render', 'naming',
            'output', 'trainer', 'subject_crop', 'bucket_resize',
            'watermark_removal', 'planning',
        ]);
        if (record.settings_version !== SETTINGS_VERSION) {
            throw new RangeError(`settings.settings_version must be ${SETTINGS_VERSION}.`);
        }
        const output = parseOutput(record.output);
        const bucketResize = parseBucketResize(record.bucket_resize);
        const watermarkRemoval = parseWatermarkRemoval(record.watermark_removal);
        const trainer = parseTrainer(record.trainer, output, bucketResize);
        if (watermarkRemoval.enabled && (
            output.mode !== 'folder'
            || output.image_op !== 'copy'
            || trainer.config !== 'none'
        )) {
            throw new RangeError(
                'settings.watermark_removal requires folder output, Copy, and no verified trainer package.',
            );
        }
        const planning = requireRecord(record.planning, 'settings.planning', ['epochs']);
        return Object.freeze({
            settings_version: SETTINGS_VERSION,
            target_model: requireLiteral(
                record.target_model, 'settings.target_model', TARGET_MODELS,
            ),
            caption_render: parseCaptionRender(record.caption_render),
            naming: parseNaming(record.naming),
            output,
            trainer,
            subject_crop: parseSubjectCrop(record.subject_crop),
            bucket_resize: bucketResize,
            watermark_removal: watermarkRemoval,
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

    function readSubjectCropControls() {
        return {
            enabled: requireElement('dataset-subject-crop-enabled').checked,
            alpha_threshold: Number(requireElement('dataset-subject-crop-threshold').value),
            padding_percent: Number(requireElement('dataset-subject-crop-padding').value),
            background_mode: requireElement('dataset-subject-crop-background').value,
            solid_color: requireElement('dataset-subject-crop-color').value.toUpperCase(),
        };
    }

    function readBucketResizeControls() {
        return {
            enabled: requireElement('dataset-bucket-resize-enabled').checked,
            subject_aware: requireElement('dataset-bucket-resize-subject-aware').checked,
            alpha_threshold: Number(
                requireElement('dataset-bucket-resize-threshold').value
            ),
        };
    }

    function readWatermarkRemovalControls() {
        const enabled = requireElement('dataset-watermark-removal-enabled').checked;
        if (!enabled) {
            return {
                enabled: false,
                method: 'telea',
                radius: 3,
                padding_percent: 0,
                regions: [],
            };
        }
        const readPercent = (id, label, minimum, maximum) => requireInteger(
            Number(requireElement(id).value), label, minimum, maximum,
        );
        const x = readPercent('dataset-watermark-x', 'watermark left percentage', 0, 100);
        const y = readPercent('dataset-watermark-y', 'watermark top percentage', 0, 100);
        const width = readPercent('dataset-watermark-width', 'watermark width percentage', 1, 100);
        const height = readPercent('dataset-watermark-height', 'watermark height percentage', 1, 100);
        if (x + width > 100 || y + height > 100) {
            throw new RangeError('Watermark removal rectangle must stay within the image bounds.');
        }
        return {
            enabled: true,
            method: requireLiteral(
                requireElement('dataset-watermark-method').value,
                'watermark removal method',
                ['telea', 'ns'],
            ),
            radius: readPercent('dataset-watermark-radius', 'watermark repair radius', 1, 20),
            padding_percent: readPercent(
                'dataset-watermark-padding', 'watermark padding percentage', 0, 10,
            ),
            regions: [{
                x: x * 100,
                y: y * 100,
                width: width * 100,
                height: height * 100,
            }],
        };
    }

    function syncSubjectCropControls() {
        const enabled = requireElement('dataset-subject-crop-enabled').checked;
        const settings = requireElement('dataset-subject-crop-settings');
        settings.hidden = !enabled;
        const backgroundMode = requireElement('dataset-subject-crop-background').value;
        const colorLabel = requireElement('dataset-subject-crop-color-label');
        colorLabel.hidden = !enabled || backgroundMode !== 'solid_color';
    }

    function syncBucketResizeControls() {
        const enabled = requireElement('dataset-bucket-resize-enabled').checked;
        requireElement('dataset-bucket-resize-settings').hidden = !enabled;
        const subjectAware = requireElement('dataset-bucket-resize-subject-aware').checked;
        requireElement('dataset-bucket-resize-threshold').disabled = (
            !enabled || !subjectAware
        );
    }

    function syncWatermarkRemovalControls() {
        const enabled = requireElement('dataset-watermark-removal-enabled').checked;
        requireElement('dataset-watermark-removal-settings').hidden = !enabled;
    }

    function subjectCropDisabledReason(dm) {
        if (!requireElement('dataset-subject-crop-enabled').checked) return '';
        if (dm._outputMode?.() !== 'folder') {
            return dm._t(
                'dataset.subjectCropRequiresFolder',
                'Subject crop requires folder export.',
            );
        }
        if (requireElement('dataset-image-op').value !== 'copy') {
            return dm._t(
                'dataset.subjectCropRequiresCopy',
                'Subject crop requires Copy so source images remain untouched.',
            );
        }
        if (requireElement('dataset-mask-export').value === 'none') {
            return dm._t(
                'dataset.subjectCropRequiresMaskExport',
                'Choose a training-mask export format before enabling subject crop.',
            );
        }
        if (requireElement('dataset-trainer-package').value !== 'none') {
            return dm._t(
                'dataset.subjectCropNoPackage',
                'Subject crop is not available with verified trainer packages yet.',
            );
        }
        const hasLocalItems = (dm.imageIds || []).some((imageId) => dm.isLocalId?.(imageId));
        const hasScanTokens = (dm._getDatasetScanTokenSources?.() || []).length > 0;
        if (hasLocalItems || hasScanTokens) {
            return dm._t(
                'dataset.subjectCropRequiresLibrary',
                'Subject crop requires indexed Library images with stored training masks.',
            );
        }
        return '';
    }

    function bucketResizeDisabledReason(dm) {
        if (!requireElement('dataset-bucket-resize-enabled').checked) return '';
        if (dm._outputMode?.() !== 'folder') {
            return dm._t(
                'dataset.bucketResizeRequiresFolder',
                'Bucket preprocessing requires folder export.',
            );
        }
        if (requireElement('dataset-image-op').value !== 'copy') {
            return dm._t(
                'dataset.bucketResizeRequiresCopy',
                'Bucket preprocessing requires Copy so source images remain untouched.',
            );
        }
        if (requireElement('dataset-trainer-package').value !== 'none') {
            return dm._t(
                'dataset.bucketResizeNoPackage',
                'Bucket preprocessing is not available with verified trainer packages.',
            );
        }
        const hasLocalItems = (dm.imageIds || []).some((imageId) => dm.isLocalId?.(imageId));
        const hasScanTokens = (dm._getDatasetScanTokenSources?.() || []).length > 0;
        if (hasLocalItems || hasScanTokens) {
            return dm._t(
                'dataset.bucketResizeRequiresLibrary',
                'Bucket preprocessing requires indexed Library images.',
            );
        }
        const resolution = Number(requireElement('dataset-trainer-resolution').value);
        if (
            !Number.isSafeInteger(resolution)
            || resolution < 256
            || resolution > 4096
            || resolution % 64 !== 0
        ) {
            return dm._t(
                'dataset.bucketResizeResolutionInvalid',
                'Bucket resolution must be a whole multiple of 64 from 256 to 4096.',
            );
        }
        return '';
    }

    function watermarkRemovalDisabledReason(dm) {
        if (!requireElement('dataset-watermark-removal-enabled').checked) return '';
        if (dm._outputMode?.() !== 'folder') {
            return dm._t(
                'dataset.watermarkRemovalRequiresFolder',
                'Watermark removal requires folder export.',
            );
        }
        if (requireElement('dataset-image-op').value !== 'copy') {
            return dm._t(
                'dataset.watermarkRemovalRequiresCopy',
                'Watermark removal requires Copy so source images remain safe.',
            );
        }
        if (requireElement('dataset-trainer-package').value !== 'none') {
            return dm._t(
                'dataset.watermarkRemovalNoPackage',
                'Watermark removal is not available with verified trainer packages.',
            );
        }
        try {
            readWatermarkRemovalControls();
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
        return '';
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
            subject_crop: readSubjectCropControls(),
            bucket_resize: readBucketResizeControls(),
            watermark_removal: readWatermarkRemovalControls(),
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
            resolution: settings.bucket_resize.enabled
                ? { minimum: 256, maximum: 4096 }
                : { minimum: 1024, maximum: 1024 },
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
            'dataset-trainer-keep-tokens', 'dataset-subject-crop-enabled',
            'dataset-subject-crop-settings', 'dataset-subject-crop-threshold',
            'dataset-subject-crop-padding', 'dataset-subject-crop-background',
            'dataset-subject-crop-color-label', 'dataset-subject-crop-color',
            'dataset-bucket-resize-enabled', 'dataset-bucket-resize-settings',
            'dataset-bucket-resize-subject-aware', 'dataset-bucket-resize-threshold',
            'dataset-watermark-removal-enabled', 'dataset-watermark-removal-settings',
            'dataset-watermark-x', 'dataset-watermark-y', 'dataset-watermark-width',
            'dataset-watermark-height', 'dataset-watermark-padding',
            'dataset-watermark-method', 'dataset-watermark-radius',
            'dataset-est-epochs',
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
        requireElement('dataset-bucket-resize-enabled').checked = settings.bucket_resize.enabled;
        requireElement('dataset-bucket-resize-subject-aware').checked = (
            settings.bucket_resize.subject_aware
        );
        requireElement('dataset-bucket-resize-threshold').value = String(
            settings.bucket_resize.alpha_threshold
        );
        syncBucketResizeControls();
        dm._installTrainerContractOptions(trainer.config);
        requireElement('dataset-trainer-package').value = trainer.config;
        dm._applyTrainerSelection(false);
        requireElement('dataset-mask-export').value = trainer.mask_export;
        requireElement('dataset-subject-crop-enabled').checked = settings.subject_crop.enabled;
        requireElement('dataset-subject-crop-threshold').value = String(
            settings.subject_crop.alpha_threshold,
        );
        requireElement('dataset-subject-crop-padding').value = String(
            settings.subject_crop.padding_percent,
        );
        const subjectCropBackground = requireElement('dataset-subject-crop-background');
        subjectCropBackground.value = settings.subject_crop.background_mode;
        subjectCropBackground.dispatchEvent(new Event('dataset:select-sync'));
        requireElement('dataset-subject-crop-color').value = (
            settings.subject_crop.solid_color.toLowerCase()
        );
        syncSubjectCropControls();
        const watermarkRemoval = settings.watermark_removal;
        requireElement('dataset-watermark-removal-enabled').checked = watermarkRemoval.enabled;
        requireElement('dataset-watermark-method').value = watermarkRemoval.method;
        requireElement('dataset-watermark-method').dispatchEvent(new Event('dataset:select-sync'));
        requireElement('dataset-watermark-radius').value = String(watermarkRemoval.radius);
        requireElement('dataset-watermark-padding').value = String(
            watermarkRemoval.padding_percent,
        );
        const watermarkRegion = watermarkRemoval.regions[0] || {
            x: 7300,
            y: 7500,
            width: 2400,
            height: 1800,
        };
        requireElement('dataset-watermark-x').value = String(Math.round(watermarkRegion.x / 100));
        requireElement('dataset-watermark-y').value = String(Math.round(watermarkRegion.y / 100));
        requireElement('dataset-watermark-width').value = String(
            Math.round(watermarkRegion.width / 100),
        );
        requireElement('dataset-watermark-height').value = String(
            Math.round(watermarkRegion.height / 100),
        );
        syncWatermarkRemovalControls();
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
            'dataset-subject-crop-enabled', 'dataset-subject-crop-threshold',
            'dataset-subject-crop-padding', 'dataset-subject-crop-background',
            'dataset-subject-crop-color', 'dataset-bucket-resize-enabled',
            'dataset-bucket-resize-subject-aware', 'dataset-bucket-resize-threshold',
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
        const refreshSubjectCropState = () => {
            syncSubjectCropControls();
            dm._markReadinessStale?.();
            dm._renderReadiness?.();
            dm._updateExportEnabled?.();
        };
        for (const id of [
            'dataset-subject-crop-enabled', 'dataset-subject-crop-threshold',
            'dataset-subject-crop-padding', 'dataset-subject-crop-background',
            'dataset-subject-crop-color',
        ]) {
            const element = requireElement(id);
            const eventName = element.tagName.toLowerCase() === 'select'
                || element.type === 'checkbox'
                || element.type === 'color'
                ? 'change'
                : 'input';
            element.addEventListener(eventName, refreshSubjectCropState);
        }
        syncSubjectCropControls();
        const refreshBucketResizeState = () => {
            syncBucketResizeControls();
            dm._markReadinessStale?.();
            dm._applyTrainerSelection?.(false);
        };
        for (const id of [
            'dataset-bucket-resize-enabled', 'dataset-bucket-resize-subject-aware',
            'dataset-bucket-resize-threshold',
        ]) {
            const element = requireElement(id);
            element.addEventListener(
                element.type === 'number' ? 'input' : 'change',
                refreshBucketResizeState,
            );
        }
        syncBucketResizeControls();
        const refreshWatermarkRemovalState = () => {
            syncWatermarkRemovalControls();
            dm._markReadinessStale?.();
            dm._renderReadiness?.();
            dm._updateExportEnabled?.();
        };
        for (const id of [
            'dataset-watermark-removal-enabled', 'dataset-watermark-x',
            'dataset-watermark-y', 'dataset-watermark-width', 'dataset-watermark-height',
            'dataset-watermark-padding', 'dataset-watermark-method',
            'dataset-watermark-radius',
        ]) {
            const element = requireElement(id);
            element.addEventListener(
                element.type === 'number' ? 'input' : 'change',
                refreshWatermarkRemovalState,
            );
        }
        refreshWatermarkRemovalState();
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

        _subjectCropExportSettings() {
            return parseSubjectCrop(readSubjectCropControls());
        },

        _subjectCropDisabledReason() {
            return subjectCropDisabledReason(this);
        },

        _bucketResizeExportSettings() {
            return parseBucketResize(readBucketResizeControls());
        },

        _bucketResizeDisabledReason() {
            return bucketResizeDisabledReason(this);
        },

        _watermarkRemovalExportSettings() {
            return readWatermarkRemovalControls();
        },

        _watermarkRemovalDisabledReason() {
            return watermarkRemovalDisabledReason(this);
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
