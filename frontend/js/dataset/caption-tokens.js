/**
 * Dataset Maker — exact caption token counts for the chosen base model.
 *
 * SDXL (and no base model chosen) counts with CLIP ViT-L/14, FLUX with T5 v1.1
 * XXL, Krea 2 with Qwen3 and Anima with Qwen3-0.6B and T5 v1.1 XXL
 * (backend/services/caption_tokenizer_service.py says why each is exact).
 *
 * Backend: GET /api/dataset/caption-tokens/status?profile=, POST .../prepare?profile=
 * (installs the small `tokenizers` package when it is missing and downloads the
 * model's tokenizer files once, 2 to 14 MB, on request) and POST /api/dataset/caption-tokens.
 *
 * Until the files are there every count stays the labelled estimate
 * (SeparationConsole.estimateTokens) and nothing waits on the download. A
 * caption is too long when any of its exact counts is over the budget.
 *
 * Used by the caption editor's token counter and by the "Long captions" check of
 * the Quality Audit.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const API = '/api/dataset/caption-tokens';
    // The base models the backend counts for; no choice counts as CLIP, as the estimate does.
    const PROFILES = ['sdxl', 'flux', 'krea2', 'anima'];
    const DEFAULT_PROFILE = 'sdxl';
    const POLL_MS = 1000;
    // Captions asked for per request (the audit counts the whole queue).
    const CHUNK = 400;
    // Exact counts kept for the editor's live counter, newest last.
    const CACHE_LIMIT = 200;
    const COUNTER_DELAY_MS = 250;
    // What the download is when the status has not said yet.
    const DEFAULT_MB = 2;
    const MB = 1000000;
    // Short names for the counter ("CLIP 16 · T5 18").
    const SHORT_LABELS = { clip_vit_l_14: 'CLIP', qwen3_0_6b: 'Qwen3', t5_v1_1_xxl: 'T5' };

    const state = {
        status: null,
        statusRequest: null,
        statusTriedFor: '',
        statusError: null,
        preparing: null,
        cache: new Map(),
        counterTimer: null,
        counterRequested: '',
    };

    function changed() {
        window.dispatchEvent(new CustomEvent('captiontokens:changed'));
    }

    /** The base model picked in LoRA setup ('' when none). */
    function targetModel() {
        return window.TargetModel?.current?.() || '';
    }

    /** The tokenizer profile of the chosen base model. */
    function profile() {
        const model = targetModel();
        return PROFILES.includes(model) ? model : DEFAULT_PROFILE;
    }

    /** The status of the chosen model's tokenizers, or null while it has not been read. */
    function currentStatus() {
        return state.status?.profile === profile() ? state.status : null;
    }

    /** The token limit of the chosen base model (the CLIP one when none is chosen). */
    function budget() {
        return window.TargetModel?.tokenBudget?.() || 75;
    }

    function ready() {
        return currentStatus()?.available === true;
    }

    /** The base model's name ("SDXL", "Krea 2", ...); CLIP when none is chosen (it counts as CLIP). */
    function modelLabel() {
        return targetModel() ? (currentStatus()?.model || '') : 'CLIP';
    }

    /** The tokenizers the chosen model counts with, by name ("CLIP ViT-L/14", ...). */
    function tokenizerLabels() {
        const files = currentStatus()?.files;
        return Array.isArray(files) ? files.map((f) => String(f.label || f.id)) : [];
    }

    function sizeMb() {
        const bytes = Number(currentStatus()?.download_bytes);
        return Number.isFinite(bytes) && bytes > 0 ? Math.max(1, Math.round(bytes / MB)) : DEFAULT_MB;
    }

    async function readJson(response) {
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        return JSON.parse(body);
    }

    /** Looks at the chosen model's tokenizer files again. Keeps the last answer when the request fails. */
    function refreshStatus() {
        if (state.statusRequest) return state.statusRequest;
        const asked = profile();
        state.statusTriedFor = asked;
        state.statusRequest = fetch(`${API}/status?profile=${encodeURIComponent(asked)}`)
            .then(readJson)
            .then((status) => {
                state.status = status;
                state.statusError = null;
                return status;
            })
            .catch((error) => {
                state.statusError = error instanceof Error ? error.message : String(error);
                return state.status;
            })
            .finally(() => {
                state.statusRequest = null;
                changed();
                // The model changed while this was out: look again for the new one.
                if (profile() !== asked) void refreshStatus();
            });
        return state.statusRequest;
    }

    /** Starts the one-time download for the chosen model and follows it until it ends. */
    function prepare() {
        if (state.preparing) return state.preparing;
        const asked = profile();
        state.preparing = (async () => {
            try {
                await readJson(await fetch(`${API}/prepare?profile=${encodeURIComponent(asked)}`, { method: 'POST' }));
                for (;;) {
                    const status = await refreshStatus();
                    if (!status || !status.preparing) break;
                    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
                }
            } catch (error) {
                state.statusError = error instanceof Error ? error.message : String(error);
            } finally {
                state.preparing = null;
                await refreshStatus();
            }
            return state.status;
        })();
        changed();
        return state.preparing;
    }

    /**
     * Exact counts of the texts with the chosen model's tokenizers, in the same
     * order: `[{counts: [{label, tokens}], tokens}]` (tokens = the largest count),
     * or null when the tokenizers are not there (no number is guessed).
     */
    async function countExact(texts) {
        const asked = profile();
        const out = [];
        for (let start = 0; start < texts.length; start += CHUNK) {
            const response = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: asked, texts: texts.slice(start, start + CHUNK) }),
            });
            const answer = await readJson(response);
            if (!answer.available || !Array.isArray(answer.counts) || !Array.isArray(answer.metrics)) return null;
            for (const row of answer.counts) out.push(exactRow(answer.metrics, row));
        }
        return out;
    }

    function exactRow(metrics, row) {
        const counts = metrics.map((m) => ({ label: SHORT_LABELS[m.id] || String(m.label || m.id), tokens: Number(row[m.id]) }));
        return { counts, tokens: Math.max(...counts.map((c) => c.tokens)) };
    }

    /** "CLIP 16" or "Qwen3 10 · T5 12": the exact counts of one caption, for a label. */
    function describe(exact) {
        return exact.counts.map((c) => `${c.label} ${c.tokens}`).join(' · ');
    }

    /** The caption of one picture as it exports: tag box and natural-language text composed by its type. */
    function finalCaption(id) {
        const compose = window.CaptionCore?.compose;
        if (typeof compose !== 'function') return String(DM._booruTextFor(id) || '');
        return String(compose(DM._booruTextFor(id), DM._nlTextFor(id), DM._captionTypeFor(id)) || '');
    }

    /**
     * The exact counts of a text when they are known. Otherwise asks for them in the
     * background (once the tokenizers are ready) and announces `captiontokens:changed`
     * when they arrive, so the live counter can redraw.
     */
    function exactFor(text) {
        // One look per model on its own; a failed look is not repeated until something asks again.
        if (!currentStatus() && state.statusTriedFor !== profile()) void refreshStatus();
        if (!ready()) return null;
        const key = `${profile()}\n${text}`;
        const known = state.cache.get(key);
        if (known) return known;
        if (state.counterRequested !== key) {
            state.counterRequested = key;
            if (state.counterTimer) window.clearTimeout(state.counterTimer);
            state.counterTimer = window.setTimeout(async () => {
                state.counterTimer = null;
                try {
                    const counted = await countExact([text]);
                    if (!counted) return;
                    state.cache.set(key, counted[0]);
                    if (state.cache.size > CACHE_LIMIT) state.cache.delete(state.cache.keys().next().value);
                    changed();
                } catch (_) {
                    /* the estimate stays; the audit reports a failed count in words */
                }
            }, COUNTER_DELAY_MS);
        }
        return null;
    }

    DM._captionTokens = Object.freeze({
        profile,
        ready,
        budget,
        sizeMb,
        modelLabel,
        tokenizerLabels,
        describe,
        finalCaption,
        refreshStatus,
        prepare,
        countExact,
        exactFor,
        get status() { return currentStatus(); },
        get statusError() { return state.statusError; },
        get preparing() { return state.preparing !== null || currentStatus()?.preparing === true; },
    });

    function bindTargetModel() {
        document.getElementById('dataset-target-model')?.addEventListener('change', () => {
            void refreshStatus();
            changed();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTargetModel, { once: true });
    else bindTargetModel();
})();
