import { beforeAll, describe, expect, test } from 'vitest'
import { enVideo } from '../../i18n/en.video'
import { zhCNVideo } from '../../i18n/zh-CN.video'
import { installFailureText } from './installError'
import { format, useLang } from '../../i18n'
import { readVideoInstall, startedVideoInstall } from '../jobs/videoJob'
import type { VideoSupport } from './videoApi'
import { installLabelOf, videoStatusText } from './videoStatus'

const say = (key: keyof typeof enVideo, params?: Record<string, string | number>) => format(enVideo[key], params)

const base: VideoSupport = {
  available: false,
  source: null,
  can_install: true,
  estimated_mb: 77,
  download_from: 'github.com/BtbN/FFmpeg-Builds',
  install: { state: 'idle' },
  indexing: false,
  videos: 3,
  pending: 0,
  unreadable: 0,
}

describe('videoStatusText', () => {
  test('missing says where the download comes from and what is lost meanwhile', () => {
    expect(videoStatusText(base, say as never)).toMatch(/Not installed.*github\.com\/BtbN/)
  })
  test('downloading counts megabytes; failed says why; ready says where and how many are being read', () => {
    const run = { ...base, install: { state: 'running', phase: 'downloading', downloaded: 38_000_000, total: 77_000_000 } } as VideoSupport
    expect(videoStatusText(run, say as never)).toBe('Downloading ffmpeg: 38 of 77 MB...')
    const failed = { ...base, install: { state: 'failed', error: '<urlopen error [WinError 10061]>', error_code: 'video_install_unreachable', error_params: {} } } as VideoSupport
    expect(videoStatusText(failed, say as never)).toBe('The install failed: The download site could not be reached. Check the network and the proxy setting.')
    const ready = { ...base, available: true, source: 'installed', pending: 1 } as VideoSupport
    expect(videoStatusText(ready, say as never)).toBe("Ready: ffmpeg installed in the program's data folder. Reading 1 video...")
  })
  test('a system without a ready-made build is told to use the package manager', () => {
    expect(videoStatusText({ ...base, can_install: false }, say as never)).toMatch(/package manager/)
  })
})

describe('installFailureText', () => {
  test('every code the backend reports has its own sentence, in both languages, and no code or raw system text shows', () => {
    const codes: [string, Record<string, unknown>][] = [
      ['video_install_unsupported', {}],
      ['video_install_no_build', {}],
      ['video_install_no_checksum', {}],
      ['video_install_checksum_mismatch', {}],
      ['video_install_bad_archive', {}],
      ['video_install_site_refused', { status: 403 }],
      ['video_install_timeout', {}],
      ['video_install_unreachable', {}],
      ['video_install_connection_broken', {}],
    ]
    const sayZh = (key: keyof typeof zhCNVideo, params?: Record<string, string | number>) => format(zhCNVideo[key], params)
    for (const [code, params] of codes) {
      const en = installFailureText({ code, params, message: '<urlopen error [WinError 10061] raw>' }, say as never)
      const zh = installFailureText({ code, params, message: '<urlopen error [WinError 10061] raw>' }, sayZh as never)
      for (const text of [en, zh]) {
        expect(text).not.toContain('video_install')
        expect(text).not.toContain('WinError')
        expect(text).not.toMatch(/\{\w+\}/)
      }
      expect(en).not.toBe(zh)
    }
    expect(installFailureText({ code: 'video_install_site_refused', params: { status: 403 } }, say as never)).toBe('The download site answered 403 instead of the file. Try again later.')
    expect(installFailureText({ code: 'video_install_failed', params: { reason: 'disk full' } }, say as never)).toBe('Something unexpected went wrong: disk full')
    expect(installFailureText({}, say as never)).toMatch(/no reason was given/)
  })
})

describe('installLabelOf', () => {
  test('size when known, Try again after a failure', () => {
    expect(installLabelOf(base, say as never)).toBe('Install video support (about 77 MB)')
    expect(installLabelOf({ ...base, install: { state: 'failed' } }, say as never)).toBe('Try again')
    expect(installLabelOf({ ...base, estimated_mb: null }, say as never)).toBe('Install video support')
  })
})

describe('the install as a job', () => {
  beforeAll(() => useLang.setState({ lang: 'en' }))
  test('running reports bytes; failed reports the reason; an idle uninstalled backend is a lost run; done when ffmpeg is there', () => {
    const start = startedVideoInstall({ state: 'running', phase: 'looking', downloaded: 0, total: null })
    expect(start.status).toBe('running')
    const mid = readVideoInstall(start, { available: false, install: { state: 'running', phase: 'downloading', downloaded: 5, total: 10 } })
    expect([mid.status, mid.current, mid.total, mid.unit]).toEqual(['running', 5, 10, 'bytes'])
    expect(readVideoInstall(mid, { available: false, install: { state: 'failed', error: 'x', error_code: 'video_install_timeout', error_params: {} } })).toMatchObject({
      status: 'error',
      message: expect.stringContaining('took too long'),
    })
    expect(readVideoInstall(mid, { available: false, install: { state: 'idle' } })).toMatchObject({ status: 'error', lost: true })
    expect(readVideoInstall(mid, { available: true, install: { state: 'done' } }).status).toBe('done')
  })
})
