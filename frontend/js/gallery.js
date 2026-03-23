/**
 * SD Image Sorter - Gallery Module
 * Handles image grid display, preview modal, multi-selection and drag-and-drop
 */

const Gallery = {
    images: [],
    loading: false,
    lazyObserver: null,
    currentPreviewIndex: -1,
    currentPreviewRequestId: 0,
    showAllTags: false,

    setImages(images) {
        this.images = images;
        this.render();
    },

    render() {
        const { $, AppState } = window.App || { $: (s) => document.querySelector(s), AppState: window.AppState };
        const grid = $('#gallery-grid');
        if (!grid) return;

        grid.innerHTML = '';
        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
        }

        if (this.images.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--text-secondary);">
                    <div style="font-size: 48px; margin-bottom: 16px;">📷</div>
                    <p>No images found. Click "Scan Folder" to add images.</p>
                </div>
            `;
            return;
        }

        const isWaterfall = AppState.viewMode === 'waterfall';
        if (!isWaterfall) {
            this.lazyObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target.querySelector('img');
                        if (img && img.dataset.src) {
                            img.onerror = () => {
                                img.src = 'data:image/svg+xml,' + encodeURIComponent(`
                                    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
                                        <rect fill="#1e293b" width="200" height="200"/>
                                        <text fill="#64748b" font-family="sans-serif" font-size="14" x="100" y="100" text-anchor="middle">Not found</text>
                                    </svg>
                                `);
                            };
                            img.src = img.dataset.src;
                            delete img.dataset.src;
                        }
                        observer.unobserve(entry.target);
                    }
                });
            }, { rootMargin: '200px' });
        }

        const fragment = document.createDocumentFragment();
        this.images.forEach((image, index) => {
            const item = this.createGalleryItem(image, index, isWaterfall);
            fragment.appendChild(item);
            if (this.lazyObserver && !isWaterfall) {
                this.lazyObserver.observe(item);
            }
        });

        grid.appendChild(fragment);
    },

    createGalleryItem(image, index, isWaterfall = false) {
        const { API, AppState } = window.App || { API: window.API, AppState: window.AppState };
        const genColors = window.GENERATOR_COLORS || {
            comfyui: '#22c55e',
            nai: '#f97316',
            webui: '#3b82f6',
            forge: '#8b5cf6',
            unknown: '#64748b'
        };

        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (isWaterfall) {
            item.classList.add('waterfall-item');
        }
        if (AppState.selectedIds.has(image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;

        const safeFilename = (image.filename || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const star = image.is_favorite ? '★' : '☆';
        const thumbSize = AppState.viewMode === 'large' ? 512 : AppState.viewMode === 'waterfall' ? 384 : 256;
        const thumbnailUrl = API.getThumbnailUrl(image.id, thumbSize);
        const imageTag = isWaterfall
            ? `<img src="${thumbnailUrl}" alt="${safeFilename}" loading="lazy">`
            : `<img data-src="${thumbnailUrl}" alt="${safeFilename}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`;

        item.innerHTML = `
            ${imageTag}
            <button class="gallery-favorite-btn" type="button" aria-label="Toggle favorite">${star}</button>
            <div class="gallery-item-overlay">
                <span class="gallery-item-generator" style="background: ${genColors[image.generator] || genColors.unknown}">
                    ${this._escapeHtml(image.generator)}
                </span>
            </div>
        `;

        item.addEventListener('click', () => {
            if (AppState.selectionMode) {
                this.toggleSelection(image.id);
            } else {
                this.openPreview(image.id);
            }
        });

        const favoriteBtn = item.querySelector('.gallery-favorite-btn');
        favoriteBtn?.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await this.toggleFavorite(image.id);
        });

        item.addEventListener('dragstart', (e) => {
            const imgUrl = API.getImageUrl(image.id);
            const absoluteUrl = new URL(imgUrl, window.location.origin).href;
            e.dataTransfer.setData('text/uri-list', absoluteUrl);
            e.dataTransfer.setData('text/plain', absoluteUrl);
            const mimeType = image.filename.toLowerCase().endsWith('.png') ? 'image/png' :
                image.filename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            e.dataTransfer.setData('DownloadURL', `${mimeType}:${image.filename}:${absoluteUrl}`);
            const img = item.querySelector('img');
            if (img && img.src) {
                e.dataTransfer.setDragImage(img, 50, 50);
            }
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'copyMove';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        return item;
    },

    _setFavoriteState(imageId, isFavorite, favoriteCopyPath = null) {
        this.images = this.images.map(image => image.id === imageId ? { ...image, is_favorite: isFavorite, favorite_copy_path: favoriteCopyPath } : image);
        if (window.App?.AppState?.images) {
            window.App.AppState.images = window.App.AppState.images.map(image => image.id === imageId ? { ...image, is_favorite: isFavorite, favorite_copy_path: favoriteCopyPath } : image);
        }

        document.querySelectorAll(`.gallery-item[data-id="${imageId}"] .gallery-favorite-btn`).forEach(btn => {
            btn.textContent = isFavorite ? '★' : '☆';
        });

        const modalFavoriteBtn = document.querySelector('#modal-favorite-toggle');
        if (modalFavoriteBtn && this.currentPreviewIndex >= 0 && this.images[this.currentPreviewIndex]?.id === imageId) {
            modalFavoriteBtn.textContent = isFavorite ? '★ Favorited' : '★ Favorite';
        }
        if (this._lastModalImage?.id === imageId) {
            this._lastModalImage = {
                ...this._lastModalImage,
                is_favorite: isFavorite,
                favorite_copy_path: favoriteCopyPath,
            };
        }
    },

    async toggleFavorite(imageId) {
        const { API, showToast } = window.App || { API: window.API, showToast: window.showToast };
        const current = this.images.find(image => image.id === imageId) || window.App?.AppState?.images?.find(image => image.id === imageId);
        const isFavorite = !!current?.is_favorite;

        try {
            if (isFavorite) {
                await API.removeFromFavorites(imageId);
                this._setFavoriteState(imageId, false, null);
                showToast?.('Removed from Favorites', 'success');
            } else {
                const result = await API.addToFavorites(imageId);
                this._setFavoriteState(imageId, true, result.copied_path || null);
                showToast?.('Added to Favorites', 'success');
            }
        } catch (error) {
            showToast?.('Failed to update Favorites: ' + error.message, 'error');
        }
    },

    toggleSelection(imageId) {
        const { $, AppState, updateSelectionUI } = window.App || { $: (s) => document.querySelector(s), AppState: window.AppState, updateSelectionUI: window.updateSelectionUI };

        const isNowSelected = !AppState.selectedIds.has(imageId);

        if (isNowSelected) {
            AppState.selectedIds.add(imageId);
        } else {
            AppState.selectedIds.delete(imageId);
        }

        // Update DOM element if it exists in the current view
        const item = document.querySelector(`.gallery-item[data-id="${imageId}"]`);
        if (item) {
            item.classList.toggle('selected', isNowSelected);
        }

        // Force VirtualGallery to re-render visible rows to reflect selection changes
        // (items not currently in DOM will pick up selection state when scrolled into view)
        if (window.VirtualGallery && window.VirtualGallery.initialized) {
            // Only re-render if the item wasn't found in DOM (it's in a virtual row)
            if (!item) {
                window.VirtualGallery.renderVisible();
            }
        }

        if (updateSelectionUI) updateSelectionUI();
    },

    /**
     * Extract parsed metadata from image, with JS fallback for old images.
     * Returns { generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes }
     */
    _extractParsedData(image) {
        // Try to get _parsed from metadata_json
        let metaObj = null;
        if (image.metadata_json) {
            try {
                metaObj = typeof image.metadata_json === 'string'
                    ? JSON.parse(image.metadata_json)
                    : image.metadata_json;
            } catch (_) {
                metaObj = null;
            }
        }

        if (metaObj && metaObj._parsed) {
            return metaObj._parsed;
        }

        // Fallback: try to extract from raw metadata for old images
        return this._fallbackParseMeta(metaObj, image);
    },

    /**
     * JS fallback parser for images scanned before parser enhancement.
     * Extracts what we can from raw metadata_json.
     */
    _fallbackParseMeta(metaObj, image) {
        const result = {
            generation_params: null,
            is_img2img: false,
            img2img_info: null,
            character_prompts: null,
            prompt_nodes: null,
        };

        if (!metaObj) return result;
        const gen = (image.generator || '').toLowerCase();

        // --- WebUI / Forge fallback ---
        if (gen === 'webui' || gen === 'forge') {
            const params = metaObj.parameters || '';
            const paramsLine = this._extractWebUIParamsLine(params);
            if (paramsLine) {
                result.generation_params = this._parseGenParamsLine(paramsLine);
            }
            // img2img detection
            if (result.generation_params && result.generation_params.denoising_strength != null) {
                const hasHires = result.generation_params.hires_upscaler != null;
                if (!hasHires) {
                    result.is_img2img = true;
                    result.img2img_info = { denoising_strength: result.generation_params.denoising_strength };
                }
            }
        }

        // --- NAI fallback ---
        if (gen === 'nai') {
            // Try Comment (PNG) or UserComment (WebP) or Description
            let naiData = null;
            const commentSources = [metaObj.Comment, metaObj.UserComment, metaObj.Description];
            for (const src of commentSources) {
                if (!src) continue;
                let raw = src;
                // Strip ASCII prefix from EXIF UserComment
                if (typeof raw === 'string' && raw.startsWith('ASCII')) {
                    raw = raw.replace(/^ASCII[\x00]*/,'');
                }
                try {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    // Validate it looks like NAI data (has prompt or steps)
                    if (parsed && (parsed.steps != null || parsed.prompt != null || parsed.Description != null)) {
                        naiData = parsed;
                        break;
                    }
                } catch (_) { /* ignore */ }
            }
            if (naiData) {
                // Gen params
                const gp = {};
                if (naiData.steps != null) gp.steps = naiData.steps;
                if (naiData.sampler != null) gp.sampler = naiData.sampler;
                if (naiData.seed != null) gp.seed = naiData.seed;
                if (naiData.scale != null) gp.cfg_scale = naiData.scale;
                if (naiData.strength != null) gp.strength = naiData.strength;
                if (naiData.noise != null) gp.noise = naiData.noise;
                if (naiData.sm != null) gp.sm = naiData.sm;
                if (naiData.sm_dyn != null) gp.sm_dyn = naiData.sm_dyn;
                if (naiData.cfg_rescale != null) gp.cfg_rescale = naiData.cfg_rescale;
                if (naiData.noise_schedule != null) gp.noise_schedule = naiData.noise_schedule;
                if (naiData.uncond_scale != null) gp.uncond_scale = naiData.uncond_scale;
                if (naiData.skip_cfg_above_sigma != null) gp.skip_cfg_above_sigma = naiData.skip_cfg_above_sigma;
                if (Object.keys(gp).length > 0) result.generation_params = gp;

                // img2img
                if (naiData.strength != null && naiData.strength < 1.0) {
                    result.is_img2img = true;
                    result.img2img_info = { strength: naiData.strength, noise: naiData.noise };
                }

                // Character prompts (NAI V4)
                if (naiData.v4_prompt && naiData.v4_prompt.character_prompts) {
                    const chars = naiData.v4_prompt.character_prompts;
                    if (Array.isArray(chars) && chars.length > 0) {
                        result.character_prompts = chars.map((c, i) => ({
                            index: i,
                            prompt: (c.prompt || c.caption || {}).base_caption || '',
                            negative_prompt: (c.ucPrompt || c.uc || {}).base_caption || '',
                            center: c.center || null,
                        }));
                    }
                }
            }
        }

        // --- ComfyUI fallback ---
        if (gen === 'comfyui') {
            let promptData = metaObj.prompt;
            // prompt may be a JSON string in some cases
            if (typeof promptData === 'string') {
                try { promptData = JSON.parse(promptData); } catch (_) { promptData = null; }
            }
            if (promptData && typeof promptData === 'object') {
                // Try to find KSampler params
                for (const [nodeId, node] of Object.entries(promptData)) {
                    const ct = (node.class_type || '').toLowerCase();
                    if (ct.includes('ksampler')) {
                        const inp = node.inputs || {};
                        const gp = {};
                        if (inp.seed != null) gp.seed = inp.seed;
                        if (inp.steps != null) gp.steps = inp.steps;
                        if (inp.cfg != null) gp.cfg_scale = inp.cfg;
                        if (inp.sampler_name != null) gp.sampler = inp.sampler_name;
                        if (inp.scheduler != null) gp.scheduler = inp.scheduler;
                        if (inp.denoise != null) gp.denoise = inp.denoise;
                        if (Object.keys(gp).length > 0) result.generation_params = gp;

                        // img2img: if denoise < 1.0 and there's a LoadImage node
                        if (inp.denoise != null && inp.denoise < 1.0) {
                            const hasLoadImage = Object.values(promptData).some(n =>
                                (n.class_type || '').toLowerCase().includes('loadimage')
                            );
                            if (hasLoadImage) {
                                result.is_img2img = true;
                                result.img2img_info = { denoise: inp.denoise };
                            }
                        }
                        break;
                    }
                }
            }
        }

        return result;
    },

    /**
     * Extract the generation params line from WebUI parameters text.
     * e.g., "Steps: 20, Sampler: Euler a, CFG scale: 7, ..."
     */
    _extractWebUIParamsLine(params) {
        if (!params) return null;
        const lines = params.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('Steps:')) return line;
        }
        return null;
    },

    /**
     * Parse WebUI generation params line into a key-value object.
     * "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345"
     */
    _parseGenParamsLine(line) {
        if (!line) return null;
        const params = {};
        // Split on ", Key: " pattern (key may contain spaces like "CFG scale")
        const regex = /([A-Za-z][A-Za-z0-9 _]*?):\s*((?:[^,]|,(?!\s*[A-Za-z][A-Za-z0-9 _]*?:\s))*)/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
            const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
            let val = match[2].trim();
            // Try numeric conversion
            const num = Number(val);
            if (!isNaN(num) && val !== '') {
                params[key] = num;
            } else {
                params[key] = val;
            }
        }
        return Object.keys(params).length > 0 ? params : null;
    },

    /**
     * Render all expanded modal sections for the preview.
     */
    _renderModalSections(image, parsedData) {
        const $ = (s) => document.querySelector(s);
        const escapeHtml = window.escapeHtml || ((s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

        // --- Checkpoint ---
        const cpItem = $('#modal-checkpoint-item');
        const cpText = $('#modal-checkpoint');
        if (image.checkpoint) {
            cpItem.style.display = '';
            cpText.textContent = image.checkpoint;
        } else {
            cpItem.style.display = 'none';
        }

        // --- img2img Badge ---
        const img2imgBadge = $('#modal-img2img-badge');
        if (parsedData.is_img2img) {
            img2imgBadge.style.display = '';
        } else {
            img2imgBadge.style.display = 'none';
        }

        // --- Key Generation Parameters (always visible bar) ---
        const keyParamsBar = $('#modal-key-params');
        const gp = parsedData.generation_params || {};
        const keyParamMap = {
            'kp-steps': gp.steps,
            'kp-sampler': gp.sampler || gp.sampler_name,
            'kp-scheduler': gp.scheduler || gp.noise_schedule || gp.schedule_type,
            'kp-cfg': gp.cfg_scale ?? gp.cfg ?? gp.scale,
            'kp-seed': gp.seed,
            'kp-denoise': gp.denoise ?? gp.denoising_strength ?? gp.strength,
        };
        let hasAnyKeyParam = false;
        for (const [elemId, val] of Object.entries(keyParamMap)) {
            const el = $(`#${elemId}`);
            if (el) {
                if (val != null && val !== '') {
                    el.style.display = '';
                    const valSpan = el.querySelector('span');
                    if (valSpan) {
                        valSpan.textContent = typeof val === 'number'
                            ? (Number.isInteger(val) ? val : val.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
                            : String(val);
                    }
                    hasAnyKeyParam = true;
                } else {
                    el.style.display = 'none';
                }
            }
        }
        keyParamsBar.style.display = hasAnyKeyParam ? '' : 'none';

        // --- LoRAs ---
        const lorasSection = $('#modal-loras-section');
        const lorasList = $('#modal-loras-list');
        let loras = [];
        if (image.loras) {
            try {
                loras = typeof image.loras === 'string' ? JSON.parse(image.loras) : image.loras;
            } catch (_) { /* ignore */ }
        }
        if (Array.isArray(loras) && loras.length > 0) {
            lorasSection.style.display = '';
            lorasList.innerHTML = loras.map(l => `<span class="lora-pill">${escapeHtml(l)}</span>`).join('');
        } else {
            lorasSection.style.display = 'none';
            lorasList.innerHTML = '';
        }

        // --- Negative Prompt ---
        const negSection = $('#modal-negative-section');
        const negText = $('#modal-negative-text');
        if (image.negative_prompt) {
            negSection.style.display = '';
            negText.textContent = image.negative_prompt;
            negText.style.display = '';
        } else {
            negSection.style.display = 'none';
        }

        // --- Character Prompts (NAI V4) ---
        const charsSection = $('#modal-characters-section');
        const charsList = $('#modal-characters-list');
        if (parsedData.character_prompts && parsedData.character_prompts.length > 0) {
            charsSection.style.display = '';
            charsList.innerHTML = parsedData.character_prompts.map((c, i) => {
                const centerStr = c.center ? ` (${c.center.x?.toFixed?.(2) || c.center.x}, ${c.center.y?.toFixed?.(2) || c.center.y})` : '';
                const negHtml = c.negative_prompt
                    ? `<div class="char-negative"><strong>Neg:</strong> ${escapeHtml(c.negative_prompt)}</div>`
                    : '';
                return `
                    <div class="character-card">
                        <div class="character-card-header">Character ${c.index != null ? c.index + 1 : i + 1}${centerStr}</div>
                        <div>${escapeHtml(c.prompt)}</div>
                        ${negHtml}
                    </div>
                `;
            }).join('');
        } else {
            charsSection.style.display = 'none';
            charsList.innerHTML = '';
        }

        // --- Generation Parameters ---
        const paramsSection = $('#modal-params-section');
        const paramsGrid = $('#modal-params-grid');
        if (parsedData.generation_params && Object.keys(parsedData.generation_params).length > 0) {
            paramsSection.style.display = '';
            const paramLabels = {
                steps: 'Steps',
                sampler: 'Sampler',
                seed: 'Seed',
                cfg_scale: 'CFG Scale',
                cfg: 'CFG',
                scale: 'Scale',
                scheduler: 'Scheduler',
                denoise: 'Denoise',
                denoising_strength: 'Denoise',
                strength: 'Strength',
                noise: 'Noise',
                sm: 'SMEA',
                sm_dyn: 'SMEA Dyn',
                cfg_rescale: 'CFG Rescale',
                clip_skip: 'Clip Skip',
                hires_upscaler: 'Hires Upscaler',
                hires_upscale: 'Hires Scale',
                hires_steps: 'Hires Steps',
                model: 'Model',
                model_hash: 'Model Hash',
                sampler_name: 'Sampler',
                noise_schedule: 'Noise Schedule',
                uncond_scale: 'Uncond Scale',
                skip_cfg_above_sigma: 'Skip CFG σ',
                schedule_type: 'Schedule Type',
            };
            paramsGrid.innerHTML = Object.entries(parsedData.generation_params).map(([key, val]) => {
                const label = paramLabels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const displayVal = typeof val === 'number'
                    ? (Number.isInteger(val) ? val : val.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
                    : escapeHtml(String(val));
                return `<div class="param-item"><span class="param-label">${escapeHtml(label)}</span><span class="param-value">${displayVal}</span></div>`;
            }).join('');
            paramsGrid.style.display = '';
        } else {
            paramsSection.style.display = 'none';
            paramsGrid.innerHTML = '';
        }

        // --- img2img Details ---
        const img2imgSection = $('#modal-img2img-section');
        const img2imgInfo = $('#modal-img2img-info');
        if (parsedData.is_img2img && parsedData.img2img_info && Object.keys(parsedData.img2img_info).length > 0) {
            img2imgSection.style.display = '';
            img2imgInfo.innerHTML = Object.entries(parsedData.img2img_info).map(([key, val]) => {
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                return `<div class="param-item"><span class="param-label">${escapeHtml(label)}</span><span class="param-value">${escapeHtml(String(val))}</span></div>`;
            }).join('');
        } else {
            img2imgSection.style.display = 'none';
            img2imgInfo.innerHTML = '';
        }

        // --- ComfyUI Node Breakdown ---
        const nodesSection = $('#modal-nodes-section');
        const nodesList = $('#modal-nodes-list');
        if (parsedData.prompt_nodes && parsedData.prompt_nodes.length > 0) {
            nodesSection.style.display = '';
            nodesList.innerHTML = parsedData.prompt_nodes.map(node => {
                const roleClass = (node.role || '').toLowerCase().includes('negative') ? 'negative' : 'positive';
                const roleLabel = node.role || 'unknown';
                const nodeTitle = node.node_id ? `Node #${node.node_id}` : (node.class_type || 'Node');
                return `
                    <div class="prompt-node-item">
                        <div class="prompt-node-header">
                            <span>${escapeHtml(nodeTitle)}</span>
                            <span class="node-role ${roleClass}">${escapeHtml(roleLabel)}</span>
                        </div>
                        <div class="prompt-node-text">${escapeHtml(node.text || '')}</div>
                    </div>
                `;
            }).join('');
            nodesList.style.display = '';
        } else {
            nodesSection.style.display = 'none';
            nodesList.innerHTML = '';
        }
    },

    /**
     * Initialize collapsible section toggle handlers (called once).
     */
    _initSectionToggles() {
        if (this._togglesInitialized) return;
        this._togglesInitialized = true;

        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('.section-toggle');
            if (!toggle) return;

            const targetId = toggle.dataset.target;
            if (!targetId) return;

            const target = document.getElementById(targetId);
            if (!target) return;

            const icon = toggle.querySelector('.collapse-icon');
            const isCollapsed = target.style.display === 'none';

            if (isCollapsed) {
                target.style.display = '';
                if (icon) icon.textContent = '▼';
                toggle.classList.remove('section-collapsed');
            } else {
                target.style.display = 'none';
                if (icon) icon.textContent = '▶';
                toggle.classList.add('section-collapsed');
            }
        });
    },

    _escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    },

    _renderModalTags(tags = []) {
        const tagsList = document.querySelector('#modal-tags-list');
        if (!tagsList) return;

        if (tags.length === 0) {
            tagsList.textContent = 'No tags (run WD14 tagger)';
            tagsList.style.color = 'var(--text-muted)';
            return;
        }
        tagsList.style.color = '';

        const ratingTags = ['general', 'sensitive', 'questionable', 'explicit'];
        const ratings = tags.filter(t => ratingTags.includes(t.tag));
        const otherTags = tags.filter(t => !ratingTags.includes(t.tag));
        const visibleTags = this.showAllTags ? otherTags : otherTags.slice(0, 40);

        let html = '';
        if (ratings.length > 0) {
            const rating = ratings.reduce((a, b) => a.confidence > b.confidence ? a : b);
            const ratingColors = {
                general: '#22c55e',
                sensitive: '#eab308',
                questionable: '#f97316',
                explicit: '#ef4444'
            };
            html += `<span class="tag" style="background: ${ratingColors[rating.tag]}; color: white; font-weight: 600;">${this._escapeHtml(rating.tag)}</span>`;
        }

        html += visibleTags.map(t => `<span class="tag">${this._escapeHtml(t.tag)}</span>`).join('');
        tagsList.innerHTML = html;

        const toggleBtn = document.querySelector('#btn-toggle-all-tags');
        if (toggleBtn) {
            toggleBtn.style.display = otherTags.length > 40 ? '' : 'none';
            toggleBtn.textContent = this.showAllTags ? 'Show Less' : 'Show More';
        }
    },

    _serializeGenerationParams(parsedData) {
        const params = parsedData?.generation_params || {};
        return Object.entries(params)
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
            .join('\n');
    },

    _buildCopyAllText(image, parsedData, tags) {
        const loras = (() => {
            try {
                if (!image?.loras) return [];
                return typeof image.loras === 'string' ? JSON.parse(image.loras) : image.loras;
            } catch (_) {
                return [];
            }
        })();

        const sections = [
            ['Filename', image?.filename],
            ['Generator', image?.generator],
            ['Size', image?.width && image?.height ? `${image.width}x${image.height}` : null],
            ['Prompt', image?.prompt],
            ['Negative', image?.negative_prompt],
            ['Checkpoint', image?.checkpoint],
            ['LoRAs', loras.length ? loras.join(', ') : null],
            ['Tags', tags?.length ? tags.map(tag => tag.tag).join(', ') : null],
            ['Params', this._serializeGenerationParams(parsedData)],
        ];

        return sections
            .filter(([, value]) => value != null && value !== '' && value !== 'undefined')
            .map(([label, value]) => `${label}:\n${String(value)}`)
            .join('\n\n');
    },

    async openPreview(imageId) {
        const { $, API, showModal, formatSize, showToast } = window.App || { $: (s) => document.querySelector(s), API: window.API, showModal: window.showModal, formatSize: window.formatSize, showToast: window.showToast };

        this._initSectionToggles();
        const summaryImage = this.images.find(image => image.id === imageId) || window.App?.AppState?.images?.find(image => image.id === imageId);
        this.currentPreviewIndex = this.images.findIndex(image => image.id === imageId);
        this.currentPreviewRequestId += 1;
        const requestId = this.currentPreviewRequestId;
        this.showAllTags = false;
        this._lastModalImage = null;
        this._lastModalTags = [];
        this._lastParsedData = null;

        $('#modal-image').src = API.getImageUrl(imageId);
        $('#modal-filename').textContent = summaryImage?.filename || `Image #${imageId}`;
        $('#modal-generator').textContent = (summaryImage?.generator || '-').toUpperCase();
        $('#modal-size').textContent = summaryImage ? `${summaryImage.width || '?'}×${summaryImage.height || '?'} • ${formatSize(summaryImage.file_size || 0)}` : '-';
        $('#modal-prompt-text').textContent = summaryImage?.prompt || 'Loading prompt…';
        $('#modal-negative-text').textContent = 'Loading…';
        $('#modal-loading-state').textContent = 'Loading details…';
        $('#modal-loading-state').style.display = '';
        $('#modal-favorite-toggle').textContent = summaryImage?.is_favorite ? '★ Favorited' : '★ Favorite';
        document.querySelector('#modal-tags-list').textContent = 'Loading tags…';
        document.querySelector('#modal-tags-list').style.color = 'var(--text-muted)';
        $('#modal-favorite-toggle').onclick = () => this.toggleFavorite(imageId);
        ['#modal-loras-section', '#modal-negative-section', '#modal-characters-section', '#modal-params-section', '#modal-img2img-section', '#modal-nodes-section'].forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
            }
        });
        document.querySelector('#modal-key-params').style.display = 'none';
        document.querySelector('#modal-checkpoint-item').style.display = 'none';
        document.querySelector('#modal-img2img-badge').style.display = 'none';
        document.querySelector('#modal-loras-list').innerHTML = '';
        document.querySelector('#modal-characters-list').innerHTML = '';
        document.querySelector('#modal-params-grid').innerHTML = '';
        document.querySelector('#modal-img2img-info').innerHTML = '';
        document.querySelector('#modal-nodes-list').innerHTML = '';
        $('#btn-reparse-metadata').onclick = async () => {
            try {
                $('#modal-loading-state').textContent = 'Reparsing metadata…';
                $('#modal-loading-state').style.display = '';
                const reparsed = await API.reparseImage(imageId);
                if (requestId !== this.currentPreviewRequestId) return;
                this._hydratePreview(reparsed.image, reparsed.tags);
                showToast?.('Metadata reparsed', 'success');
            } catch (error) {
                showToast?.('Failed to reparse metadata: ' + error.message, 'error');
            }
        };
        $('#modal-prev-image').onclick = () => this.openAdjacentPreview(-1);
        $('#modal-next-image').onclick = () => this.openAdjacentPreview(1);
        $('#btn-toggle-all-tags').onclick = () => {
            this.showAllTags = !this.showAllTags;
            this._renderModalTags(this._lastModalTags || []);
        };

        const copyToClipboard = async (text, successMessage) => {
            try {
                await navigator.clipboard.writeText(text || '');
                showToast?.(successMessage, 'success');
            } catch (error) {
                showToast?.('Failed to copy text', 'error');
            }
        };
        $('#btn-copy-prompt').onclick = () => copyToClipboard(this._lastModalImage?.prompt || '', 'Prompt copied');
        $('#btn-copy-negative').onclick = () => copyToClipboard(this._lastModalImage?.negative_prompt || '', 'Negative prompt copied');
        $('#btn-copy-tags').onclick = () => copyToClipboard((this._lastModalTags || []).map(tag => tag.tag).join(', '), 'Tags copied');
        $('#btn-copy-params').onclick = () => copyToClipboard(this._serializeGenerationParams(this._lastParsedData), 'Params copied');
        $('#btn-copy-all').onclick = () => copyToClipboard(this._buildCopyAllText(this._lastModalImage, this._lastParsedData, this._lastModalTags), 'All metadata copied');

        showModal?.('image-modal');

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
            $('#modal-loading-state').textContent = 'Failed to load details';
            showToast?.('Failed to load image details', 'error');
        }
    },

    _hydratePreview(image, tags) {
        const { $, formatSize } = window.App || { $: (s) => document.querySelector(s), formatSize: window.formatSize };
        $('#modal-filename').textContent = image.filename;
        $('#modal-generator').textContent = image.generator.toUpperCase();
        $('#modal-size').textContent = `${image.width}×${image.height} • ${formatSize(image.file_size)}`;
        $('#modal-prompt-text').textContent = image.prompt || 'No prompt data';
        $('#modal-favorite-toggle').textContent = image.is_favorite ? '★ Favorited' : '★ Favorite';

        const parsedData = this._extractParsedData(image);
        this._lastModalImage = image;
        this._lastModalTags = tags;
        this._lastParsedData = parsedData;

        this._renderModalSections(image, parsedData);
        this._renderModalTags(tags);
        $('#modal-loading-state').style.display = 'none';
        $('#btn-toggle-all-tags').textContent = 'Show More';
    },

    openAdjacentPreview(direction) {
        if (!this.images.length || this.currentPreviewIndex < 0) return;
        const nextIndex = this.currentPreviewIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.images.length) return;
        this.openPreview(this.images[nextIndex].id);
    },

    // Cleanup when switching views
    destroy() {
        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
            this.lazyObserver = null;
        }
        // Also cleanup VirtualGallery if it's active
        if (window.VirtualGallery && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }
    }
};

window.Gallery = Gallery;
