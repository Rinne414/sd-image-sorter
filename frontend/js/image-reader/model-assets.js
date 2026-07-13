/**
 * image-reader/model-assets.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method body moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 1231-1358 (of 1,749): _renderModelAssetsSection (ComfyUI model-asset
 * blocks: primary model, parser source, checkpoint/UNet/diffusion/LoRA/YOLO
 * candidate lists and the global candidate confidence cards).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _renderModelAssetsSection(result) {
            const section = document.getElementById('reader-model-assets-section');
            const container = document.getElementById('reader-model-assets');
            if (!section || !container) return;

            const assets = this._getModelAssets(result);
            const hasAssets = assets && (
                assets.primary_model_name ||
                (assets.loras && assets.loras.length) ||
                (assets.yolo_models && assets.yolo_models.length) ||
                (assets.checkpoint_candidates && assets.checkpoint_candidates.length) ||
                (assets.unet_candidates && assets.unet_candidates.length) ||
                (assets.diffusion_model_candidates && assets.diffusion_model_candidates.length) ||
                (assets.model_candidates && assets.model_candidates.length) ||
                (assets.yolo_candidates && assets.yolo_candidates.length) ||
                (assets.global_lora_candidates && assets.global_lora_candidates.length) ||
                (assets.global_yolo_candidates && assets.global_yolo_candidates.length)
            );

            if (!hasAssets) {
                section.style.display = 'none';
                container.innerHTML = '';
                return;
            }

            const blocks = [];
            const humanizeSource = (value) => {
                if (!value) return '';
                if (value === 'activity_subgraph_fallback') return this._t('reader.modelAssetsSourceActivity', 'Active subgraph fallback');
                if (value === 'global_candidate_fallback') return this._t('reader.modelAssetsSourceGlobal', 'Global candidate fallback');
                if (value === 'global_graph_fallback') return this._t('reader.modelAssetsSourceGraph', 'Full graph fallback');
                if (value === 'fast_path') return this._t('reader.modelAssetsSourceFastPath', 'Fast path');
                return String(value).replace(/_/g, ' ');
            };
            const humanizeConfidence = (value) => {
                if (value === 'high') return this._t('reader.modelAssetsConfidenceHigh', 'High confidence');
                if (value === 'medium') return this._t('reader.modelAssetsConfidenceMedium', 'Medium confidence');
                if (value === 'low') return this._t('reader.modelAssetsConfidenceLow', 'Low confidence');
                return '';
            };
            const addListBlock = (titleKey, titleFallback, values) => {
                if (!Array.isArray(values) || values.length === 0) return;
                const uniqueValues = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
                if (!uniqueValues.length) return;
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t(titleKey, titleFallback))}</div>
                        <div class="reader-model-asset-list">
                            ${uniqueValues.map((value) => `<span class="reader-model-asset-pill">${this._escapeHtml(value)}</span>`).join('')}
                        </div>
                    </div>
                `);
            };
            const addCandidateBlock = (titleKey, titleFallback, items) => {
                if (!Array.isArray(items) || items.length === 0) return;
                const uniqueItems = [];
                const seenNames = new Set();
                for (const item of items) {
                    const name = String(item?.name || '').trim();
                    if (!name || seenNames.has(name)) continue;
                    seenNames.add(name);
                    uniqueItems.push(item);
                }
                if (!uniqueItems.length) return;

                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t(titleKey, titleFallback))}</div>
                        <div class="model-asset-candidate-list">
                            ${uniqueItems.map((item) => {
                                const confidence = String(item?.confidence || 'low').toLowerCase();
                                const metaParts = [
                                    humanizeSource(item?.source_mode),
                                    item?.node_id ? `${this._t('reader.modelAssetsNode', 'Node')} ${item.node_id}` : '',
                                    item?.class_type ? String(item.class_type) : '',
                                    item?.key_path ? String(item.key_path) : (item?.input_key ? String(item.input_key) : ''),
                                ].filter(Boolean);
                                return `
                                    <div class="model-asset-candidate model-asset-candidate-secondary">
                                        <div class="model-asset-candidate-head">
                                            <span class="reader-model-asset-pill">${this._escapeHtml(String(item?.name || ''))}</span>
                                            <span class="model-asset-confidence is-${this._escapeHtml(confidence)}">${this._escapeHtml(humanizeConfidence(confidence))}</span>
                                        </div>
                                        <div class="model-asset-candidate-meta">${this._escapeHtml(metaParts.join(' • '))}</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `);
            };

            if (assets.primary_model_name) {
                const primaryModelType = assets.primary_model_type || this._t('generator.unknown', 'Unknown');
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.primaryModel', 'Primary Model'))}</div>
                        <div class="reader-model-asset-value">${this._escapeHtml(assets.primary_model_name)}</div>
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.primaryModelType', 'Primary Model Type'))}: ${this._escapeHtml(primaryModelType)}</div>
                    </div>
                `);
            }

            if (assets.source) {
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.modelAssetsSource', 'Parser Source'))}</div>
                        <div class="reader-model-asset-value">${this._escapeHtml(humanizeSource(assets.source))}</div>
                    </div>
                `);
            }
            if (Array.isArray(assets.sources) && assets.sources.length > 1) {
                addListBlock('reader.modelAssetsSources', 'All Sources', assets.sources.map((value) => humanizeSource(value)));
            }

            addListBlock('reader.modelAssetsCheckpoints', 'Checkpoint Candidates', (assets.checkpoint_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsUnets', 'UNet Candidates', (assets.unet_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsDiffusion', 'Diffusion Candidates', (assets.diffusion_model_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsModels', 'Additional / Upscale / ControlNet Models', (assets.model_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsLoras', 'LoRA Candidates', (assets.lora_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsYolo', 'YOLO / Detector Models', assets.yolo_models || (assets.yolo_candidates || []).map((item) => item.name));
            addCandidateBlock('reader.modelAssetsGlobalLoras', 'Global LoRA Candidates', assets.global_lora_candidates || []);
            addCandidateBlock('reader.modelAssetsGlobalYolo', 'Full-graph YOLO Candidates', assets.global_yolo_candidates || []);

            container.innerHTML = blocks.join('');
            section.style.display = '';
        },

});
