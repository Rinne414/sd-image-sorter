// The open video's play controls, for the big image's keys (Space, K, comma, period).
// The player registers itself while it is on screen; the lightbox's key handler asks here.

export interface VideoControl {
  toggle: () => void
  step: (dir: 1 | -1) => void
}

let active: VideoControl | null = null

export function registerVideoControl(control: VideoControl): () => void {
  active = control
  return () => {
    if (active === control) active = null
  }
}

export const activeVideoControl = (): VideoControl | null => active
