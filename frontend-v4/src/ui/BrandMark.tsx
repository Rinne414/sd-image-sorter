/**
 * The program's mark in the owner's brand colours (owner pick 2026-11-08, "D+ magenta"):
 * one frame on a contact sheet, circled by the pick marker, on a magenta tile. The tile
 * keeps the same contrast on the dark and light top bars. ui/FrameMark.tsx stays for the
 * frozen /next/ interface. The browser tab icon (favicon.svg) is the same drawing.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className={className}>
      <rect width="22" height="22" rx="5" fill="#D5237A" />
      <path d="M0 6.9H2.2A.8.8 0 0 1 3 7.7V14.3A.8.8 0 0 1 2.2 15.1H0Z" fill="#373438" opacity=".75" />
      <path d="M22 6.9H19.8A.8.8 0 0 0 19 7.7V14.3A.8.8 0 0 0 19.8 15.1H22Z" fill="#373438" opacity=".75" />
      <rect x="7.9" y="6.9" width="6.2" height="8.2" rx=".9" fill="#EEE5EB" />
      <path
        d="M14.4 3.5C13.3 2.95 12.2 2.7 11 2.7C7.4 2.7 4.5 6.4 4.5 11C4.5 15.6 7.4 19.3 11 19.3C14.6 19.3 17.5 15.6 17.5 11C17.5 7.8 16.2 5.1 14.1 3.8C13 3.1 11.6 2.3 10.1 1.9"
        fill="none"
        stroke="#EEE5EB"
        strokeWidth="2"
        strokeLinecap="round"
        transform="rotate(-6 11 11)"
      />
    </svg>
  )
}
