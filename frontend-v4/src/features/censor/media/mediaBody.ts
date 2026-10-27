import type { MaskShape } from '../detection'
import { effectiveDetector, type DetectorId, type Target } from '../detectSettings'
import type { MediaStyle } from './mediaSettings'

// What the GIF and video censor is asked: the censor step's detection
// settings turned into the job request. Pure, so it can be tested alone.

export type MediaModelType = 'nudenet' | 'legacy' | 'both'

export interface DetectInput {
  /** null: not chosen yet (the backend's recommendation applies). */
  detector: DetectorId | null
  recommended: string | null | undefined
  targets: readonly Target[]
  confidence: number
  maskShape: MaskShape
  yolo: string
  customPath: string
  /** The chosen YOLO file knows the privacy classes, so the body-part targets apply to it. */
  legacyKnowsTargets: boolean
}

export interface MediaDetection {
  modelType: MediaModelType
  /** SAM 3 is not used for moving pictures: NudeNet stands in, and the dialog says so. */
  swappedFromSam3: boolean
  modelPath: string
  /** null: every class the model knows. */
  targets: Target[] | null
  confidence: number
  shape: MaskShape
}

export function mediaDetection(input: DetectInput): MediaDetection | { error: 'noTargets' } {
  const chosen = effectiveDetector(input.detector, input.recommended)
  const swappedFromSam3 = chosen === 'sam3'
  const modelType: MediaModelType = chosen === 'sam3' ? 'nudenet' : chosen
  const modelPath = modelType === 'nudenet' ? '' : input.customPath.trim() || input.yolo
  const filtered = modelType !== 'legacy' || input.legacyKnowsTargets
  if (filtered && input.targets.length === 0) return { error: 'noTargets' }
  return {
    modelType,
    swappedFromSam3,
    modelPath,
    targets: filtered ? [...input.targets] : null,
    confidence: input.confidence,
    shape: input.maskShape,
  }
}

export interface MediaOptions {
  style: MediaStyle
  blockAuto: boolean
  block: number
  every: number
  hold: number
  /** '' = the backend's default folder. */
  output: string
  includeVideos: boolean
}

export type MediaSource = { files: string[] } | { folder: string }

/** The body of POST /api/censor/media/start. */
export type MediaStartBody = ReturnType<typeof mediaStartBody>

export function mediaStartBody(source: MediaSource, detection: MediaDetection, options: MediaOptions) {
  return {
    ...('files' in source ? { files: source.files } : { folder: source.folder }),
    output_folder: options.output.trim(),
    include_videos: options.includeVideos,
    model_type: detection.modelType,
    model_path: detection.modelPath,
    confidence: detection.confidence,
    target_classes: detection.targets,
    // The detection chain's own default; the censor step has no switch for it either.
    face_guard: true,
    shape: detection.shape,
    expand_percent: 0,
    style: options.style,
    block_size: options.blockAuto ? 0 : options.block,
    detect_every: options.every,
    hold: options.hold,
  }
}

/** The model cards the detection needs on disk (NudeNet's, or the YOLO file's). */
export function mediaCards(detection: Pick<MediaDetection, 'modelType' | 'modelPath'>): ('censor-nudenet' | 'censor-legacy')[] {
  if (detection.modelType === 'legacy') return detection.modelPath ? [] : ['censor-legacy']
  return ['censor-nudenet']
}
