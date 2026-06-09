/**
 * Shared tag-category copy menu.
 */
(function () {
    const CATEGORY_GROUPS = [
        { id: 'appearance', labelKey: 'tagCategory.appearance', fallback: 'Appearance', icon: '◌', categories: ['body', 'character', 'expression'], saveCategory: 'body' },
        { id: 'clothing', labelKey: 'tagCategory.clothing', fallback: 'Clothing', icon: '▣', categories: ['outfit'], saveCategory: 'outfit' },
        { id: 'pose', labelKey: 'tagCategory.pose', fallback: 'Pose', icon: '↕', categories: ['pose', 'action', 'angle'], saveCategory: 'pose' },
        { id: 'scenery', labelKey: 'tagCategory.scenery', fallback: 'Scenery', icon: '△', categories: ['background'], saveCategory: 'background' },
        { id: 'style', labelKey: 'tagCategory.style', fallback: 'Style', icon: '✦', categories: ['style', 'artist'], saveCategory: 'style' },
        { id: 'qualityMeta', labelKey: 'tagCategory.qualityMeta', fallback: 'Quality / Meta', icon: '#', categories: ['quality', 'meta', 'rating'], saveCategory: 'quality' },
        { id: 'unclassified', labelKey: 'tagCategory.unclassified', fallback: 'Unclassified', icon: '?', categories: ['unknown'], saveCategory: 'unknown' },
    ];

    const CORE_BOARD_GROUPS = CATEGORY_GROUPS.filter((group) => (
        ['appearance', 'clothing', 'pose', 'scenery', 'unclassified'].includes(group.id)
    ));

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        return value && value !== key ? value : fallback;
    }

    function escapeHtml(value) {
        if (window.escapeHtml) return window.escapeHtml(value);
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function normalizeTagValue(value) {
        return String(value ?? '')
            .trim()
            .replace(/^["']|["']$/g, '')
            .replace(/\s+/g, ' ');
    }

    function parsePromptTags(value) {
        const text = String(value || '');
        if (!text.trim()) return [];
        const parts = [];
        let current = '';
        let roundDepth = 0;
        let squareDepth = 0;
        let curlyDepth = 0;
        let angleDepth = 0;

        for (const char of text) {
            if (char === '(') roundDepth += 1;
            else if (char === ')' && roundDepth > 0) roundDepth -= 1;
            else if (char === '[') squareDepth += 1;
            else if (char === ']' && squareDepth > 0) squareDepth -= 1;
            else if (char === '{') curlyDepth += 1;
            else if (char === '}' && curlyDepth > 0) curlyDepth -= 1;
            else if (char === '<') angleDepth += 1;
            else if (char === '>' && angleDepth > 0) angleDepth -= 1;

            if (char === ',' && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0 && angleDepth === 0) {
                const token = normalizeTagValue(current);
                if (token) parts.push(token);
                current = '';
                continue;
            }
            current += char;
        }

        const last = normalizeTagValue(current);
        if (last) parts.push(last);
        return dedupeTags(parts);
    }

    function dedupeTags(tags) {
        const seen = new Set();
        const result = [];
        (tags || []).forEach((tag) => {
            const value = normalizeTagValue(typeof tag === 'object' ? (tag.tag || tag.name || tag.text) : tag);
            if (!value) return;
            const key = value.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            result.push(value);
        });
        return result;
    }

    async function getTagsFromSource(source = {}) {
        const directTags = dedupeTags(source.tags || []);
        if (directTags.length > 0) return directTags;

        const imageId = Number(source.imageId || source.image?.id);
        if (Number.isFinite(imageId) && imageId > 0 && window.App?.API?.getImage) {
            try {
                const result = await window.App.API.getImage(imageId);
                const fetchedTags = dedupeTags(result?.tags || result?.image?.tags || []);
                if (fetchedTags.length > 0) return fetchedTags;
                const promptTags = parsePromptTags(result?.image?.prompt || source.image?.prompt || source.prompt || '');
                if (promptTags.length > 0) return promptTags;
            } catch (_error) {
                // Fall through to prompt parsing.
            }
        }

        return parsePromptTags(source.prompt || source.image?.prompt || '');
    }

    async function classifyTags(tags) {
        const cleanTags = dedupeTags(tags);
        const byCategory = {};
        const tagCategory = {};
        CATEGORY_GROUPS.forEach((group) => {
            group.categories.forEach((category) => {
                byCategory[category] = [];
            });
        });

        if (cleanTags.length === 0) {
            return { tags: [], byCategory, tagCategory };
        }

        try {
            const result = await window.App?.API?.post?.('/api/prompts/categorize', cleanTags);
            (result?.results || []).forEach((item) => {
                const tag = normalizeTagValue(item?.tag);
                const category = normalizeTagValue(item?.category || 'unknown').toLowerCase() || 'unknown';
                if (!tag) return;
                if (!byCategory[category]) byCategory[category] = [];
                byCategory[category].push(tag);
                tagCategory[tag.toLowerCase()] = category;
            });
        } catch (_error) {
            cleanTags.forEach((tag) => {
                byCategory.unknown = byCategory.unknown || [];
                byCategory.unknown.push(tag);
                tagCategory[tag.toLowerCase()] = 'unknown';
            });
        }

        cleanTags.forEach((tag) => {
            const key = tag.toLowerCase();
            if (tagCategory[key]) return;
            byCategory.unknown = byCategory.unknown || [];
            byCategory.unknown.push(tag);
            tagCategory[key] = 'unknown';
        });

        return { tags: cleanTags, byCategory, tagCategory };
    }

    function tagsForGroup(classified, group) {
        return dedupeTags(group.categories.flatMap((category) => classified.byCategory[category] || []));
    }

    function groupForCategory(category) {
        const clean = String(category || 'unknown').toLowerCase();
        return CORE_BOARD_GROUPS.find((group) => group.categories.includes(clean)) || CORE_BOARD_GROUPS.find((group) => group.id === 'unclassified');
    }

    function copyTags(tags, message) {
        const text = dedupeTags(tags).join(', ');
        if (!text) {
            window.App?.showToast?.(t('tagCategory.noneFound', 'No tags found for that category.'), 'warning');
            return Promise.resolve(false);
        }
        if (typeof window.App?.copyTextToClipboard === 'function') {
            return window.App.copyTextToClipboard(text, message);
        }
        return navigator.clipboard.writeText(text).then(() => {
            window.App?.showToast?.(message, 'success');
            return true;
        });
    }

    function removeMenu() {
        document.querySelector('.tag-category-copy-menu')?.remove();
    }

    function positionMenu(menu, options = {}) {
        const anchor = options.anchor || null;
        let left = Number(options.x);
        let top = Number(options.y);

        if ((!Number.isFinite(left) || !Number.isFinite(top)) && anchor?.getBoundingClientRect) {
            const rect = anchor.getBoundingClientRect();
            left = rect.left;
            top = rect.bottom + 6;
        }

        menu.style.left = `${Number.isFinite(left) ? left : 12}px`;
        menu.style.top = `${Number.isFinite(top) ? top : 12}px`;

        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth - 8) {
                menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
            }
            if (rect.bottom > window.innerHeight - 8) {
                menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
            }
        });
    }

    function buildMenuShell(options = {}) {
        removeMenu();
        const menu = document.createElement('div');
        menu.className = 'tag-category-copy-menu';
        menu.setAttribute('role', 'menu');
        menu.innerHTML = `
            <div class="tag-category-copy-title">${escapeHtml(options.title || t('tagCategory.copyOptions', 'Copy Options'))}</div>
            <div class="tag-category-copy-body">
                <div class="tag-category-copy-loading">${escapeHtml(t('common.loading', 'Loading...'))}</div>
            </div>
        `;
        document.body.appendChild(menu);
        positionMenu(menu, options);

        const closeOnOutside = (event) => {
            if (!menu.contains(event.target)) {
                removeMenu();
                document.removeEventListener('click', closeOnOutside);
                document.removeEventListener('keydown', closeOnEscape);
            }
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') {
                removeMenu();
                document.removeEventListener('click', closeOnOutside);
                document.removeEventListener('keydown', closeOnEscape);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeOnOutside);
            document.addEventListener('keydown', closeOnEscape);
        }, 0);

        return menu;
    }

    async function showMenu(options = {}) {
        const menu = buildMenuShell(options);
        const body = menu.querySelector('.tag-category-copy-body');
        const tags = await getTagsFromSource(options.source || options);
        const classified = await classifyTags(tags);

        if (!menu.isConnected) return null;

        const allCount = classified.tags.length;
        body.innerHTML = '';

        const allButton = document.createElement('button');
        allButton.type = 'button';
        allButton.className = 'tag-category-copy-item';
        allButton.innerHTML = `
            <span class="tag-category-copy-icon" aria-hidden="true">🏷</span>
            <span class="tag-category-copy-label">${escapeHtml(t('tagCategory.allTags', 'All Tags'))}</span>
            <span class="tag-category-copy-count">${allCount}</span>
        `;
        allButton.addEventListener('click', () => {
            copyTags(classified.tags, t('tagCategory.allCopied', 'Tags copied'));
            removeMenu();
        });
        body.appendChild(allButton);

        CATEGORY_GROUPS.forEach((group) => {
            const groupTags = tagsForGroup(classified, group);
            const label = t(group.labelKey, group.fallback);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tag-category-copy-item';
            button.dataset.group = group.id;
            button.innerHTML = `
                <span class="tag-category-copy-icon" aria-hidden="true">${escapeHtml(group.icon)}</span>
                <span class="tag-category-copy-label">${escapeHtml(label)}</span>
                <span class="tag-category-copy-count">${groupTags.length}</span>
            `;
            button.addEventListener('click', () => {
                copyTags(
                    groupTags,
                    t('tagCategory.groupCopied', 'Copied {category} tags', { category: label }).replace('{category}', label)
                );
                removeMenu();
            });
            body.appendChild(button);
        });

        if (options.showTeach !== false && typeof window.PromptLab?.openCategoryBoard === 'function') {
            const separator = document.createElement('div');
            separator.className = 'tag-category-copy-separator';
            body.appendChild(separator);

            const teach = document.createElement('button');
            teach.type = 'button';
            teach.className = 'tag-category-copy-item';
            teach.innerHTML = `
                <span class="tag-category-copy-icon" aria-hidden="true">↔</span>
                <span class="tag-category-copy-label">${escapeHtml(t('tagCategory.teach', 'Teach categories'))}</span>
                <span class="tag-category-copy-count">${allCount}</span>
            `;
            teach.addEventListener('click', () => {
                if (allCount === 0) {
                    window.App?.showToast?.(t('tagCategory.noneFound', 'No tags found for that category.'), 'warning');
                    return;
                }
                window.App?.switchView?.('promptlab');
                window.PromptLab.openCategoryBoard(classified.tags);
                removeMenu();
            });
            body.appendChild(teach);
        }

        positionMenu(menu, options);
        return { tags, classified };
    }

    window.TagCategoryCopy = {
        CATEGORY_GROUPS,
        CORE_BOARD_GROUPS,
        classifyTags,
        copyTags,
        getTagsFromSource,
        groupForCategory,
        parsePromptTags,
        showMenu,
        tagsForGroup,
    };
}());
