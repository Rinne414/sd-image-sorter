import { expect, test, type Page } from '@playwright/test'

/**
 * The backend writes its sentences as "<English> / <中文>" so either interface
 * can show them. The interface shows only its own half: a Chinese screen used
 * to read "代理没有保存成功：Enter an HTTP or mixed port ... / 请填 ...".
 * The SOCKS refusal comes from the real backend here, not a mock.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const SOCKS = 'socks5://127.0.0.1:7897'
const SOCKS_EN = 'SOCKS is not supported: pip and some downloads cannot use it. Enter the HTTP or mixed port of your proxy tool instead, such as 7890.'
const SOCKS_ZH = '不支持 SOCKS：pip 和部分下载用不了。请改填代理工具的 HTTP 或混合端口，如 7890。'

async function dismissFirstRunQuestions(page: Page) {
  // A fresh data folder may ask once whether to use a ComfyUI found on this PC.
  await page.addLocatorHandler(page.locator('#confirm-modal.visible'), async () => {
    await page.locator('#btn-confirm-cancel').click()
  })
}

async function openClassicProxy(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript((value) => {
    localStorage.setItem('sd-image-sorter-lang', value)
    localStorage.setItem('aurora-entry-skip', '1')
  }, lang)
  await dismissFirstRunQuestions(page)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="models"]').click()
  await page.evaluate(() => (window as any).ModelNetworkSettings.reveal())
  await expect(page.locator('[data-testid="network-proxy-card"]')).toBeVisible()
}

for (const [lang, sentence, other] of [['zh-CN', SOCKS_ZH, SOCKS_EN], ['en', SOCKS_EN, SOCKS_ZH]] as const) {
  test(`classic: a SOCKS address is refused in the interface language only (${lang})`, async ({ page }) => {
    await openClassicProxy(page, lang)
    await page.locator('#network-proxy-input').fill(SOCKS)
    await page.locator('[data-testid="network-proxy-save"]').click()
    const toast = page.locator('#toast-container .toast.error .toast-message').last()
    await expect(toast).toContainText(sentence)
    await expect(toast).not.toContainText(other)
    await expect(toast).not.toContainText(' / ')
  })
}

test('classic: only a real English / Chinese pair is split', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  const pick = (text: string, lang: string) => page.evaluate(({ text, lang }) => {
    (window as any).I18n.setLang(lang)
    return (window as any).pickUiLanguageHalf(text)
  }, { text, lang })
  const pair = 'Install Node.js, then run run.sh (Linux / macOS) again. / 安装 Node.js 后重新运行 run.sh（Linux / macOS）。'
  expect(await pick(pair, 'en')).toBe('Install Node.js, then run run.sh (Linux / macOS) again.')
  expect(await pick(pair, 'zh-CN')).toBe('安装 Node.js 后重新运行 run.sh（Linux / macOS）。')
  // An English line that names a Chinese folder, and a Chinese-only line, stay whole.
  expect(await pick('Moved 3 pictures / skipped 2 already in 新建', 'zh-CN')).toBe('Moved 3 pictures / skipped 2 already in 新建')
  expect(await pick('运行 run.sh（Linux / macOS）', 'en')).toBe('运行 run.sh（Linux / macOS）')
})
