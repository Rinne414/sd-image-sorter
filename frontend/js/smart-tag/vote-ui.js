/**
 * smart-tag/vote-ui.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 559-599: syncSmartTagVoteUi — the consensus gate (locked until two
 * distinct taggers), the no-duplicate Tagger 2 rule, the booru/natural
 * section enable/disable and the torii-options toggle. Classic script;
 * family renames applied ($ -> smartTag$).
 */
'use strict';
    function syncSmartTagVoteUi() {
        const select1 = smartTag$('#smart-tag-tagger-1');
        const select2 = smartTag$('#smart-tag-tagger-2');
        const consensusMode = smartTag$('#smart-tag-consensus-mode');
        const booruSection = smartTag$('#smart-tag-booru-section');
        const naturalSection = smartTag$('#smart-tag-natural-section');
        const booruEnabled = !!smartTag$('#smart-tag-enable-wd14')?.checked;
        const naturalEnabled = !!smartTag$('#smart-tag-enable-vlm')?.checked;
        const nlMode = smartTag$('#smart-tag-nl-mode')?.value || 'vlm';
        if (!select1 || !select2) return;

        for (const option of Array.from(select2.options)) {
            option.disabled = option.value !== '' && option.value === select1.value;
        }
        if (select2.value && select2.value === select1.value) {
            select2.value = '';
        }

        const dualTagger = Boolean(select1.value && select2.value);
        if (consensusMode) {
            consensusMode.disabled = !dualTagger;
            consensusMode.setAttribute('aria-disabled', String(!dualTagger));
        }
        if (booruSection) {
            booruSection.classList.toggle('is-disabled', !booruEnabled);
            booruSection.querySelectorAll('select, input[type="number"]').forEach((el) => {
                el.disabled = !booruEnabled;
            });
        }
        if (naturalSection) {
            naturalSection.classList.toggle('is-disabled', !naturalEnabled);
            naturalSection.querySelectorAll('select').forEach((el) => {
                el.disabled = !naturalEnabled;
            });
        }
        const settingsBtn = smartTag$('#btn-smart-tag-vlm-settings');
        if (settingsBtn) settingsBtn.disabled = !naturalEnabled || nlMode !== 'vlm';
        const toriiOptions = smartTag$('#smart-tag-torii-options');
        if (toriiOptions) toriiOptions.hidden = nlMode !== 'toriigate';
    }

