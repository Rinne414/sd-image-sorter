/**
 * gallery/modal-preview.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 3534-4043 + 4179-4185 (of 4,708): copy-all/zoom/scroll state + openPreview + _hydratePreview.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _buildCopyAllText(image, parsedData, tags, promptView = null) {
        const loras = (() => {
            try {
                if (!image?.loras) return [];
                return typeof image.loras === 'string' ? JSON.parse(image.loras) : image.loras;
            } catch (_) {
                return [];
            }
        })();
        const currentPromptView = promptView || this._getModalPromptView() || this._buildConvertedPromptView(image, parsedData, 'original');
        const promptText = String(currentPromptView?.promptText ?? image?.prompt ?? '').trim();
        const negativeText = String(currentPromptView?.negativeText ?? image?.negative_prompt ?? '').trim();
        const paramsText = this._serializeGenerationParams(image, parsedData);

        const civitaiParts = [];
        if (promptText) civitaiParts.push(promptText);
        if (negativeText) civitaiParts.push(`Negative prompt: ${negativeText}`);
        if (paramsText) civitaiParts.push(paramsText);
        if (civitaiParts.length > 0) {
            return civitaiParts.join('\n');
        }

        const sections = [
            ['Filename', image?.filename],
            ['Path', image?.path],
            ['Generator', image?.generator],
            ['Size', image?.width && image?.height ? `${image.width}x${image.height}` : null],
            ['Prompt', currentPromptView?.promptText ?? image?.prompt],
            ['Negative', currentPromptView?.negativeText ?? image?.negative_prompt],
            ['Checkpoint', image?.checkpoint],
            ['LoRAs', loras.length ? loras.join(', ') : null],
            ['Tags', tags?.length ? tags.map(tag => tag.tag).join(', ') : null],
            ['Params', paramsText],
        ];

        return sections
            .filter(([, value]) => value != null && value !== '' && value !== 'undefined')
            .map(([label, value]) => `${label}:
${String(value)}`)
            .join('\n\n');
    },

    _cleanupZoomHandlers(modalImg = document.getElementById('modal-image')) {
        if (modalImg) {
            if (this._zoomWheelHandler) {
                modalImg.removeEventListener('wheel', this._zoomWheelHandler);
            }
            if (this._zoomMousedownHandler) {
                modalImg.removeEventListener('mousedown', this._zoomMousedownHandler);
            }
            if (this._zoomDblclickHandler) {
                modalImg.removeEventListener('dblclick', this._zoomDblclickHandler);
            }
            modalImg.style.cursor = 'default';
        }
        if (this._zoomMousemoveHandler) {
            document.removeEventListener('mousemove', this._zoomMousemoveHandler);
        }
        if (this._zoomMouseupHandler) {
            document.removeEventListener('mouseup', this._zoomMouseupHandler);
        }
        this._zoomWheelHandler = null;
        this._zoomMousedownHandler = null;
        this._zoomDblclickHandler = null;
        this._zoomMousemoveHandler = null;
        this._zoomMouseupHandler = null;
    },

    _getModalInfoScroller() {
        return document.querySelector('#image-modal .modal-info-scroll')
            || document.querySelector('#image-modal .modal-info');
    },

    _captureModalInfoScrollState() {
        const info = this._getModalInfoScroller();
        if (!info) return null;
        const maxScroll = Math.max(0, info.scrollHeight - info.clientHeight);
        return {
            top: info.scrollTop || 0,
            ratio: maxScroll > 0 ? (info.scrollTop || 0) / maxScroll : 0,
        };
    },

    _cancelModalInfoScrollRestore() {
        const pending = this._modalInfoScrollRestore;
        if (!pending) return;
        this._modalInfoScrollRestore = null;
        if (pending.rafId) cancelAnimationFrame(pending.rafId);
        if (pending.timerId) window.clearTimeout(pending.timerId);
        pending.detach();
    },

    _restoreModalInfoScrollState(scrollState) {
        // A new restore supersedes any still-pending one so rapid prev/next
        // navigation cannot replay a stale snapshot.
        this._cancelModalInfoScrollRestore();
        const info = this._getModalInfoScroller();
        if (!info || !scrollState) return;
        const apply = () => {
            const maxScroll = Math.max(0, info.scrollHeight - info.clientHeight);
            if (maxScroll <= 0) return;
            const targetTop = Math.max(scrollState.top || 0, (scrollState.ratio || 0) * maxScroll);
            info.scrollTop = Math.min(maxScroll, targetTop);
        };
        // Cancel the delayed re-apply as soon as the user scrolls on their
        // own — otherwise the 120ms timer snaps their position back.
        const userScrollEvents = ['wheel', 'touchstart', 'mousedown'];
        const onUserScroll = () => this._cancelModalInfoScrollRestore();
        userScrollEvents.forEach((type) => info.addEventListener(type, onUserScroll, { passive: true }));
        const pending = {
            rafId: 0,
            timerId: 0,
            detach: () => userScrollEvents.forEach((type) => info.removeEventListener(type, onUserScroll)),
        };
        this._modalInfoScrollRestore = pending;
        pending.rafId = requestAnimationFrame(() => {
            pending.rafId = requestAnimationFrame(() => {
                pending.rafId = 0;
                apply();
            });
        });
        pending.timerId = window.setTimeout(() => {
            pending.timerId = 0;
            apply();
            this._cancelModalInfoScrollRestore();
        }, 120);
    },

    _closeModalCopyMenu() {
        document.getElementById('modal-copy-menu')?.removeAttribute('open');
    },

    _closeModalToolsMenu() {
        document.getElementById('modal-tools-menu')?.removeAttribute('open');
    },

    async openPreview(imageId) {
        const { $, showModal, formatSize, showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const wasModalVisible = document.getElementById('image-modal')?.classList.contains('visible');
        const modalInfoScrollState = wasModalVisible ? this._captureModalInfoScrollState() : null;
        this._pendingModalInfoScrollState = modalInfoScrollState;

        // Reset zoom/pan transform when opening a new preview (including adjacent navigation)
        const modalImgReset = $('#modal-image');
        if (modalImgReset) {
            modalImgReset.style.transform = '';
            modalImgReset.style.cursor = 'default';
        }

        this._initSectionToggles();
        const summaryImage = this.images.find(image => image.id === imageId) || window.App?.AppState?.images?.find(image => image.id === imageId);
        this.currentPreviewIndex = this.images.findIndex(image => image.id === imageId);
        this._currentPreviewId = imageId;
        // FLOW-03: bind the modal handoff row once (delegated). The row sends the
        // currently-previewed image into the next pipeline step.
        if (!this._handoffBound) {
            this._handoffBound = true;
            document.querySelector('.modal-handoff-row')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-modal-handoff]');
                if (!btn) return;
                e.preventDefault();
                this._closeModalToolsMenu();
                this._handleModalHandoff(btn.dataset.modalHandoff);
            });
        }
        if (!this._analysisBound) {
            this._analysisBound = true;
            document.querySelector('.modal-analysis-row')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-modal-analysis]');
                if (!btn) return;
                e.preventDefault();
                this._closeModalToolsMenu();
                this._handleModalAnalysis(btn.dataset.modalAnalysis);
            });
        }
        if (!this._modalCopyMenuOutsideBound) {
            this._modalCopyMenuOutsideBound = true;
            document.addEventListener('click', (event) => {
                const copyMenu = document.getElementById('modal-copy-menu');
                const toolsMenu = document.getElementById('modal-tools-menu');
                if (copyMenu?.hasAttribute('open') && !copyMenu.contains(event.target)) {
                    copyMenu.removeAttribute('open');
                }
                if (toolsMenu?.hasAttribute('open') && !toolsMenu.contains(event.target)) {
                    toolsMenu.removeAttribute('open');
                }
            });
        }
        this._syncModalAnalysisButtons();
        // FLOW-02: bind the inline tag-editor controls once, and make sure each
        // freshly-opened image starts in read-only (not a leftover edit session).
        this._bindTagEditOnce();
        this._exitTagEdit();
        this.currentPreviewRequestId += 1;
        const requestId = this.currentPreviewRequestId;
        this.showAllTags = false;
        this._lastModalImage = null;
        this._lastModalTags = [];
        this._lastParsedData = null;

        // Show skeleton modal content while loading. When the modal is
        // ALREADY showing an image (prev/next navigation), keep it on screen
        // and swap only after the next image has decoded — hiding it first
        // produced a black flash on every switch (owner 2026-07-05, design
        // rule: no uncomfortable/rapid flashes).
        const modalImgEl = $('#modal-image');
        const isRenavigation = !!(modalImgEl?.getAttribute('src'))
            && !!document.getElementById('image-modal')?.classList.contains('visible');
        if (window.SkeletonModal) {
            window.SkeletonModal.showImageModal('image-modal', { keepImage: isRenavigation });
        }

        const nextImageUrl = API?.getImageUrl?.(imageId) ?? `/api/image-file/${imageId}`;
        // When image loads, hide the skeleton
        modalImgEl.onload = () => {
            if (window.SkeletonModal) {
                window.SkeletonModal.hideImageModal('image-modal');
            }
        };
        if (isRenavigation) {
            const preload = new Image();
            preload.src = nextImageUrl;
            const applyPreloaded = () => {
                if (requestId !== this.currentPreviewRequestId) return; // user moved on
                modalImgEl.src = nextImageUrl;
            };
            if (typeof preload.decode === 'function') {
                preload.decode().then(applyPreloaded).catch(applyPreloaded);
            } else {
                preload.onload = applyPreloaded;
                preload.onerror = applyPreloaded;
            }
        } else {
            modalImgEl.src = nextImageUrl;
        }
        $('#modal-filename').textContent = summaryImage?.filename || `Image #${imageId}`;
        const modalGenerator = $('#modal-generator');
        if (modalGenerator) {
            const summaryGenerator = summaryImage?.generator || '';
            modalGenerator.dataset.generatorValue = this._normalizeGenerator(summaryGenerator);
            modalGenerator.textContent = summaryGenerator
                ? this._formatGeneratorLabel(summaryGenerator)
                : '-';
        }
        // Show the "we only check metadata, not the invisible pixel
        // watermark" note for closed-source AI providers (Gemini /
        // gpt-image). Hide for everything else. Stay in sync with
        // backend/metadata_parser.py — when a new closed-AI provider
        // gets a metadata-only detector but no in-pixel detector,
        // add it here so the user is aware.
        this._updateAiProviderNote(summaryImage?.generator);
        $('#modal-size').textContent = summaryImage ? `${summaryImage.width || '?'}×${summaryImage.height || '?'} • ${formatSize(summaryImage.file_size || 0)}` : '-';
        this._renderModalRating(summaryImage || { id: imageId, user_rating: 0 });
        $('#modal-prompt-text').textContent = summaryImage?.prompt || this._t('modal.loadingPrompt', null, 'Loading prompt…');
        $('#modal-negative-text').textContent = this._t('modal.loadingNegative', null, 'Loading…');
        $('#modal-loading-state').textContent = this._t('modal.loadingDetails', null, 'Loading details…');
        $('#modal-loading-state').style.display = '';
        document.querySelector('#modal-tags-list').textContent = this._t('modal.loadingTags', null, 'Loading tags…');
        document.querySelector('#modal-tags-list').style.color = 'var(--text-muted)';
        $('#btn-toggle-prompt-format').disabled = true;
        $('#btn-toggle-prompt-format').textContent = this._t('modal.viewAsSD', null, 'View as SD');
        ['#modal-loras-section', '#modal-negative-section', '#modal-characters-section', '#modal-params-section', '#modal-model-assets-section', '#modal-img2img-section', '#modal-nodes-section', '#modal-caption-section'].forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
            }
        });
        document.querySelector('#modal-key-params').style.display = 'none';
        document.querySelector('#modal-checkpoint-item').style.display = 'none';
        const aeItemReset = document.querySelector('#modal-aesthetic-item');
        if (aeItemReset) aeItemReset.style.display = 'none';
        document.querySelector('#modal-img2img-badge').style.display = 'none';
        document.querySelector('#modal-loras-list').innerHTML = '';
        document.querySelector('#modal-characters-list').innerHTML = '';
        document.querySelector('#modal-params-grid').innerHTML = '';
        document.querySelector('#modal-model-assets-grid').innerHTML = '';
        document.querySelector('#modal-img2img-info').innerHTML = '';
        document.querySelector('#modal-nodes-list').innerHTML = '';
        $('#btn-reparse-metadata').onclick = async () => {
            try {
                $('#modal-loading-state').textContent = this._t('modal.reparsing', null, 'Reading image info again…');
                $('#modal-loading-state').style.display = '';
                const reparsed = await API.reparseImage(imageId);
                if (requestId !== this.currentPreviewRequestId) return;
                this._hydratePreview(reparsed.image, reparsed.tags);
                showToast?.(this._t('modal.metadataReparsed', null, 'Image info refreshed'), 'success');
            } catch (error) {
                showToast?.(formatUserError(error, this._t('modal.failedReparse', null, 'Could not read the image info again')), "error");
            }
        };
        $('#modal-prev-image').onclick = () => this.openAdjacentPreview(-1);
        $('#modal-next-image').onclick = () => this.openAdjacentPreview(1);

        if (this._modalKeydownHandler) {
            document.removeEventListener('keydown', this._modalKeydownHandler);
        }
        this._modalKeydownHandler = (e) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.openAdjacentPreview(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.openAdjacentPreview(1);
            } else if (e.key === 'Escape') {
                document.removeEventListener('keydown', this._modalKeydownHandler);
                this._modalKeydownHandler = null;
                const closeModal = window.App?.closeModal || window.closeModal;
                if (typeof closeModal === 'function') {
                    closeModal('image-modal');
                }
            }
        };
        document.addEventListener('keydown', this._modalKeydownHandler);
        $('#btn-toggle-all-tags').onclick = () => {
            this.showAllTags = !this.showAllTags;
            this._renderModalTags(this._lastModalTags || []);
        };

        const copyToClipboard = async (text, successMessage) => {
            try {
                await navigator.clipboard.writeText(text || '');
                showToast?.(successMessage, 'success');
            } catch (error) {
                showToast?.(this._t('modal.copyFailed', null, 'Failed to copy text'), 'error');
            } finally {
                this._closeModalCopyMenu();
            }
        };
        const getPromptView = () => this._getModalPromptView() || this._buildPromptView(this._lastModalImage, this._lastParsedData, 'original');
        $('#btn-toggle-prompt-format').onclick = () => this._togglePromptFormat();
        $('#btn-copy-prompt').onclick = () => copyToClipboard((getPromptView().promptText || ''), this._t('modal.promptCopied', null, 'Prompt copied'));
        $('#btn-copy-negative').onclick = () => copyToClipboard((getPromptView().negativeText || ''), this._t('modal.negativeCopied', null, 'Negative prompt copied'));
        $('#btn-copy-tags').onclick = () => copyToClipboard((this._lastModalTags || []).map(tag => tag.tag).join(', '), this._t('modal.tagsCopied', null, 'Tags copied'));
        const tagCategoryButton = document.querySelector('#btn-copy-tags-category');
        if (tagCategoryButton) {
            tagCategoryButton.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._closeModalCopyMenu();
                window.TagCategoryCopy?.showMenu?.({
                    anchor: tagCategoryButton,
                    source: {
                        imageId: this._lastModalImage?.id,
                        image: this._lastModalImage,
                        tags: this._lastModalTags || [],
                        prompt: getPromptView().promptText || '',
                    },
                    title: this._t('tagCategory.copyOptions', null, 'Copy Options'),
                });
            };
        }
        const btnCopyCaption = document.querySelector('#btn-copy-caption');
        if (btnCopyCaption) {
            btnCopyCaption.onclick = () => copyToClipboard(
                document.querySelector('#modal-caption-text')?.textContent || '',
                this._t('modal.captionCopied', null, 'Caption copied')
            );
        }
        $('#btn-copy-params').onclick = () => copyToClipboard(
            this._serializeGenerationParams(this._lastModalImage, this._lastParsedData),
            this._t('modal.paramsCopied', null, 'Image settings copied')
        );
        $('#btn-copy-all').onclick = () => copyToClipboard(this._buildCopyAllText(this._lastModalImage, this._lastParsedData, this._lastModalTags, getPromptView()), this._t('modal.allCopied', null, 'All image info copied'));
        $('#btn-open-folder').onclick = async () => {
            const image = this._lastModalImage;
            if (!image?.id) return;
            try {
                const API = getRequiredGalleryAPI();
                await API.openFolder(image.id);
            } catch (error) {
                showToast?.(this._t('modal.openFolderFailed', null, 'Failed to open folder'), 'error');
            }
        };

        showModal?.('image-modal');
        if (modalInfoScrollState) {
            this._restoreModalInfoScrollState(modalInfoScrollState);
        } else {
            const info = this._getModalInfoScroller();
            if (info) info.scrollTop = 0;
        }

        // Zoom/pan for modal image
        {
            const modalImg = $('#modal-image');
            let scale = 1;
            let translateX = 0;
            let translateY = 0;
            let isPanning = false;
            let startX = 0;
            let startY = 0;

            const resetZoom = () => {
                scale = 1;
                translateX = 0;
                translateY = 0;
                modalImg.style.transform = '';
                modalImg.style.cursor = 'default';
            };

            this._cleanupZoomHandlers(modalImg);

            this._zoomWheelHandler = (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                scale = Math.max(0.5, Math.min(scale * delta, 10));
                if (Math.abs(scale - 1) < 0.05) { resetZoom(); return; }
                modalImg.style.transform = `scale(${scale}) translate(${translateX}px, ${translateY}px)`;
                modalImg.style.cursor = scale > 1 ? 'grab' : 'default';
            };

            this._zoomMousedownHandler = (e) => {
                if (scale <= 1) return;
                isPanning = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                modalImg.style.cursor = 'grabbing';
                e.preventDefault();
            };

            this._zoomMousemoveHandler = (e) => {
                if (!isPanning) return;
                translateX = e.clientX - startX;
                translateY = e.clientY - startY;
                modalImg.style.transform = `scale(${scale}) translate(${translateX}px, ${translateY}px)`;
            };

            this._zoomMouseupHandler = () => {
                if (isPanning) {
                    isPanning = false;
                    modalImg.style.cursor = scale > 1 ? 'grab' : 'default';
                }
            };

            this._zoomDblclickHandler = resetZoom;

            modalImg.addEventListener('wheel', this._zoomWheelHandler, { passive: false });
            modalImg.addEventListener('mousedown', this._zoomMousedownHandler);
            document.addEventListener('mousemove', this._zoomMousemoveHandler);
            document.addEventListener('mouseup', this._zoomMouseupHandler);
            modalImg.addEventListener('dblclick', this._zoomDblclickHandler);
        }

        try {
            const result = await API.getImage(imageId);
            if (requestId !== this.currentPreviewRequestId) {
                return;
            }
            this._hydratePreview(result.image, result.tags);
        } catch (error) {
            if (requestId !== this.currentPreviewRequestId) {
                return;
            }
            $('#modal-loading-state').textContent = this._t('modal.failedLoadDetails', null, 'Failed to load details');
            showToast?.(this._t('modal.failedLoadDetails', null, 'Failed to load details'), 'error');
        }
    },

    _hydratePreview(image, tags) {
        const { $, formatSize } = getGalleryAppContext();

        // Hide skeleton modal content
        if (window.SkeletonModal) {
            window.SkeletonModal.hideImageModal('image-modal');
        }

        $('#modal-filename').textContent = image.filename;
        const pathEl = $('#modal-file-path');
        const subfolderEl = $('#modal-file-subfolder');
        if (pathEl) {
            const normalizedPath = String(image.path || '');
            const pathParts = normalizedPath.replace(/\\/g, '/').split('/');
            pathParts.pop();
            const parentFolder = pathParts.pop() || '';
            pathEl.textContent = normalizedPath;
            pathEl.title = image.path || '';
            if (subfolderEl) {
                subfolderEl.textContent = parentFolder || '';
                subfolderEl.title = parentFolder || '';
                subfolderEl.style.display = parentFolder ? '' : 'none';
            }
            pathEl.closest('.modal-path-row')?.style.setProperty('display', image.path ? '' : 'none');
        }
        const modalGeneratorFinal = $('#modal-generator');
        if (modalGeneratorFinal) {
            modalGeneratorFinal.dataset.generatorValue = this._normalizeGenerator(image.generator);
            modalGeneratorFinal.textContent = this._formatGeneratorLabel(image.generator);
        }
        $('#modal-size').textContent = `${image.width}×${image.height} • ${formatSize(image.file_size)}`;
        this._renderModalRating(image);
        $('#modal-prompt-text').textContent = image.prompt || this._t('modal.noPrompt', null, 'No prompt');
        const parsedData = this._extractParsedData(image);
        this._lastModalImage = image;
        this._lastModalTags = tags;
        this._lastParsedData = parsedData;

        this._renderModalSections(image, parsedData);
        this._renderModalTags(tags);
        this._renderModalCaption(image);
        this._applyModalPromptView(this._buildPromptView(image, parsedData, 'original'));
        this._applyModalSectionStates();
        $('#modal-loading-state').style.display = 'none';
        $('#btn-toggle-all-tags').textContent = this._t('modal.showMore', null, 'Show More');
        this._restoreModalInfoScrollState(this._pendingModalInfoScrollState);

        // Extract and display color distribution
        this._extractColorDistribution($('#modal-image'));
    },

    openAdjacentPreview(direction) {
        if (!this.images.length || this.currentPreviewIndex < 0) return;
        const nextIndex = this.currentPreviewIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.images.length) return;
        this.openPreview(this.images[nextIndex].id);
    },

});
