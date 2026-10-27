import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { NO_DATA_RGB } from './colors'
import { basePointSize, coreBox, floorGrid, indexOfId, MAX_POINT_SIZE, type Box, type CloudArrays } from './geometry'
import type { Ring } from './lookups'

// The 3-D point cloud: one THREE.Points draw call fed by typed arrays, orbit
// controls, a raycast hover and a click that names the dot under the pointer.
// Dots are round sprites (a small shader: size falls off with distance, dots
// that stand for more pictures are a little larger, the back of the cloud
// fades). Frames are drawn only when something changed. Ported from the
// classic page (frontend/js/style-map/scene.js + rings.js).

const FOCUS_LIGHTEN = 0.35
const FOCUS_DIM = 0.45
const FAR_ALPHA = 0.45
const FIT_SHARE = 0.8
const FRAME_MAX_SHARE = 0.97
const VIEW_DIRECTION = new THREE.Vector3(1, 0.5, 1.2).normalize()
const FOV = 50
const WHITE = new THREE.Color(1, 1, 1)
/** A press that moves less than this is a click, not a turn of the map. */
const CLICK_SLOP_PX = 4
const FLIGHT_MS = 380

const RING_TEXTURE = 128
const QUERY_SCALE = 6.5
const NEAR_SCALE = 4
const QUERY_MIN_SIZE = 0.1
const NEAR_MIN_SIZE = 0.055

const VERTEX_SHADER = `
  attribute float size;
  attribute vec3 color;
  uniform float scale;
  uniform float fogNear;
  uniform float fogFar;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    vFade = smoothstep(fogNear, fogFar, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAGMENT_SHADER = `
  uniform float farAlpha;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    if (d > 0.5) discard;
    float edge = 1.0 - smoothstep(0.40, 0.5, d);
    float depth = mix(1.0, farAlpha, vFade);
    gl_FragColor = vec4(vColor * mix(1.0, 0.75, vFade), edge * depth);
  }
`

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function colorFrom(name: string, fallback: string): THREE.Color {
  try {
    return new THREE.Color(cssVar(name, fallback))
  } catch {
    return new THREE.Color(fallback)
  }
}

/** A ring (or, for the query point, a filled disc) drawn once on a canvas. */
function ringTexture(kind: 'hover' | Ring['kind'], accent: string, muted: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = RING_TEXTURE
  canvas.height = RING_TEXTURE
  const ctx = canvas.getContext('2d')
  const c = RING_TEXTURE / 2
  if (ctx) {
    if (kind === 'query') {
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.38
      ctx.beginPath()
      ctx.arc(c, c, c - 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.lineWidth = 12
    } else {
      ctx.lineWidth = kind === 'hover' ? 10 : kind === 'far' ? 7 : 6
      if (kind === 'far') ctx.setLineDash([12, 10])
    }
    ctx.strokeStyle = kind === 'far' ? muted : accent
    ctx.beginPath()
    ctx.arc(c, c, c - 8, 0, Math.PI * 2)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** What an overlay needs to project world points (sizes in the canvas's own CSS pixels). */
export interface SceneView {
  camera: THREE.PerspectiveCamera
  width: number
  height: number
  near: number
  far: number
}

export interface ScreenPoint {
  x: number
  y: number
  /** 0 at the front of the cloud, 1 at the back. */
  depth: number
  behind: boolean
}

export interface Hit {
  id: number
  members: number
}

export interface SceneHandlers {
  onHover?: (hit: Hit | null) => void
  onCameraChange?: (view: SceneView) => void
  /** A click (not a drag) on a dot. */
  onClickDot?: (hit: Hit) => void
}

/**
 * A tool that takes the pointer before the orbit controls (the box and lasso
 * select, PickTool.tsx): `down` returns true when it handles this press.
 */
export interface PointerTool {
  down: (event: PointerEvent) => boolean
}

const RING_KINDS: readonly Ring['kind'][] = ['query', 'near', 'far']

export class StyleMapScene {
  readonly canvas: HTMLCanvasElement
  private readonly handlers: SceneHandlers
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100)
  private readonly controls: OrbitControls
  private readonly material: THREE.ShaderMaterial
  private readonly points: THREE.Points
  private geometry = new THREE.BufferGeometry()
  private readonly frame: THREE.LineSegments
  private readonly hoverRing: THREE.Sprite
  private ringMaterials: Record<Ring['kind'], THREE.SpriteMaterial>
  private readonly ringSprites: THREE.Sprite[] = []
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly scratch = new THREE.Color()
  private readonly cameraStamp = new Float32Array(34)
  private readonly resizeObserver: ResizeObserver
  private hoverColor: THREE.Color
  private baseColors: Float32Array = new Float32Array(0)
  private focus: { labels: Int8Array; region: number } | null = null
  private selected: Uint8Array | null = null
  private remap: ((xyz: [number, number, number], id?: number) => [number, number, number] | null) | null = null
  private pointerTool: PointerTool | null = null
  private pointerInside = false
  private pointerDirty = false
  private press: { x: number; y: number; id: number } | null = null
  private running = false
  private frameHandle = 0
  private flight = 0
  private flownTo = false
  private aspect = 1
  private pixelRatio: number
  private center = new THREE.Vector3()
  private radius = 1
  private disposed = false
  private readonly cleanup: (() => void)[] = []

  ids: Int32Array = new Int32Array(0)
  members: Uint16Array = new Uint16Array(0)
  sizes: Float32Array = new Float32Array(0)
  positions: Float32Array = new Float32Array(0)
  count = 0
  hovered = -1
  /** The central mass and the floor grid (the axis labels stand on it). */
  core: Box | null = null
  floorY = NaN
  cloudTopY = NaN
  private frameCorners: THREE.Vector3[] = []

  /** Throws when the browser gives no WebGL (the page then explains why). */
  constructor(canvas: HTMLCanvasElement, handlers: SceneHandlers = {}) {
    this.canvas = canvas
    this.handlers = handlers
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 0.2
    this.controls.maxDistance = 20
    this.controls.listenToKeyEvents(canvas)
    this.hoverColor = colorFrom('--accent', '#e2a03f')
    this.material = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 1 }, fogNear: { value: 0 }, fogFar: { value: 1 }, farAlpha: { value: FAR_ALPHA } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    })
    this.points = new THREE.Points(this.geometry, this.material)
    this.points.frustumCulled = false
    this.scene.add(this.points)
    this.frame = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }))
    this.frame.visible = false
    this.scene.add(this.frame)
    this.hoverRing = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
    this.hoverRing.renderOrder = 10
    this.hoverRing.visible = false
    this.scene.add(this.hoverRing)
    this.ringMaterials = { query: new THREE.SpriteMaterial(), near: new THREE.SpriteMaterial(), far: new THREE.SpriteMaterial() }
    this.applyTheme()

    const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false) => {
      canvas.addEventListener(type, fn as EventListener, capture)
      this.cleanup.push(() => canvas.removeEventListener(type, fn as EventListener, capture))
    }
    listen('pointermove', (e) => this.onPointerMove(e))
    listen('pointerleave', () => {
      this.pointerInside = false
      this.pointerDirty = true
      this.requestRender()
    })
    // Capture phase: a pointer tool (box select) may take the press before the orbit controls.
    listen('pointerdown', (e) => this.onPointerDown(e), true)
    listen('pointerup', (e) => this.onPointerUp(e))
    this.controls.addEventListener('change', () => this.requestRender())
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement ?? canvas)
    this.resize()
    this.fitCamera(false)
    this.controls.saveState()
  }

  /** Colours that follow the theme: the background, the grid, the hover accent and the rings. */
  applyTheme(): void {
    this.scene.background = colorFrom('--stage', '#0a0909')
    ;(this.frame.material as THREE.LineBasicMaterial).color = colorFrom('--line-strong', '#3d3a34')
    this.hoverColor = colorFrom('--accent', '#e2a03f')
    const accent = cssVar('--accent', '#e2a03f')
    const muted = cssVar('--muted', '#989184')
    const hover = this.hoverRing.material
    hover.map?.dispose()
    hover.map = ringTexture('hover', accent, muted)
    hover.needsUpdate = true
    for (const kind of RING_KINDS) {
      const material = this.ringMaterials[kind]
      material.map?.dispose()
      material.map = ringTexture(kind, accent, muted)
      material.transparent = true
      material.depthTest = false
      material.needsUpdate = true
    }
    this.repaintColors()
  }

  // ---- data -------------------------------------------------------------

  setPoints(cloud: CloudArrays): void {
    const { count, positions, sizes, ids, members } = cloud
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) colors.set(NO_DATA_RGB, i * 3)
    this.hovered = -1
    this.focus = null
    this.selected = null
    this.canvas.dataset.picked = '0'
    this.hoverRing.visible = false
    this.clearRings()
    this.ids = ids
    this.members = members
    this.sizes = sizes
    this.positions = positions
    this.count = count
    this.baseColors = colors.slice()
    // What the page drew, readable without WebGL calls (the end-to-end tests read it).
    this.canvas.dataset.points = String(count)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    const previous = this.geometry
    this.geometry = geometry
    this.points.geometry = geometry
    previous.dispose()
    geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    if (count > 0 && sphere && Number.isFinite(sphere.radius)) {
      this.center.copy(sphere.center)
      this.radius = Math.max(sphere.radius, 0.05)
    } else {
      this.center.set(0, 0, 0)
      this.radius = 1
    }
    this.fitFrame()
    this.raycaster.params.Points = { threshold: count > 0 ? basePointSize(count) * 0.9 : MAX_POINT_SIZE }
    this.fitCamera(false)
    this.controls.saveState()
    this.handlers.onHover?.(null)
    this.render()
    this.requestRender()
  }

  private fitFrame(): void {
    this.core = coreBox(this.positions, this.count)
    this.frame.visible = this.core !== null
    this.frameCorners = []
    this.floorY = NaN
    this.cloudTopY = NaN
    if (!this.core) return
    const floor = floorGrid(this.core)
    this.floorY = floor.floorY
    this.cloudTopY = floor.cloudTopY
    this.frame.geometry.dispose()
    this.frame.geometry = new THREE.BufferGeometry()
    this.frame.geometry.setAttribute('position', new THREE.Float32BufferAttribute(floor.vertices, 3))
    this.frameCorners = floor.corners.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  }

  /** Every dot's own colour (3 floats per dot, point order); null: the no-data grey. A wrong length is ignored. */
  setBaseColors(rgb: Float32Array | null): void {
    if (rgb === null) {
      for (let i = 0; i < this.count; i += 1) this.baseColors.set(NO_DATA_RGB, i * 3)
    } else if (rgb.length === this.count * 3) {
      this.baseColors.set(rgb)
    } else {
      return
    }
    this.repaintColors()
  }

  /** Light one region (`labels[i]`: the region of dot i); null restores the plain map. */
  setFocus(labels: Int8Array | null, region: number | null): void {
    this.focus = region === null || !labels ? null : { labels, region }
    this.repaintColors()
  }

  /** Mark picked dots (1 per picked dot, point order); null clears. Used by the box and lasso select. */
  setSelected(flags: Uint8Array | null): void {
    this.selected = flags && flags.length === this.count ? flags : null
    let picked = 0
    if (this.selected) for (const flag of this.selected) picked += flag
    // How many dots wear the pick mark (the end-to-end tests read it).
    this.canvas.dataset.picked = String(picked)
    this.repaintColors()
  }

  /**
   * The user's own axes (customStore.ts) move every dot; lookups still speak the server's
   * coordinates and `fn` turns them into a dot's shown position (null: not a dot).
   */
  setRemap(fn: ((xyz: [number, number, number], id?: number) => [number, number, number] | null) | null): void {
    this.remap = fn
  }

  setPointerTool(tool: PointerTool | null): void {
    this.pointerTool = tool
  }

  private colorAt(index: number): THREE.Color {
    if (this.selected?.[index]) return this.scratch.copy(this.hoverColor)
    const at = index * 3
    this.scratch.setRGB(this.baseColors[at]!, this.baseColors[at + 1]!, this.baseColors[at + 2]!, THREE.LinearSRGBColorSpace)
    if (!this.focus) {
      if (this.selected) this.scratch.multiplyScalar(FOCUS_DIM)
      return this.scratch
    }
    if (this.focus.labels[index] === this.focus.region) this.scratch.lerp(WHITE, FOCUS_LIGHTEN)
    else this.scratch.multiplyScalar(FOCUS_DIM)
    return this.scratch
  }

  private repaintColors(): void {
    const colors = this.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!colors) return
    for (let i = 0; i < this.count; i += 1) {
      const c = this.colorAt(i)
      colors.setXYZ(i, c.r, c.g, c.b)
    }
    if (this.hovered >= 0) colors.setXYZ(this.hovered, this.hoverColor.r, this.hoverColor.g, this.hoverColor.b)
    colors.needsUpdate = true
    this.requestRender()
  }

  // ---- rings ------------------------------------------------------------

  /** Mark a lookup: the query point (a disc), near and far neighbours (rings). */
  setRings(rings: readonly Ring[]): void {
    const shown = this.remap
      ? rings.flatMap((ring) => {
          const at = this.remap?.([ring.x, ring.y, ring.z], ring.id)
          return at ? [{ ...ring, x: at[0], y: at[1], z: at[2] }] : []
        })
      : rings
    const dot = basePointSize(this.count)
    shown.forEach((ring, index) => {
      while (this.ringSprites.length <= index) {
        const sprite = new THREE.Sprite(this.ringMaterials.near)
        sprite.renderOrder = 9
        sprite.visible = false
        this.scene.add(sprite)
        this.ringSprites.push(sprite)
      }
      const sprite = this.ringSprites[index]!
      sprite.material = this.ringMaterials[ring.kind]
      sprite.position.set(ring.x, ring.y, ring.z)
      const query = ring.kind === 'query'
      const size = Math.max(dot * (query ? QUERY_SCALE : NEAR_SCALE), query ? QUERY_MIN_SIZE : NEAR_MIN_SIZE)
      sprite.scale.set(size, size, 1)
      sprite.visible = true
    })
    for (let i = shown.length; i < this.ringSprites.length; i += 1) this.ringSprites[i]!.visible = false
    this.canvas.dataset.rings = shown.map((ring) => ring.kind).join(' ')
    this.requestRender()
  }

  private clearRings(): void {
    for (const sprite of this.ringSprites) sprite.visible = false
  }

  // ---- camera -----------------------------------------------------------

  /**
   * Fit the cloud to FIT_SHARE of the canvas's short side. With `keep` only
   * the distance changes (a resize keeps the user's rotation); a view the
   * user turned to a dot stays.
   */
  private fitCamera(keep: boolean): void {
    if (keep && this.flownTo) {
      this.camera.updateProjectionMatrix()
      return
    }
    this.flownTo = false
    const halfFov = THREE.MathUtils.degToRad(FOV) / 2
    const shortHalf = this.aspect >= 1 ? halfFov : Math.atan(Math.tan(halfFov) * this.aspect)
    let distance = this.radius / (Math.sin(shortHalf) * FIT_SHARE)
    const direction =
      keep && this.camera.position.distanceTo(this.controls.target) > 1e-6
        ? this.camera.position.clone().sub(this.controls.target).normalize()
        : VIEW_DIRECTION.clone()
    this.controls.target.copy(this.center)
    if (this.count > 0 && Number.isFinite(this.floorY)) this.controls.target.y = (this.cloudTopY + this.floorY) / 2
    this.place(direction, distance)
    // The sphere overstates a flat cloud: measure how far the dots (and the
    // grid corners) really reach and tighten the distance (three passes).
    for (let pass = 0; pass < 3 && this.count > 0; pass += 1) {
      const reach = this.projectedReach()
      if (!reach.cloud) break
      distance *= Math.max(reach.cloud / FIT_SHARE, reach.all / FRAME_MAX_SHARE, 0.05)
      this.place(direction, distance)
    }
  }

  private place(direction: THREE.Vector3, distance: number): void {
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance)
    this.camera.near = Math.max(0.01, distance / 100)
    this.camera.far = distance * 20 + 10
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    this.controls.update()
  }

  /** How far the central mass (cloud) and everything (all) reach from the canvas centre, in NDC. */
  private projectedReach(): { cloud: number; all: number } {
    const v = new THREE.Vector3()
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    const take = () => {
      minX = Math.min(minX, v.x)
      maxX = Math.max(maxX, v.x)
      minY = Math.min(minY, v.y)
      maxY = Math.max(maxY, v.y)
    }
    const reach = () => Math.max(-minX, maxX, -minY, maxY)
    const core = this.core
    const outliers: number[] = []
    const p = this.positions
    for (let i = 0; i < this.count; i += 1) {
      const x = p[i * 3]!
      const y = p[i * 3 + 1]!
      const z = p[i * 3 + 2]!
      const inCore = !core || (x >= core.min[0] && x <= core.max[0] && y >= core.min[1] && y <= core.max[1] && z >= core.min[2] && z <= core.max[2])
      if (!inCore) {
        outliers.push(x, y, z)
        continue
      }
      v.set(x, y, z).project(this.camera)
      take()
    }
    const cloud = reach()
    for (let i = 0; i < outliers.length; i += 3) {
      v.set(outliers[i]!, outliers[i + 1]!, outliers[i + 2]!).project(this.camera)
      take()
    }
    for (const corner of this.frameCorners) {
      v.copy(corner).project(this.camera)
      take()
    }
    return { cloud: Number.isFinite(cloud) ? cloud : 0, all: reach() }
  }

  private resize(): void {
    const host = this.canvas.parentElement ?? this.canvas
    const width = host.clientWidth
    const height = host.clientHeight
    if (!width || !height || this.disposed) return
    this.renderer.setSize(width, height, false)
    this.aspect = width / height
    this.camera.aspect = this.aspect
    // World size -> pixels at distance 1 (perspective point sprites).
    this.material.uniforms.scale!.value = (height * this.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2))
    this.fitCamera(true)
    this.render()
  }

  resetView(): void {
    this.controls.reset()
    this.fitCamera(false)
    this.render()
  }

  /** Turn the camera to a point (the orbit target glides there; reduced motion jumps). */
  flyTo(xyz: [number, number, number], options: { exact?: boolean; id?: number } = {}): void {
    let target: [number, number, number] | null = xyz
    if (this.remap && !options.exact) target = this.remap(xyz, options.id)
    if (!target) return
    cancelAnimationFrame(this.flight)
    this.flownTo = true
    const delta = new THREE.Vector3(...target).sub(this.controls.target)
    const apply = (share: number) => {
      const step = delta.clone().multiplyScalar(share)
      this.controls.target.add(step)
      this.camera.position.add(step)
      this.controls.update()
      this.render()
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced || !this.running) {
      apply(1)
      return
    }
    const startedAt = performance.now()
    let shown = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / FLIGHT_MS)
      const eased = 1 - (1 - progress) ** 3
      apply(eased - shown)
      shown = eased
      if (progress < 1) this.flight = requestAnimationFrame(tick)
    }
    this.flight = requestAnimationFrame(tick)
  }

  /** The world position of picture `id`'s dot, or null when the map does not hold it. */
  positionOf(id: number): [number, number, number] | null {
    const i = indexOfId(this.ids, id)
    if (i < 0) return null
    return [this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!]
  }

  view(): SceneView {
    return {
      camera: this.camera,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      near: this.material.uniforms.fogNear!.value as number,
      far: this.material.uniforms.fogFar!.value as number,
    }
  }

  /** A world point on the canvas (CSS pixels of the canvas itself). */
  project(xyz: readonly [number, number, number], view: SceneView): ScreenPoint {
    const v = new THREE.Vector3(xyz[0], xyz[1], xyz[2])
    const distance = view.camera.position.distanceTo(v)
    const behind = v.clone().applyMatrix4(view.camera.matrixWorldInverse).z >= 0
    v.project(view.camera)
    const span = Math.max(1e-6, view.far - view.near)
    return {
      x: ((v.x + 1) / 2) * view.width,
      y: ((1 - v.y) / 2) * view.height,
      depth: Math.min(1, Math.max(0, (distance - view.near) / span)),
      behind,
    }
  }

  /** Projection x view, for projecting every dot at once (box select). */
  projectionMatrix(): ArrayLike<number> {
    this.camera.updateMatrixWorld()
    return new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements
  }

  // ---- frames -----------------------------------------------------------

  resume(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.resize()
    this.requestRender()
  }

  pause(): void {
    this.running = false
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
  }

  private requestRender(): void {
    if (!this.running || this.frameHandle) return
    this.frameHandle = requestAnimationFrame(() => this.drawFrame())
  }

  private drawFrame(): void {
    this.frameHandle = 0
    if (!this.running) return
    // update() is true while damping still moves the camera (its 'change' queues the next frame).
    const moving = this.controls.update()
    if (this.pointerDirty) this.pick()
    this.render()
    if (moving) this.requestRender()
  }

  private render(): void {
    if (this.disposed) return
    const distance = this.camera.position.distanceTo(this.controls.target)
    this.material.uniforms.fogNear!.value = Math.max(0.01, distance - this.radius)
    this.material.uniforms.fogFar!.value = distance + this.radius
    this.renderer.render(this.scene, this.camera)
    if (this.cameraMoved()) this.handlers.onCameraChange?.(this.view())
  }

  /** True when the view, the projection or the canvas size changed since the last frame. */
  private cameraMoved(): boolean {
    const view = this.camera.matrixWorldInverse.elements
    const projection = this.camera.projectionMatrix.elements
    let moved = false
    for (let i = 0; i < 16; i += 1) {
      if (this.cameraStamp[i] !== view[i] || this.cameraStamp[16 + i] !== projection[i]) {
        moved = true
        this.cameraStamp[i] = view[i]!
        this.cameraStamp[16 + i] = projection[i]!
      }
    }
    const size = [this.canvas.clientWidth, this.canvas.clientHeight]
    for (let i = 0; i < 2; i += 1) {
      if (this.cameraStamp[32 + i] !== size[i]) {
        moved = true
        this.cameraStamp[32 + i] = size[i]!
      }
    }
    return moved
  }

  // ---- pointer ----------------------------------------------------------

  private onPointerMove(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.pointerInside = true
    this.pointerDirty = true
    this.requestRender()
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.pointerTool?.down(event)) {
      event.stopImmediatePropagation()
      event.preventDefault()
      this.press = null
      return
    }
    this.press = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null
  }

  private onPointerUp(event: PointerEvent): void {
    const press = this.press
    this.press = null
    if (!press || press.id !== event.pointerId || event.button !== 0) return
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) return
    // The dot under the pointer now (a hover pick may not have run since the last move).
    this.onPointerMove(event)
    this.pick()
    if (this.hovered < 0) return
    this.handlers.onClickDot?.({ id: this.ids[this.hovered]!, members: this.members[this.hovered]! })
  }

  private pick(): void {
    this.pointerDirty = false
    if (!this.pointerInside || this.count === 0) {
      this.setHover(-1)
      return
    }
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.points, false)
    let best = -1
    let bestDistance = Infinity
    for (const hit of hits) {
      const d = hit.distanceToRay ?? Infinity
      if (hit.index !== undefined && d < bestDistance) {
        bestDistance = d
        best = hit.index
      }
    }
    this.setHover(best)
  }

  private setHover(index: number): void {
    if (index === this.hovered) return
    const colors = this.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!colors) return
    if (this.hovered >= 0 && this.hovered < this.count) {
      const restore = this.colorAt(this.hovered)
      colors.setXYZ(this.hovered, restore.r, restore.g, restore.b)
    }
    if (index >= 0) {
      colors.setXYZ(index, this.hoverColor.r, this.hoverColor.g, this.hoverColor.b)
      this.hoverRing.position.set(this.positions[index * 3]!, this.positions[index * 3 + 1]!, this.positions[index * 3 + 2]!)
      const ring = this.sizes[index]! * 3.2
      this.hoverRing.scale.set(ring, ring, 1)
      this.hoverRing.visible = true
    } else {
      this.hoverRing.visible = false
    }
    colors.needsUpdate = true
    this.hovered = index
    this.canvas.style.cursor = index >= 0 ? 'pointer' : ''
    this.canvas.dataset.hovered = index >= 0 ? String(this.ids[index]) : ''
    this.handlers.onHover?.(index >= 0 ? { id: this.ids[index]!, members: this.members[index]! } : null)
    this.requestRender()
  }

  dispose(): void {
    this.pause()
    cancelAnimationFrame(this.flight)
    this.disposed = true
    this.resizeObserver.disconnect()
    for (const fn of this.cleanup) fn()
    this.controls.dispose()
    this.geometry.dispose()
    this.frame.geometry.dispose()
    ;(this.frame.material as THREE.Material).dispose()
    this.material.dispose()
    this.hoverRing.material.map?.dispose()
    this.hoverRing.material.dispose()
    for (const kind of RING_KINDS) {
      this.ringMaterials[kind].map?.dispose()
      this.ringMaterials[kind].dispose()
    }
    this.renderer.dispose()
  }
}
