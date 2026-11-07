/**
 * app/update-auto-check.js — the automatic update check of the classic interface.
 *
 * Once after start, at most once a day, in the background. It only reminds: a
 * quiet note and the update button changing to "Update x.y.z". It never opens
 * the update popup over the user's work and never installs anything; that
 * waits for the user to press Update. A failed check says nothing and is tried
 * again at the next start. The switch lives in Settings > About and is on by
 * default; "Reset all settings" turns it back on.
 *
 * Classic script: shares the global scope with update-popup.js (AppState, API,
 * showToast, appT, setUpdateButtonState, handleAppUpdateButtonClick).
 */
const AUTO_UPDATE_CHECK_KEY = 'sd-image-sorter-update-autocheck'; // "0" = switched off
const AUTO_UPDATE_CHECKED_AT_KEY = 'sd-image-sorter-update-checked-at';
const AUTO_UPDATE_REMINDED_KEY = 'sd-image-sorter-update-reminded';
const AUTO_UPDATE_DELAY_MS = 30 * 1000;
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readAutoUpdateStore(key) {
    try {
        return localStorage.getItem(key);
    } catch (_error) {
        return null;
    }
}

function isAutoUpdateCheckEnabled() {
    return readAutoUpdateStore(AUTO_UPDATE_CHECK_KEY) !== '0';
}

function setAutoUpdateCheckEnabled(enabled) {
    try {
        if (enabled) localStorage.removeItem(AUTO_UPDATE_CHECK_KEY);
        else localStorage.setItem(AUTO_UPDATE_CHECK_KEY, '0');
    } catch (_error) {
        // Storage blocked: the choice lasts until the page closes.
    }
}

function isAutoUpdateCheckDue() {
    const checkedAt = Number(readAutoUpdateStore(AUTO_UPDATE_CHECKED_AT_KEY));
    if (!Number.isFinite(checkedAt) || checkedAt <= 0) return true;
    const elapsed = Date.now() - checkedAt;
    // A clock set back counts as due rather than waiting for it to catch up.
    return elapsed < 0 || elapsed >= AUTO_UPDATE_INTERVAL_MS;
}

function remindAboutUpdate(status) {
    AppState.update.status = status;
    setUpdateButtonState(status, false);
    const version = status.latest_version || '';
    if (readAutoUpdateStore(AUTO_UPDATE_REMINDED_KEY) === version) return;
    try {
        localStorage.setItem(AUTO_UPDATE_REMINDED_KEY, version);
    } catch (_error) {
        // Storage blocked: the note may show again next start.
    }
    const buttons = getUpdateActionButtons();
    const anchor = buttons.find((button) => button.offsetParent !== null) || buttons[0];
    showToast(
        appT('update.autoFound', 'Version {version} is available. Nothing changes until you press Update.', { version }),
        'info',
        {
            duration: 12000,
            actionLabel: appT('update.autoView', 'View'),
            onAction: () => { if (anchor) void handleAppUpdateButtonClick({ currentTarget: anchor }); },
        }
    );
}

async function runAutomaticUpdateCheck() {
    if (!isAutoUpdateCheckEnabled() || !isAutoUpdateCheckDue()) return;
    if (AppState.update.checking) return;
    try {
        const status = await API.getUpdateStatus(false);
        // The channel answered with an error or could not be reached: say
        // nothing, and do not count it as today's check.
        if (!status || status.error) return;
        try {
            localStorage.setItem(AUTO_UPDATE_CHECKED_AT_KEY, String(Date.now()));
        } catch (_error) {
            // Storage blocked: it checks again at the next start.
        }
        if (status.has_update) remindAboutUpdate(status);
    } catch (_error) {
        // Silent by design.
    }
}

function scheduleAutomaticUpdateCheck() {
    window.setTimeout(() => { void runAutomaticUpdateCheck(); }, AUTO_UPDATE_DELAY_MS);
}

if (document.readyState === 'complete') scheduleAutomaticUpdateCheck();
else window.addEventListener('load', scheduleAutomaticUpdateCheck);
