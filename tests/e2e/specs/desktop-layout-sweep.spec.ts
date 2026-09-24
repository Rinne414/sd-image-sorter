import { expect, test, type Page } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Whole-app desktop layout sweep: the entry page, every page and sub-tab,
 * and every dialog (tabbed ones tab by tab) at 1366x768, 1920x1080 and
 * 2560x1440, with a few seeded images so pages show content.
 *
 * Per screen it records:
 * - page-overflow: the page scrolls sideways;
 * - dialog-outside: a dialog box extends past the window;
 * - offscreen: a control sits past the window edge, not in a sideways scroller;
 * - clipped-control: a control cut off by a container that cannot scroll;
 * - covered: a control on screen whose centre another element covers
 *   (not counting pinned bars that the control can scroll out from under);
 * - pinned-transparent: a pinned (sticky) bar with no background inside a
 *   scrolling area, so content shows through it;
 * - close-overlap: a dialog's close button on top of header text or controls;
 * - clipped-text: text cut off by overflow hidden without an ellipsis;
 * - console-error: an error logged while the screen was open.
 *
 * Each run writes .tmp/desktop-layout-sweep/ (findings JSON plus one
 * screenshot per screen) and fails on any finding, listing them all.
 */

test.describe.configure({ mode: 'serial' })
test.setTimeout(600_000)

const OUT_DIR = path.resolve(__dirname, '../../../.tmp/desktop-layout-sweep')
const FIXTURE_DIR = path.resolve(__dirname, '../../../.tmp/e2e-layout-sweep-images')

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

const VIEWS = ['gallery', 'reader', 'sorting', 'censor', 'similar', 'dataset', 'artist', 'promptlab', 'reverse'] as const

// Needs a finished obfuscation run to have anything to show.
const DIALOGS_WITHOUT_SWEEP_STATE = ['obfuscate-preview-modal']

// Dialogs opened through the shared showModal(); the rest have their own opener below.
const GENERIC_MODALS = [
  'analytics-modal', 'autosep-overflow-modal', 'autosep-settings-modal', 'batch-export-modal',
  'caption-editor-modal', 'confirm-modal', 'detect-modal', 'dup-cleaner-modal',
  'entry-catalog-modal', 'export-modal', 'filter-modal', 'input-modal', 'library-roots-modal',
  'mass-tag-confirm-modal', 'mass-tag-modal', 'metadata-editor-modal', 'model-select-modal',
  'nav-customize-modal', 'obfuscate-preview-modal', 'promptlab-category-board-modal',
  'promptlab-image-picker-modal', 'publish-set-modal', 'queue-manager-modal', 'reconnect-modal',
  'rename-modal', 'repair-review-modal', 'save-options-modal', 'scan-modal', 'search-help-modal',
  'tags-library-modal', 'vlm-debug-chat-modal', 'vlm-settings-modal',
] as const

interface Finding {
  viewport: string
  screen: string
  kind: string
  selector: string
  text: string
  detail: string
}

let seededIds: number[] = []

test.beforeAll(async ({ playwright }, testInfo) => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const generators = ['comfyui', 'nai', 'webui', 'forge', 'unknown'] as const
  const colors = ['teal', 'purple', 'orange', 'green', 'gray', 'navy']
  for (let i = 0; i < 6; i += 1) {
    await createTestImage(FIXTURE_DIR, `sweep_${i}.png`, {
      width: i % 2 ? 768 : 512,
      height: i % 3 ? 512 : 896,
      color: colors[i],
      generator: generators[i % generators.length],
      prompt: `layout sweep fixture ${i}, 1girl, solo, long_hair, outdoors`,
      negativePrompt: 'lowres, bad anatomy',
      checkpoint: 'layout_sweep.safetensors',
    })
  }
  const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
  await api.post('/api/scan', { data: { folder_path: FIXTURE_DIR } })
  for (let i = 0; i < 120; i += 1) {
    const progress = await (await api.get('/api/scan/progress')).json()
    if (!['running', 'queued', 'starting', 'scanning'].includes(String(progress.status))) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const listed = await (await api.get('/api/images?limit=200&sort_by=newest')).json()
  const fixtureKey = FIXTURE_DIR.replace(/\\/g, '/').toLowerCase()
  seededIds = (listed.images || [])
    .filter((image: { path?: string }) => String(image.path || '').replace(/\\/g, '/').toLowerCase().startsWith(fixtureKey))
    .map((image: { id: number }) => image.id)
  await api.dispose()
})

test.afterAll(async ({ playwright }, testInfo) => {
  if (seededIds.length) {
    const api = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
    await api.post('/api/images/remove-selected', { data: { image_ids: seededIds } })
    await api.dispose()
  }
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

async function gotoApp(page: Page, skipEntry: boolean): Promise<void> {
  if (skipEntry) {
    await page.addInitScript(() => localStorage.setItem('sd-sorter-entry-skip-session', '1'))
  }
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.waitForTimeout(600)
}

async function closeAllModals(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.evaluate(() => {
    document.querySelectorAll('.modal.visible, .modal.active').forEach((modal) => {
      const hide = (window as any).hideModal
      if (typeof hide === 'function' && modal.id) hide(modal.id)
      modal.classList.remove('visible', 'active')
    })
    document.getElementById('toast-container')?.replaceChildren()
  })
  await page.waitForTimeout(150)
}

/** Runs inside the page: layout findings for everything under rootSelector. */
async function inspect(page: Page, rootSelector: string): Promise<Omit<Finding, 'viewport' | 'screen'>[]> {
  return page.evaluate((selector) => {
    const out: { kind: string; selector: string; text: string; detail: string }[] = []
    const vw = window.innerWidth
    const vh = window.innerHeight
    const describe = (el: Element): string => {
      const parts: string[] = []
      let node: Element | null = el
      for (let depth = 0; node && depth < 3; depth += 1) {
        if (node.id) { parts.unshift(`#${node.id}`); break }
        const cls = [...node.classList].slice(0, 2).map((c) => `.${c}`).join('')
        parts.unshift(`${node.tagName.toLowerCase()}${cls}`)
        node = node.parentElement
      }
      return parts.join(' > ')
    }
    const label = (el: Element) => (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ').trim().slice(0, 40)
    const add = (kind: string, el: Element, detail: string) => out.push({ kind, selector: describe(el), text: label(el), detail })
    const shown = (el: Element) => (el as any).checkVisibility
      ? (el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : (el as HTMLElement).offsetParent !== null
    const clips = (style: CSSStyleDeclaration) => /(hidden|clip)/.test(style.overflowX + style.overflowY)
    const scrolls = (style: CSSStyleDeclaration) => /(auto|scroll)/.test(style.overflowX + style.overflowY)
    const pinnedAncestor = (el: Element | null): Element | null => {
      for (let a = el; a; a = a.parentElement) {
        if (/(sticky|fixed)/.test(getComputedStyle(a).position)) return a
      }
      return null
    }
    const scrollAncestor = (el: Element): Element | null => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a)
        if (scrolls(s) && (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1)) return a
      }
      return null
    }

    const overflowX = document.documentElement.scrollWidth - vw
    if (overflowX > 1) out.push({ kind: 'page-overflow', selector: 'html', text: '', detail: `${overflowX}px` })

    const root = document.querySelector(selector)
    if (!root) return out

    if (root.classList.contains('modal')) {
      const box = root.querySelector('.modal-content')?.getBoundingClientRect()
      if (box && (box.left < -1 || box.top < -1 || box.right > vw + 1 || box.bottom > vh + 1)) {
        out.push({ kind: 'dialog-outside', selector, text: '', detail: `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}` })
      }
    }

    const controls = root.querySelectorAll('button, a[href], select, textarea, input:not([type=hidden]), [role=button], [role=tab]')
    controls.forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || !shown(el)) return
      if (el.matches('input[type=checkbox], input[type=radio]') && getComputedStyle(el).opacity === '0') return
      let visible = { left: 0, top: 0, right: vw, bottom: vh }
      let reachableByScroll = false
      let escaped = getComputedStyle(el).position === 'fixed'
      for (let a = el.parentElement; a; a = a.parentElement) {
        const style = getComputedStyle(a)
        // Ancestors outside a fixed-position box do not clip it.
        if (escaped) break
        if (style.position === 'fixed') escaped = true
        if (!clips(style) && !scrolls(style)) continue
        const ar = a.getBoundingClientRect()
        const partly = r.left < ar.left - 1 || r.right > ar.right + 1 || r.top < ar.top - 1 || r.bottom > ar.bottom + 1
        if (scrolls(style)) {
          if (partly) reachableByScroll = true
        } else if (partly && !reachableByScroll) {
          add('clipped-control', el, `cut by ${describe(a)}`)
          return
        }
        visible = {
          left: Math.max(visible.left, ar.left), top: Math.max(visible.top, ar.top),
          right: Math.min(visible.right, ar.right), bottom: Math.min(visible.bottom, ar.bottom),
        }
      }
      if (reachableByScroll) return
      if (r.right > vw + 1 || r.left < -1) { add('offscreen', el, `x ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`); return }
      const cx = (r.left + r.right) / 2
      const cy = (r.top + r.bottom) / 2
      if (cx < visible.left || cx > visible.right || cy < visible.top || cy > visible.bottom || cy > vh || cy < 0) return
      const hit = document.elementFromPoint(cx, cy)
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return
      const wrappingLabel = el.closest('label')
      if (wrappingLabel && (wrappingLabel === hit || wrappingLabel.contains(hit))) return
      // Under a pinned bar in a scrolling area: scrolling brings it out.
      const pinned = pinnedAncestor(hit)
      if (pinned && !pinned.contains(el) && scrollAncestor(el)) return
      add('covered', el, `by ${describe(hit)}`)
    })

    root.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el)
      if (style.position !== 'sticky' || !shown(el) || el.getBoundingClientRect().width < 160) return
      const bg = style.backgroundColor
      const transparent = bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg)
      if (transparent && style.backgroundImage === 'none' && scrollAncestor(el)) {
        add('pinned-transparent', el, 'sticky bar without a background in a scrolling area')
      }
    })

    root.querySelectorAll('.modal-close').forEach((close) => {
      if (!shown(close)) return
      const c = close.getBoundingClientRect()
      const overlaps = (r: DOMRect) => {
        const w = Math.min(r.right, c.right) - Math.max(r.left, c.left)
        const h = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
        return w > 3 && h > 3
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent || '').trim() || close.contains(node)) continue
        const parent = node.parentElement
        if (!parent || !shown(parent) || parent.clientWidth <= 2) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        if ([...range.getClientRects()].some(overlaps)) { add('close-overlap', parent, 'text under the close button'); return }
      }
      root.querySelectorAll('button, a[href], input, select').forEach((el) => {
        if (el === close || close.contains(el) || !shown(el)) return
        if (overlaps(el.getBoundingClientRect())) add('close-overlap', el, 'control under the close button')
      })
    })

    root.querySelectorAll('*').forEach((el) => {
      if (el.classList.contains('sr-only') || el.closest('.sr-only')) return
      const style = getComputedStyle(el)
      if (!clips(style) || style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') return
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0)
      // A label collapsed to zero width (top bar, icon buttons) is hidden on purpose.
      if (!hasText || !shown(el) || el.clientWidth <= 2) return
      const dx = el.scrollWidth - el.clientWidth
      const dy = el.scrollHeight - el.clientHeight
      if ((dx > 2 && /(hidden|clip)/.test(style.overflowX)) || (dy > 2 && /(hidden|clip)/.test(style.overflowY))) {
        add('clipped-text', el, `hidden ${Math.max(dx, 0)}x${Math.max(dy, 0)}px`)
      }
    })
    return out
  }, rootSelector)
}

async function sweepScreen(
  page: Page,
  findings: Finding[],
  errors: string[],
  viewport: string,
  screen: string,
  rootSelector: string,
): Promise<void> {
  errors.length = 0
  await page.waitForTimeout(500)
  await page.evaluate(() => document.getElementById('toast-container')?.replaceChildren())
  for (const f of await inspect(page, rootSelector)) findings.push({ viewport, screen, ...f })
  for (const message of errors) findings.push({ viewport, screen, kind: 'console-error', selector: '', text: '', detail: message.slice(0, 200) })
  await page.screenshot({ path: path.join(OUT_DIR, `${viewport}-${screen}.png`) })
}

function collectErrors(page: Page, errors: string[]): void {
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(String(error)))
}

function writeReport(viewport: string, part: string, findings: Finding[], notOpened: string[] = []): void {
  fs.writeFileSync(path.join(OUT_DIR, `findings-${viewport}-${part}.json`), JSON.stringify({ findings, notOpened }, null, 1))
}

for (const size of VIEWPORTS) {
  const viewport = `${size.width}`

  test(`pages at ${size.width}x${size.height}`, async ({ page }) => {
    const findings: Finding[] = []
    const errors: string[] = []
    collectErrors(page, errors)
    await page.setViewportSize(size)
    await gotoApp(page, false)
    await sweepScreen(page, findings, errors, viewport, 'entry', 'body')

    await page.evaluate(() => localStorage.setItem('sd-sorter-entry-skip-session', '1'))
    await gotoApp(page, true)
    for (const view of VIEWS) {
      await page.evaluate((name) => (window as any).App.switchView(name), view)
      if (view === 'sorting') {
        for (const sub of ['autosep', 'manual']) {
          await page.evaluate((name) => (window as any)._switchSortingSub?.(name), sub)
          await sweepScreen(page, findings, errors, viewport, `view-sorting-${sub}`, '#view-sorting')
        }
        continue
      }
      await sweepScreen(page, findings, errors, viewport, `view-${view}`, `#view-${view}`)
      if (view === 'dataset') {
        for (const tab of ['import', 'workbench', 'export']) {
          const button = page.locator(`#dataset-tab-${tab}`)
          if (await button.count() === 0) continue
          await button.click()
          await sweepScreen(page, findings, errors, viewport, `view-dataset-${tab}`, '#view-dataset')
        }
      }
    }
    writeReport(viewport, 'pages', findings)
    expect(findings, JSON.stringify(findings, null, 1)).toEqual([])
  })

  test(`dialogs at ${size.width}x${size.height}`, async ({ page }) => {
    const findings: Finding[] = []
    const errors: string[] = []
    const notOpened: string[] = []
    collectErrors(page, errors)
    await page.setViewportSize(size)
    await gotoApp(page, true)

    for (const id of GENERIC_MODALS) {
      await closeAllModals(page)
      // A dialog that lives inside a page only shows while that page is active.
      const opened = await page.evaluate((modalId) => {
        const modal = document.getElementById(modalId)
        const show = (window as any).showModal
        if (!modal || typeof show !== 'function') return false
        const view = modal.closest('.view')
        const viewName = view?.id?.replace(/^view-/, '')
        ;(window as any).App.switchView(viewName && viewName !== 'manual' && viewName !== 'autosep' ? viewName : 'gallery')
        if (viewName === 'autosep' || viewName === 'manual') {
          ;(window as any).App.switchView('sorting')
          ;(window as any)._switchSortingSub?.(viewName)
        }
        show(modalId)
        const content = modal.querySelector('.modal-content') || modal
        return content.getBoundingClientRect().height > 20
      }, id)
      if (!opened) { notOpened.push(id); continue }
      await sweepScreen(page, findings, errors, viewport, id, `#${id}`)
    }

    await closeAllModals(page)
    await page.evaluate(() => (window as any).App.switchView('gallery'))
    await page.locator('#btn-open-model-manager').click()
    for (const tab of ['general', 'models', 'disk', 'audit']) {
      await page.locator(`[data-settings-tab="${tab}"]`).click()
      await sweepScreen(page, findings, errors, viewport, `model-manager-${tab}`, '#model-manager-modal')
    }

    await closeAllModals(page)
    await page.locator('#btn-tag').click()
    for (const tab of ['smart', 'local', 'nl', 'aesthetic', 'color']) {
      await page.locator(`#tag-modal [data-tagger-tab="${tab}"]`).click()
      await sweepScreen(page, findings, errors, viewport, `tag-${tab}`, '#tag-modal')
    }

    await closeAllModals(page)
    await page.evaluate(() => (window as any).SmartTag?.open?.())
    await sweepScreen(page, findings, errors, viewport, 'smart-tag-modal', '#smart-tag-modal')

    await closeAllModals(page)
    await page.evaluate(() => (window as any).App.switchView('gallery'))
    const firstImage = page.locator('#gallery-grid .gallery-item').first()
    if (await firstImage.count()) {
      await firstImage.click()
      await sweepScreen(page, findings, errors, viewport, 'image-modal', '#image-modal')
    } else {
      notOpened.push('image-modal')
    }
    writeReport(viewport, 'dialogs', findings, notOpened)
    expect(findings, JSON.stringify(findings, null, 1)).toEqual([])
    expect(notOpened, 'every dialog the sweep can reach must open').toEqual(DIALOGS_WITHOUT_SWEEP_STATE)
  })
}
