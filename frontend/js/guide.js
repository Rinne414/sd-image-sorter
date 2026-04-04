/**
 * SD Image Sorter - Contextual Guide System
 *
 * Provides a detailed per-tab guide in English and Simplified Chinese.
 * The content is embedded here so the guide keeps working even when the
 * main translation packs are incomplete.
 */

(function () {
    'use strict';

    const GUIDE_COPY = {
        en: {
            button: 'Guide',
            subtitle: 'What this tab does and how to use it',
            close: 'Close',
            sections: {
                purpose: 'What This Tab Is For',
                steps: 'How To Use It',
                features: 'Main Functions',
                tips: 'Practical Tips',
            },
            tabs: {
                gallery: {
                    icon: '🖼️',
                    title: 'Gallery',
                    purpose: [
                        'Browse every scanned image in one place, inspect prompts and metadata, and narrow the list with filters before you move or edit anything.',
                    ],
                    steps: [
                        'Start with "Scan Folder" to import images into the database.',
                        'Use generator tabs, filters, and sort controls to narrow the gallery to the images you actually want.',
                        'Open an image to inspect its prompt, tags, LoRAs, parameters, and prompt format conversions.',
                        'Turn on "Select Images" when you want batch export, censor editing, or other multi-image actions.',
                    ],
                    features: [
                        'Multiple view modes for dense browsing, larger previews, or waterfall layout.',
                        'Filter summaries so you always know why the current gallery looks the way it does.',
                        'Prompt and metadata copy buttons in the image preview modal.',
                        'Quick access to random image, tags library, and selection tools.',
                    ],
                    tips: [
                        'Use the filter editor when the summary starts getting too dense to read.',
                        'If the prompt format toggle is available in the preview modal, compare the converted format before copying it into another tool.',
                    ],
                },
                autosep: {
                    icon: '📁',
                    title: 'Auto-Separate',
                    purpose: [
                        'Move every image that matches your current filters into a destination folder in one batch operation.',
                    ],
                    steps: [
                        'Set the filters you want to target, then open this tab.',
                        'Enter a destination folder and run "Preview Results" first.',
                        'Review the preview count and example images so you do not move the wrong set.',
                        'Run "Move Images" only after the preview matches your intent.',
                    ],
                    features: [
                        'Reuses the same filter system as Gallery, so you do not need to rebuild criteria.',
                        'Preview list shows examples before files are moved.',
                        'Works well for separating generators, ratings, models, prompts, and dimensions.',
                    ],
                    tips: [
                        'Preview before every large move. It is the fastest way to catch a bad filter combination.',
                        'Chinese folder paths are supported by the backend, but keep destination names short enough that Windows path length does not become the real limit.',
                    ],
                },
                manual: {
                    icon: '🎮',
                    title: 'Manual Sort',
                    purpose: [
                        'Rapidly triage images into up to four target folders with keyboard-driven sorting.',
                    ],
                    steps: [
                        'Configure the folders for W, A, S, and D before starting.',
                        'Optionally narrow the working set with filters so the session only contains the images you care about.',
                        'Start the session and use W/A/S/D to move, Space to skip, and Z to undo.',
                        'Watch the minimap and progress cards to track what is processed, skipped, or still pending.',
                    ],
                    features: [
                        'Four-way folder mapping for fast keep/delete/best/needs-work style workflows.',
                        'Undo support so a single bad key press does not ruin the session.',
                        'Resume banner for unfinished sessions.',
                        'Status strip, minimap, and shortcut card for high-speed operation.',
                    ],
                    tips: [
                        'Keep folder names and meanings consistent between sessions. Speed comes from muscle memory.',
                        'If you work in Chinese, the translated labels change, but the keyboard mapping does not.',
                    ],
                },
                censor: {
                    icon: '🔳',
                    title: 'Censored Edit',
                    purpose: [
                        'Apply mosaic, blur, bars, or manual painting to one or many selected images.',
                    ],
                    steps: [
                        'Send images here from Gallery selection when you know which files need edits.',
                        'Choose a tool, adjust brush settings, and edit the current image in the center canvas.',
                        'Use auto-detection when you want the model to propose sensitive regions first.',
                        'Save all processed images only after checking your output format and metadata options.',
                    ],
                    features: [
                        'Queue view for batch work across multiple images.',
                        'Brush, pen, eraser, clone, zoom, reset, and detection settings.',
                        'Batch rename and output format controls before final save.',
                    ],
                    tips: [
                        'If the sidebar feels dense on smaller screens, finish one image at a time instead of trying to open every control at once.',
                        'For share-safe output, strip metadata unless you explicitly need to preserve it.',
                    ],
                },
                similar: {
                    icon: '🔍',
                    title: 'Similar Images',
                    purpose: [
                        'Find visually similar images or near-duplicates using embeddings.',
                    ],
                    steps: [
                        'Generate embeddings first if this is your first run or your library changed significantly.',
                        'Search by image ID when you already know the source image you want to compare.',
                        'Upload an image when the search source is outside the current library.',
                        'Use the duplicates panel to review very high-similarity pairs before deleting anything.',
                    ],
                    features: [
                        'Separate search and duplicate workflows in one tab.',
                        'Threshold control so you can tune how strict duplicate detection should be.',
                        'Useful for curation after a large generation session.',
                    ],
                    tips: [
                        'High thresholds are safer for duplicate cleanup. Lower thresholds are better for inspiration clustering.',
                        'Embeddings are model-generated features, so visually close images may still need a human check before deletion.',
                    ],
                },
                promptlab: {
                    icon: '🧪',
                    title: 'Prompt Lab',
                    purpose: [
                        'Assemble prompts from categories, reusable tag sets, locked slots, and presets.',
                    ],
                    steps: [
                        'Browse categories on the left and click tags to add them to prompt slots.',
                        'Adjust weight sliders and lock any slot you want to preserve during randomization.',
                        'Use tag sets to apply a prepared combination quickly.',
                        'Generate, validate, copy, or send the result straight into Gallery prompt filtering.',
                    ],
                    features: [
                        'Slot-based prompt building instead of one big text box.',
                        'Randomization that respects locks and category weights.',
                        'Preset save/load flow for reusable prompt structures.',
                        'Prompt validation and direct reuse in Gallery.',
                    ],
                    tips: [
                        'If prompts start overflowing the output area in Chinese, switch to a narrower tag selection set instead of forcing everything into one prompt.',
                        'Use presets for structure and randomize for variation. That keeps results controlled without becoming repetitive.',
                    ],
                },
                artist: {
                    icon: '🎨',
                    title: 'Artist ID',
                    purpose: [
                        'Estimate likely artist or style labels across the image library and then drill back into Gallery with that filter applied.',
                    ],
                    steps: [
                        'Choose the model source and confidence threshold first.',
                        'Run identification for all images or only the selected set.',
                        'Review the aggregated artist cards and switch between grid and list if needed.',
                        'Open an artist and use the gallery filter shortcut to inspect those images in context.',
                    ],
                    features: [
                        'Batch identification with progress tracking.',
                        'Stats cards for total images, identified images, undefined results, and artist count.',
                        'Direct bridge back into Gallery filtering.',
                    ],
                    tips: [
                        'Treat this as an assistive classifier, not a guaranteed attribution tool.',
                        'Raise the threshold if too many weak guesses are cluttering the result list.',
                    ],
                },
            },
        },
        'zh-CN': {
            button: '指南',
            subtitle: '这个标签页能做什么，以及应该怎么用',
            close: '关闭',
            sections: {
                purpose: '这个标签页的用途',
                steps: '使用步骤',
                features: '主要功能',
                tips: '实用建议',
            },
            tabs: {
                gallery: {
                    icon: '🖼️',
                    title: '图库',
                    purpose: [
                        '在一个地方浏览所有已扫描图片，查看提示词与元数据，并先用筛选器缩小范围，再决定移动、导出或编辑。',
                    ],
                    steps: [
                        '先用“扫描文件夹”把图片导入数据库。',
                        '使用生成器标签、筛选器与排序，先把图库收敛到真正想处理的图片。',
                        '打开单张图片，查看提示词、标签、LoRA、参数，以及不同提示词格式的转换结果。',
                        '需要批量导出、送去马赛克编辑或执行其他批量操作时，再打开“选择图片”。',
                    ],
                    features: [
                        '支持多种浏览模式，适合密集浏览、大图预览或瀑布流查看。',
                        '筛选摘要会明确告诉你当前结果是如何被筛出来的。',
                        '图片预览弹窗里可以直接复制提示词、参数与其他元数据。',
                        '可快速访问随机图片、标签库和批量选择工具。',
                    ],
                    tips: [
                        '当筛选条件越来越多时，直接打开筛选编辑器比只看摘要更清楚。',
                        '如果预览弹窗里能切换提示词格式，复制前先确认转换后的格式是否真的是你要用的版本。',
                    ],
                },
                autosep: {
                    icon: '📁',
                    title: '自动分类',
                    purpose: [
                        '把所有符合当前筛选条件的图片一次性移动到目标文件夹。',
                    ],
                    steps: [
                        '先设定要命中的筛选条件，再进入这个标签页。',
                        '填写目标文件夹后，先运行“预览结果”。',
                        '确认数量和示例图片都正确，再执行真正的移动。',
                        '只有在预览结果完全符合预期时，再点击“移动图片”。',
                    ],
                    features: [
                        '直接复用图库筛选系统，不需要重复设置规则。',
                        '正式移动前会先展示样例图片与统计数量。',
                        '适合按生成器、分级、模型、提示词和尺寸做批量整理。',
                    ],
                    tips: [
                        '每次大批量移动前都先预览，这是发现误筛最快的方法。',
                        '后端对中文路径是安全的，但 Windows 仍然有路径长度限制，所以目标文件夹不要无限叠层级。',
                    ],
                },
                manual: {
                    icon: '🎮',
                    title: '手动排序',
                    purpose: [
                        '使用键盘把图片快速分流到最多四个目标文件夹里。',
                    ],
                    steps: [
                        '开始前先设置 W、A、S、D 对应的文件夹。',
                        '可以先用筛选器缩小工作集，只处理这一轮真正想看的图片。',
                        '开始排序后，使用 W/A/S/D 移动，Space 跳过，Z 撤销。',
                        '结合缩略图小地图和进度统计，随时掌握哪些已经处理、哪些还没处理。',
                    ],
                    features: [
                        '四方向文件夹映射，适合保留、删除、精选、待复查这类高速分类流程。',
                        '支持撤销，避免一次误按毁掉整轮排序。',
                        '检测到未完成会话时可直接恢复。',
                        '状态栏、小地图与快捷键卡片适合长时间高频操作。',
                    ],
                    tips: [
                        '尽量保持每个方向的语义一致，这样速度会明显提升。',
                        '即使切换成中文，键盘映射仍然不变，真正决定效率的是肌肉记忆。',
                    ],
                },
                censor: {
                    icon: '🔳',
                    title: '马赛克编辑',
                    purpose: [
                        '对一张或多张图片应用马赛克、模糊、黑条或手动涂抹。',
                    ],
                    steps: [
                        '先从图库把要处理的图片送进这个标签页。',
                        '选择工具，调整画笔与样式，然后在中间画布上处理当前图片。',
                        '想让模型先帮你标出区域时，可以先执行自动检测。',
                        '全部检查完成后，再根据输出格式和元数据设置进行保存。',
                    ],
                    features: [
                        '支持批量队列，不需要一张一张重新打开。',
                        '提供画笔、钢笔、橡皮、克隆、缩放、重置和检测设置。',
                        '保存前可批量重命名并决定输出格式。',
                    ],
                    tips: [
                        '小分辨率或较窄屏幕下，优先专注当前图片，不要同时展开过多设置区。',
                        '如果是对外分享，除非确实需要，否则建议去掉元数据。',
                    ],
                },
                similar: {
                    icon: '🔍',
                    title: '相似图片',
                    purpose: [
                        '用嵌入向量查找视觉上相似的图片，或找出接近重复的图。',
                    ],
                    steps: [
                        '第一次使用或图库变化很大时，先生成嵌入向量。',
                        '已知源图片时，可直接按图片 ID 搜索。',
                        '源图片不在当前图库时，可上传图片进行搜索。',
                        '在重复图面板中，结合高相似度阈值人工确认后再删除。',
                    ],
                    features: [
                        '搜索和查重分成两个独立流程，逻辑更清楚。',
                        '可调阈值，便于控制重复图检测的严格程度。',
                        '特别适合大批量出图后的清理与归档。',
                    ],
                    tips: [
                        '高阈值更适合安全查重，低阈值更适合找风格接近的图。',
                        '向量结果只是辅助，真正删除前最好仍然做一次人工确认。',
                    ],
                },
                promptlab: {
                    icon: '🧪',
                    title: '提示词工坊',
                    purpose: [
                        '通过分类标签、标签集合、锁定槽位和预设来组合提示词。',
                    ],
                    steps: [
                        '在左侧浏览分类，点击标签把它们加入中间的提示词槽位。',
                        '调整权重，并锁定随机化时不希望变化的槽位。',
                        '需要快速套用组合时，直接使用标签集合。',
                        '生成、校验、复制，或者直接把结果送回图库做提示词筛选。',
                    ],
                    features: [
                        '用槽位结构来搭提示词，而不是只靠一个大文本框。',
                        '随机化会遵守锁定状态和分类权重。',
                        '可以把当前结构保存成预设，反复复用。',
                        '可直接校验冲突，并回送图库继续筛图。',
                    ],
                    tips: [
                        '如果中文模式下输出区看起来太拥挤，不要硬塞更多标签，先收敛分类组合。',
                        '最佳做法是“预设负责结构，随机化负责变化”，这样稳定又不会太重复。',
                    ],
                },
                artist: {
                    icon: '🎨',
                    title: '画师识别',
                    purpose: [
                        '对图库中的图片做画师/风格预测，再一键回到图库按该结果继续筛图。',
                    ],
                    steps: [
                        '先选择模型来源和置信度阈值。',
                        '再决定是识别全部图片，还是只识别当前选中图片。',
                        '查看汇总结果卡片，必要时在网格和列表视图间切换。',
                        '点进某个画师后，可直接把这个结果应用到图库筛选里。',
                    ],
                    features: [
                        '支持批量识别，并带进度反馈。',
                        '顶部统计卡会显示总图片数、已识别数、未定义数和画师数。',
                        '结果可直接回流到图库继续处理。',
                    ],
                    tips: [
                        '这更适合作为辅助分类，而不是严格的作者归属工具。',
                        '如果弱匹配太多，可以适当提高阈值来减少噪声。',
                    ],
                },
            },
        },
    };

    const TAB_ANCHORS = {
        gallery: '#view-gallery .gallery-header',
        autosep: '#view-autosep .panel-title',
        manual: '#view-manual .setup-title',
        censor: '#view-censor .censor-toolbar-v2',
        similar: '#view-similar .similar-header',
        promptlab: '#view-promptlab .promptlab-builder-header',
        artist: '#view-artist .results-header',
    };

    const Guide = {
        _modalEl: null,
        _styleEl: null,
        _initialized: false,
        _openTab: null,

        getCurrentTab() {
            return window.App?.AppState?.currentView
                || document.querySelector('.view.active')?.id?.replace(/^view-/, '')
                || 'gallery';
        },

        _lang() {
            return window.I18n?.getLang?.() === 'zh-CN' ? 'zh-CN' : 'en';
        },

        _copy() {
            return GUIDE_COPY[this._lang()];
        },

        _tab(tabName) {
            return this._copy().tabs[tabName];
        },

        _escape(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        },

        _injectStyles() {
            if (this._styleEl) return;

            const style = document.createElement('style');
            style.id = 'guide-system-styles';
            style.textContent = `
.guide-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid rgba(45, 212, 191, 0.28);
    background: rgba(45, 212, 191, 0.08);
    color: #dffff9;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: all 160ms ease;
}
.guide-inline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.guide-btn:hover {
    background: rgba(45, 212, 191, 0.14);
    border-color: rgba(45, 212, 191, 0.42);
    transform: translateY(-1px);
}
.guide-btn--pulse {
    animation: guidePulse 2s ease-in-out 3;
}
@keyframes guidePulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(45, 212, 191, 0.3); }
    50% { box-shadow: 0 0 0 8px rgba(45, 212, 191, 0); }
}
.guide-overlay {
    position: fixed;
    inset: 0;
    z-index: 9100;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
}
.guide-overlay.visible {
    display: flex;
}
.guide-overlay-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(3, 10, 15, 0.72);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
}
.guide-modal {
    position: relative;
    width: min(760px, 100%);
    max-height: min(86vh, 860px);
    display: flex;
    flex-direction: column;
    background: rgba(9, 21, 30, 0.96);
    border: 1px solid rgba(184, 215, 233, 0.12);
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 28px 60px rgba(0, 0, 0, 0.38);
}
.guide-modal-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 22px 24px 18px;
    border-bottom: 1px solid rgba(184, 215, 233, 0.08);
}
.guide-modal-icon {
    font-size: 28px;
    line-height: 1;
}
.guide-modal-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
}
.guide-modal-subtitle {
    display: block;
    margin-top: 4px;
    font-size: 13px;
    color: var(--text-muted);
}
.guide-modal-close {
    margin-left: auto;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 10px;
    background: rgba(255,255,255,0.04);
    color: var(--text-secondary);
    cursor: pointer;
}
.guide-modal-body {
    padding: 20px 24px 12px;
    overflow-y: auto;
}
.guide-section {
    padding-bottom: 18px;
    margin-bottom: 18px;
    border-bottom: 1px solid rgba(184, 215, 233, 0.06);
}
.guide-section:last-child {
    border-bottom: none;
    margin-bottom: 0;
}
.guide-section h4 {
    margin: 0 0 10px;
    color: var(--accent-secondary);
    font-size: 14px;
    font-weight: 700;
}
.guide-section ul {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 8px;
}
.guide-section li {
    color: var(--text-secondary);
    line-height: 1.65;
    font-size: 14px;
}
.guide-modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 18px 24px 22px;
    border-top: 1px solid rgba(184, 215, 233, 0.08);
}
.guide-modal-action {
    padding: 10px 16px;
    border-radius: 12px;
    border: 1px solid rgba(255, 138, 61, 0.24);
    background: rgba(255, 138, 61, 0.12);
    color: #ffe3ca;
    font-weight: 700;
    cursor: pointer;
}
@media (max-width: 768px) {
    .guide-btn {
        margin-left: 0;
        width: fit-content;
    }
    .guide-modal {
        max-height: 90vh;
        border-radius: 20px;
    }
    .guide-modal-header,
    .guide-modal-body,
    .guide-modal-footer {
        padding-inline: 18px;
    }
}`;

            document.head.appendChild(style);
            this._styleEl = style;
        },

        _renderSection(title, items) {
            return `
                <section class="guide-section">
                    <h4>${this._escape(title)}</h4>
                    <ul>${items.map((item) => `<li>${this._escape(item)}</li>`).join('')}</ul>
                </section>
            `;
        },

        _ensureModal() {
            if (this._modalEl) return;

            const overlay = document.createElement('div');
            overlay.className = 'guide-overlay';
            overlay.id = 'guide-overlay';
            overlay.innerHTML = `
                <div class="guide-overlay-backdrop"></div>
                <div class="guide-modal" role="dialog" aria-modal="true">
                    <div class="guide-modal-header">
                        <span class="guide-modal-icon" aria-hidden="true"></span>
                        <div>
                            <h3 class="guide-modal-title"></h3>
                            <span class="guide-modal-subtitle"></span>
                        </div>
                        <button class="guide-modal-close" aria-label="Close">✕</button>
                    </div>
                    <div class="guide-modal-body"></div>
                    <div class="guide-modal-footer">
                        <button class="guide-modal-action"></button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            this._modalEl = overlay;

            const hide = () => this.hide();
            overlay.querySelector('.guide-overlay-backdrop').addEventListener('click', hide);
            overlay.querySelector('.guide-modal-close').addEventListener('click', hide);
            overlay.querySelector('.guide-modal-action').addEventListener('click', hide);
        },

        show(tabName) {
            const copy = this._copy();
            const tab = this._tab(tabName);
            if (!tab) return;

            this._ensureModal();
            this._openTab = tabName;

            const modal = this._modalEl;
            modal.querySelector('.guide-modal-icon').textContent = tab.icon;
            modal.querySelector('.guide-modal-title').textContent = tab.title;
            modal.querySelector('.guide-modal-subtitle').textContent = copy.subtitle;
            modal.querySelector('.guide-modal-action').textContent = copy.close;

            modal.querySelector('.guide-modal-body').innerHTML = [
                this._renderSection(copy.sections.purpose, tab.purpose),
                this._renderSection(copy.sections.steps, tab.steps),
                this._renderSection(copy.sections.features, tab.features),
                this._renderSection(copy.sections.tips, tab.tips),
            ].join('');

            modal.classList.add('visible');
            modal.querySelector('.guide-modal-action').focus();

            this._escHandler = (event) => {
                if (event.key === 'Escape') {
                    this.hide();
                }
            };
            document.addEventListener('keydown', this._escHandler, true);
        },

        hide() {
            if (!this._modalEl) return;
            this._modalEl.classList.remove('visible');
            this._openTab = null;
            if (this._escHandler) {
                document.removeEventListener('keydown', this._escHandler, true);
                this._escHandler = null;
            }
        },

        _button(tabName, pulse) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `guide-btn${pulse ? ' guide-btn--pulse' : ''}`;
            button.dataset.guideTab = tabName;
            button.innerHTML = `<span aria-hidden="true">❔</span><span>${this._escape(this._copy().button)}</span>`;
            button.addEventListener('click', () => this.show(tabName));
            return button;
        },

        _mountButtons() {
            let shouldPulse = false;
            try {
                shouldPulse = !localStorage.getItem('guide-visited');
                localStorage.setItem('guide-visited', '1');
            } catch (_error) {
                shouldPulse = false;
            }

            Object.entries(TAB_ANCHORS).forEach(([tabName, selector]) => {
                if (document.querySelector(`[data-guide-tab="${tabName}"]`)) return;

                const anchor = document.querySelector(selector);
                if (!anchor) return;

                const button = this._button(tabName, shouldPulse);
                if (anchor.matches('.panel-title, .setup-title')) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'guide-inline-header';
                    anchor.parentNode.insertBefore(wrapper, anchor);
                    wrapper.appendChild(anchor);
                    wrapper.appendChild(button);
                    return;
                }

                anchor.appendChild(button);
            });
        },

        _refreshButtons() {
            const label = this._copy().button;
            document.querySelectorAll('.guide-btn span:last-child').forEach((node) => {
                node.textContent = label;
            });

            if (this._openTab && this._modalEl?.classList.contains('visible')) {
                this.show(this._openTab);
            }
        },

        init() {
            if (this._initialized) return;
            this._initialized = true;
            if (window.I18n?.init && !window.I18n._initialized) {
                window.I18n.init();
                window.I18n.applyToDOM?.();
            }
            this._injectStyles();
            this._mountButtons();
            document.addEventListener('languageChanged', () => this._refreshButtons());
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Guide.init());
    } else {
        Guide.init();
    }

    window.Guide = Guide;
})();
