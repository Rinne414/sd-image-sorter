/**
 * The "Build style index" job: POST /api/style-map/vectors/start scoped to
 * the current Gallery filter token, polled through /vectors/progress while
 * it runs, with pause / resume / cancel. The running -> idle transition
 * shows a clear "Done" state (toast + the progress row) for a few seconds,
 * as docs/DESIGN.md §progress-toast asks.
 */
import { t, formatError } from './text.js';

const POLL_MS = 1000;
const DONE_VISIBLE_MS = 5000;

function api() {
    return window.App?.API || null;
}

function toast(message, level) {
    const show = window.App?.showToast;
    if (typeof show === 'function') show(message, level);
}

export class IndexJob {
    constructor({ getSpace, getToken, getModelSettings, onChange, onDone }) {
        this.getSpace = getSpace;
        this.getToken = getToken;
        this.getModelSettings = typeof getModelSettings === 'function' ? getModelSettings : () => ({});
        this.onChange = typeof onChange === 'function' ? onChange : () => {};
        this.onDone = typeof onDone === 'function' ? onDone : () => {};
        this.state = {
            running: false,
            paused: false,
            processed: 0,
            total: 0,
            written: 0,
            errors: 0,
            message: '',
            startedAt: null,
            done: null,
        };
        this.wasRunning = false;
        this.timer = null;
        this.doneTimer = null;
        // Polling runs only while the page is open: stopPolling() lowers this
        // and a poll that was mid-flight when the user left must not reschedule.
        this.active = false;
    }

    isRunning() {
        return this.state.running;
    }

    estimateRemainingMs() {
        const { processed, total, startedAt } = this.state;
        if (!startedAt || processed <= 0 || total <= processed) return null;
        const elapsed = Date.now() - startedAt;
        if (elapsed < 2000) return null;
        return (elapsed / processed) * (total - processed);
    }

    async start() {
        if (this.state.running) {
            toast(t('stylemap.indexBusy', 'A style index job is already running.'), 'info');
            return;
        }
        // The Style Finder's model settings ride along: the index runs the
        // weights the user identifies with, never the official ones over them.
        // "Local" with no file named is refused there too: nothing is sent.
        let settings;
        try {
            settings = this.getModelSettings();
        } catch (_error) {
            toast(t('stylemap.indexNeedsLocalPath', 'The Style Finder page is set to a local model but names no file. Fill in the path there, then build the style index.'), 'error');
            return;
        }
        const body = { space: this.getSpace(), ...settings };
        const token = this.getToken();
        if (token) body.selection_token = token;
        // The page is open when the button is clicked; leaving it while the
        // start request is in flight lowers the flag, and the poll below
        // must not bring it back.
        this.active = true;
        try {
            const result = await api().post('/api/style-map/vectors/start', body);
            if (result?.status === 'idle') {
                toast(t('stylemap.indexNothing', 'Every picture in the filter already has style data.'), 'info');
                return;
            }
            this.wasRunning = true;
            this.state.startedAt = Date.now();
            if (!this.active) return; // left the page; probe() picks the job up on return
            await this.poll();
        } catch (error) {
            toast(formatError(error), 'error');
        }
    }

    /** Pick up a job that was already running (page re-entered). */
    async probe() {
        this.clearTimer();
        this.active = true;
        await this.poll();
    }

    stopPolling() {
        this.active = false;
        this.clearTimer();
    }

    clearTimer() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    async poll() {
        this.clearTimer();
        try {
            await this.tick();
        } catch (_error) {
            // a failed poll just tries again
        }
        if (this.active && this.state.running) this.timer = setTimeout(() => this.poll(), POLL_MS);
    }

    async tick() {
        const p = await api().get('/api/style-map/vectors/progress');
        const running = Boolean(p?.running);
        Object.assign(this.state, {
            running,
            paused: Boolean(p?.paused),
            processed: Number(p?.processed || 0),
            total: Number(p?.total || 0),
            written: Number(p?.written || 0),
            errors: Number(p?.errors || 0),
            message: String(p?.message || ''),
        });
        if (running && !this.state.startedAt) {
            this.state.startedAt = p?.started_at ? Number(p.started_at) * 1000 : Date.now();
        }
        if (this.wasRunning && !running) {
            this.finish();
        } else if (running) {
            this.wasRunning = true;
        }
        this.onChange(this);
    }

    finish() {
        this.wasRunning = false;
        const { written, errors } = this.state;
        this.state.done = { written, errors, at: Date.now() };
        this.state.startedAt = null;
        const message = errors > 0
            ? t('stylemap.indexDoneErrors', 'Done: {n} pictures added, {errors} failed', { n: written, errors })
            : t('stylemap.indexDone', 'Done: {n} pictures added', { n: written });
        toast(message, errors > 0 ? 'warning' : 'success');
        if (this.doneTimer) clearTimeout(this.doneTimer);
        this.doneTimer = setTimeout(() => {
            this.state.done = null;
            this.onChange(this);
        }, DONE_VISIBLE_MS);
        this.onDone();
    }

    async pause() {
        await this.control('pause');
    }

    async resume() {
        await this.control('resume');
    }

    async cancel() {
        await this.control('cancel');
    }

    async control(action) {
        try {
            await api().post(`/api/style-map/vectors/${action}`, {});
            await this.poll();
        } catch (error) {
            toast(formatError(error), 'error');
        }
    }
}
