/**
 * Dataset Maker verified trainer contract selector.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const TRAINER_WIRES = Object.freeze(['kohya_toml', 'anima_lora_toml']);
    const CONTRACT_MASK_WIRES = Object.freeze(['none', 'kohya', 'anima_lora']);
    const GENERIC_MASK_WIRES = Object.freeze(['none', 'onetrainer', 'kohya']);
    const EXPECTED_TRAINER_CONTRACTS = Object.freeze({
        kohya_toml: {
            id: 'kohya_sd_scripts',
            display_name: 'Kohya sd-scripts',
            wire_value: 'kohya_toml',
            contract_version: '1.0.0',
            verified: true,
            mask_export_modes: ['none', 'kohya'],
            upstream: {
                repository: 'https://github.com/kohya-ss/sd-scripts',
                tag: 'v0.11.1',
                commit: '6721028c79ee85a78b3a06dfd8954dae310a1cce',
            },
            capabilities: {
                caption_extensions: ['.txt'],
                bucketed_training: true,
                caption_shuffle_keep_tokens: true,
                conditioning_masks: true,
                conditioning_training_args: ['--masked_loss'],
                class_tokens_behavior: 'caption_fallback_only',
            },
            option_bounds: {
                repeats: { minimum: 1, maximum: 1000, default: 10 },
                batch_size: { minimum: 1, maximum: 64, default: 2 },
                resolution: { minimum: 256, maximum: 4096, default: 1024 },
                keep_tokens: { minimum: 0, maximum: 50, default: 0 },
            },
            generated_artifacts: {
                dataset_config: 'dataset_config.toml',
                caption_sidecar: '<image-stem>.txt',
                conditioning_directory: 'mask',
            },
            verification_boundary: {
                module: 'library.config_util',
                required_flags: [
                    '--support_dreambooth',
                    '--support_finetuning',
                    '--support_dropout',
                ],
                conditioning_flag: '--support_controlnet',
                validates_upstream_schema: true,
                validates_artifact_completeness: false,
                requires_module_path_match: true,
                artifact_completeness_gate: 'all_conditioning_files_before_generation',
                starts_training: false,
            },
        },
        anima_lora_toml: {
            id: 'anima_lora',
            display_name: 'Anima LoRA',
            wire_value: 'anima_lora_toml',
            contract_version: '1.0.0',
            verified: true,
            mask_export_modes: ['none', 'anima_lora'],
            upstream: {
                repository: 'https://github.com/sorryhyun/anima_lora',
                tag: 'v1.14.2.hotfix',
                commit: '13eaf97a3903405baa939d7cb4a524f8f3e11303',
                license: 'MIT',
                python_requirement: '==3.13.*',
            },
            capabilities: {
                caption_extensions: ['.txt'],
                separate_loss_masks: true,
                loss_mask_suffix: '_mask.png',
                class_tokens_behavior: 'forbidden',
            },
            option_bounds: {
                repeats: { minimum: 1, maximum: 1000, default: 10 },
                batch_size: { minimum: 1, maximum: 64, default: 2 },
                resolution: { minimum: 1024, maximum: 1024, default: 1024 },
                keep_tokens: { minimum: 0, maximum: 0, default: 0 },
            },
            generated_artifacts: {
                dataset_config: 'dataset_config.toml',
                caption_sidecar: '<image-stem>.txt',
                loss_mask: '<relative-path>/<image-stem>_mask.png',
                mask_directory: 'mask',
            },
            verification_boundary: {
                module: 'library.config.loader',
                required_flags: ['--support_dropout'],
                validates_upstream_schema: true,
                validates_artifact_completeness: false,
                requires_module_path_match: true,
                artifact_completeness_gate: 'all_captions_and_requested_masks_before_generation',
                starts_training: false,
            },
        },
    });

    function freezeBounds(minimum, maximum, defaultValue) {
        return Object.freeze({ minimum, maximum, default: defaultValue });
    }

    const GENERIC_BOUNDS = Object.freeze({
        repeats: freezeBounds(1, 1000, 10),
        batchSize: freezeBounds(1, 64, 2),
        resolution: freezeBounds(1024, 1024, 1024),
        keepTokens: freezeBounds(0, 0, 0),
    });

    function requireRecord(value, label) {
        if (value === null || Array.isArray(value) || typeof value !== 'object') {
            throw new TypeError(`${label} must be an object`);
        }
        return value;
    }

    function requireString(record, key, label) {
        const value = record[key];
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new TypeError(`${label}.${key} must be a non-empty string`);
        }
        return value.trim();
    }

    function requireLiteral(record, key, expected, label) {
        if (record[key] !== expected) {
            throw new TypeError(`${label}.${key} must be ${JSON.stringify(expected)}`);
        }
        return expected;
    }

    function requireExpectedShape(value, expected, label) {
        if (Array.isArray(expected)) {
            if (!Array.isArray(value) || value.length !== expected.length) {
                throw new TypeError(
                    `${label} must be ${JSON.stringify(expected)}; received=${JSON.stringify(value)}`,
                );
            }
            expected.forEach((item, index) => {
                requireExpectedShape(value[index], item, `${label}[${index}]`);
            });
            return;
        }
        if (expected !== null && typeof expected === 'object') {
            const record = requireRecord(value, label);
            Object.entries(expected).forEach(([key, expectedValue]) => {
                requireExpectedShape(record[key], expectedValue, `${label}.${key}`);
            });
            return;
        }
        if (value !== expected) {
            throw new TypeError(
                `${label} must be ${JSON.stringify(expected)}; received=${JSON.stringify(value)}`,
            );
        }
    }

    function parseIntegerBounds(record, key, label, allowedMinimum, allowedMaximum) {
        const bounds = requireRecord(record[key], `${label}.${key}`);
        const minimum = bounds.minimum;
        const maximum = bounds.maximum;
        const defaultValue = bounds.default;
        for (const [field, value] of [
            ['minimum', minimum],
            ['maximum', maximum],
            ['default', defaultValue],
        ]) {
            if (!Number.isSafeInteger(value)) {
                throw new TypeError(`${label}.${key}.${field} must be a safe integer`);
            }
        }
        if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) {
            throw new RangeError(
                `${label}.${key} must satisfy minimum <= default <= maximum`,
            );
        }
        if (minimum < allowedMinimum || maximum > allowedMaximum) {
            throw new RangeError(
                `${label}.${key} must stay within ${allowedMinimum}..${allowedMaximum}`,
            );
        }
        return freezeBounds(minimum, maximum, defaultValue);
    }

    function parseMaskModes(value, label) {
        if (!Array.isArray(value) || value.length === 0) {
            throw new TypeError(`${label}.mask_export_modes must be a non-empty array`);
        }
        const modes = value.map((mode, index) => {
            if (typeof mode !== 'string' || !CONTRACT_MASK_WIRES.includes(mode)) {
                throw new TypeError(
                    `${label}.mask_export_modes[${index}] is unsupported: ${JSON.stringify(mode)}`,
                );
            }
            return mode;
        });
        if (!modes.includes('none')) {
            throw new RangeError(`${label}.mask_export_modes must include "none"`);
        }
        if (new Set(modes).size !== modes.length) {
            throw new RangeError(`${label}.mask_export_modes must not contain duplicates`);
        }
        return Object.freeze([...modes]);
    }

    function parseRepository(value, label) {
        let parsed;
        try {
            parsed = new URL(value);
        } catch (error) {
            throw new TypeError(`${label} must be an absolute URL: ${error.message}`);
        }
        if (parsed.protocol !== 'https:') {
            throw new RangeError(`${label} must use HTTPS`);
        }
        return parsed.toString().replace(/\/$/, '');
    }

    function parseTrainerContract(value, index) {
        const label = `trainer contracts response.trainers[${index}]`;
        const record = requireRecord(value, label);
        const id = requireString(record, 'id', label);
        if (!/^[a-z0-9_]+$/.test(id)) {
            throw new RangeError(`${label}.id contains unsupported characters: ${id}`);
        }
        const displayName = requireString(record, 'display_name', label);
        const wireValue = requireString(record, 'wire_value', label);
        if (!TRAINER_WIRES.includes(wireValue)) {
            throw new RangeError(`${label}.wire_value is unsupported: ${wireValue}`);
        }
        requireExpectedShape(record, EXPECTED_TRAINER_CONTRACTS[wireValue], label);
        const contractVersion = requireString(record, 'contract_version', label);
        if (!/^\d+\.\d+\.\d+$/.test(contractVersion)) {
            throw new RangeError(`${label}.contract_version must use semantic version form`);
        }
        requireLiteral(record, 'verified', true, label);
        const maskExportModes = parseMaskModes(record.mask_export_modes, label);

        const upstream = requireRecord(record.upstream, `${label}.upstream`);
        const repository = parseRepository(
            requireString(upstream, 'repository', `${label}.upstream`),
            `${label}.upstream.repository`,
        );
        const tag = requireString(upstream, 'tag', `${label}.upstream`);
        const commit = requireString(upstream, 'commit', `${label}.upstream`);
        if (!/^[a-f0-9]{40}$/.test(commit)) {
            throw new RangeError(`${label}.upstream.commit must be a 40-character lowercase SHA-1`);
        }

        requireRecord(record.capabilities, `${label}.capabilities`);
        const optionBounds = requireRecord(record.option_bounds, `${label}.option_bounds`);
        const bounds = Object.freeze({
            repeats: parseIntegerBounds(
                optionBounds, 'repeats', `${label}.option_bounds`, 1, 1000,
            ),
            batchSize: parseIntegerBounds(
                optionBounds, 'batch_size', `${label}.option_bounds`, 1, 64,
            ),
            resolution: parseIntegerBounds(
                optionBounds, 'resolution', `${label}.option_bounds`, 256, 4096,
            ),
            keepTokens: parseIntegerBounds(
                optionBounds, 'keep_tokens', `${label}.option_bounds`, 0, 50,
            ),
        });

        const artifacts = requireRecord(record.generated_artifacts, `${label}.generated_artifacts`);
        requireString(artifacts, 'dataset_config', `${label}.generated_artifacts`);
        requireString(artifacts, 'caption_sidecar', `${label}.generated_artifacts`);
        const verification = requireRecord(
            record.verification_boundary,
            `${label}.verification_boundary`,
        );
        requireString(verification, 'module', `${label}.verification_boundary`);
        requireLiteral(
            verification,
            'validates_upstream_schema',
            true,
            `${label}.verification_boundary`,
        );
        requireLiteral(
            verification,
            'requires_module_path_match',
            true,
            `${label}.verification_boundary`,
        );
        requireLiteral(verification, 'starts_training', false, `${label}.verification_boundary`);

        return Object.freeze({
            id,
            displayName,
            wireValue,
            contractVersion,
            maskExportModes,
            upstream: Object.freeze({ repository, tag, commit }),
            bounds,
        });
    }

    function parseTrainerContractsResponse(value) {
        const response = requireRecord(value, 'trainer contracts response');
        if (!Array.isArray(response.trainers) || response.trainers.length === 0) {
            throw new TypeError('trainer contracts response.trainers must be a non-empty array');
        }
        const contracts = response.trainers.map(parseTrainerContract);
        const ids = contracts.map((contract) => contract.id);
        const wires = contracts.map((contract) => contract.wireValue);
        if (new Set(ids).size !== ids.length) {
            throw new RangeError('trainer contracts response contains duplicate trainer ids');
        }
        if (new Set(wires).size !== wires.length) {
            throw new RangeError('trainer contracts response contains duplicate trainer wire values');
        }
        const missingWires = TRAINER_WIRES.filter((wire) => !wires.includes(wire));
        if (contracts.length !== TRAINER_WIRES.length || missingWires.length > 0) {
            throw new RangeError(
                `trainer contracts response is incomplete: missing_wire_values=${missingWires.join(',')}`,
            );
        }
        return Object.freeze([...contracts]);
    }

    function responseSnippet(body) {
        const normalized = String(body).replace(/\s+/g, ' ').trim();
        return normalized.slice(0, 300);
    }

    async function requestTrainerContracts() {
        const response = await fetch('/api/dataset/trainers', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(
                `Trainer contract request failed: status=${response.status}, ` +
                `response_body=${responseSnippet(body)}`,
            );
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (error) {
            throw new SyntaxError(
                `Trainer contracts response is not valid JSON: error=${error.message}, ` +
                `response_body=${responseSnippet(body)}`,
            );
        }
        return parseTrainerContractsResponse(parsed);
    }

    function createState(status, contracts, errorMessage) {
        return Object.freeze({ status, contracts: Object.freeze([...contracts]), errorMessage });
    }

    function createOption(value, text, i18nKey) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (i18nKey) option.dataset.i18n = i18nKey;
        return option;
    }

    function maskLabel(dm, mode) {
        const labels = {
            none: ['dataset.maskExportNone', "Don't export"],
            onetrainer: ['dataset.maskExportOnetrainer', 'OneTrainer (name-masklabel.png beside image)'],
            kohya: ['dataset.maskExportKohya', 'Kohya conditioning masks (mask/ folder)'],
            anima_lora: ['dataset.maskExportAnima', 'Anima LoRA (mask/<stem>_mask.png)'],
        };
        const [key, fallback] = labels[mode];
        return { key, text: dm._t(key, fallback) };
    }

    function renderMaskOptions(dm, modes, preferredValue) {
        const select = document.getElementById('dataset-mask-export');
        if (!select) throw new Error('Dataset trainer selector requires #dataset-mask-export');
        const options = modes.map((mode) => {
            const label = maskLabel(dm, mode);
            return createOption(mode, label.text, label.key);
        });
        select.replaceChildren(...options);
        select.value = modes.includes(preferredValue) ? preferredValue : 'none';
        select.dispatchEvent(new Event('dataset:select-sync'));
    }

    function applyInputBounds(input, bounds, resetToDefault, disabled) {
        if (!input) throw new Error('Dataset trainer selector is missing a numeric input');
        input.min = String(bounds.minimum);
        input.max = String(bounds.maximum);
        input.step = '1';
        const current = Number(input.value);
        const currentValid = Number.isSafeInteger(current) &&
            current >= bounds.minimum && current <= bounds.maximum;
        if (resetToDefault || !currentValid) input.value = String(bounds.default);
        input.disabled = disabled;
    }

    function readBoundedInteger(inputId, bounds, label) {
        const input = document.getElementById(inputId);
        if (!input) throw new Error(`Dataset trainer selector requires #${inputId}`);
        const raw = String(input.value).trim();
        const value = Number(raw);
        if (!Number.isSafeInteger(value)) {
            throw new TypeError(`${label} must be a whole number; received=${JSON.stringify(raw)}`);
        }
        if (value < bounds.minimum || value > bounds.maximum) {
            throw new RangeError(
                `${label} must be between ${bounds.minimum} and ${bounds.maximum}; received=${value}`,
            );
        }
        return value;
    }

    function selectedContract(dm) {
        const state = dm._trainerContractState;
        if (!state || state.status !== 'ready') return null;
        const value = document.getElementById('dataset-trainer-package')?.value || 'none';
        if (value === 'none') return null;
        return state.contracts.find((contract) => contract.wireValue === value) || null;
    }

    function buildTrainerExportFields(dm, state) {
        const contract = selectedContract(dm);
        const bounds = contract?.bounds || GENERIC_BOUNDS;
        const maskExport = document.getElementById('dataset-mask-export')?.value || '';
        const allowedMasks = contract?.maskExportModes || GENERIC_MASK_WIRES;
        if (!allowedMasks.includes(maskExport)) {
            throw new RangeError(
                `mask_export=${JSON.stringify(maskExport)} is not allowed for the selected trainer package`,
            );
        }
        if (contract && dm._outputMode?.() !== 'folder') {
            throw new RangeError('Verified trainer packages require output_mode="folder"');
        }
        const imageOperation = document.getElementById('dataset-image-op')?.value || '';
        if (contract && imageOperation !== 'copy') {
            throw new RangeError('Verified trainer packages require image_op="copy"');
        }
        return Object.freeze({
            mask_export: maskExport,
            trainer_config: contract?.wireValue || 'none',
            trainer_repeats: readBoundedInteger('dataset-est-repeats', bounds.repeats, 'repeats'),
            trainer_batch: readBoundedInteger('dataset-est-batch', bounds.batchSize, 'batch size'),
            trainer_resolution: contract
                ? readBoundedInteger('dataset-trainer-resolution', bounds.resolution, 'resolution')
                : GENERIC_BOUNDS.resolution.default,
            trainer_keep_tokens: contract
                ? readBoundedInteger('dataset-trainer-keep-tokens', bounds.keepTokens, 'keep_tokens')
                : GENERIC_BOUNDS.keepTokens.default,
        });
    }

    DM._hasSelectedTrainerPackage = function () {
        return selectedContract(this) !== null;
    };

    DM._trainerExportFields = function () {
        const state = this._trainerContractState;
        if (!state || state.status === 'idle' || state.status === 'loading') {
            throw new Error(this._t(
                'dataset.trainerContractsLoading',
                'Loading verified trainer contracts...',
            ));
        }
        if (state.status === 'error') throw new Error(state.errorMessage);
        return buildTrainerExportFields(this, state);
    };

    DM._trainerContractDisabledReason = function () {
        const state = this._trainerContractState;
        if (!state || state.status === 'idle' || state.status === 'loading') {
            return this._t(
                'dataset.trainerContractsLoading',
                'Loading verified trainer contracts...',
            );
        }
        if (state.status === 'error') return state.errorMessage;
        try {
            buildTrainerExportFields(this, state);
            return '';
        } catch (error) {
            return error.message;
        }
    };

    DM._syncTrainerOutputControls = function () {
        const hasTrainer = this._hasSelectedTrainerPackage();
        const folder = document.querySelector('input[name="dataset-output-mode"][value="folder"]');
        const copy = document.querySelector('input[name="dataset-image-op-radio"][value="copy"]');
        const move = document.querySelector('input[name="dataset-image-op-radio"][value="move"]');
        const hiddenOperation = document.getElementById('dataset-image-op');
        const constraint = this._t(
            'dataset.trainerRequiresFolderCopy',
            'Verified trainer packages require folder export with Copy.',
        );
        if (hasTrainer) {
            if (folder) folder.checked = true;
            if (copy) copy.checked = true;
            if (hiddenOperation) hiddenOperation.value = 'copy';
        }
        if (move) {
            move.disabled = hasTrainer;
            move.title = hasTrainer ? constraint : '';
        }
    };

    DM._renderTrainerContractState = function () {
        const state = this._trainerContractState;
        const selector = document.getElementById('dataset-trainer-package');
        const status = document.getElementById('dataset-trainer-contract-state');
        const retry = document.getElementById('btn-dataset-trainer-contract-retry');
        const mask = document.getElementById('dataset-mask-export');
        if (!state || !selector || !status || !retry || !mask) {
            throw new Error('Dataset trainer selector controls are incomplete');
        }
        status.dataset.state = state.status;
        retry.hidden = state.status !== 'error';
        selector.disabled = state.status !== 'ready';
        mask.disabled = state.status !== 'ready';
        selector.dispatchEvent(new Event('dataset:select-sync'));
        mask.dispatchEvent(new Event('dataset:select-sync'));
        if (state.status === 'loading' || state.status === 'idle') {
            status.textContent = this._t(
                'dataset.trainerContractsLoading',
                'Loading verified trainer contracts...',
            );
        } else if (state.status === 'error') {
            const prefix = this._t(
                'dataset.trainerContractsFailed',
                'Trainer contracts unavailable',
            );
            status.textContent = `${prefix}: ${state.errorMessage}`;
        } else {
            status.textContent = this._t(
                'dataset.trainerContractsReady',
                '{count} verified trainer contracts loaded.',
                { count: state.contracts.length },
            );
        }
    };

    DM._installTrainerContractOptions = function (preferredValue) {
        const state = this._trainerContractState;
        const selector = document.getElementById('dataset-trainer-package');
        if (!state || state.status !== 'ready' || !selector) {
            throw new Error('Trainer contract options require a ready contract state');
        }
        const noneOption = createOption(
            'none',
            this._t('dataset.trainerPackageNone', 'Images + captions only'),
            'dataset.trainerPackageNone',
        );
        const contractOptions = state.contracts.map((contract) =>
            createOption(contract.wireValue, contract.displayName, ''));
        selector.replaceChildren(noneOption, ...contractOptions);
        const available = ['none', ...state.contracts.map((contract) => contract.wireValue)];
        selector.value = available.includes(preferredValue) ? preferredValue : 'none';
        selector.dispatchEvent(new Event('dataset:select-sync'));
    };

    DM._renderTrainerSettingError = function () {
        const error = document.getElementById('dataset-trainer-setting-error');
        if (!error) return;
        const reason = this._trainerContractDisabledReason();
        const stateReady = this._trainerContractState?.status === 'ready';
        error.hidden = !stateReady || !reason;
        error.textContent = stateReady ? reason : '';
        for (const id of [
            'dataset-est-repeats',
            'dataset-est-batch',
            'dataset-trainer-resolution',
            'dataset-trainer-keep-tokens',
        ]) {
            const input = document.getElementById(id);
            if (input) input.setAttribute('aria-invalid', stateReady && reason ? 'true' : 'false');
        }
    };

    DM._applyTrainerSelection = function (resetContractValues) {
        const contract = selectedContract(this);
        const mask = document.getElementById('dataset-mask-export');
        const settings = document.getElementById('dataset-trainer-settings');
        const pin = document.getElementById('dataset-trainer-pin');
        const repeats = document.getElementById('dataset-est-repeats');
        const batch = document.getElementById('dataset-est-batch');
        const resolution = document.getElementById('dataset-trainer-resolution');
        const keepTokens = document.getElementById('dataset-trainer-keep-tokens');
        if (!mask || !settings || !pin) {
            throw new Error('Dataset trainer selector settings are incomplete');
        }
        const preferredMask = resetContractValues ? 'none' : mask.value;
        renderMaskOptions(
            this,
            contract?.maskExportModes || GENERIC_MASK_WIRES,
            preferredMask,
        );
        const bounds = contract?.bounds || GENERIC_BOUNDS;
        applyInputBounds(repeats, bounds.repeats, false, false);
        applyInputBounds(batch, bounds.batchSize, false, false);
        applyInputBounds(
            resolution,
            bounds.resolution,
            resetContractValues,
            !contract || bounds.resolution.minimum === bounds.resolution.maximum,
        );
        applyInputBounds(
            keepTokens,
            bounds.keepTokens,
            resetContractValues,
            !contract || bounds.keepTokens.minimum === bounds.keepTokens.maximum,
        );
        settings.hidden = !contract;
        pin.hidden = !contract;
        pin.textContent = contract
            ? this._t(
                'dataset.trainerPin',
                'Verified {tag} · commit {commit}',
                { tag: contract.upstream.tag, commit: contract.upstream.commit.slice(0, 12) },
            )
            : '';
        this._syncTrainerOutputControls();
        this._syncOutputModeUi?.();
        this._renderTrainerSettingError();
        this._renderReadiness?.();
        this._updateExportEnabled?.();
        this._refreshExportPreview?.();
    };

    DM._loadTrainerContracts = async function () {
        const generation = Number.isSafeInteger(this._trainerContractLoadGeneration)
            ? this._trainerContractLoadGeneration + 1
            : 1;
        this._trainerContractLoadGeneration = generation;
        this._trainerContractState = createState('loading', [], '');
        this._renderTrainerContractState();
        this._renderReadiness?.();
        this._updateExportEnabled?.();
        try {
            const contracts = await requestTrainerContracts();
            if (generation !== this._trainerContractLoadGeneration) return;
            this._trainerContractState = createState('ready', contracts, '');
            this._installTrainerContractOptions('none');
            this._renderTrainerContractState();
            this._applyTrainerSelection(true);
        } catch (error) {
            if (generation !== this._trainerContractLoadGeneration) return;
            const message = error instanceof Error ? error.message : String(error);
            this._trainerContractState = createState('error', [], message);
            this._renderTrainerContractState();
            this._renderTrainerSettingError();
            this._renderReadiness?.();
            this._updateExportEnabled?.();
            window.Logger?.warn?.('dataset_trainer_contract_load_failed', {
                generation,
                error_type: error?.constructor?.name || typeof error,
                message,
            });
        }
    };

    DM._startTrainerContractLoad = function () {
        const loadPromise = this._loadTrainerContracts();
        this._trainerContractLoadPromise = loadPromise;
        return loadPromise;
    };

    DM._initTrainerSelector = function () {
        if (this._trainerSelectorBound) return this._trainerContractLoadPromise;
        this._trainerSelectorBound = true;
        this._trainerContractState = createState('idle', [], '');
        document.getElementById('dataset-trainer-package')?.addEventListener('change', () => {
            this._markReadinessStale?.();
            this._applyTrainerSelection(true);
        });
        document.getElementById('btn-dataset-trainer-contract-retry')?.addEventListener('click', () => {
            this._startTrainerContractLoad();
        });
        for (const id of [
            'dataset-mask-export',
            'dataset-est-repeats',
            'dataset-est-batch',
            'dataset-trainer-resolution',
            'dataset-trainer-keep-tokens',
        ]) {
            const input = document.getElementById(id);
            if (!input) continue;
            const eventName = input.tagName.toLowerCase() === 'select' ? 'change' : 'input';
            input.addEventListener(eventName, () => {
                this._markReadinessStale?.();
                this._renderTrainerSettingError();
                this._renderReadiness?.();
                this._updateExportEnabled?.();
                this._refreshExportPreview?.();
            });
        }
        document.addEventListener('languageChanged', () => {
            if (this._trainerContractState?.status === 'ready') {
                const selectedValue = document.getElementById('dataset-trainer-package')?.value || 'none';
                this._installTrainerContractOptions(selectedValue);
                this._applyTrainerSelection(false);
            }
            this._renderTrainerContractState();
        });
        return this._startTrainerContractLoad();
    };
})();
