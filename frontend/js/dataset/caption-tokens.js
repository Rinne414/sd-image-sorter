/**
 * Dataset Maker — exact caption token counts for Anima (Qwen3-0.6B and T5 v1.1 XXL).
 *
 * Backend: GET /api/dataset/caption-tokens/status, POST .../prepare (installs
 * the small `tokenizers` package when it is missing and downloads the two
 * tokenizer files once, about 14 MB, on request) and POST /api/dataset/caption-tokens.
 *
 * Until the files are there every count stays the labelled estimate
 * (SeparationConsole.estimateTokens) and nothing waits on the download. A
 * caption is too long when either exact count is over the budget.
 *
 * Used by the caption editor's token counter and by the "Long captions" check of
 * the Quality Audit.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const API = '/api/dataset/caption-tokens';
    const PROFILE = 'anima';
    const POLL_MS = 1000;
    // Captions asked for per request (the audit counts the whole queue).
    const CHUNK = 400;
    // Exact counts kept for the editor's live counter, newest last.
    const CACHE_LIMIT = 200;
    const COUNTER_DELAY_MS = 250;
    // What the download is when the status has not said yet (about 14 MB).
    const DEFAULT_MB = 14;
    const MB = 1000000;

    const state = {
        status: null,
        statusRequest: null,
        statusTried: false,
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

    function isAnima() {
        return targetModel() === PROFILE;
    }

    /** The token limit of the chosen base model (the CLIP one when none is chosen). */
    function budget() {
        return window.TargetModel?.tokenBudget?.() || 75;
    }

    function ready() {
        return isAnima() && state.status?.available === true;
    }

    function sizeMb() {
        const bytes = Number(state.status?.download_bytes);
        return Number.isFinite(bytes) && bytes > 0 ? Math.max(1, Math.round(bytes / MB)) : DEFAULT_MB;
    }

    async function readJson(response) {
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        return JSON.parse(body);
    }

    /** Looks at the tokenizer files again. Keeps the last answer when the request fails. */
    function refreshStatus() {
        if (state.statusRequest) return state.statusRequest;
        state.statusTried = true;
        state.statusRequest = fetch(`${API}/status`)
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
            });
        return state.statusRequest;
    }

    /** Starts the one-time download and follows it until it ends. Resolves with the last status. */
    function prepare() {
        if (state.preparing) return state.preparing;
        state.preparing = (async () => {
            try {
                await readJson(await fetch(`${API}/prepare`, { method: 'POST' }));
                for (;;) {
                    const status = await refreshStatus();
                    if (!status || !status.preparing) break;
                    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
                }
            } catch (error) {
                state.statusError = error instanceof Error ? error.message : String(error);
            } finally {
                state.preparing = null;
                state.cache.clear();
                await refreshStatus();
            }
            return state.status;
        })();
        changed();
        return state.preparing;
    }

    /**
     * Exact counts of the texts, `[{qwen, t5}]` in the same order, or null when the
     * tokenizers are not there (no number is guessed).
     */
    async function countExact(texts) {
        const out = [];
        for (let start = 0; start < texts.length; start += CHUNK) {
            const response = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: PROFILE, texts: texts.slice(start, start + CHUNK) }),
            });
            const answer = await readJson(response);
            if (!answer.available || !Array.isArray(answer.counts)) return null;
            for (const c of answer.counts) out.push({ qwen: Number(c.qwen3_0_6b), t5: Number(c.t5_v1_1_xxl) });
        }
        return out;
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
        if (!isAnima()) return null;
        // One look on its own; a failed look is not repeated until something asks again.
        if (!state.status && !state.statusTried) void refreshStatus();
        if (!ready()) return null;
        const known = state.cache.get(text);
        if (known) return known;
        if (state.counterRequested !== text) {
            state.counterRequested = text;
            if (state.counterTimer) window.clearTimeout(state.counterTimer);
            state.counterTimer = window.setTimeout(async () => {
                state.counterTimer = null;
                try {
                    const counted = await countExact([text]);
                    if (!counted) return;
                    state.cache.set(text, counted[0]);
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
        isAnima,
        ready,
        budget,
        sizeMb,
        finalCaption,
        refreshStatus,
        prepare,
        countExact,
        exactFor,
        get status() { return state.status; },
        get statusError() { return state.statusError; },
        get preparing() { return state.preparing !== null || state.status?.preparing === true; },
    });

    function bindTargetModel() {
        document.getElementById('dataset-target-model')?.addEventListener('change', () => {
            if (isAnima()) void refreshStatus();
            changed();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTargetModel, { once: true });
    else bindTargetModel();
})();
