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
        const t = (key, fallback, params) => { const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : fallback; };
        const app = window.App || {};
        const imageId = Number(image?.id);
        const selectedIds = app.AppState?.selectedIds instanceof Set ? app.AppState.selectedIds : new Set();
        const isSelected = selectedIds.has(imageId) || selectedIds.has(String(image?.id));
        const selectedImageIds = Array.from(selectedIds)
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
                .replace('{count}', String(actionCount))
            : '';
        const labelWithScope = (key, fallback) => {
            const label = t(key, fallback);
            return scopeLabel ? `${label} · ${scopeLabel}` : label;
        };
        const tagCopySource = { imageId: image.id, image };

        const items = [
            { label: t('gallery.contextPreview', 'Preview'), icon: '\u{1F5BC}', action: () => this.openPreview(image.id) },
            { label: isSelected ? t('gallery.contextDeselectImage', 'Deselect Image') : t('gallery.contextSelectImage', 'Select Image'), icon: isSelected ? '\u2715' : '\u2713', action: () => this._setContextImageSelection(image.id, !isSelected) },
            { type: 'separator' },
            { label: t('gallery.contextCopyTags', 'Copy Tags'), icon: '\u{1F3F7}', action: async () => {
                const copy = window.TagCategoryCopy;
                if (!copy) {
                    app.showToast?.(t('modal.copyFailed', 'Failed to copy text'), 'error');
                    return;
                }
                const tags = await copy.getTagsFromSource(tagCopySource);
                await copy.copyTags(tags, t('modal.tagsCopied', 'Tags copied'));
            }},
            { label: t('gallery.contextCopyTagCategory', 'Copy Tag Category...'), icon: '\u25BE', action: (event) => {
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
              icon: this.isFavorited(image.id) ? '\u{1F494}' : '♥',
              action: () => this.toggleFavorite(image.id) },
            { label: labelWithScope('collections.contextAddTo', 'Add to collection…'), icon: '\u{1F4DA}',
              action: () => window.CollectionsUI?.openAddToCollectionPicker?.(actionImageIds) },
            { type: 'separator' },
            { label: labelWithScope('gallery.contextMoveImage', 'Move...'), icon: '\u{1F4C1}', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'move', { source: 'context' }) },
            { label: labelWithScope('gallery.contextCopyImage', 'Copy...'), icon: '\u{1F4C4}', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'copy', { source: 'context' }) },
            { type: 'separator' },
            { label: labelWithScope('gallery.contextSendToCensor', 'Send to Censor'), icon: '\u{1F533}', action: () => {
                if (typeof app.addToCensorQueue === 'function') {
                    app.addToCensorQueue(actionImageIds);
                } else {
                    app.showToast?.(t('gallery.contextSendToCensorFailed', 'Failed to send image to Edit'), 'error');
                }
            }},
            { label: labelWithScope('modal.addToDataset', 'Add to dataset'), icon: '\u{1F4E6}', action: () => app.addToDatasetMaker?.(actionImageIds, { switchView: true, showToast: true }) },
            { label: t('gallery.contextFindSimilar', 'Find Similar'), icon: '\u{1F50E}', action: () => app.openSimilarFromImage?.(image.id) },
            { label: t('gallery.contextNearDuplicates', 'Find near-duplicates (CLIP)'), icon: '\u{1F46F}', action: () => window.ClipTools?.near?.(image.id) },
            actionCount === 2
                ? { label: t('gallery.contextCompareTwo', 'Compare 2 images (CLIP)'), icon: '⚖️', action: () => window.ClipTools?.compare?.(actionImageIds[0], actionImageIds[1]) }
                : null,
            { label: t('gallery.contextPromptHelper', 'Prompt Helper'), icon: '\u{1F9EA}', action: () => app.openPromptBuildFromImage?.(image.id) },
            { label: t('gallery.contextReadMetadata', 'Metadata / Info'), icon: '\u{1F4D6}', action: () => app.openReaderFromImage?.(image.id, image.filename || '') },
            checkpointFilterValue ? { label: t('gallery.contextFilterCheckpoint', 'Filter by Checkpoint'), icon: '\u{1F50D}', action: () => {
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
            { label: t('gallery.contextOpenFolder', 'Open in Folder'), icon: '\u{1F4C2}', action: () => {
                app.API?.openFolder?.(image.id);
            }},
            { label: t('gallery.contextCopyPath', 'Copy Path'), icon: '\u{1F4CB}', action: () => {
                if (typeof app.copyTextToClipboard === 'function') {
                    app.copyTextToClipboard(image.path || '', t('gallery.pathCopied', 'Path copied'));
                } else {
                    navigator.clipboard.writeText(image.path || '');
                    app.showToast?.(t('gallery.pathCopied', 'Path copied'), 'success');
                }
            }},
            { type: 'separator' },
            { label: labelWithScope('gallery.contextRemoveFromGallery', 'Remove from Gallery'), icon: '\u{1F9F9}', danger: true, action: () => app.removeGalleryImagesByIds?.(actionImageIds) },
            { label: labelWithScope('gallery.contextMoveToTrash', 'Move to Trash...'), icon: '\u{1F5D1}', danger: true, action: () => app.deleteGalleryImagesByIds?.(actionImageIds) },
        ].filter(Boolean);

        items.forEach((item) => {
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
            icon.textContent = item.icon;

            const label = document.createElement('span');
            label.className = 'context-menu-label';
            label.textContent = item.label;

            button.append(icon, label);
            button.addEventListener('click', (event) => {
                Promise.resolve(item.action(event, menu)).catch((error) => {
                    const message = typeof formatUserError === 'function'
                        ? formatUserError(error, t('modal.copyFailed', 'Failed to copy text'))
                        : t('modal.copyFailed', 'Failed to copy text');
                    app.showToast?.(message, 'error');
                });
                menu.remove();
            });
            menu.appendChild(button);
        });

        document.body.appendChild(menu);
        this._positionContextMenu(menu, e.clientX, e.clientY, e.currentTarget || e.target?.closest?.('.gallery-item'));

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
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
            document.addEventListener('keydown', closeOnEscape);
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
