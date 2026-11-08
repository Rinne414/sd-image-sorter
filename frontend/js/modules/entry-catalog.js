/**
 * Function catalog — the "what can this app actually do?" listing.
 *
 * Owner FB (2026-07-07): 自由模式 and 全部工具 were the same thing; one of
 * them becomes a catalog that lists EVERY function with a one-line usage so
 * features buried in sub-tabs (隐私处理 lives inside the Reader) are finally
 * discoverable from the main page.
 *
 * Rows are built with DOM APIs (no innerHTML) and re-built on every open so
 * they always render in the current language.
 */
(function () {
    'use strict';

    function t(key, fallback) {
        const value = window.I18n && window.I18n.t ? window.I18n.t(key) : null;
        return (value && value !== key) ? value : (fallback || key);
    }

    function goView(view) {
        if (window.EntryPage && typeof window.EntryPage.hide === 'function') window.EntryPage.hide();
        const tab = document.getElementById(`nav-tab-${view}`);
        if (tab) tab.click();
    }

    /** Click a lazily-bound control, retrying a few frames while it wires up. */
    function clickWhenReady(id, attempts) {
        const node = document.getElementById(id);
        if (node) {
            node.click();
            return;
        }
        if (attempts > 0) {
            window.requestAnimationFrame(() => clickWhenReady(id, attempts - 1));
        }
    }

    function openReaderTool(tool) {
        goView('reader');
        window.requestAnimationFrame(() => clickWhenReady(`reader-tool-tab-${tool}`, 10));
    }

    function openSettingsTab(tabName) {
        const opener = document.getElementById('btn-open-model-manager');
        if (opener) opener.click();
        window.requestAnimationFrame(() => {
            if (window.SettingsTabs && typeof window.SettingsTabs.activate === 'function') {
                window.SettingsTabs.activate(tabName);
            }
        });
    }

    function enterMission(missionKey, entryTileId) {
        // Entry mission tiles already carry the full behavior (mission mode +
        // landing view + any follow-up click); proxy through them.
        const tile = document.getElementById(entryTileId);
        if (tile) {
            tile.click();
            return;
        }
        if (window.NavMissions) window.NavMissions.enter(missionKey);
    }

    // Names reuse the nav/entry keys the tabs and tiles already translate
    // with; only the usage lines are catalog-specific.
    const GROUPS = [
        {
            titleKey: 'catalog.groupCore', titleFallback: 'Core views',
            items: [
                { icon: '#i-image', nameKey: 'nav.gallery', name: 'Gallery', descKey: 'catalog.gallery', desc: 'Browse, filter, pick, and batch-process every indexed image', run: () => goView('gallery') },
                { icon: '#i-book', nameKey: 'nav.reader', name: 'Reader', descKey: 'catalog.reader', desc: 'Drop an image to read its prompt, model, and generation parameters', run: () => goView('reader') },
                { icon: '#i-folders', nameKey: 'nav.sorting', name: 'Organize', descKey: 'catalog.sorting', desc: 'Auto-separate by filters, then hand-sort a batch with WASD keys', run: () => goView('sorting') },
                { icon: '#i-grid', nameKey: 'nav.censor', name: 'Censor Edit', descKey: 'catalog.censor', desc: 'Brush/pen censoring, AI detection, review conveyor, safe export', run: () => goView('censor') },
                { icon: '#i-search', nameKey: 'nav.similar', name: 'Find Similar', descKey: 'catalog.similar', desc: 'Search by image, text, or upload; find near-duplicates. Needs CLIP via Prepare.', run: () => goView('similar') },
                { icon: '#i-package', nameKey: 'nav.dataset', name: 'Dataset', descKey: 'catalog.dataset', desc: 'Build a LoRA training set: captions, Smart Tag, and paired image + .txt export', run: () => goView('dataset') },
            ],
        },
        {
            titleKey: 'catalog.groupPipelines', titleFallback: 'Pipelines',
            items: [
                { icon: '#i-target', nameKey: 'entry.missionLoraTitle', name: 'LoRA Dataset', descKey: 'catalog.lora', desc: 'Pick, tag and caption, then export a kohya-ready training set', run: () => enterMission('lora', 'entry-mission-lora') },
                { icon: '#i-upload', nameKey: 'entry.missionPixivTitle', name: 'Pixiv Set Publishing', descKey: 'catalog.pixiv', desc: 'Pick, censor and rename, then export a ready-to-post set', run: () => enterMission('pixiv', 'entry-mission-pixiv') },
                { icon: '#i-folders', nameKey: 'entry.missionOrganizeTitle', name: 'Batch Organize', descKey: 'catalog.organize', desc: 'Move a mountain of images into clean folders, with undo', run: () => enterMission('organize', 'entry-mission-organize') },
            ],
        },
        {
            titleKey: 'catalog.groupTools', titleFallback: 'Tools',
            items: [
                { icon: '#i-shield', nameKey: 'tools.obfuscation', name: 'Privacy Tools', descKey: 'catalog.obfuscation', desc: 'Obfuscate images for upload sites and restore them back (inside Reader)', run: () => openReaderTool('obfuscation') },
                { icon: '#i-broom', nameKey: 'dup.navTitle', name: 'Duplicate Cleanup', descKey: 'catalog.dup', desc: 'Scan the whole library for duplicates and clean them in one pass', run: () => { goView('gallery'); window.requestAnimationFrame(() => clickWhenReady('nav-tools-dup-cleaner', 10)); } },
                { icon: '#i-folders', nameKey: 'libraryRoots.watch', name: 'Watch for new pictures', descKey: 'catalog.watch', desc: 'Watch your ComfyUI or WebUI output folder: new pictures join the gallery by themselves, no Scan', run: () => { goView('gallery'); window.LibraryRootsUI?.open?.(); } },
                { icon: '#i-refresh', nameKey: 'sendGen.title', name: 'Send to generator', descKey: 'catalog.sendToGenerator', desc: 'Reuse the recipe of a picture: copy WebUI or NovelAI text, copy or save the ComfyUI workflow, or run it again in ComfyUI', run: () => { goView('gallery'); window.App?.showToast?.(t('sendGen.catalogHint', 'Open a picture and press Generator, or right-click a picture'), 'info'); } },
                { icon: '#i-download', nameKey: 'ext.settingsTitle', name: 'Browser extension', descKey: 'catalog.browserExtension', desc: 'Right-click a picture on any web page to save it here with the page it came from', run: () => { openSettingsTab('general'); window.requestAnimationFrame(() => { const panel = document.getElementById('settings-browser-ext'); if (panel) { panel.open = true; panel.scrollIntoView({ block: 'nearest' }); } }); } },
                { icon: '#i-clipboard', nameKey: 'collect.pasteButton', name: 'Paste picture', descKey: 'catalog.collectPaste', desc: 'Paste a picture or a picture address (Ctrl+V in the gallery) to save it into collected/<date>', run: () => { goView('gallery'); document.getElementById('btn-scan')?.click(); window.requestAnimationFrame(() => document.getElementById('btn-paste-picture')?.focus()); } },
                { icon: '#i-download', nameKey: 'quickCollect.title', name: 'Quick collect', descKey: 'catalog.quickCollect', desc: 'A small window that takes dropped or pasted pictures: a copy goes to output/collected and into the gallery', run: () => window.DesktopBridge?.openQuickCollect?.() },
                { icon: '#i-image', nameKey: 'video.catalogName', name: 'Videos in the library', descKey: 'catalog.videos', desc: 'Videos in your folders join the gallery: hover a card to play it, open it to read its prompt; Videos filter; video support (ffmpeg) installs from here', run: () => { openSettingsTab('general'); window.requestAnimationFrame(() => document.getElementById('settings-video-support')?.scrollIntoView({ block: 'nearest' })); } },
                { icon: '#i-wand', nameKey: 'nav.reverse', name: 'Reverse Prompt', descKey: 'catalog.reverse', desc: 'Drop one image. If the file stored a prompt, that record is shown first; you can still infer from pixels to compare.', run: () => goView('reverse') },
                { icon: '#i-flask', nameKey: 'nav.promptlab', name: 'Prompt Helper', descKey: 'catalog.promptlab', desc: 'Build prompts from your library: weights, templates, negatives', run: () => goView('promptlab') },
                { icon: '#i-brush', nameKey: 'nav.artist', name: 'Style Finder', descKey: 'catalog.artist', desc: 'Identify artists with a similar style', run: () => goView('artist') },
                { icon: '#i-compass', nameKey: 'nav.stylemap', name: 'Style Map', descKey: 'catalog.stylemap', desc: 'Your library as a 3-D cloud where pictures drawn alike sit together. Build the style index first.', run: () => goView('stylemap') },
                { icon: '#i-monitor', nameKey: 'settings.backgroundTitle', name: 'Background', descKey: 'catalog.background', desc: 'See which AI models are loaded and free them; unused ones are freed by themselves after a while', run: () => { openSettingsTab('general'); window.requestAnimationFrame(() => document.getElementById('settings-background-row')?.scrollIntoView({ block: 'nearest' })); } },
                { icon: '#i-monitor', nameKey: 'network.proxy.title', name: 'Network proxy', descKey: 'catalog.networkProxy', desc: 'Enter a proxy port once for model downloads, package installs and update checks', run: () => { openSettingsTab('models'); window.requestAnimationFrame(() => { window.ModelNetworkSettings?.reveal(); document.getElementById('network-proxy-section')?.scrollIntoView({ block: 'nearest' }); }); } },
                { icon: '#i-package', nameKey: 'entry.tileModels', name: 'Model Center', descKey: 'catalog.models', desc: 'Download and manage the AI models used by tagging, similarity, artist, censor, and captions', run: () => openSettingsTab('models') },
                { icon: '#i-layers', nameKey: 'catalog.vopusName', name: 'Vopus interface', descKey: 'catalog.vopus', desc: 'A second interface on the same library; the one you pick opens at every start (its Settings switches back)', run: () => window.InterfaceSwitch?.useVopus() },
                { icon: '#i-arrow-up', nameKey: 'update.check', name: 'Check Updates', descKey: 'catalog.update', desc: 'See whether a new version is out; nothing changes until you press Install Update', run: () => document.getElementById('btn-app-update')?.click() },
                { icon: '#i-settings', nameKey: 'settings.tabGeneral', name: 'Settings', descKey: 'catalog.settings', desc: 'Sound, entry page, UI scale, language, disk cache, updates', run: () => openSettingsTab('general') },
            ],
        },
    ];

    function buildRow(item) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'catalog-item';

        const icon = document.createElement('span');
        icon.className = 'catalog-icon';
        icon.setAttribute('aria-hidden', 'true');
        if (String(item.icon || '').startsWith('#i-')) {
            // Graphite entries name a sprite symbol. The legacy emoji rows below
            // still take the textContent path and are retired separately.
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'icon');
            svg.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', item.icon);
            svg.appendChild(use);
            icon.appendChild(svg);
        } else {
            icon.textContent = item.icon;
        }

        const copy = document.createElement('span');
        copy.className = 'catalog-copy';
        const name = document.createElement('span');
        name.className = 'catalog-name';
        name.textContent = t(item.nameKey, item.name);
        const desc = document.createElement('span');
        desc.className = 'catalog-desc';
        desc.textContent = t(item.descKey, item.desc);
        copy.appendChild(name);
        copy.appendChild(desc);

        const arrow = document.createElement('span');
        arrow.className = 'catalog-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';

        row.appendChild(icon);
        row.appendChild(copy);
        row.appendChild(arrow);
        row.addEventListener('click', () => {
            close();
            item.run();
        });
        return row;
    }

    function render() {
        const body = document.getElementById('entry-catalog-body');
        if (!body) return;
        body.textContent = '';
        GROUPS.forEach((group) => {
            const heading = document.createElement('div');
            heading.className = 'catalog-group-title';
            heading.textContent = t(group.titleKey, group.titleFallback);
            body.appendChild(heading);
            const list = document.createElement('div');
            list.className = 'catalog-group';
            group.items.forEach((item) => list.appendChild(buildRow(item)));
            body.appendChild(list);
        });
    }

    function open() {
        const modal = document.getElementById('entry-catalog-modal');
        if (!modal) return;
        render();
        if (typeof window.App?.showModal === 'function') {
            window.App.showModal('entry-catalog-modal', { onEscape: close });
        } else {
            modal.classList.add('visible');
        }
    }

    function close() {
        if (typeof window.App?.hideModal === 'function') {
            window.App.hideModal('entry-catalog-modal');
            return;
        }
        const modal = document.getElementById('entry-catalog-modal');
        if (modal) modal.classList.remove('visible');
    }

    function wire() {
        const modal = document.getElementById('entry-catalog-modal');
        if (!modal) return;
        const closeButton = document.getElementById('entry-catalog-close');
        if (closeButton) closeButton.addEventListener('click', close);
        const backdrop = modal.querySelector('.modal-backdrop');
        if (backdrop) backdrop.addEventListener('click', close);
    }

    function isTypingTarget(target) {
        return target instanceof Element
            && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    }

    /**
     * Ctrl K (Cmd K on a Mac) opens the catalog from anywhere, and closes it
     * again. It is the one browser key the program takes. It stays out of the
     * way while typing in a field, with other modifiers held, while another
     * dialog is open, and while an input method is composing text.
     */
    function onShortcut(event) {
        if (event.key !== 'k' && event.key !== 'K') return;
        if (event.ctrlKey === event.metaKey || event.altKey || event.shiftKey) return;
        if (event.repeat || event.isComposing || event.defaultPrevented) return;
        if (isTypingTarget(event.target)) return;
        const catalog = document.getElementById('entry-catalog-modal');
        if (!catalog) return;
        const isOpen = catalog.classList.contains('visible');
        if (!isOpen && document.querySelector('.modal.visible')) return;
        event.preventDefault();
        if (isOpen) close(); else open();
    }

    document.addEventListener('keydown', onShortcut);

    function wireButton() {
        const button = document.getElementById('btn-all-features');
        if (button) button.addEventListener('click', open);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireButton);
    } else {
        wireButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }

    window.EntryCatalog = { open, close, openSettingsTab, openReaderTool };
})();
