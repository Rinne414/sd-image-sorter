/**
 * SD Image Sorter - Onboarding Tour
 * Interactive guided tour for new users
 */

const OnboardingTour = (function() {
    'use strict';

    const STORAGE_KEY = 'sd-image-sorter-onboarding-completed';
    const DISMISSED_KEY = 'sd-image-sorter-onboarding-dismissed-version';
    const AUTO_START_ENABLED = true;
    const FIRST_RUN_CHECK_KEY = 'sd-image-sorter-has-seen-images';

    // Current tour version - increment when adding new features
    const TOUR_VERSION = 1;

    // Tour step definitions (bilingual)
    const TOUR_STEPS_EN = [
        {
            id: 'welcome',
            title: 'Welcome to SD Image Sorter',
            content: `<p>This tool helps you organize, tag, and manage your Stable Diffusion generated images.</p>
                <ul>
                    <li>Scan folders for images with metadata</li>
                    <li>AI-powered tagging with WD14</li>
                    <li>Auto-separate by filters</li>
                    <li>Manual keyboard sorting (WASD)</li>
                    <li>Canvas-based censor editing</li>
                </ul>`,
            target: null,
            position: 'center'
        },
        {
            id: 'navigation-tabs',
            title: 'Navigation Tabs',
            content: `<p>Switch between different views:</p>
                <ul>
                    <li><strong>Gallery</strong> - Browse and filter your images</li>
                    <li><strong>Auto-Separate</strong> - Move images matching filters</li>
                    <li><strong>Manual Sort</strong> - WASD keyboard sorting</li>
                    <li><strong>Censored Edit</strong> - Canvas-based censoring</li>
                    <li><strong>Similar</strong> - Find similar images</li>
                    <li><strong>Prompt Lab</strong> - Analyze prompts</li>
                    <li><strong>Artist ID</strong> - Identify artist styles</li>
                </ul>`,
            target: '.nav-tabs',
            position: 'bottom'
        },
        {
            id: 'scan-folder',
            title: 'Scan Your Images',
            content: `<p>Click <strong>Scan Folder</strong> to load images from a directory.</p>
                <ul>
                    <li>Detect the generator (ComfyUI, NAI, WebUI, Forge)</li>
                    <li>Extract prompts, checkpoints, and LoRAs</li>
                    <li>Store metadata in a local database</li>
                </ul>`,
            target: '#btn-scan',
            position: 'bottom'
        },
        {
            id: 'setup',
            title: 'Feature Setup',
            content: `<p>Click the <strong>wrench icon</strong> to download AI models.</p>
                <ul>
                    <li>WD14 tagger for auto-tagging</li>
                    <li>CLIP for similar image search</li>
                    <li>NudeNet / YOLO for censor detection</li>
                </ul>
                <p>Models download on first use. Some need a restart after install.</p>`,
            target: '#btn-open-model-manager',
            position: 'bottom'
        },
        {
            id: 'complete',
            title: 'You\'re All Set!',
            content: `<p>Start by scanning a folder, then explore the features.</p>
                <p>Click anywhere outside this dialog to close it.</p>`,
            target: null,
            position: 'center'
        }
    ];

    const TOUR_STEPS_ZH = [
        {
            id: 'welcome',
            title: '欢迎使用 SD Image Sorter',
            content: `<p>这个工具帮你整理、打标、管理 Stable Diffusion 生成的图片。</p>
                <ul>
                    <li>扫描文件夹，自动读取 SD 元数据</li>
                    <li>WD14 AI 自动打标</li>
                    <li>按筛选条件自动分类</li>
                    <li>WASD 键盘快速手动分拣</li>
                    <li>画布式打码编辑</li>
                </ul>`,
            target: null,
            position: 'center'
        },
        {
            id: 'navigation-tabs',
            title: '导航标签',
            content: `<p>切换不同功能：</p>
                <ul>
                    <li><strong>Gallery</strong> - 浏览和筛选图库</li>
                    <li><strong>Auto-Separate</strong> - 按筛选批量移动</li>
                    <li><strong>Manual Sort</strong> - WASD 键盘分拣</li>
                    <li><strong>Edit</strong> - 打码编辑</li>
                    <li><strong>Similar</strong> - 相似图搜索</li>
                    <li><strong>Prompt Lab</strong> - 提示词工坊</li>
                    <li><strong>Artist ID</strong> - 画师风格识别</li>
                </ul>`,
            target: '.nav-tabs',
            position: 'bottom'
        },
        {
            id: 'scan-folder',
            title: '扫描图片',
            content: `<p>点击 <strong>Scan Folder</strong> 导入图片文件夹。</p>
                <ul>
                    <li>自动识别生成器（ComfyUI、NAI、WebUI、Forge）</li>
                    <li>提取 prompt、checkpoint、LoRA 信息</li>
                    <li>元数据存入本地数据库</li>
                </ul>`,
            target: '#btn-scan',
            position: 'bottom'
        },
        {
            id: 'setup',
            title: '功能准备',
            content: `<p>点击右上角 <strong>🧰 扳手图标</strong> 下载 AI 模型。</p>
                <ul>
                    <li>WD14 打标模型</li>
                    <li>CLIP 相似图搜索模型</li>
                    <li>NudeNet / YOLO 打码检测模型</li>
                </ul>
                <p>模型首次使用时下载。部分功能安装后需要重启。</p>`,
            target: '#btn-open-model-manager',
            position: 'bottom'
        },
        {
            id: 'complete',
            title: '准备就绪！',
            content: `<p>先扫描一个文件夹，然后探索各项功能吧。</p>
                <p>点击对话框外任意位置可关闭本引导。</p>`,
            target: null,
            position: 'center'
        }
    ];

    function _getSteps() {
        return window.I18n?.getLang?.() === 'zh-CN' ? TOUR_STEPS_ZH : TOUR_STEPS_EN;
    }

    // State
    let currentStepIndex = 0;
    let isActive = false;
    let overlayEl = null;
    let tooltipEl = null;
    let progressEl = null;
    let originalOverflow = '';

    function cleanupResidualTourUi() {
        document.querySelectorAll('.onboarding-overlay, .onboarding-tooltip').forEach((node) => {
            node.remove();
        });
        document.body.style.overflow = '';
    }

    /**
     * Check if onboarding has been completed
     * @returns {boolean}
     */
    function isCompleted() {
        const completed = localStorage.getItem(STORAGE_KEY);
        if (completed) {
            try {
                const data = JSON.parse(completed);
                return data.version >= TOUR_VERSION && data.completed === true;
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Check if current version was dismissed
     * @returns {boolean}
     */
    function wasDismissed() {
        const dismissed = localStorage.getItem(DISMISSED_KEY);
        return dismissed && parseInt(dismissed, 10) >= TOUR_VERSION;
    }

    /**
     * Mark onboarding as completed
     */
    function markCompleted() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: TOUR_VERSION,
            completed: true,
            completedAt: new Date().toISOString()
        }));
    }

    /**
     * Mark current version as dismissed
     */
    function markDismissed() {
        localStorage.setItem(DISMISSED_KEY, TOUR_VERSION.toString());
    }

    /**
     * Reset onboarding state (for testing or manual restart)
     */
    function resetState() {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(DISMISSED_KEY);
    }

    /**
     * Create the overlay element
     * @returns {HTMLElement}
     */
    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'onboarding-overlay';
        overlay.innerHTML = `
            <div class="onboarding-highlight-container">
                <div class="onboarding-highlight"></div>
            </div>
        `;
        return overlay;
    }

    /**
     * Create the tooltip element
     * @returns {HTMLElement}
     */
    function createTooltip() {
        const isZh = window.I18n?.getLang?.() === 'zh-CN';
        const tooltip = document.createElement('div');
        tooltip.className = 'onboarding-tooltip';
        tooltip.setAttribute('role', 'dialog');
        tooltip.setAttribute('aria-labelledby', 'onboarding-title');
        tooltip.innerHTML = `
            <div class="onboarding-header">
                <h3 id="onboarding-title" class="onboarding-title"></h3>
                <button class="onboarding-lang" aria-label="Switch language" title="${isZh ? 'Switch to English' : '切换到中文'}">🌐</button>
                <button class="onboarding-skip" aria-label="${isZh ? '跳过引导' : 'Skip tour'}">
                    <span>${isZh ? '跳过' : 'Skip'}</span>
                </button>
            </div>
            <div class="onboarding-content"></div>
            <div class="onboarding-footer">
                <div class="onboarding-progress"></div>
                <div class="onboarding-actions">
                    <button class="btn btn-ghost onboarding-back" disabled>
                        <span>${isZh ? '上一步' : 'Back'}</span>
                    </button>
                    <button class="btn btn-primary onboarding-next">
                        <span>${isZh ? '下一步' : 'Next'}</span>
                    </button>
                </div>
            </div>
        `;
        return tooltip;
    }

    /**
     * Update progress indicators
     */
    function updateProgress() {
        const progressContainer = tooltipEl.querySelector('.onboarding-progress');
        progressContainer.innerHTML = '';

        _getSteps().forEach((step, index) => {
            const dot = document.createElement('span');
            dot.className = 'onboarding-progress-dot';
            if (index < currentStepIndex) {
                dot.classList.add('completed');
            } else if (index === currentStepIndex) {
                dot.classList.add('active');
            }
            dot.setAttribute('aria-label', `Step ${index + 1}`);
            progressContainer.appendChild(dot);
        });
    }

    /**
     * Position the tooltip relative to the target element
     * @param {HTMLElement} targetEl - Target element to highlight
     * @param {string} position - Preferred position (top, bottom, left, right, center)
     */
    function positionTooltip(targetEl, position) {
        const highlight = overlayEl.querySelector('.onboarding-highlight');

        if (!targetEl || position === 'center') {
            // Center mode - hide highlight, center tooltip
            highlight.style.display = 'none';
            tooltipEl.classList.add('onboarding-center');
            tooltipEl.style.top = '50%';
            tooltipEl.style.left = '50%';
            tooltipEl.style.transform = 'translate(-50%, -50%)';
            return;
        }

        highlight.style.display = 'block';
        tooltipEl.classList.remove('onboarding-center');

        // Get target position
        const targetRect = targetEl.getBoundingClientRect();
        const tooltipRect = tooltipEl.getBoundingClientRect();

        // Position highlight around target
        const padding = 8;
        highlight.style.top = `${targetRect.top - padding}px`;
        highlight.style.left = `${targetRect.left - padding}px`;
        highlight.style.width = `${targetRect.width + padding * 2}px`;
        highlight.style.height = `${targetRect.height + padding * 2}px`;

        // Position tooltip
        const gap = 16;
        let top, left;

        switch (position) {
            case 'top':
                top = targetRect.top - tooltipRect.height - gap;
                left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
                break;
            case 'bottom':
                top = targetRect.bottom + gap;
                left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
                break;
            case 'left':
                top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
                left = targetRect.left - tooltipRect.width - gap;
                break;
            case 'right':
                top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
                left = targetRect.right + gap;
                break;
            default:
                top = targetRect.bottom + gap;
                left = targetRect.left;
        }

        // Keep tooltip within viewport
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < 20) left = 20;
        if (left + tooltipRect.width > viewportWidth - 20) {
            left = viewportWidth - tooltipRect.width - 20;
        }
        if (top < 80) top = 80; // Below nav bar
        if (top + tooltipRect.height > viewportHeight - 20) {
            top = viewportHeight - tooltipRect.height - 20;
        }

        tooltipEl.style.top = `${top}px`;
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.transform = 'none';

        // Scroll target into view if needed
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /**
     * Show a specific step
     * @param {number} index - Step index
     */
    function showStep(index) {
        if (index < 0 || index >= _getSteps().length) return;

        currentStepIndex = index;
        const step = _getSteps()[index];

        // Update tooltip content
        const titleEl = tooltipEl.querySelector('.onboarding-title');
        const contentEl = tooltipEl.querySelector('.onboarding-content');

        titleEl.textContent = step.title;
        contentEl.innerHTML = step.content;

        // Update buttons
        const backBtn = tooltipEl.querySelector('.onboarding-back');
        const nextBtn = tooltipEl.querySelector('.onboarding-next');

        backBtn.disabled = index === 0;
        const isZh = window.I18n?.getLang?.() === 'zh-CN';
        nextBtn.querySelector('span').textContent = index === _getSteps().length - 1 ? (isZh ? '完成' : 'Finish') : (isZh ? '下一步' : 'Next');

        // Update progress
        updateProgress();

        // Find target element and position
        let targetEl = null;
        if (step.target) {
            targetEl = document.querySelector(step.target);
        }

        // Small delay to allow DOM updates
        requestAnimationFrame(() => {
            positionTooltip(targetEl, step.position);
        });
    }

    /**
     * Go to next step
     */
    function nextStep() {
        if (currentStepIndex < _getSteps().length - 1) {
            showStep(currentStepIndex + 1);
        } else {
            complete();
        }
    }

    /**
     * Go to previous step
     */
    function prevStep() {
        if (currentStepIndex > 0) {
            showStep(currentStepIndex - 1);
        }
    }

    /**
     * Start the tour
     */
    function start() {
        if (isActive) return;

        isActive = true;
        currentStepIndex = 0;

        // Do NOT block body scroll — it makes the page unresponsive if
        // cleanup fails for any reason.

        // Create and append elements
        overlayEl = createOverlay();
        tooltipEl = createTooltip();

        document.body.appendChild(overlayEl);
        document.body.appendChild(tooltipEl);

        // Add event listeners
        const skipBtn = tooltipEl.querySelector('.onboarding-skip');
        const backBtn = tooltipEl.querySelector('.onboarding-back');
        const nextBtn = tooltipEl.querySelector('.onboarding-next');

        skipBtn.addEventListener('click', skip);
        backBtn.addEventListener('click', prevStep);
        nextBtn.addEventListener('click', nextStep);

        // Language toggle: switch language and restart tour with new language
        const langBtn = tooltipEl.querySelector('.onboarding-lang');
        if (langBtn) {
            langBtn.addEventListener('click', () => {
                const newLang = window.I18n?.getLang?.() === 'zh-CN' ? 'en' : 'zh-CN';
                if (window.I18n?.setLang) window.I18n.setLang(newLang);
                end();
                // Restart with new language
                setTimeout(() => start(), 100);
            });
        }

        // Allow clicking the overlay backdrop to dismiss the tour
        overlayEl.addEventListener('click', (e) => {
            if (e.target !== overlayEl && !e.target.classList.contains('onboarding-highlight-container')) return;
            overlayEl.style.pointerEvents = 'none';
            const target = document.elementFromPoint(e.clientX, e.clientY);
            overlayEl.style.pointerEvents = '';
            const navTarget = target?.closest?.('.nav-tab, .mobile-nav-item');
            skip();
            if (navTarget) navTarget.click();
        });

        // Keyboard navigation
        document.addEventListener('keydown', handleKeydown);

        // Show first step
        showStep(0);

        // Announce to screen readers
        tooltipEl.setAttribute('aria-live', 'polite');
    }

    /**
     * Handle keyboard navigation
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
        if (!isActive) return;

        switch (e.key) {
            case 'ArrowRight':
            case 'Enter':
                e.preventDefault();
                nextStep();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                prevStep();
                break;
            case 'Escape':
                e.preventDefault();
                skip();
                break;
        }
    }

    /**
     * Skip the tour
     */
    function skip() {
        markDismissed();
        end();
    }

    /**
     * Complete the tour
     */
    function complete() {
        markCompleted();
        end();
    }

    /**
     * End the tour (cleanup)
     */
    function end() {
        isActive = false;

        // Remove event listeners
        document.removeEventListener('keydown', handleKeydown);

        // Remove elements immediately — no animation delay that could leave
        // a blocking overlay if something goes wrong.
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        if (tooltipEl && tooltipEl.parentNode) {
            tooltipEl.parentNode.removeChild(tooltipEl);
        }

        overlayEl = null;
        tooltipEl = null;

        // Restore body scroll (safety — in case old code set it)
        document.body.style.overflow = '';
    }

    /**
     * Initialize - auto-start tour for first-time users.
     * Tour is also available via OnboardingTour.start() programmatically.
     */
    function init() {
        cleanupResidualTourUi();

        // Auto-start only on true first-run: user has never loaded images
        // and hasn't completed or dismissed the tour before. Re-check the
        // active view after the startup delay so the tour does not cover a
        // user who already jumped into a focused workflow such as Dataset
        // Maker.
        if (AUTO_START_ENABLED && !isCompleted() && !wasDismissed()) {
            const hasSeen = localStorage.getItem(FIRST_RUN_CHECK_KEY);
            if (!hasSeen) {
                setTimeout(() => {
                    if (window.AppState?.currentView && window.AppState.currentView !== 'gallery') return;
                    const activeView = document.querySelector('.view.active');
                    if (activeView && activeView.id && activeView.id !== 'view-gallery') return;
                    start();
                    // Safety: force-clean after 90s in case user is stuck
                    setTimeout(() => {
                        if (isActive) {
                            skip();
                            cleanupResidualTourUi();
                        }
                    }, 90000);
                }, 800);
            }
        }
    }

    /** Mark that the user has loaded images at least once (called by app after gallery loads). */
    function markHasSeenImages() {
        localStorage.setItem(FIRST_RUN_CHECK_KEY, '1');
    }

    // Public API
    return {
        init,
        start,
        skip,
        complete,
        resetState,
        isCompleted,
        wasDismissed,
        markHasSeenImages
    };
})();

// Export to window for backward compatibility
window.OnboardingTour = OnboardingTour;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', OnboardingTour.init);
} else {
    OnboardingTour.init();
}
