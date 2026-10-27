import type { SceneView, StyleMapScene } from './scene'

// The one scene on screen, for the parts of the page that turn the camera
// (a list row, a found picture) or follow it (landmarks, axis labels). The
// canvas component sets it; everything else asks for it and does nothing
// while there is none (no WebGL, or the page is closed).

let current: StyleMapScene | null = null
const listeners = new Set<(view: SceneView) => void>()

export function setScene(scene: StyleMapScene | null): void {
  current = scene
}

export const getScene = (): StyleMapScene | null => current

/** Called by the scene after a frame whose camera moved. */
export function emitCamera(view: SceneView): void {
  for (const fn of listeners) fn(view)
}

/** Follow the camera; returns the function that stops. */
export function onCamera(fn: (view: SceneView) => void): () => void {
  listeners.add(fn)
  const scene = current
  if (scene) fn(scene.view())
  return () => {
    listeners.delete(fn)
  }
}
