/**
 * gallery/metadata-editor.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 4515-4697 (of 4,708): metadata editor from gallery (_metadataBackup data prop rides along).
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    // ============== Metadata Editing from Gallery ==============
    _metadataBackup: {},

    openMetadataEditor() {
        const image = this._lastModalImage;
        if (!image || !image.id) return;

        const { $ } = getGalleryAppContext();
        const modal = $('#metadata-editor-modal');
        if (!modal) return;

        // Populate form fields with current data
        const parsedData = this._lastParsedData || {};
        $('#meta-edit-prompt').value = image.prompt || '';
        $('#meta-edit-negative').value = image.negative_prompt || '';
        $('#meta-edit-seed').value = parsedData.seed || '';
        $('#meta-edit-sampler').value = parsedData.sampler || '';
        $('#meta-edit-steps').value = parsedData.steps || '';
        $('#meta-edit-cfg').value = parsedData.cfg_scale || '';
        $('#meta-edit-checkpoint').value = parsedData.model || image.checkpoint || '';
        $('#meta-edit-loras').value = Array.isArray(image.loras) ? image.loras.join(', ') : '';
        $('#meta-edit-format').value = 'png';

        modal.dataset.imageId = image.id;
        modal.dataset.imagePath = image.path || '';
        showModal('metadata-editor-modal');
    },

    async saveMetadataEdit() {
        const { $, showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const modal = $('#metadata-editor-modal');
        if (!modal) return;

        const imageId = Number(modal.dataset.imageId);
        const sourcePath = modal.dataset.imagePath;
        if (!imageId || !sourcePath) {
            showToast?.(this._t('modal.editNoPath', null, 'Cannot save: image path not found'), 'error');
            return;
        }

        try {
            // Backup current metadata
            const currentImage = this._lastModalImage;
            this._metadataBackup[imageId] = {
                prompt: currentImage.prompt,
                negative_prompt: currentImage.negative_prompt,
                checkpoint: currentImage.checkpoint,
                loras: currentImage.loras,
                parsedData: { ...this._lastParsedData }
            };

            // Collect edited metadata
            const metadata = {
                prompt: $('#meta-edit-prompt').value.trim(),
                negative: $('#meta-edit-negative').value.trim(),
                seed: $('#meta-edit-seed').value.trim(),
                sampler: $('#meta-edit-sampler').value.trim(),
                steps: $('#meta-edit-steps').value.trim(),
                cfg_scale: $('#meta-edit-cfg').value.trim(),
                model: $('#meta-edit-checkpoint').value.trim(),
                loras: $('#meta-edit-loras').value.trim()
            };

            const format = $('#meta-edit-format').value || 'png';

            // Save edited metadata (overwrite in-place)
            await API.saveEditedMetadata(sourcePath, sourcePath, format, metadata, true);

            // Update in-memory data
            currentImage.prompt = metadata.prompt;
            currentImage.negative_prompt = metadata.negative;
            if (metadata.model) currentImage.checkpoint = metadata.model;
            if (metadata.loras) {
                currentImage.loras = metadata.loras.split(',').map(l => l.trim()).filter(Boolean);
            }

            // Update parsed data
            if (this._lastParsedData) {
                if (metadata.seed) this._lastParsedData.seed = metadata.seed;
                if (metadata.sampler) this._lastParsedData.sampler = metadata.sampler;
                if (metadata.steps) this._lastParsedData.steps = metadata.steps;
                if (metadata.cfg_scale) this._lastParsedData.cfg_scale = metadata.cfg_scale;
                if (metadata.model) this._lastParsedData.model = metadata.model;
            }

            // Update modal display without full reload
            this._hydratePreview(currentImage, this._lastModalTags);

            // Update gallery card if visible
            this._updateGalleryCardInPlace(imageId, currentImage);

            // Close editor modal
            closeModal('metadata-editor-modal');

            // Show success toast with Undo
            showToast?.(
                this._t('modal.metadataUpdated', null, 'Metadata updated'),
                'success',
                {
                    duration: 10000,
                    actionLabel: this._t('modal.undo', null, 'Undo'),
                    onAction: () => this.undoMetadataEdit(imageId)
                }
            );
        } catch (error) {
            showToast?.(
                formatUserError(error, this._t('modal.editFailed', null, 'Failed to save metadata')),
                'error'
            );
        }
    },

    async undoMetadataEdit(imageId) {
        const backup = this._metadataBackup[imageId];
        if (!backup) return;

        const { showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const currentImage = this._lastModalImage;
        if (!currentImage || currentImage.id !== imageId) return;

        try {
            const sourcePath = currentImage.path;
            if (!sourcePath) return;

            // Restore from backup
            const metadata = {
                prompt: backup.prompt || '',
                negative: backup.negative_prompt || '',
                seed: backup.parsedData?.seed || '',
                sampler: backup.parsedData?.sampler || '',
                steps: backup.parsedData?.steps || '',
                cfg_scale: backup.parsedData?.cfg_scale || '',
                model: backup.checkpoint || '',
                loras: Array.isArray(backup.loras) ? backup.loras.join(', ') : ''
            };

            await API.saveEditedMetadata(sourcePath, sourcePath, 'png', metadata, true);

            // Restore in-memory data
            currentImage.prompt = backup.prompt;
            currentImage.negative_prompt = backup.negative_prompt;
            currentImage.checkpoint = backup.checkpoint;
            currentImage.loras = backup.loras;
            this._lastParsedData = { ...backup.parsedData };

            // Update modal display
            this._hydratePreview(currentImage, this._lastModalTags);

            // Update gallery card
            this._updateGalleryCardInPlace(imageId, currentImage);

            // Clear backup
            delete this._metadataBackup[imageId];

            showToast?.(this._t('modal.metadataRestored', null, 'Metadata restored'), 'info');
        } catch (error) {
            showToast?.(
                formatUserError(error, this._t('modal.undoFailed', null, 'Failed to restore metadata')),
                'error'
            );
        }
    },

    _updateGalleryCardInPlace(imageId, updatedImage) {
        const card = document.querySelector(`#gallery-grid .gallery-item[data-id="${imageId}"]`);
        if (!card) return;

        // Update prompt text if visible
        const promptEl = card.querySelector('.gallery-item-prompt');
        if (promptEl && updatedImage.prompt) {
            promptEl.textContent = updatedImage.prompt;
            promptEl.title = updatedImage.prompt;
        }

        // Update checkpoint badge if visible
        const checkpointEl = card.querySelector('.gallery-item-checkpoint');
        if (checkpointEl && updatedImage.checkpoint) {
            checkpointEl.textContent = updatedImage.checkpoint;
            checkpointEl.title = updatedImage.checkpoint;
        }
    }
});
