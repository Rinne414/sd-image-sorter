/**
 * Dataset Maker — category cleanup tag lists (Phase 2E).
 *
 * Curated starter lists per danbooru-style category. Each click of a
 * cleanup button APPENDS the category's tags to the blacklist textarea
 * (deduplicating so the user can click multiple times safely without
 * inflating the field).
 *
 * Lists are deliberately conservative — the most common 30-60 tags per
 * category, not every possible token. Power users can extend the
 * blacklist textarea afterwards. Lists target danbooru-style WD14 tag
 * naming (underscores, lower case); the underscore-to-space step in
 * the export engine handles both forms when matching.
 *
 * Why this lives in its own file: keeps the four parts of the dataset-maker
 * module under ~400 lines each so each chunk is reviewable.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ============== Curated tag lists per category ==============
    const TAG_CATEGORIES = {
        quality: [
            // Anima / Pony / NoobAI score tags
            'masterpiece', 'best_quality', 'high_quality', 'normal_quality', 'low_quality', 'worst_quality',
            'score_9', 'score_8', 'score_7', 'score_6', 'score_5', 'score_4',
            'score_9_up', 'score_8_up', 'score_7_up', 'score_6_up', 'score_5_up', 'score_4_up',
            'highres', 'absurdres', 'lowres',
            'detailed', 'extremely_detailed', 'highly_detailed',
            'newest', 'recent', 'old', 'oldest',
            // Generic style-grade tokens
            'official_art', 'professional_lighting', 'depth_of_field',
            'anatomically_correct', 'realistic',
        ],
        identity: [
            // Hair color
            'black_hair', 'white_hair', 'silver_hair', 'grey_hair', 'gray_hair',
            'blonde_hair', 'yellow_hair', 'brown_hair', 'red_hair', 'orange_hair',
            'pink_hair', 'purple_hair', 'blue_hair', 'green_hair',
            'multicolored_hair', 'two-tone_hair', 'gradient_hair', 'streaked_hair',
            // Eye color
            'black_eyes', 'white_eyes', 'red_eyes', 'orange_eyes', 'yellow_eyes',
            'green_eyes', 'blue_eyes', 'purple_eyes', 'pink_eyes', 'brown_eyes',
            'heterochromia',
            // Skin
            'dark_skin', 'pale_skin', 'tan', 'tanned',
            // Other identity markers
            'freckles', 'mole', 'mole_under_eye', 'mole_under_mouth', 'beauty_mark',
            'scar', 'scar_on_face', 'eyepatch',
        ],
        appearance: [
            // Hair length / style
            'long_hair', 'medium_hair', 'short_hair', 'very_long_hair', 'very_short_hair',
            'twintails', 'ponytail', 'side_ponytail', 'braid', 'twin_braids',
            'bangs', 'blunt_bangs', 'side_bangs', 'parted_bangs',
            'hair_bun', 'double_bun', 'hair_ornament', 'hair_ribbon', 'hair_bow',
            'ahoge', 'antenna_hair',
            // Build / body
            'large_breasts', 'medium_breasts', 'small_breasts', 'flat_chest', 'huge_breasts',
            'thick_thighs', 'wide_hips', 'slim',
            // Common clothing classes (clothes are a STYLE LoRA's friend, but
            // most character LoRAs want the clothes to vary across the dataset)
            'school_uniform', 'serafuku', 'sailor_collar',
            'shirt', 't-shirt', 'sweater', 'hoodie', 'jacket', 'coat',
            'skirt', 'pleated_skirt', 'miniskirt', 'long_skirt',
            'dress', 'long_dress', 'short_dress',
            'pants', 'shorts', 'jeans',
            'thighhighs', 'pantyhose', 'stockings', 'socks',
            'shoes', 'boots', 'sneakers',
            'hat', 'cap', 'beret',
            'gloves',
        ],
        poses: [
            'standing', 'sitting', 'lying', 'on_back', 'on_stomach', 'on_side',
            'kneeling', 'squatting', 'leaning', 'leaning_forward', 'leaning_back',
            'crossed_legs', 'crossed_arms', 'arms_up', 'arms_behind_back',
            'hands_up', 'hands_on_hips', 'hand_on_hip', 'hand_to_mouth', 'hand_to_face',
            'looking_at_viewer', 'looking_away', 'looking_back', 'looking_up', 'looking_down', 'looking_to_the_side',
            'open_mouth', 'closed_mouth', 'parted_lips',
            'smile', 'closed_eyes', 'one_eye_closed',
            'walking', 'running', 'jumping', 'falling', 'flying',
            'holding', 'holding_phone', 'holding_book', 'holding_weapon',
            'dynamic_pose', 'contrapposto',
            'from_above', 'from_below', 'from_behind', 'from_side',
            'close-up', 'cowboy_shot', 'full_body', 'upper_body',
        ],
        copyright: [
            // Generic
            'original', 'no_copyright', 'oc',
            // Common franchise / IP tags (small representative set; if a
            // user needs more they can paste them into the blacklist)
            'touhou', 'kantai_collection', 'kancolle', 'fate_series', 'fate/grand_order', 'fate_(series)',
            'idolmaster', 'idolm@ster', 'love_live!', 'lovelive', 'bang_dream!',
            'azur_lane', 'arknights', 'genshin_impact', 'honkai_impact', 'honkai_(series)', 'honkai:_star_rail',
            'blue_archive', 'pokemon', 'digimon', 'jojo_no_kimyou_na_bouken',
            'bocchi_the_rock!', 'oshi_no_ko', 'spy_x_family', 'frieren',
            'naruto', 'dragon_ball', 'one_piece', 'bleach', 'attack_on_titan', 'shingeki_no_kyojin',
            'demon_slayer', 'kimetsu_no_yaiba', 'jujutsu_kaisen', 'chainsaw_man',
            'persona_5', 'nier_automata', 'overwatch', 'league_of_legends', 'final_fantasy',
            'voiceroid', 'vocaloid', 'hatsune_miku', 'kasane_teto', 'utau',
            // Generic species / style markers that often pollute LoRA captions
            'anime_coloring', 'anime_style',
        ],
    };

    // ============== Implementation ==============

    function appendToBlacklist(category) {
        const ta = document.getElementById('dataset-blacklist');
        if (!ta) return 0;
        const tagsToAdd = TAG_CATEGORIES[category] || [];
        if (tagsToAdd.length === 0) return 0;

        const existing = (ta.value || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        // Normalise existing entries for comparison so we don't add
        // duplicates that differ only by underscore vs space or case.
        const norm = (s) => String(s).replace(/_/g, ' ').toLowerCase().trim();
        const seen = new Set(existing.map(norm));

        const added = [];
        for (const tag of tagsToAdd) {
            if (seen.has(norm(tag))) continue;
            seen.add(norm(tag));
            added.push(tag);
        }
        if (added.length === 0) return 0;

        const merged = [...existing, ...added];
        ta.value = merged.join(', ');
        // Trigger input handlers (caption refresh, etc.)
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return added.length;
    }

    DM._initCleanupButtons = function () {
        const wire = (id, category) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const added = appendToBlacklist(category);
                if (added === 0) {
                    this._toast(this._t('dataset.cleanupAlreadyAdded',
                        'Those {category} tags are already in the blacklist.',
                        { category: this._t(`dataset.cleanup${category[0].toUpperCase()}${category.slice(1)}Label`, category) }),
                        'info', 3000);
                } else {
                    this._toast(this._t('dataset.cleanupAdded',
                        'Added {count} {category} tags to the blacklist.',
                        { count: added, category: this._t(`dataset.cleanup${category[0].toUpperCase()}${category.slice(1)}Label`, category) }),
                        'success', 3000);
                }
            });
        };
        wire('btn-dataset-cleanup-quality', 'quality');
        wire('btn-dataset-cleanup-identity', 'identity');
        wire('btn-dataset-cleanup-appearance', 'appearance');
        wire('btn-dataset-cleanup-poses', 'poses');
        wire('btn-dataset-cleanup-copyright', 'copyright');
    };

    // Wire on view init (DM.init runs once when the view first becomes active)
    const originalInit = DM.init;
    DM.init = function () {
        originalInit.call(this);
        this._initCleanupButtons();
    };
})();
