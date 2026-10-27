/** A single frame of film with its sprocket holes: the app's mark. */
export function FrameMark({ className }: { className?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className={className}>
      <rect x="1.5" y="3.5" width="19" height="15" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5.5" y="7" width="11" height="8" fill="currentColor" />
      {[3.2, 7.2, 11.2, 15.2].map((x) => (
        <g key={x} fill="currentColor">
          <rect x={x} y="4.6" width="2" height="1.2" />
          <rect x={x} y="16.2" width="2" height="1.2" />
        </g>
      ))}
    </svg>
  )
}
