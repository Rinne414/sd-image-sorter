import type { MaskShape } from './detection'
import type { DetectorId, Target } from './detectSettings'
import type { Box, CensorStyle } from './ops'

// What V4 sends to the detection endpoints, and the check on what comes back.
// The editor draws the picture upright (the browser applies its EXIF
// orientation), so every request asks for the upright frame too, and an answer
// measured on a picture of another size is refused: applying it would censor
// the wrong place while the image looks done.

/** What one detect run asks for. */
export interface DetectPlan {
  detector: DetectorId
  modelPath: string
  /** null: every class the model knows. */
  targets: Target[] | null
  confidence: number
  maskShape: MaskShape
  /** SAM3 words (SAM3 detector only). */
  words: string[]
  style: CensorStyle
  block: number
}

/** The picture as the editor decoded it. */
export interface Size {
  width: number
  height: number
}

export function detectBody(imageId: number, plan: DetectPlan) {
  return {
    image_id: imageId,
    model_path: plan.modelPath,
    model_type: plan.detector,
    confidence_threshold: plan.confidence,
    // Only exposed parts: a covered chest is not something to censor.
    exposed_only: true,
    target_classes: plan.targets,
    ...(plan.detector === 'sam3' && plan.words.length > 0 ? { text_prompts: plan.words } : {}),
    upright: true,
  }
}

export function refineBody(imageId: number, boxes: readonly Box[], confidence: number) {
  const items = boxes.map((box) => ({ image_id: imageId, box: box.map((v) => Math.round(v)), upright: true }))
  return { items, sam3_confidence: confidence, upright: true }
}

export function segmentBody(imageId: number, word: string) {
  return { image_id: imageId, text_prompt: word, upright: true }
}

const sizeText = (w: unknown, h: unknown) => `${String(w ?? '?')}×${String(h ?? '?')}`

/** When the answer was measured on a picture of another size: both sizes as text; null when they agree. */
export function frameMismatch(answer: { image_width?: unknown; image_height?: unknown }, picture: Size): { got: string; want: string } | null {
  if (answer.image_width === picture.width && answer.image_height === picture.height) return null
  return { got: sizeText(answer.image_width, answer.image_height), want: sizeText(picture.width, picture.height) }
}
