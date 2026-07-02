function readStoredBoolean(storageKey, fallback = false) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (raw == null) return fallback;
        return raw === '1' || raw === 'true';
    } catch (error) {
        return fallback;
    }
}

function writeStoredBoolean(storageKey, value) {
    try {
        localStorage.setItem(storageKey, value ? '1' : '0');
    } catch (error) {
        // Ignore localStorage failures.
    }
}

function readStoredJson(storageKey, fallback = null) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
        return fallback;
    }
}

function writeStoredJson(storageKey, value) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(value));
        return true;
    } catch (error) {
        return false;
    }
}

function removeStoredKey(storageKey) {
    try {
        localStorage.removeItem(storageKey);
    } catch (error) {
        // Ignore localStorage failures.
    }
}

