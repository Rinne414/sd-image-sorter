// The one confirmation sound of the Sort page (V3.5 audio.js): a short,
// quiet, neutral pip when an image goes somewhere. Off unless turned on; no
// audio context is made until the first pip, so a silent page costs nothing.

const FREQUENCY_HZ = 660
const PEAK_GAIN = 0.04
const ATTACK_S = 0.004
const DURATION_S = 0.03
const RELEASE_PAD_S = 0.005

let context: AudioContext | null = null
let unavailable = false

function audioContext(): AudioContext | null {
  if (context || unavailable) return context
  try {
    context = new AudioContext()
  } catch {
    // no Web Audio here: the page simply stays silent
    unavailable = true
  }
  return context
}

/** Play the pip once. Never throws: a sound must not break sorting. */
export function pip(): void {
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = FREQUENCY_HZ
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + ATTACK_S)
  gain.gain.linearRampToValueAtTime(0, now + DURATION_S)
  osc.connect(gain)
  gain.connect(ctx.destination)
  // Release the nodes; hundreds of pips in a session must not pile up.
  osc.onended = () => {
    osc.disconnect()
    gain.disconnect()
  }
  osc.start(now)
  osc.stop(now + DURATION_S + RELEASE_PAD_S)
}
