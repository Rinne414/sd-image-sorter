/**
 * smart-tag/taggers.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 361-558 + 600-624: the tagger-select family (setSelectLoading,
 * appendTaggerOption, isBooruTaggerModel, getEnabledBooruTaggerModels,
 * getModelDefaultThresholds — hosts the `model?.default_threshold`
 * literal pinned by backend/tests/test_frontend_contract.py —
 * getModelDefaultMaxTags, toFiniteMaxTags, the touched-input guards,
 * getPayloadThresholdsForModel/getPayloadMaxTagsForModels,
 * applyMaxTagsDefault/applyThresholdDefaults, the tagger-help elements,
 * populateSmartTaggerSelects) and loadSmartTaggerModels
 * (GET /api/tagger/models -> catalog). Classic script; family renames
 * applied.
 */
'use strict';
    function setSelectLoading(select, label) {
        if (!select) return;
        select.innerHTML = '';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = label;
        select.appendChild(option);
    }

    function appendTaggerOption(select, model, selectedValue) {
        const option = document.createElement('option');
        const name = String(model?.name || model?.path || '').trim();
        option.value = name;
        // Surface the beginner-facing "best for" hint directly in the visible
        // option text (not just the title tooltip) so the Dataset Smart-Tag
        // dropdown is self-describing, matching the Gallery picker. The option
        // value stays the raw model name so selection logic is unaffected.
        const recommendedSuffix = model?.recommended
            ? ` (${smartTagT('smartTag.taggerRecommended', 'Recommended')})`
            : '';
        const bestForSuffix = model?.best_for ? ` — ${model.best_for}` : '';
        option.textContent = name + recommendedSuffix + bestForSuffix;
        if (model?.best_for) option.title = `${name} - ${model.best_for}`;
        if (model?.disabled) {
            option.disabled = true;
            option.setAttribute('aria-disabled', 'true');
            option.textContent += ` (${smartTagT('smartTag.taggerUnavailable', 'Unavailable')})`;
            if (model?.disabled_reason) option.title = model.disabled_reason;
        }
        if (name === selectedValue) option.selected = true;
        select.appendChild(option);
    }

    function isBooruTaggerModel(model) {
        const backend = String(model?.runtime_backend || '').toLowerCase();
        const role = String(model?.smart_tag_role || '').toLowerCase();
        return Boolean(model?.name)
            && role !== 'natural_language'
            && backend !== 'toriigate'
            && model.name !== 'toriigate-0.5';
    }

    function getEnabledBooruTaggerModels() {
        return taggerModelCatalog.filter((model) => isBooruTaggerModel(model) && !model.disabled);
    }

    function getModelDefaultThresholds(modelName) {
        const model = taggerModelCatalog.find((item) => item?.name === modelName);
        const general = toFiniteThreshold(
            model?.default_threshold,
            toFiniteThreshold(smartTag$('#smart-tag-general-threshold')?.value, 0.35)
        );
        return {
            general_threshold: general,
            character_threshold: toFiniteThreshold(
                model?.default_character_threshold,
                toFiniteThreshold(smartTag$('#smart-tag-character-threshold')?.value, 0.85)
            ),
            copyright_threshold: toFiniteThreshold(
                model?.default_copyright_threshold,
                toFiniteThreshold(smartTag$('#smart-tag-copyright-threshold')?.value, general)
            ),
        };
    }

    function getModelDefaultMaxTags(modelName) {
        const model = taggerModelCatalog.find((item) => item?.name === modelName);
        const value = parseInt(model?.default_max_tags_per_image, 10);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    function toFiniteMaxTags(value, fallback) {
        const num = parseInt(value, 10);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(2000, num));
    }

    function thresholdInputsWereTouched() {
        return ['#smart-tag-general-threshold', '#smart-tag-character-threshold', '#smart-tag-copyright-threshold']
            .some((selector) => smartTag$(selector)?.dataset.userTouched === 'true');
    }

    function maxTagsInputWasTouched() {
        return smartTag$('#smart-tag-max-tags')?.dataset.userTouched === 'true';
    }

    function getPayloadThresholdsForModel(modelName, sharedThresholds) {
        return thresholdInputsWereTouched()
            ? sharedThresholds
            : getModelDefaultThresholds(modelName);
    }

    function getPayloadMaxTagsForModels(modelNames) {
        const input = smartTag$('#smart-tag-max-tags');
        if (maxTagsInputWasTouched()) {
            return toFiniteMaxTags(input?.value, 0);
        }
        const values = modelNames
            .map((name) => getModelDefaultMaxTags(name))
            .filter((value) => value > 0);
        if (!values.length) return undefined;
        return Math.min(...values);
    }

    function applyMaxTagsDefault(modelNames, { force = false } = {}) {
        const input = smartTag$('#smart-tag-max-tags');
        if (!input || (!force && input.dataset.userTouched === 'true')) return;
        const value = getPayloadMaxTagsForModels(modelNames);
        input.value = String(Number.isFinite(value) ? value : 0);
    }

    function applyThresholdDefaults(modelName, { force = false } = {}) {
        const defaults = getModelDefaultThresholds(modelName);
        const pairs = [
            ['#smart-tag-general-threshold', defaults.general_threshold],
            ['#smart-tag-character-threshold', defaults.character_threshold],
            ['#smart-tag-copyright-threshold', defaults.copyright_threshold],
        ];
        for (const [selector, value] of pairs) {
            const input = smartTag$(selector);
            if (!input) continue;
            if (force || input.dataset.userTouched !== 'true') {
                input.value = Number(value).toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
            }
        }
    }

    function ensureTaggerHelpElement(selectId, helpId) {
        let help = document.getElementById(helpId);
        if (help) return help;
        const select = document.getElementById(selectId);
        if (!select || !select.parentNode) return null;
        ensureSmartTagStyles();
        help = document.createElement('small');
        help.id = helpId;
        help.className = 'smart-tag-tagger-help';
        help.textContent = '';
        // Insert right after the select element so it sits directly
        // under the dropdown regardless of the surrounding wrapper.
        select.parentNode.insertBefore(help, select.nextSibling);
        return help;
    }

    function updateTaggerHelpFor(selectId, helpId) {
        const help = ensureTaggerHelpElement(selectId, helpId);
        if (!help) return;
        const select = document.getElementById(selectId);
        const value = (select?.value || '').trim();
        const model = taggerModelCatalog.find((m) => m?.name === value);
        help.textContent = model?.best_for ? String(model.best_for) : '';
    }

    function updateAllTaggerHelp() {
        updateTaggerHelpFor('smart-tag-tagger-1', 'smart-tag-tagger-1-help');
        updateTaggerHelpFor('smart-tag-tagger-2', 'smart-tag-tagger-2-help');
    }

    function populateSmartTaggerSelects() {
        const select1 = smartTag$('#smart-tag-tagger-1');
        const select2 = smartTag$('#smart-tag-tagger-2');
        if (!select1 || !select2) return;

        const enabledModels = getEnabledBooruTaggerModels();
        const fallbackDefault = enabledModels[0]?.name || taggerModelDefault || '';
        const previous1 = select1.value || taggerModelDefault || fallbackDefault;
        const previous2 = select2.value || '';
        const selected1 = enabledModels.some((model) => model.name === previous1) ? previous1 : fallbackDefault;
        const selected2 = enabledModels.some((model) => model.name === previous2) && previous2 !== selected1
            ? previous2
            : '';

        select1.innerHTML = '';
        select2.innerHTML = '';

        if (!taggerModelCatalog.length) {
            setSelectLoading(select1, smartTagT('smartTag.taggerLoadFailed', 'Failed to load taggers'));
            setSelectLoading(select2, smartTagT('smartTag.taggerDisabled', 'Off'));
            return;
        }

        for (const model of taggerModelCatalog.filter(isBooruTaggerModel)) {
            appendTaggerOption(select1, model, selected1);
        }

        const offOption = document.createElement('option');
        offOption.value = '';
        offOption.textContent = smartTagT('smartTag.taggerDisabled', 'Off');
        select2.appendChild(offOption);
        for (const model of taggerModelCatalog.filter(isBooruTaggerModel)) {
            appendTaggerOption(select2, model, selected2);
        }
        select2.value = selected2;
        applyThresholdDefaults(selected1, { force: false });
        applyMaxTagsDefault([selected1, selected2].filter(Boolean), { force: false });
        syncSmartTagVoteUi();
        updateAllTaggerHelp();
    }

    async function loadSmartTaggerModels() {
        const select1 = smartTag$('#smart-tag-tagger-1');
        const select2 = smartTag$('#smart-tag-tagger-2');
        if (!select1 || !select2) return;

        setSelectLoading(select1, smartTagT('smartTag.taggerLoading', 'Loading taggers...'));
        setSelectLoading(select2, smartTagT('smartTag.taggerLoading', 'Loading taggers...'));
        try {
            const data = await getJson('/api/tagger/models');
            taggerModelCatalog = Array.isArray(data.models) ? data.models : [];
            taggerModelDefault = String(data.default || '').trim();
            populateSmartTaggerSelects();
        } catch (err) {
            taggerModelCatalog = [];
            taggerModelDefault = '';
            populateSmartTaggerSelects();
            if (typeof window.showToast === 'function') {
                window.showToast(
                    smartTagT('smartTag.taggerLoadFailedToast', 'Failed to load Smart Tag tagger list. The backend default will be used.'),
                    'warning'
                );
            }
        }
    }

