import { describe, expect, it } from 'vitest'
import { pickLanguageHalf } from './bilingual'

const PROXY = 'Enter an HTTP or mixed port such as 7890, or an address such as 127.0.0.1:7890. / 请填 HTTP 或混合端口（如 7890）或地址（如 127.0.0.1:7890）。'

describe('pickLanguageHalf', () => {
  it('shows the half for the interface language', () => {
    expect(pickLanguageHalf(PROXY, 'en')).toBe('Enter an HTTP or mixed port such as 7890, or an address such as 127.0.0.1:7890.')
    expect(pickLanguageHalf(PROXY, 'zh-CN')).toBe('请填 HTTP 或混合端口（如 7890）或地址（如 127.0.0.1:7890）。')
  })

  it('splits at the slash right before the Chinese, not at one inside the English', () => {
    const text = 'Install Node.js, then run run.sh (Linux / macOS) again. / 安装 Node.js 后重新运行 run.sh（Linux / macOS）。'
    expect(pickLanguageHalf(text, 'en')).toBe('Install Node.js, then run run.sh (Linux / macOS) again.')
    expect(pickLanguageHalf(text, 'zh-CN')).toBe('安装 Node.js 后重新运行 run.sh（Linux / macOS）。')
  })

  it('splits the SOCKS refusal, whose Chinese half carries several terms', () => {
    const text = 'SOCKS is not supported: pip and some downloads cannot use it. Enter the HTTP or mixed port of your proxy tool instead, such as 7890. / 不支持 SOCKS：pip 和部分下载用不了。请改填代理工具的 HTTP 或混合端口，如 7890。'
    expect(pickLanguageHalf(text, 'zh-CN')).toBe('不支持 SOCKS：pip 和部分下载用不了。请改填代理工具的 HTTP 或混合端口，如 7890。')
  })

  it('leaves a line alone that is not one English and one Chinese half', () => {
    expect(pickLanguageHalf('Folder path is empty', 'zh-CN')).toBe('Folder path is empty')
    expect(pickLanguageHalf('运行 run.sh（Linux / macOS）', 'en')).toBe('运行 run.sh（Linux / macOS）')
    // An English line that names a Chinese folder is not a translation.
    expect(pickLanguageHalf('Moved 3 pictures / skipped 2 already in 新建', 'zh-CN')).toBe('Moved 3 pictures / skipped 2 already in 新建')
  })

  it('gives the same answer when called again (no state kept between calls)', () => {
    const first = pickLanguageHalf(PROXY, 'en')
    pickLanguageHalf('Moved 3 pictures / skipped 2 already in 新建', 'en')
    expect(pickLanguageHalf(PROXY, 'en')).toBe(first)
  })
})
