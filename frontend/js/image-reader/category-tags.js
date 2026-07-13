/**
 * image-reader/category-tags.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 280-283 + 1490-1649 (of 1,749): _closeCopyMenu,
 * _renderReaderCategoryTags (window.TagCategoryCopy classify/copy/find
 * integration; test_frontend_contract.py pins this literal via
 * _reader_family_source), _copy (prompt/negative/params/sd/all clipboard
 * variants) and _copyPromptCategory (also contract-pinned).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _closeCopyMenu() {
            document.getElementById('reader-copy-menu')?.removeAttribute('open');
        },

        async _renderReaderCategoryTags(result) {
            const section = document.getElementById('reader-category-tags-section');
            const container = document.getElementById('reader-category-tags');
            if (!section || !container) return;

            const copy = window.TagCategoryCopy;
            if (!copy?.getTagsFromSource || !copy?.classifyTags) {
                section.hidden = true;
                container.innerHTML = '';
                return;
            }

            const promptView = this._buildPromptView(result || this._currentResult, this._promptFormat);
            const source = {
                imageId: this._currentLibraryImageId,
                tags: this._currentReaderTags || [],
                prompt: promptView?.promptText || result?.prompt || '',
            };
            const renderToken = `${Date.now()}-${Math.random()}`;
            this._readerCategoryRenderToken = renderToken;
            container.innerHTML = `<div class="tag-category-copy-loading">${this._escapeHtml(this._t('common.loading', 'Loading...'))}</div>`;
            section.hidden = false;

            try {
                const tags = await copy.getTagsFromSource(source);
                const classified = await copy.classifyTags(tags);
                if (this._readerCategoryRenderToken !== renderToken) return;

                const groups = (copy.CATEGORY_GROUPS || [])
                    .map((group) => {
                        const groupTags = copy.tagsForGroup(classified, group);
                        return { group, groupTags };
                    })
                    .filter(({ groupTags }) => groupTags.length > 0);

                if (!groups.length) {
                    section.hidden = true;
                    container.innerHTML = '';
                    return;
                }

                container.innerHTML = groups.map(({ group, groupTags }) => {
                    const label = this._t(group.labelKey, group.fallback);
                    return `
                        <section class="reader-category-group" data-group="${this._escapeHtml(group.id)}">
                            <div class="reader-category-group-head">
                                <span class="reader-category-title">${this._escapeHtml(label)}</span>
                                <span class="tag-category-copy-count">${groupTags.length}</span>
                                <span class="reader-category-actions">
                                    <button type="button" class="btn btn-ghost btn-small reader-category-copy" data-group="${this._escapeHtml(group.id)}">${this._escapeHtml(this._t('reader.copy', 'Copy'))}</button>
                                    <button type="button" class="btn btn-ghost btn-small reader-category-find" data-group="${this._escapeHtml(group.id)}">${this._escapeHtml(this._t('tagCategory.find', 'Find'))}</button>
                                </span>
                            </div>
                            <div class="reader-category-chip-list">
                                ${groupTags.map((tag) => `<span class="reader-category-chip">${this._escapeHtml(tag)}</span>`).join('')}
                            </div>
                        </section>
                    `;
                }).join('');

                container.querySelectorAll('.reader-category-copy').forEach((button) => {
                    button.addEventListener('click', () => {
                        const group = groups.find((item) => item.group.id === button.dataset.group);
                        if (!group) return;
                        const label = this._t(group.group.labelKey, group.group.fallback);
                        copy.copyTags(group.groupTags, this._t('tagCategory.groupCopied', 'Copied {category} tags', { category: label }).replace('{category}', label));
                    });
                });
                container.querySelectorAll('.reader-category-find').forEach((button) => {
                    button.addEventListener('click', () => {
                        const group = groups.find((item) => item.group.id === button.dataset.group);
                        if (!group) return;
                        const label = this._t(group.group.labelKey, group.group.fallback);
                        copy.findGalleryByTags(group.groupTags, label);
                    });
                });
            } catch (_error) {
                section.hidden = true;
                container.innerHTML = '';
            }
        },

        _copy(what) {
            const r = this._currentResult;
            if (!r) return;

            let text = '';
            const gp = this._getGenParams(r);

            switch (what) {
                case 'prompt':
                    text = r.prompt || '';
                    break;
                case 'negative':
                    text = r.negative_prompt || '';
                    break;
                case 'params': {
                    text = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    break;
                }
                case 'sd': {
                    const promptView = this._buildPromptView(r, 'sd');
                    const parts = [];
                    if (promptView?.promptText) parts.push(promptView.promptText);
                    if (promptView?.negativeText) parts.push(`Negative prompt: ${promptView.negativeText}`);
                    const paramStr = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    if (paramStr) parts.push(paramStr);
                    text = parts.join('\n');
                    break;
                }
                case 'all': {
                    const parts = [];
                    parts.push(`Generator: ${r.generator || 'unknown'}`);
                    if (r.checkpoint) parts.push(`Checkpoint: ${r.checkpoint}`);
                    const loras = this._getLoras(r);
                    if (loras.length) parts.push(`LoRAs: ${loras.join(', ')}`);
                    parts.push('');
                    if (r.prompt) parts.push(r.prompt);
                    if (r.negative_prompt) parts.push(`\nNegative prompt: ${r.negative_prompt}`);
                    const paramStr = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    if (paramStr) parts.push(`\n${paramStr}`);
                    text = parts.join('\n');
                    break;
                }
            }

            navigator.clipboard.writeText(text).then(() => {
                window.App?.showToast?.(this._t('reader.copied', 'Copied to clipboard'), 'success');
            }).catch(() => {
                window.App?.showToast?.(this._t('reader.copyFailed', 'Failed to copy'), 'error');
            });
        },

        _copyPromptCategory(event) {
            const r = this._currentResult;
            if (!r) {
                window.App?.showToast?.(this._t('reader.noPrompt', 'No prompt found in this image'), 'warning');
                return;
            }
            const promptView = this._buildPromptView(r, this._promptFormat);
            window.TagCategoryCopy?.showMenu?.({
                anchor: event?.currentTarget || document.getElementById('reader-copy-prompt-category'),
                source: {
                    imageId: this._currentLibraryImageId,
                    tags: this._currentReaderTags || [],
                    prompt: promptView?.promptText || r.prompt || '',
                },
                title: this._t('tagCategory.copyOptions', 'Copy Options'),
            });
        },

});
