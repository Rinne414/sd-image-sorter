/**
 * Target base-model profiles for LoRA dataset prep (standing optimize
 * directive: evidence-based model support, frontend-first).
 *
 * The model you train FOR decides how captions should look, so the choice
 * lives at the top of the LoRA-setup card and drives:
 *   - the recommended per-image caption type (booru / both / nl), offered
 *     as an explicit one-click apply — never silently rewritten;
 *   - the token budget the Separation Console counter warns against.
 *
 * Evidence per profile (primary sources):
 *   sdxl  — CLIP text encoders take 77 tokens (75 usable): the budget the
 *           QW-1 counter always used for SD1.5/SDXL-family models.
 *   flux  — FLUX.1 conditions on T5-XXL with max_sequence_length 512
 *           (black-forest-labs/flux reference inference + diffusers
 *           FluxPipeline default); booru tags work but NL adds detail.
 *   krea2 — Krea 2 uses Qwen 3 VL as its text encoder and was trained
 *           predominantly on LONG natural-language captions
 *           (krea.ai/blog/krea-2-technical-report); the official
 *           prompting guide says "natural language prompts" and "long
 *           detailed prompts yield best results"
 *           (github.com/krea-ai/krea-2 docs/prompting.md). LoRA captions
 *           are required per image (krea.ai/blog/krea-2-lora-training).
 *   anima — Qwen3-class encoder with booru-tag-native vocabulary; the
 *           app's Anima export presets (@-prefixed triggers, category
 *           sections) already encode its conventions.
 */
(function () {
    'use strict';

    const STORE_KEY = 'sd-image-sorter-dataset-target-model';

    function t(en, zh) {
        try {
            const lang = window.I18n?.getLang?.() || document.documentElement.lang || '';
            return String(lang).toLowerCase().startsWith('zh') ? zh : en;
        } catch (_) { return en; }
    }

    const PROFILES = {
        sdxl: {
            captionType: 'booru',
            tokenBudget: 75,
            hint: () => t(
                'CLIP encoder: 75-token budget — concise booru tags, most important first.',
                'CLIP 编码器：75-token 预算 — 精简 booru 标签，重要的放前面。'),
            applyLabel: () => t('Set every image to Booru tags', '全部图片设为 Booru 标签'),
        },
        flux: {
            captionType: 'both',
            tokenBudget: 512,
            hint: () => t(
                'T5 encoder (512 tokens): tags + a natural-language sentence give the densest signal.',
                'T5 编码器（512 tokens）：标签 + 自然语言句子的组合信息最充分。'),
            applyLabel: () => t('Set every image to Both (tags + NL)', '全部图片设为 Both（标签+自然语言）'),
        },
        krea2: {
            captionType: 'nl',
            tokenBudget: 512,
            hint: () => t(
                'Qwen3-VL encoder, trained on long natural-language captions — the NL sentence IS the training payload; run Smart Tag with a VLM caption. Tags still help search.',
                'Qwen3-VL 编码器，以自然语言长 caption 训练 — NL 句子才是训练本体；请用带 VLM 描述的 Smart Tag。标签仍可用于搜索。'),
            applyLabel: () => t('Set every image to NL captions', '全部图片设为自然语言 caption'),
        },
        anima: {
            captionType: 'booru',
            tokenBudget: 512,
            hint: () => t(
                'Booru-native vocabulary (Qwen3 encoder) — rich tag lists work; use the Anima export presets for @-triggers and sections.',
                'Booru 原生词表（Qwen3 编码器）— 标签列表友好；导出请配合 Anima 预设（@ 触发词与分区）。'),
            applyLabel: () => t('Set every image to Booru tags', '全部图片设为 Booru 标签'),
        },
    };

    const TargetModel = {
        get dm() { return window.DatasetMaker || null; },

        current() {
            return document.getElementById('dataset-target-model')?.value || '';
        },

        profile() {
            return PROFILES[this.current()] || null;
        },

        /** Token budget for caption counters; null = no target chosen (CLIP default applies). */
        tokenBudget() {
            const profile = this.profile();
            return profile ? profile.tokenBudget : null;
        },

        init() {
            const select = document.getElementById('dataset-target-model');
            if (!select) return;
            try {
                const stored = localStorage.getItem(STORE_KEY);
                if (stored && PROFILES[stored]) select.value = stored;
            } catch (_) { /* stateless fallback */ }
            select.addEventListener('change', () => {
                try { localStorage.setItem(STORE_KEY, select.value); } catch (_) {}
                this.refresh();
            });
            document.getElementById('btn-dataset-target-model-apply')
                ?.addEventListener('click', () => this.applyRecommendation());
            this.refresh();
        },

        refresh() {
            const hint = document.getElementById('dataset-target-model-hint');
            const apply = document.getElementById('btn-dataset-target-model-apply');
            const profile = this.profile();
            if (hint) hint.textContent = profile ? profile.hint() : '';
            if (apply) {
                apply.hidden = !profile;
                if (profile) apply.textContent = profile.applyLabel();
            }
        },

        applyRecommendation() {
            const dm = this.dm;
            const profile = this.profile();
            if (!dm || !profile) return;
            if (typeof dm._applyCaptionTypeToScope !== 'function') {
                window.App?.showToast?.(t('Load a dataset queue first', '请先建立数据集队列'), 'info');
                return;
            }
            dm._applyCaptionTypeToScope(profile.captionType, 'all');
            window.App?.showToast?.(
                t(`Caption type set to "${profile.captionType}" for every image`,
                  `已把全部图片的 caption 类型设为「${profile.captionType}」`),
                'success');
        },
    };

    window.TargetModel = TargetModel;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TargetModel.init());
    } else {
        TargetModel.init();
    }
})();
