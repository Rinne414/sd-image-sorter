import type { ReactNode } from 'react'
import { useLang, useT, type Lang, type MessageKey } from '../../i18n'
import type { StartPage } from '../../lib/route'
import { percent, roomAt, SCALE_OPTIONS, type ScaleSetting } from '../../lib/uiScale'
import { useApp } from '../../state/store'
import { useTheme, type ThemeMode } from '../../theme'
import styles from './AppearanceTab.module.css'
import { useUiScale } from './uiScaleStore'
import { useSaved } from './useSaved'

const THEMES: { value: ThemeMode; label: MessageKey }[] = [
  { value: 'system', label: 'theme.system' },
  { value: 'dark', label: 'theme.dark' },
  { value: 'light', label: 'theme.light' },
]

const LANGS: { value: Lang; label: MessageKey }[] = [
  { value: 'zh-CN', label: 'settings.lang.zh' },
  { value: 'en', label: 'settings.lang.en' },
]

const START_PAGES: { value: StartPage; label: MessageKey }[] = [
  { value: 'home', label: 'settings.start.home' },
  { value: 'library', label: 'settings.start.library' },
]

type Section = 'theme' | 'lang' | 'scale' | 'start' | 'film'

/**
 * Settings › Appearance: theme, language, interface zoom, the page V4 opens
 * on and the ★5 film on Home, each applied as soon as it is chosen.
 */
export function AppearanceTab() {
  const t = useT()
  const [saved, mark] = useSaved<Section>()
  const mode = useTheme((s) => s.mode)
  const lang = useLang((s) => s.lang)

  return (
    <div className={styles.sections}>
      <Choice
        name="theme"
        title={t('settings.theme.title')}
        saved={saved === 'theme'}
        options={THEMES.map((o) => ({ value: o.value, label: t(o.label) }))}
        value={mode}
        onChange={(v) => {
          useTheme.getState().setMode(v)
          mark('theme')
        }}
      >
        <p className={styles.hint}>{t('settings.theme.hint')}</p>
      </Choice>
      <Choice
        name="lang"
        title={t('settings.lang.title')}
        saved={saved === 'lang'}
        options={LANGS.map((o) => ({ value: o.value, label: t(o.label) }))}
        value={lang}
        onChange={(v) => {
          useLang.getState().setLang(v)
          mark('lang')
        }}
      />
      <ScaleChoice saved={saved === 'scale'} onSaved={() => mark('scale')} />
      <HomeChoices saved={saved} mark={mark} />
    </div>
  )
}

/** The page a plain launch opens on, and whether Home shows the ★5 film (like V3.5's entry page settings). */
function HomeChoices({ saved, mark }: { saved: Section | null; mark: (section: Section) => void }) {
  const t = useT()
  const startPage = useApp((s) => s.startPage)
  const homeFilm = useApp((s) => s.homeFilm)
  return (
    <>
      <Choice
        name="start"
        title={t('settings.start.title')}
        saved={saved === 'start'}
        options={START_PAGES.map((o) => ({ value: o.value, label: t(o.label) }))}
        value={startPage}
        onChange={(v) => {
          useApp.getState().setStartPage(v)
          mark('start')
        }}
      >
        <p className={styles.hint}>{t('settings.start.hint')}</p>
      </Choice>
      <Choice
        name="film"
        title={t('settings.film.title')}
        saved={saved === 'film'}
        options={[
          { value: 'on', label: t('settings.film.on') },
          { value: 'off', label: t('settings.film.off') },
        ]}
        value={homeFilm ? 'on' : 'off'}
        onChange={(v) => {
          useApp.getState().setHomeFilm(v === 'on')
          mark('film')
        }}
      >
        <p className={styles.hint}>{t('settings.film.hint')}</p>
      </Choice>
    </>
  )
}

function ScaleChoice({ saved, onSaved }: { saved: boolean; onSaved: () => void }) {
  const t = useT()
  const setting = useUiScale((s) => s.setting)
  const scale = useUiScale((s) => s.scale)
  const windowWidth = useUiScale((s) => s.windowWidth)
  const room = roomAt(windowWidth, scale)
  const options = [{ value: 'auto' as ScaleSetting, label: t('settings.scale.auto') }, ...SCALE_OPTIONS.map((s) => ({ value: s as ScaleSetting, label: percent(s) }))]

  return (
    <Choice
      name="scale"
      title={t('settings.scale.title')}
      saved={saved}
      options={options}
      value={setting}
      onChange={(v) => {
        useUiScale.getState().setSetting(v)
        onSaved()
      }}
    >
      <p className={styles.now} data-testid="scale-now">
        {t(setting === 'auto' ? 'settings.scale.nowAuto' : 'settings.scale.nowFixed', { percent: percent(scale) })}
      </p>
      {!room.fits && (
        <p className={styles.warn} role="status" data-testid="scale-too-big">
          {t('settings.scale.tooBig', { percent: percent(scale), width: room.width })}
        </p>
      )}
      <p className={styles.hint}>{t('settings.scale.hint')}</p>
    </Choice>
  )
}

interface ChoiceProps<T extends string | number> {
  name: string
  title: string
  saved: boolean
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  children?: ReactNode
}

/** One setting: its title, a row of choices (radio buttons), and notes under it. */
function Choice<T extends string | number>({ name, title, saved, options, value, onChange, children }: ChoiceProps<T>) {
  const t = useT()
  return (
    <fieldset className={styles.section} data-testid={`setting-${name}`}>
      <legend className={styles.title}>
        {title}
        <span className={styles.saved} role="status">
          {saved ? t('settings.saved') : ''}
        </span>
      </legend>
      <div className={styles.choices}>
        {options.map((o) => (
          <label key={String(o.value)} className={styles.choice} data-checked={o.value === value || undefined}>
            <input type="radio" name={name} value={String(o.value)} checked={o.value === value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  )
}
