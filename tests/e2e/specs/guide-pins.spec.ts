import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Characterization pins for frontend/js/guide.js (1,034 lines) — step 0 of
 * the pins-first decomposition protocol used by gallery, manual-sort,
 * artist-ident, separation-console, virtual-list, and vlm-caption.
 *
 * guide.js is a strict IIFE with three closure-private immutable data blocks
 * (GUIDE_COPY, TAB_SHORTCUTS, TAB_ANCHORS) and one stateful object published
 * as window.Guide. The state is held on that object (_modalEl, _styleEl,
 * _initialized, _openTab, and the live _escHandler), while every method uses
 * `this`. The split must preserve the final window.Guide identity and the
 * keyboard-shortcuts bridge; it must not turn the private data blocks into
 * enumerable window globals.
 *
 * The only external runtime reader is keyboard-shortcuts.js:
 *   #btn-help -> Guide.getCurrentTab() -> Guide.show(tab), falling back to the
 *   keyboard shortcuts panel when show() returns false.
 *
 * These pins need no images, models, or DB fixtures. They drive the real app,
 * real DOM, real I18n system, and real click handlers.
 */

test.describe.configure({ mode: 'serial' })

type GuideTabCopy = {
  icon: string
  title: string
  purpose: string[]
  steps: string[]
  features: string[]
  tips: string[]
}

type GuideCopy = {
  button: string
  subtitle: string
  close: string
  closeAria: string
  tour: string
  tourTitle: string
  refreshI18n: string
  refreshI18nTitle: string
  refreshI18nDone: string
  refreshI18nFailed: string
  sections: {
    purpose: string
    steps: string
    features: string
    tips: string
  }
  tabs: Record<string, GuideTabCopy>
}

type GuideFacade = {
  getCurrentTab: () => string
  _lang: () => string
  _copy: () => GuideCopy
  _tab: (tabName: string) => GuideTabCopy | undefined
  _escape: (value: string | null | undefined) => string
  _injectStyles: () => void
  _renderShortcutsSection: (tabName: string) => string
  _ensureModal: () => void
  show: (tab: string) => boolean
  hide: () => void
  refreshTranslations: () => Promise<void>
  init: () => void
  _button: (tabName: string, pulse: boolean) => HTMLButtonElement
  _mountButtons: () => void
  _refreshButtons: () => void
  _renderSection: (title: string, items: string[]) => string
  _modalEl: HTMLElement | null
  _styleEl: HTMLStyleElement | null
  _initialized: boolean
  _openTab: string | null
  _escHandler?: ((event: KeyboardEvent) => void) | null
}

type GuideWindow = typeof window & {
  App: {
    switchView: (view: string) => void
  }
  Guide: GuideFacade
  I18n: {
    getLang: () => string
    setLang: (lang: string) => void
  }
  OnboardingTour?: {
    resetState: () => void
    start: () => void
  }
  _switchSortingSub: (sub: string) => void
  __guideTourCalls?: { reset: number; start: number }
}

async function gotoGuide(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const w = window as GuideWindow
    return document.documentElement.dataset.appReady === '1'
      && w.Guide?._initialized === true
      && typeof w.Guide.show === 'function'
      && typeof w.App?.switchView === 'function'
      && typeof w._switchSortingSub === 'function'
  })
  await expect(page.locator('#btn-help')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await gotoGuide(page)
})

test('window.Guide exposes the stateful singleton surface and mounts one inline button per supported anchor', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const w = window as GuideWindow
    const guide = w.Guide
    const requiredFunctions = [
      'getCurrentTab', '_lang', '_copy', '_tab', '_escape', '_injectStyles',
      '_renderSection', '_renderShortcutsSection', '_ensureModal', 'show',
      'hide', 'refreshTranslations', '_button', '_mountButtons',
      '_refreshButtons', 'init',
    ] as const
    const inlineTabs = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-tab]'))
      .map((button) => button.dataset.guideTab || '')
      .sort()
    return {
      isObject: guide !== null && typeof guide === 'object',
      identity: w.Guide === guide,
      sealed: Object.isSealed(guide),
      frozen: Object.isFrozen(guide),
      missingFunctions: requiredFunctions.filter((name) => typeof guide[name] !== 'function'),
      initialized: guide._initialized,
      openTab: guide._openTab,
      modalBeforeFirstOpen: guide._modalEl,
      styleId: guide._styleEl?.id || null,
      styleCount: document.querySelectorAll('#guide-system-styles').length,
      inlineTabs,
      privateDataLeakedToWindow: [
        'GUIDE_COPY', 'TAB_SHORTCUTS', 'TAB_ANCHORS',
      ].filter((name) => Object.prototype.hasOwnProperty.call(window, name)),
      guideVisited: localStorage.getItem('guide-visited'),
    }
  })

  expect(probe.isObject).toBe(true)
  expect(probe.identity).toBe(true)
  expect(probe.sealed).toBe(false)
  expect(probe.frozen).toBe(false)
  expect(probe.missingFunctions).toEqual([])
  expect(probe.initialized).toBe(true)
  expect(probe.openTab).toBeNull()
  expect(probe.modalBeforeFirstOpen).toBeNull()
  expect(probe.styleId).toBe('guide-system-styles')
  expect(probe.styleCount).toBe(1)
  expect(probe.inlineTabs).toEqual(['artist', 'censor', 'promptlab', 'similar'])
  expect(probe.privateDataLeakedToWindow).toEqual([])
  expect(probe.guideVisited).toBe('1')
})

test('init and button mounting are idempotent and languageChanged has one refresh listener', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const w = window as GuideWindow
    const guide = w.Guide
    const identity = guide
    const originalRefresh = guide._refreshButtons
    let refreshCalls = 0
    guide._refreshButtons = function (this: GuideFacade): void {
      refreshCalls += 1
      return originalRefresh.call(this)
    }

    guide.init()
    guide.init()
    guide._mountButtons()
    guide._mountButtons()
    document.dispatchEvent(new CustomEvent('languageChanged', {
      detail: { lang: w.I18n.getLang() },
    }))

    const counts = Array.from(document.querySelectorAll<HTMLElement>('[data-guide-tab]'))
      .reduce<Record<string, number>>((acc, button) => {
        const tab = button.dataset.guideTab || ''
        acc[tab] = (acc[tab] || 0) + 1
        return acc
      }, {})
    guide._refreshButtons = originalRefresh
    return {
      sameIdentity: w.Guide === identity,
      styleCount: document.querySelectorAll('#guide-system-styles').length,
      counts,
      refreshCalls,
    }
  })

  expect(probe.sameIdentity).toBe(true)
  expect(probe.styleCount).toBe(1)
  expect(probe.counts).toEqual({ censor: 1, similar: 1, promptlab: 1, artist: 1 })
  expect(probe.refreshCalls).toBe(1)
})

test('desktop help opens the English gallery guide with sections, shortcuts, focus, and Escape cleanup', async ({ page }) => {
  await page.evaluate(() => (window as GuideWindow).I18n.setLang('en'))
  await page.locator('#btn-help').click()

  const overlay = page.locator('#guide-overlay')
  await expect(overlay).toHaveClass(/visible/)
  await expect(overlay.locator('.guide-modal-title')).toHaveText('Gallery')
  await expect(overlay.locator('.guide-modal-subtitle')).toHaveText('What this tab does and how to use it')
  await expect(overlay.locator('.guide-section')).toHaveCount(5)
  await expect(overlay.locator('.guide-section h4')).toHaveText([
    'What This Tab Is For',
    'How To Use It',
    'Main Functions',
    'Practical Tips',
    '⌨️ Keyboard Shortcuts',
  ])
  await expect(overlay.locator('.guide-shortcut-key')).toContainText(['G / L / W', '?', 'Esc'])
  await expect(overlay.locator('.guide-modal-action')).toBeFocused()

  const openState = await page.evaluate(() => {
    const guide = (window as GuideWindow).Guide
    return { openTab: guide._openTab, escType: typeof guide._escHandler }
  })
  expect(openState).toEqual({ openTab: 'gallery', escType: 'function' })

  await page.keyboard.press('Escape')
  await expect(overlay).not.toHaveClass(/visible/)
  expect(await page.evaluate(() => {
    const guide = (window as GuideWindow).Guide
    return { openTab: guide._openTab, escHandler: guide._escHandler ?? null }
  })).toEqual({ openTab: null, escHandler: null })
})

test('an open guide and every inline guide button refresh when the language changes', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as GuideWindow
    w.I18n.setLang('en')
    w.Guide.show('gallery')
  })
  await expect(page.locator('.guide-modal-title')).toHaveText('Gallery')

  await page.evaluate(() => (window as GuideWindow).I18n.setLang('zh-CN'))
  await expect(page.locator('.guide-modal-title')).toHaveText('图库')
  await expect(page.locator('.guide-modal-subtitle')).toHaveText('这个标签页能做什么，以及应该怎么用')
  await expect(page.locator('.guide-modal-action')).toHaveText('关闭')

  const labels = await page.locator('[data-guide-tab]').evaluateAll((buttons) =>
    buttons.map((button) => ({
      title: button.getAttribute('title'),
      aria: button.getAttribute('aria-label'),
    })))
  expect(labels).toEqual(Array.from({ length: 4 }, () => ({ title: '指南', aria: '指南' })))
})

test('sorting sub-view routing opens the matching Manual Sort and Auto-Separate guides', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as GuideWindow
    w.I18n.setLang('en')
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#view-manual')).toBeVisible()
  expect(await page.evaluate(() => (window as GuideWindow).Guide.getCurrentTab())).toBe('manual')
  await page.locator('#btn-help').click()
  await expect(page.locator('.guide-modal-title')).toHaveText('Manual Sort')
  await page.locator('.guide-modal-action').click()

  await page.evaluate(() => (window as GuideWindow)._switchSortingSub('autosep'))
  await expect(page.locator('#view-autosep')).toBeVisible()
  expect(await page.evaluate(() => (window as GuideWindow).Guide.getCurrentTab())).toBe('autosep')
  await page.locator('#btn-help').click()
  await expect(page.locator('.guide-modal-title')).toHaveText('Auto-Separate')
})

test('missing contextual copy returns false and the help bridge falls back to keyboard shortcuts', async ({ page }) => {
  const directResult = await page.evaluate(() => (window as GuideWindow).Guide.show('not-a-real-tab'))
  expect(directResult).toBe(false)
  await expect(page.locator('#guide-overlay')).toHaveCount(0)

  await page.evaluate(() => {
    const guide = (window as GuideWindow).Guide
    guide.getCurrentTab = () => 'not-a-real-tab'
  })
  await page.locator('#btn-help').click()
  await expect(page.locator('#keyboard-shortcuts-panel')).toHaveClass(/visible/)
  await expect(page.locator('#guide-overlay')).toHaveCount(0)
})

test('the Tour action closes the guide and calls the OnboardingTour reset/start seam once', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as GuideWindow
    w.__guideTourCalls = { reset: 0, start: 0 }
    // onboarding.js publishes one lexical const object on window. The Guide
    // handler checks window.OnboardingTour but calls the bare lexical binding,
    // so mutate that shared object's methods instead of replacing the window
    // property with a different object.
    if (!w.OnboardingTour) throw new Error('OnboardingTour is unavailable')
    w.OnboardingTour.resetState = () => { w.__guideTourCalls!.reset += 1 }
    w.OnboardingTour.start = () => { w.__guideTourCalls!.start += 1 }
    w.Guide.show('gallery')
  })
  await page.locator('.guide-modal-tour').click()
  await expect(page.locator('#guide-overlay')).not.toHaveClass(/visible/)
  expect(await page.evaluate(() => (window as GuideWindow).__guideTourCalls)).toEqual({ reset: 1, start: 1 })
})

test('section rendering escapes titles and list items instead of creating executable markup', async ({ page }) => {
  const probe = await page.evaluate(() => {
    const html = (window as GuideWindow).Guide._renderSection(
      '<img src=x onerror=alert(1)>',
      ['<script>window.__guideXss = true</script>', 'safe & sound'],
    )
    const template = document.createElement('template')
    template.innerHTML = html
    return {
      html,
      images: template.content.querySelectorAll('img').length,
      scripts: template.content.querySelectorAll('script').length,
      title: template.content.querySelector('h4')?.textContent,
      items: Array.from(template.content.querySelectorAll('li')).map((item) => item.textContent),
    }
  })

  expect(probe.images).toBe(0)
  expect(probe.scripts).toBe(0)
  expect(probe.title).toBe('<img src=x onerror=alert(1)>')
  expect(probe.items).toEqual(['<script>window.__guideXss = true</script>', 'safe & sound'])
  expect(probe.html).toContain('&lt;img')
  expect(probe.html).toContain('&lt;script&gt;')
})

test('re-show replaces the keydown listener and closing restores focus to the help trigger', async ({ page }) => {
  await page.locator('#btn-help').focus()

  const probe = await page.evaluate(() => {
    const guide = (window as GuideWindow).Guide
    guide.show('gallery')
    const firstHandler = guide._escHandler
    guide.show('gallery')
    const secondHandler = guide._escHandler
    guide.hide()

    const originalHide = guide.hide
    let leakedHideCalls = 0
    guide.hide = function (this: GuideFacade): void {
      leakedHideCalls += 1
      originalHide.call(this)
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    guide.hide = originalHide
    if (firstHandler) document.removeEventListener('keydown', firstHandler, true)

    return {
      distinctHandlers: firstHandler !== secondHandler,
      leakedHideCalls,
      focusedId: document.activeElement instanceof HTMLElement ? document.activeElement.id : null,
    }
  })

  expect(probe.distinctHandlers).toBe(true)
  expect(probe.leakedHideCalls).toBe(0)
  expect(probe.focusedId).toBe('btn-help')
})

test('the localized dialog has an accessible name and traps focus inside its controls', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as GuideWindow
    w.I18n.setLang('zh-CN')
    w.Guide.show('gallery')
  })

  const dialog = page.getByRole('dialog', { name: '图库' })
  await expect(dialog).toBeVisible()
  const closeButton = dialog.locator('.guide-modal-close')
  const tourButton = dialog.locator('.guide-modal-tour')
  const actionButton = dialog.locator('.guide-modal-action')
  await expect(closeButton).toHaveAttribute('aria-label', '关闭指南')
  await expect(tourButton).toHaveText('🎓 重新开始引导')
  await expect(tourButton).toHaveAttribute('title', '从头重新开始新手引导')
  await expect(actionButton).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(closeButton).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(actionButton).toBeFocused()
})

test('Manual Sort guide covers Slot Sort, A/B Showdown, and Keep/Reject in both languages', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as GuideWindow
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
    w.I18n.setLang('en')
    w.Guide.show('manual')
  })

  const body = page.locator('.guide-modal-body')
  await expect(body).toContainText('Slot sort (WASD)')
  await expect(body).toContainText('A/B Showdown')
  await expect(body).toContainText('Keep / Reject')

  await page.evaluate(() => (window as GuideWindow).I18n.setLang('zh-CN'))
  await expect(body).toContainText('槽位整理（WASD）')
  await expect(body).toContainText('A/B 擂台')
  await expect(body).toContainText('留 / 汰')
})
