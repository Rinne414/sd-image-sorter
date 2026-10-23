'use strict';

/**
 * The global shortcut that brings the window up with the gallery search
 * focused. Text from Settings ("Ctrl+Alt+Space") is turned into Electron's
 * accelerator form; registration failures are reported, never hidden.
 */

const MODIFIERS = new Map([
    ['ctrl', 'Control'], ['control', 'Control'], ['alt', 'Alt'], ['option', 'Alt'],
    ['shift', 'Shift'], ['win', 'Super'], ['super', 'Super'], ['meta', 'Super'], ['cmd', 'Super'],
]);
const NAMED_KEYS = new Map([
    ['space', 'Space'], [' ', 'Space'], ['enter', 'Enter'], ['return', 'Enter'], ['tab', 'Tab'],
    ['backspace', 'Backspace'], ['delete', 'Delete'], ['insert', 'Insert'], ['home', 'Home'], ['end', 'End'],
    ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
    ['arrowup', 'Up'], ['arrowdown', 'Down'], ['arrowleft', 'Left'], ['arrowright', 'Right'],
    ['escape', 'Escape'], ['esc', 'Escape'], ['`', '`'], ['-', '-'], ['=', '='], ['[', '['], [']', ']'],
    [';', ';'], ["'", "'"], [',', ','], ['.', '.'], ['/', '/'], ['\\', '\\'],
]);
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Super'];

function normalizeKey(token) {
    const lower = token.toLowerCase();
    if (NAMED_KEYS.has(lower)) return NAMED_KEYS.get(lower);
    if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(lower)) return lower.toUpperCase();
    if (/^[a-z0-9]$/u.test(lower)) return lower.toUpperCase();
    return null;
}

/**
 * "ctrl + alt + space" -> "Control+Alt+Space". Needs at least one modifier
 * and exactly one key; returns null for anything else.
 */
function toAccelerator(text) {
    const tokens = String(text || '').split('+').map((part) => part.trim()).filter(Boolean);
    if (String(text || '').trim().endsWith('++')) tokens.push('+');
    const modifiers = new Set();
    let key = null;
    for (const token of tokens) {
        const modifier = MODIFIERS.get(token.toLowerCase());
        if (modifier) {
            modifiers.add(modifier);
            continue;
        }
        const normalized = normalizeKey(token);
        if (!normalized || key) return null;
        key = normalized;
    }
    if (!key || modifiers.size === 0) return null;
    return [...MODIFIER_ORDER.filter((name) => modifiers.has(name)), key].join('+');
}

/** Register `accelerator`; returns { ok, accelerator, reason } with reason 'invalid' or 'refused'. */
function registerShortcut(globalShortcut, text, onFire, previous) {
    const accelerator = toAccelerator(text);
    if (previous) globalShortcut.unregister(previous);
    if (!accelerator) return { ok: false, accelerator: null, reason: 'invalid' };
    let ok = false;
    try {
        ok = globalShortcut.register(accelerator, onFire);
    } catch {
        ok = false;
    }
    return ok ? { ok, accelerator, reason: null } : { ok, accelerator, reason: 'refused' };
}

module.exports = { registerShortcut, toAccelerator };
