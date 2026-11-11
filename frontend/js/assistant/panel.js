/**
 * The assistant's panel: a chat on the right side of the window.
 *
 * The user says what they want; the assistant looks things up, puts results on
 * screen, and asks before it changes anything (a card with Confirm / Don't).
 * The conversation is kept in this browser, so it is still there after a
 * reload. Nothing is sent anywhere until a model service is set up, and the
 * setup says what will be sent.
 */
(function initAssistantPanel(global) {
    'use strict';

    const STORAGE_KEY = 'sd-assistant-conversation';
    const OPEN_KEY = 'sd-assistant-open';
    const KEPT_ITEMS = 200;
    const KEPT_MESSAGES = 80;
    const STORED_RESULT_CHARS = 3000;

    const t = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const client = () => global.AssistantClient;

    /** What is drawn (items) and what the model is sent (messages). */
    const conversation = { items: [], messages: [] };
    let active = null;      // the run in progress
    let settings = null;    // last settings read from the server
    let panel = null;
    let showingSetup = false;

    const TOOL_LABELS = {
        search_images: ['assistant.tool.search', 'Search the library'],
        count_images: ['assistant.tool.count', 'Count pictures'],
        get_image: ['assistant.tool.getImage', 'Read the details of a picture'],
        find_by_description: ['assistant.tool.describe', 'Find pictures by description'],
        list_library: ['assistant.tool.listLibrary', 'Look up tags and models'],
        library_stats: ['assistant.tool.stats', 'Read the library totals'],
        list_collections: ['assistant.tool.collections', 'Read your collections'],
        get_current_view: ['assistant.tool.view', 'Look at what is on screen'],
        show_in_gallery: ['assistant.tool.show', 'Show the result in the Gallery'],
        select_images: ['assistant.tool.select', 'Select pictures in the Gallery'],
        open_image: ['assistant.tool.openImage', 'Open a picture'],
        open_page: ['assistant.tool.openPage', 'Open a page'],
        add_tags: ['assistant.tool.addTags', 'Add tags'],
        remove_tags: ['assistant.tool.removeTags', 'Remove tags'],
        set_rating: ['assistant.tool.rate', 'Set stars'],
        add_to_collection: ['assistant.tool.collect', 'Add to a collection'],
    };

    // -- storage ---------------------------------------------------------

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                items: conversation.items.slice(-KEPT_ITEMS),
                messages: conversation.messages.slice(-KEPT_MESSAGES).map((message) => (
                    message.role === 'tool' && String(message.content || '').length > STORED_RESULT_CHARS
                        ? { ...message, content: `${String(message.content).slice(0, STORED_RESULT_CHARS)}\n[cut when saved]` }
                        : message
                )),
            }));
        } catch (_error) { /* storage can be blocked: the chat then lasts for this page */ }
    }

    function restore() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved) return;
            conversation.items = (saved.items || []).map((item) => (
                // A confirmation or a step that was waiting when the page closed is over.
                item.kind === 'confirm' && item.state === 'waiting' ? { ...item, state: 'declined' }
                    : item.kind === 'tool' && item.state === 'running' ? { ...item, state: 'failed' } : item
            ));
            conversation.messages = saved.messages || [];
        } catch (_error) { /* a damaged value is ignored */ }
    }

    // -- drawing ---------------------------------------------------------

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = (name) => global.UiIcon?.html?.(name) || '';

    /** The model's text: paragraphs, line breaks, **bold** and `code`; nothing else is markup. */
    function renderText(node, text) {
        node.textContent = '';
        String(text || '').split(/\n{2,}/).forEach((block) => {
            const paragraph = el('p');
            block.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\n)/).forEach((piece) => {
                if (!piece) return;
                if (piece === '\n') paragraph.appendChild(document.createElement('br'));
                else if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) paragraph.appendChild(el('strong', '', piece.slice(2, -2)));
                else if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) paragraph.appendChild(el('code', '', piece.slice(1, -1)));
                else paragraph.appendChild(document.createTextNode(piece));
            });
            node.appendChild(paragraph);
        });
    }

    function confirmText(summary) {
        const n = Number(summary.pictures || 0);
        const tags = (summary.tags || []).join(', ');
        if (summary.action === 'add_tags') return t('assistant.confirm.addTags', 'Add to {n} pictures the tags: {tags}', { n, tags });
        if (summary.action === 'remove_tags') return t('assistant.confirm.removeTags', 'Remove from {n} pictures the tags: {tags}', { n, tags });
        if (summary.action === 'set_rating') {
            return Number(summary.stars) > 0
                ? t('assistant.confirm.rate', 'Give {n} pictures {stars} of 5 stars', { n, stars: summary.stars })
                : t('assistant.confirm.clearRating', 'Clear the stars of {n} pictures', { n });
        }
        if (summary.action === 'add_to_collection') {
            return summary.new
                ? t('assistant.confirm.collectNew', 'Make the collection "{name}" and put {n} pictures in it', { n, name: summary.collection })
                : t('assistant.confirm.collect', 'Put {n} pictures in the collection "{name}"', { n, name: summary.collection });
        }
        return summary.action || '';
    }

    function drawItem(item) {
        if (item.kind === 'user') return el('div', 'assistant-msg assistant-msg-user', item.text);
        if (item.kind === 'assistant') {
            const node = el('div', `assistant-msg assistant-msg-reply${item.open ? ' is-open' : ''}`);
            renderText(node, item.text);
            return node;
        }
        if (item.kind === 'tool') {
            const [key, fallback] = TOOL_LABELS[item.name] || ['', item.name];
            const node = el('div', `assistant-step is-${item.state}`);
            node.innerHTML = `<span class="assistant-step-mark" aria-hidden="true">${item.state === 'done' ? icon('i-check') : item.state === 'failed' ? icon('i-alert') : ''}</span>`;
            node.appendChild(el('span', '', key ? t(key, fallback) : fallback));
            return node;
        }
        if (item.kind === 'confirm') {
            const node = el('div', `assistant-confirm is-${item.state}`);
            node.appendChild(el('p', 'assistant-confirm-text', confirmText(item.summary)));
            if (item.state === 'waiting') {
                const row = el('div', 'assistant-confirm-actions');
                const yes = el('button', 'btn btn-primary', t('assistant.confirm.yes', 'Confirm'));
                const no = el('button', 'btn btn-secondary', t('assistant.confirm.no', "Don't"));
                yes.type = 'button';
                no.type = 'button';
                yes.dataset.assistantConfirm = 'yes';
                no.dataset.assistantConfirm = 'no';
                yes.addEventListener('click', () => answer(item, true));
                no.addEventListener('click', () => answer(item, false));
                row.append(yes, no);
                node.appendChild(row);
            } else {
                const status = item.state === 'approved'
                    ? t('assistant.confirm.approved', 'Confirmed')
                    : t('assistant.confirm.declined', 'Not done');
                node.appendChild(el('p', 'assistant-confirm-status', status));
            }
            return node;
        }
        return el('div', `assistant-note is-${item.tone || 'info'}`, item.text);
    }

    function draw() {
        if (!panel) return;
        const list = panel.querySelector('.assistant-messages');
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        list.textContent = '';
        if (!conversation.items.length) list.appendChild(drawWelcome());
        conversation.items.forEach((item) => list.appendChild(drawItem(item)));
        if (active) list.appendChild(el('div', 'assistant-working', t('assistant.working', 'Working...')));
        if (nearBottom) list.scrollTop = list.scrollHeight;
        const send = panel.querySelector('#assistant-send');
        send.textContent = active ? t('assistant.stop', 'Stop') : t('assistant.send', 'Send');
        send.classList.toggle('btn-primary', !active);
        send.classList.toggle('btn-secondary', Boolean(active));
        panel.querySelector('#assistant-new-chat').disabled = Boolean(active) || !conversation.items.length;
    }

    function drawWelcome() {
        const box = el('div', 'assistant-welcome');
        box.appendChild(el('p', 'assistant-welcome-title', t('assistant.welcome.title', 'Tell me what you want to do')));
        const access = settings?.access || 'ask';
        const welcome = access === 'read_only'
            ? t('assistant.welcome.readOnly', 'I can find pictures and show them in the Gallery. I am set to change nothing, and I never move or delete files.')
            : access === 'auto'
                ? t('assistant.welcome.auto', 'I can find pictures, show them in the Gallery, tag and rate them, and put them into collections. I am set to do that without asking first. I never move or delete files.')
                : t('assistant.welcome.text', 'I can find pictures, show them in the Gallery, tag and rate them, and put them into collections. I ask before I change anything, and I never move or delete files.');
        box.appendChild(el('p', 'assistant-welcome-text', welcome));
        const examples = [
            ['assistant.example.untagged', 'Show me the pictures that have no tags yet'],
            ['assistant.example.best', 'Put my 5-star pictures into a collection called Best'],
            ['assistant.example.model', 'Which models did I use the most?'],
            ['assistant.example.dataset', 'I want to make a LoRA dataset. Where do I start?'],
        ];
        const row = el('div', 'assistant-examples');
        examples.forEach(([key, fallback]) => {
            const button = el('button', 'assistant-example', t(key, fallback));
            button.type = 'button';
            button.addEventListener('click', () => send(button.textContent));
            row.appendChild(button);
        });
        box.appendChild(row);
        return box;
    }

    // -- a run -----------------------------------------------------------

    function note(text, tone) {
        conversation.items.push({ kind: 'note', text, tone: tone || 'info' });
    }

    function onEvent(event) {
        const items = conversation.items;
        const last = items[items.length - 1];
        if (event.type === 'text') {
            if (last?.kind === 'assistant' && last.open) {
                last.text += event.delta;
                // Only the reply being written is redrawn: the rest of the conversation stays still.
                const node = panel.querySelector('.assistant-msg-reply.is-open');
                if (node) {
                    const list = panel.querySelector('.assistant-messages');
                    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
                    renderText(node, last.text);
                    if (nearBottom) list.scrollTop = list.scrollHeight;
                    return;
                }
            } else items.push({ kind: 'assistant', text: event.delta, open: true });
        } else if (event.type === 'text_end') {
            if (last?.kind === 'assistant') last.open = false;
        } else if (event.type === 'tool') {
            if (last?.kind === 'assistant') last.open = false;
            items.push({ kind: 'tool', name: event.name, id: event.id, state: 'running' });
        } else if (event.type === 'tool_end') {
            // The newest one: some model servers reuse call ids from turn to turn.
            const step = items.findLast((item) => item.kind === 'tool' && item.id === event.id && item.state === 'running');
            if (step) step.state = event.ok ? 'done' : 'failed';
        } else if (event.type === 'confirm') {
            items.push({ kind: 'confirm', id: event.id, summary: event.summary, state: 'waiting' });
        } else if (event.type === 'confirm_closed') {
            const card = items.findLast((item) => item.kind === 'confirm' && item.id === event.id);
            if (card) card.state = event.approved ? 'approved' : 'declined';
        } else if (event.type === 'changed') {
            global.loadImages?.();
            global.App?.loadStats?.();
            const result = event.result || {};
            if (result.stopped_early) {
                note(t('assistant.partial', 'Done for {done} of {total} pictures, then it stopped: {reason}', {
                    done: result.pictures_done ?? 0, total: result.pictures_asked ?? 0, reason: result.stopped_early,
                }), 'error');
            }
        } else if (event.type === 'empty') {
            note(event.reason === 'length'
                ? t('assistant.emptyLength', 'The model stopped before it wrote anything (it ran out of room). Try a shorter question or start a new conversation.')
                : t('assistant.empty', 'The model sent an empty reply. Ask again, or try another model.'));
        } else if (event.type === 'lost') {
            note(t('assistant.lost', 'The program restarted, so this reply was lost. Send your message again.'), 'error');
        } else if (event.type === 'limit') {
            note(t('assistant.limit', 'I stopped after {n} steps. Say "continue" if I should go on.', { n: event.rounds }));
        }
        draw();
    }

    function answer(item, approved) {
        if (!active || item.state !== 'waiting') return;
        item.state = approved ? 'approved' : 'declined';
        draw();
        active.answer(item.id, approved).catch(() => {});
    }

    async function send(text) {
        const message = String(text || '').trim();
        if (!message || active) return;
        // The panel was just opened and has not read its settings yet.
        if (!settings) await readSettings();
        if (!settings?.ready) {
            openSetup();
            return;
        }
        conversation.items.push({ kind: 'user', text: message });
        conversation.messages.push({ role: 'user', content: message });
        const input = panel.querySelector('#assistant-input');
        input.value = '';
        active = client().run(conversation.messages, onEvent);
        draw();
        let end;
        try {
            end = await active.done;
        } catch (error) {
            end = { type: 'error', message: error?.message || String(error), messages: [] };
        }
        conversation.messages.push(...(end.messages || []));
        conversation.items.forEach((item) => {
            if (item.kind === 'assistant') item.open = false;
            if (item.kind === 'tool' && item.state === 'running') item.state = 'failed';
            if (item.kind === 'confirm' && item.state === 'waiting') item.state = 'declined';
        });
        if (end.type === 'stopped') note(t('assistant.stopped', 'Stopped.'));
        if (end.type === 'error') note(end.message || t('assistant.failed', 'The assistant could not finish.'), 'error');
        active = null;
        persist();
        draw();
        input.focus();
    }

    function newChat() {
        if (active) return;
        conversation.items = [];
        conversation.messages = [];
        persist();
        draw();
    }

    // -- setup -----------------------------------------------------------

    async function readSettings() {
        try {
            settings = await client().settings();
        } catch (_error) {
            settings = { ready: false };
        }
        const chip = panel?.querySelector('.assistant-model');
        if (chip) {
            chip.textContent = settings.using?.model || t('assistant.noModel', 'Not set up');
            chip.title = settings.using ? `${settings.using.endpoint}` : '';
        }
        return settings;
    }

    function openSetup() {
        showingSetup = true;
        const form = panel.querySelector('.assistant-setup');
        form.hidden = false;
        panel.querySelector('.assistant-chat').hidden = true;
        form.querySelector('#assistant-endpoint').value = settings?.endpoint || '';
        form.dataset.loadedEndpoint = settings?.endpoint || '';
        form.querySelector('#assistant-clear-key').hidden = !settings?.api_key_display;
        form.querySelector('#assistant-model').value = settings?.model || '';
        form.querySelector('#assistant-key').value = '';
        form.querySelector('#assistant-key').placeholder = settings?.api_key_display || t('assistant.setup.keyPlaceholder', 'Leave empty for a model on this computer');
        form.querySelector('#assistant-access').value = settings?.access || 'ask';
        form.querySelector('#assistant-extra').value = settings?.extra_instructions || '';
        const borrowed = form.querySelector('.assistant-setup-borrowed');
        borrowed.hidden = !(settings?.caption_service && !settings?.endpoint);
        if (!borrowed.hidden) {
            borrowed.textContent = settings.use_caption_service
                ? t('assistant.setup.borrowed', 'Nothing is entered here, so the assistant uses the AI caption service you already set up: {model} at {address}', { model: settings.caption_service.model, address: settings.caption_service.endpoint })
                : t('assistant.setup.borrowOffer', 'You already set up an AI caption service: {model} at {address}. Leave the address empty and press Save to let the assistant use it too.', { model: settings.caption_service.model, address: settings.caption_service.endpoint });
        }
        setStatus('');
        form.querySelector('#assistant-endpoint').focus();
    }

    function closeSetup() {
        showingSetup = false;
        panel.querySelector('.assistant-setup').hidden = true;
        panel.querySelector('.assistant-chat').hidden = false;
        draw();
    }

    function setStatus(text, tone) {
        const status = panel.querySelector('.assistant-setup-status');
        status.textContent = text;
        status.dataset.tone = tone || 'info';
    }

    function formChanges() {
        const form = panel.querySelector('.assistant-setup');
        const key = form.querySelector('#assistant-key').value;
        const endpoint = form.querySelector('#assistant-endpoint').value.trim();
        return {
            // Sent only when edited: what the form was filled with may have hidden parts.
            endpoint: endpoint === (form.dataset.loadedEndpoint || '') ? null : endpoint,
            // Saving with no address of its own is the user's yes to the caption service shown above.
            use_caption_service: !endpoint && Boolean(settings?.caption_service),
            model: form.querySelector('#assistant-model').value.trim(),
            // An empty field keeps the stored key.
            api_key: key ? key.trim() : null,
            access: form.querySelector('#assistant-access').value,
            extra_instructions: form.querySelector('#assistant-extra').value,
        };
    }

    async function saveSetup(thenTest) {
        try {
            settings = await client().saveSettings(formChanges());
            await readSettings();
            if (!thenTest) {
                closeSetup();
                return;
            }
            setStatus(t('assistant.setup.testing', 'Asking the model one short question...'));
            const result = await client().test();
            setStatus(t('assistant.setup.works', 'It works: {model} answered.', { model: result.model }), 'ok');
        } catch (error) {
            setStatus(error?.message || String(error), 'error');
        }
    }

    async function loadModels() {
        try {
            const { endpoint, api_key } = formChanges();
            settings = await client().saveSettings({ endpoint, api_key });
            panel.querySelector('.assistant-setup').dataset.loadedEndpoint = settings.endpoint || '';
            setStatus(t('assistant.setup.loadingModels', 'Reading the model list...'));
            const { models } = await client().models();
            const list = panel.querySelector('#assistant-model-list');
            list.textContent = '';
            models.forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                list.appendChild(option);
            });
            setStatus(t('assistant.setup.modelsFound', '{n} models found. Pick one in the Model field.', { n: models.length }), 'ok');
            panel.querySelector('#assistant-model').focus();
        } catch (error) {
            setStatus(error?.message || String(error), 'error');
        }
    }

    // -- the panel -------------------------------------------------------

    function build() {
        panel = el('aside', 'assistant-panel');
        panel.id = 'assistant-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'complementary');
        panel.setAttribute('aria-label', t('assistant.title', 'Assistant'));
        panel.innerHTML = `
            <header class="assistant-head">
                <span class="assistant-title">${icon('i-message')}<span>${t('assistant.title', 'Assistant')}</span></span>
                <span class="assistant-model"></span>
                <span class="assistant-head-actions">
                    <button type="button" class="btn btn-ghost btn-icon-only" id="assistant-new-chat">${icon('i-plus')}</button>
                    <button type="button" class="btn btn-ghost btn-icon-only" id="assistant-open-setup">${icon('i-settings')}</button>
                    <button type="button" class="btn btn-ghost btn-icon-only" id="assistant-close">${icon('i-close')}</button>
                </span>
            </header>
            <div class="assistant-chat">
                <div class="assistant-messages" aria-live="polite"></div>
                <form class="assistant-composer">
                    <textarea id="assistant-input" rows="2"></textarea>
                    <button type="submit" class="btn btn-primary" id="assistant-send"></button>
                </form>
            </div>
            <form class="assistant-setup" hidden>
                <p class="assistant-setup-title"></p>
                <p class="assistant-setup-sent"></p>
                <p class="assistant-setup-borrowed" hidden></p>
                <label for="assistant-endpoint"></label>
                <input id="assistant-endpoint" type="url" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:11434/v1">
                <label for="assistant-key"></label>
                <div class="assistant-setup-row">
                    <input id="assistant-key" type="password" autocomplete="off">
                    <button type="button" class="btn btn-secondary" id="assistant-clear-key" hidden></button>
                </div>
                <label for="assistant-model"></label>
                <div class="assistant-setup-row">
                    <input id="assistant-model" type="text" autocomplete="off" spellcheck="false" list="assistant-model-list">
                    <datalist id="assistant-model-list"></datalist>
                    <button type="button" class="btn btn-secondary" id="assistant-load-models"></button>
                </div>
                <label for="assistant-access"></label>
                <select id="assistant-access">
                    <option value="ask"></option>
                    <option value="read_only"></option>
                    <option value="auto"></option>
                </select>
                <label for="assistant-extra"></label>
                <textarea id="assistant-extra" rows="3"></textarea>
                <p class="assistant-setup-status" aria-live="polite"></p>
                <div class="assistant-setup-actions">
                    <button type="button" class="btn btn-secondary" id="assistant-test"></button>
                    <button type="button" class="btn btn-secondary" id="assistant-setup-cancel"></button>
                    <button type="submit" class="btn btn-primary" id="assistant-save"></button>
                </div>
            </form>`;
        document.body.appendChild(panel);
        labelEverything();

        panel.querySelector('#assistant-close').addEventListener('click', () => toggle(false));
        panel.querySelector('#assistant-new-chat').addEventListener('click', newChat);
        panel.querySelector('#assistant-open-setup').addEventListener('click', () => (showingSetup ? closeSetup() : openSetup()));
        panel.querySelector('.assistant-composer').addEventListener('submit', (event) => {
            event.preventDefault();
            if (active) active.stop();
            else send(panel.querySelector('#assistant-input').value);
        });
        panel.querySelector('#assistant-input').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                if (!active) send(event.target.value);
            }
        });
        panel.querySelector('.assistant-setup').addEventListener('submit', (event) => {
            event.preventDefault();
            saveSetup(false);
        });
        panel.querySelector('#assistant-test').addEventListener('click', () => saveSetup(true));
        panel.querySelector('#assistant-setup-cancel').addEventListener('click', closeSetup);
        panel.querySelector('#assistant-load-models').addEventListener('click', loadModels);
        panel.querySelector('#assistant-clear-key').addEventListener('click', async () => {
            try {
                settings = await client().saveSettings({ clear_api_key: true });
                await readSettings();
                openSetup();
                setStatus(t('assistant.setup.keyRemoved', 'The saved key was removed.'), 'ok');
            } catch (error) {
                setStatus(error?.message || String(error), 'error');
            }
        });
        // Esc closes the panel only when the keyboard is inside it (the top layer).
        panel.addEventListener('keydown', (event) => {
            // Nothing typed here reaches the page's own shortcuts.
            event.stopPropagation();
            if (event.key !== 'Escape') return;
            if (showingSetup) closeSetup();
            else toggle(false);
        });
    }

    function labelEverything() {
        const set = (selector, key, fallback, attribute) => {
            const node = panel.querySelector(selector);
            if (!node) return;
            const text = t(key, fallback);
            if (attribute) attribute.split(',').forEach((name) => node.setAttribute(name, text));
            else node.textContent = text;
        };
        set('#assistant-new-chat', 'assistant.newChat', 'Start a new conversation', 'title,aria-label');
        set('#assistant-open-setup', 'assistant.setup.open', 'Model service and permissions', 'title,aria-label');
        set('#assistant-close', 'assistant.close', 'Close the assistant', 'title,aria-label');
        set('#assistant-input', 'assistant.placeholder', 'Say what you want to find or do...', 'placeholder,aria-label');
        set('.assistant-setup-title', 'assistant.setup.title', 'Which model should the assistant use?');
        set('.assistant-setup-sent', 'assistant.setup.sent', 'What is sent to this model service: your messages, and what the assistant looks up for them (file names, prompts, tags, counts; a file path when it reads one picture). Pictures themselves are not sent. A model on this computer keeps everything here.');
        set('label[for="assistant-endpoint"]', 'assistant.setup.endpoint', 'Address (OpenAI-compatible; Ollama, LM Studio, OpenRouter and others)');
        set('label[for="assistant-key"]', 'assistant.setup.key', 'API key');
        set('label[for="assistant-model"]', 'assistant.setup.model', 'Model');
        set('#assistant-load-models', 'assistant.setup.loadModels', 'Get the list');
        set('#assistant-clear-key', 'assistant.setup.clearKey', 'Remove the saved key');
        set('label[for="assistant-access"]', 'assistant.setup.access', 'Changes to tags, stars and collections');
        set('#assistant-access option[value="ask"]', 'assistant.setup.accessAsk', 'Ask me before every change');
        set('#assistant-access option[value="read_only"]', 'assistant.setup.accessReadOnly', 'Never change anything (look and show only)');
        set('#assistant-access option[value="auto"]', 'assistant.setup.accessAuto', 'Do them without asking');
        set('label[for="assistant-extra"]', 'assistant.setup.extra', 'Your standing instructions (optional)');
        set('#assistant-test', 'assistant.setup.test', 'Save and test');
        set('#assistant-setup-cancel', 'common.cancel', 'Cancel');
        set('#assistant-save', 'assistant.setup.save', 'Save');
    }

    async function toggle(open) {
        if (!panel) build();
        const next = open === undefined ? panel.hidden : Boolean(open);
        panel.hidden = !next;
        document.documentElement.classList.toggle('assistant-open', next);
        const button = document.getElementById('btn-assistant');
        button?.setAttribute('aria-expanded', String(next));
        try {
            localStorage.setItem(OPEN_KEY, next ? '1' : '0');
        } catch (_error) { /* not remembered */ }
        if (!next) {
            button?.focus();
            return;
        }
        await readSettings();
        if (!settings.ready && !conversation.items.length) openSetup();
        else {
            closeSetup();
            panel.querySelector('#assistant-input').focus();
        }
    }

    function wire() {
        restore();
        document.getElementById('btn-assistant')?.addEventListener('click', () => toggle());
        let wasOpen = false;
        try {
            wasOpen = localStorage.getItem(OPEN_KEY) === '1';
        } catch (_error) { /* closed */ }
        if (wasOpen) toggle(true);
        // A language switch redraws the panel in the new language.
        document.addEventListener('languageChanged', () => {
            if (!panel) return;
            labelEverything();
            draw();
        });
    }

    global.AssistantPanel = Object.freeze({ toggle, send });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
