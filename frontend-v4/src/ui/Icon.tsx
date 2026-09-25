// A small set of hand-drawn 16px icons, one stroke weight. Kept here instead of
// an icon package so the app does not look like every other generated UI.

export type IconName =
  | 'search'
  | 'close'
  | 'copy'
  | 'heart'
  | 'star'
  | 'left'
  | 'right'
  | 'caret'
  | 'sun'
  | 'moon'
  | 'folder'
  | 'up'

const STAR =
  '8,1.6 9.6,5.8 14.2,6 10.6,8.9 11.8,13.3 8,10.8 4.2,13.3 5.4,8.9 1.8,6 6.4,5.8'

interface Props {
  name: IconName
  size?: number
  filled?: boolean
  className?: string
  title?: string
}

export function Icon({ name, size = 16, filled = false, className, title }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': title ? undefined : true,
    role: title ? 'img' : undefined,
  }
  const t = title ? <title>{title}</title> : null
  switch (name) {
    case 'search':
      return (
        <svg {...common}>
          {t}
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4 14 14" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          {t}
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...common}>
          {t}
          <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
          <path d="M3 10.5V3.5a1 1 0 0 1 1-1h6.5" />
        </svg>
      )
    case 'heart':
      return (
        <svg {...common} fill={filled ? 'currentColor' : 'none'}>
          {t}
          <path d="M8 13.4C3.3 10.2 1.8 7.7 2.6 5.3 3.4 3 6.3 2.6 8 4.9c1.7-2.3 4.6-1.9 5.4.4.8 2.4-.7 4.9-5.4 8.1Z" />
        </svg>
      )
    case 'star':
      return (
        <svg {...common} fill={filled ? 'currentColor' : 'none'} strokeWidth={1.3}>
          {t}
          <polygon points={STAR} />
        </svg>
      )
    case 'left':
      return (
        <svg {...common}>
          {t}
          <path d="M10 3 5 8l5 5" />
        </svg>
      )
    case 'right':
      return (
        <svg {...common}>
          {t}
          <path d="m6 3 5 5-5 5" />
        </svg>
      )
    case 'caret':
      return (
        <svg {...common}>
          {t}
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
        </svg>
      )
    case 'sun':
      return (
        <svg {...common}>
          {t}
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        </svg>
      )
    case 'moon':
      return (
        <svg {...common}>
          {t}
          <path d="M13 10.2A5.6 5.6 0 0 1 5.8 3a5.6 5.6 0 1 0 7.2 7.2Z" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          {t}
          <path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.6h5.7c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" />
          <path d="M1.8 6.6h12.4" />
        </svg>
      )
    case 'up':
      return (
        <svg {...common}>
          {t}
          <path d="M8 13.2V3.4M3.8 7.4 8 3.2l4.2 4.2" />
        </svg>
      )
  }
}
