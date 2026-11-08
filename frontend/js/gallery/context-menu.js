/**
 * gallery/context-menu.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 4186-4406 (of 4,708): _showContextMenu + _positionContextMenu (contract-pinned).
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    /**
     * Show a context menu on right-click for a gallery item
     * @param {MouseEvent} e - The contextmenu event
     * @param {Object} image - The image data object
     */
    _showContextMenu(e, image) {
        // Remove existing menu
        document.querySelector('.gallery-context-menu')?.remove();
        document.querySelector('.collections-picker-menu')?.remove();
        const t = (key, fallback, params) => { const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : window.I18n.format(fallback, params); };
        const app = window.App || {};
        const imageId = Number(image?.id);
        const selectedIds = app.AppState?.selectedIds instanceof Set ? app.AppState.selectedIds : new Set();
        const tokenScoped = app.AppState?.selectionScope === 'filtered'
            && Boolean(app.AppState?.selectionToken);
        const tokenActive = tokenScoped
            && app.isFilteredSelectionActiveForCurrentFilters?.();
        const isSelected = tokenActive
            ? isGalleryImageSelected(app.AppState, imageId)
            : !tokenScoped && (selectedIds.has(imageId) || selectedIds.has(String(image?.id)));
        const selectedImageIds = (tokenScoped ? [] : Array.from(selectedIds))
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0);
        const actionImageIds = isSelected && selectedImageIds.length > 1 ? selectedImageIds : [imageId];
        const actionCount = actionImageIds.length;
        const checkpointFilterValue = app.normalizeCheckpointFilterValue?.(
            image.checkpoint_normalized || image.checkpoint
        ) || '';

        const menu = document.createElement('div');
        menu.className = 'gallery-context-menu';
        menu.setAttribute('role', 'menu');

        const scopeLabel = actionCount > 1
            ? t('gallery.contextApplyToSelected', 'Use selected ({count})', { count: actionCount })
            : '';
        const labelWithScope = (key, fallback) => {
            const label = t(key, fallback);
            return scopeLabel ? `${label} · ${scopeLabel}` : label;
        };
        const tagCopySource = { imageId: image.id, image };

        const items = [
            { label: t('gallery.contextPreview', 'Preview'), icon: 'i-eye', action: () => this.openPreview(image.id) },
            { label: isSelected ? t('gallery.contextDeselectImage', 'Deselect Image') : t('gallery.contextSelectImage', 'Select Image'), icon: isSelected ? 'i-close' : 'i-check', action: () => {
                if (tokenActive) {
                    this.toggleSelection(image.id);
                    return;
                }
                this._setContextImageSelection(image.id, !isSelected);
            } },
            { type: 'separator' },
            { label: t('gallery.contextCopyTags', 'Copy Tags'), icon: 'i-tag', action: async () => {
                const copy = window.TagCategoryCopy;
                if (!copy) {
                    app.showToast?.(t('modal.copyFailed', 'Failed to copy text'), 'error');
                    return;
                }
                const tags = await copy.getTagsFromSource(tagCopySource);
                await copy.copyTags(tags, t('modal.tagsCopied', 'Tags copied'));
            }},
            { label: t('gallery.contextCopyTagCategory', 'Copy Tag Category...'), icon: 'i-layers', action: (event) => {
                if (!window.TagCategoryCopy?.showMenu) {
                    app.showToast?.(t('modal.copyFailed', 'Failed to copy text'), 'error');
                    return;
                }
                window.TagCategoryCopy.showMenu({
                    x: event.clientX,
                    y: event.clientY,
                    source: tagCopySource,
                    title: t('tagCategory.copyOptions', 'Copy Options'),
                });
            }},
            { type: 'separator' },
            { label: this.isFavorited(image.id)
                ? t('collections.contextUnfavorite', 'Remove from Favorites')
                : t('collections.contextFavorite', 'Add to Favorites'),
              icon: 'i-heart',
              action: () => this.toggleFavorite(image.id) },
            { label: labelWithScope('collections.contextAddTo', 'Add to collection…'), icon: 'i-folders',
              action: () => window.CollectionsUI?.openAddToCollectionPicker?.(actionImageIds) },
            { type: 'separator' },
            { label: labelWithScope('gallery.contextMoveImage', 'Move...'), icon: 'i-arrow-right', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'move', { source: 'context' }) },
            { label: labelWithScope('gallery.contextCopyImage', 'Copy...'), icon: 'i-file', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'copy', { source: 'context' }) },
            { type: 'separator' },
            { tool: true, pictureOnly: true, label: labelWithScope('gallery.contextSendToCensor', 'Send to Censor'), icon: 'i-grid', action: () => {
                if (typeof app.addToCensorQueue === 'function') {
                    app.addToCensorQueue(actionImageIds);
                } else {
                    app.showToast?.(t('gallery.contextSendToCensorFailed', 'Failed to send image to Edit'), 'error');
                }
            }},
            { tool: true, pictureOnly: true, label: labelWithScope('modal.addToDataset', 'Add to dataset'), icon: 'i-package', action: () => app.addToDatasetMaker?.(actionImageIds, { switchView: true, showToast: true }) },
            { tool: true, pictureOnly: true, label: t('gallery.contextFindSimilar', 'Find Similar'), icon: 'i-images', action: () => app.openSimilarFromImage?.(image.id) },
            { tool: true, pictureOnly: true, label: t('gallery.contextViewOnStyleMap', 'View on the Style Map'), icon: 'i-compass', action: () => window.StyleMap?.locateImage?.(image.id) },
            { tool: true, pictureOnly: true, label: t('gallery.contextNearDuplicates', 'Find near-duplicates (CLIP)'), icon: 'i-layers', action: () => window.ClipTools?.near?.(image.id) },
            actionCount === 2
                ? { tool: true, pictureOnly: true, label: t('gallery.contextCompareTwo', 'Compare 2 images (CLIP)'), icon: 'i-scale', action: () => window.ClipTools?.compare?.(actionImageIds[0], actionImageIds[1]) }
                : null,
            { tool: true, label: t('gallery.contextPromptHelper', 'Prompt Helper'), icon: 'i-flask', action: () => app.openPromptBuildFromImage?.(image.id) },
            { tool: true, label: t('gallery.contextSendToGenerator', 'Send to generator…'), icon: 'i-upload', action: () => window.SendToGenerator?.open?.(image.id, { x: e.clientX, y: e.clientY }) },
            { tool: true, label: t('gallery.contextReadMetadata', 'Metadata / Info'), icon: 'i-info', action: () => app.openReaderFromImage?.(image.id, image.filename || '') },
            { tool: true, pictureOnly: true, label: t('gallery.contextReversePrompt', 'Send to Reverse Prompt'), icon: 'i-refresh', action: () => app.openReversePromptFromImage?.(image.id, image.filename || '') },
            { tool: true, pictureOnly: true, label: labelWithScope('gallery.contextPrivacy', 'Send to Privacy Tools'), icon: 'i-shield', action: () => app.openPrivacyFromImages?.(actionImageIds) },
            checkpointFilterValue ? { tool: true, label: t('gallery.contextFilterCheckpoint', 'Filter by Checkpoint'), icon: 'i-filter', action: () => {
                if (app.AppState) {
                    app.updateFilters?.((filters) => {
                        if (!filters.checkpoints.includes(checkpointFilterValue)) {
                            filters.checkpoints = [...filters.checkpoints, checkpointFilterValue];
                        }
                    });
                    app.updateFilterSummary?.();
                    app.loadImages?.();
                }
            }} : null,
            { type: 'separator' },
            { label: t('gallery.contextOpenFolder', 'Open in Folder'), icon: 'i-folder', action: () => {
                app.API?.openFolder?.(image.id);
            }},
            { label: t('gallery.contextCopyPath', 'Copy Path'), icon: 'i-clipboard', action: () => {
                if (typeof app.copyTextToClipboard === 'function') {
                    app.copyTextToClipboard(image.path || '', t('gallery.pathCopied', 'Path copied'));
                } else {
                    navigator.clipboard.writeText(image.path || '');
                    app.showToast?.(t('gallery.pathCopied', 'Path copied'), 'success');
                }
            }},
            { type: 'separator' },
            { label: labelWithScope('gallery.contextRemoveFromGallery', 'Remove from Gallery'), icon: 'i-broom', danger: true, action: () => app.removeGalleryImagesByIds?.(actionImageIds) },
            { label: labelWithScope('gallery.contextMoveToTrash', 'Move to Trash...'), icon: 'i-trash', danger: true, action: () => app.deleteGalleryImagesByIds?.(actionImageIds) },
        ].filter(Boolean);

        const anchorEl = e.currentTarget || e.target?.closest?.('.gallery-item');
        const renderItem = (item) => {
            if (item.type === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'context-menu-separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
                return;
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = `context-menu-item${item.danger ? ' is-danger' : ''}`;
            button.setAttribute('role', 'menuitem');

            const icon = document.createElement('span');
            icon.className = 'context-menu-icon';
            icon.setAttribute('aria-hidden', 'true');
            window.UiIcon ? window.UiIcon.fill(icon, item.icon) : (icon.textContent = item.icon);

            const label = document.createElement('span');
            label.className = 'context-menu-label';
            label.textContent = item.label;

            button.append(icon, label);
            if (item.opensPage) {
                const more = document.createElement('span');
                more.className = 'context-menu-more';
                more.setAttribute('aria-hidden', 'true');
                window.UiIcon?.fill(more, 'i-arrow-right');
                button.append(more);
                button.setAttribute('aria-haspopup', 'menu');
            }
            if (item.pictureOnly && image?.media_type === 'video') {
                button.disabled = true;
                button.title = t('video.pictureOnly', 'Works on pictures only, not videos');
            }
            button.addEventListener('click', (event) => {
                if (item.keepOpen) {
                    // Turns the page inside the menu; the outside-click
                    // listener must not close it.
                    event.stopPropagation();
                    item.action(event, menu);
                    return;
                }
                Promise.resolve(item.action(event, menu)).catch((error) => {
                    const message = typeof formatUserError === 'function'
                        ? formatUserError(error, t('modal.copyFailed', 'Failed to copy text'))
                        : t('modal.copyFailed', 'Failed to copy text');
                    app.showToast?.(message, 'error');
                });
                menu.remove();
            });
            menu.appendChild(button);
        };

        // Pro look: the tool rows (another page or tool) sit behind one Tools
        // row that opens them in the same menu, about 12 rows instead of 23
        // (blind judges 2026-11-08); today's look lists every row.
        const toolItems = items.filter((item) => item.tool);
        let mainItems = items;
        const showPage = (list) => {
            menu.replaceChildren();
            list.forEach(renderItem);
            this._positionContextMenu(menu, e.clientX, e.clientY, anchorEl);
            menu.querySelector('.context-menu-item:not(:disabled)')?.focus?.();
        };
        if (document.documentElement.dataset.look === 'pro' && toolItems.length) {
            const firstTool = items.indexOf(toolItems[0]);
            const toolsPage = [
                { label: t('gallery.contextBack', 'Back'), icon: 'i-arrow-left', keepOpen: true, action: () => showPage(mainItems) },
                { type: 'separator' },
                ...toolItems,
            ];
            mainItems = items.filter((item) => !item.tool);
            mainItems.splice(firstTool, 0, {
                label: t('gallery.contextTools', 'Tools'),
                icon: 'i-wand',
                keepOpen: true,
                opensPage: true,
                action: () => showPage(toolsPage),
            });
        }
        mainItems.forEach(renderItem);

        document.body.appendChild(menu);
        this._positionContextMenu(menu, e.clientX, e.clientY, anchorEl);

        // Scroll affordance: fade cue at the bottom while more items remain
        // below the fold (short windows), cleared when scrolled to the end.
        const updateScrollCue = () => {
            const moreBelow = menu.scrollHeight - menu.scrollTop - menu.clientHeight > 4;
            menu.classList.toggle('has-more-below', moreBelow);
        };
        menu.addEventListener('scroll', updateScrollCue, { passive: true });
        updateScrollCue();

        // Close on click outside or Escape.
        const closeMenu = () => {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('keydown', closeOnEscape);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') closeMenu();
        };
        // Escape works at once; only the outside-click listener waits a tick,
        // so the click that opened the menu does not close it (an Escape
        // pressed in that tick used to leave the menu open on a busy machine).
        document.addEventListener('keydown', closeOnEscape);
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    },

    _positionContextMenu(menu, clientX, clientY, anchorElement = null) {
        if (!menu) return;
        const anchorRect = anchorElement?.getBoundingClientRect?.() || null;
        const rawX = Number.isFinite(clientX) ? clientX : anchorRect?.right;
        const rawY = Number.isFinite(clientY) ? clientY : anchorRect?.top;
        const pointerInsideAnchor = anchorRect
            && rawX >= anchorRect.left - 1
            && rawX <= anchorRect.right + 1
            && rawY >= anchorRect.top - 1
            && rawY <= anchorRect.bottom + 1;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
        const x = anchorRect && !pointerInsideAnchor
            ? clamp(rawX ?? anchorRect.right, anchorRect.left, anchorRect.right)
            : (rawX ?? 8);
        const y = anchorRect && !pointerInsideAnchor
            ? clamp(rawY ?? anchorRect.top, anchorRect.top, anchorRect.bottom)
            : (rawY ?? 8);
        // Let the menu use the full viewport height (19 items ≈ 660px) so all
        // actions stay visible on desktop screens; PopupPosition still clamps
        // to the available space when the window is short.
        if (anchorRect && window.PopupPosition?.place) {
            const placement = anchorRect.right + 8 > window.innerWidth - 260
                ? 'left'
                : 'right';
            window.PopupPosition.place(menu, {
                anchor: anchorElement,
                placement,
                gap: 8,
                maxHeight: Math.max(120, window.innerHeight - 16),
            });
            return;
        }

        window.PopupPosition?.place(menu, {
            x,
            y,
            placement: 'point',
            maxHeight: Math.max(120, window.innerHeight - 16),
        });
    },

});
