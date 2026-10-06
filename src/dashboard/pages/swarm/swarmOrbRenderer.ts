import type { SigilParams } from "./SwarmGlyphs";

/** One WebGL renderer for every Swarm orb on the page.
 *
 * Browsers cap WebGL contexts per page at a handful, and a busy Swarm thread can show
 * several working cards, a round card and the typing row at once. So there is exactly
 * one hidden WebGL canvas here, divided into tiles; each distinct orb (manager, state,
 * tone) owns a tile, and every visible <SwarmOrb> is a plain 2D canvas that copies its
 * tile with drawImage once per frame. The orb therefore scrolls, clips and reflows with
 * its message like any inline element, and no z-index or scroll bookkeeping exists.
 *
 * three.js loads through swarmOrbThree.ts on the first subscribe, so the dashboard bundle
 * never carries it; subscribers show their CSS dot until the first frame lands. The loop
 * runs only while something is subscribed, the window is visible and motion is not
 * reduced; with reduce motion on it draws one still frame per change instead. */

type Three = typeof import("./swarmOrbThree");
type Group = InstanceType<Three["Group"]>;
type Mesh = InstanceType<Three["Mesh"]>;
type LineLoop = InstanceType<Three["LineLoop"]>;
type MeshStandardMaterial = InstanceType<Three["MeshStandardMaterial"]>;
type MeshBasicMaterial = InstanceType<Three["MeshBasicMaterial"]>;
type LineBasicMaterial = InstanceType<Three["LineBasicMaterial"]>;
type Scene = InstanceType<Three["Scene"]>;
type OrthographicCamera = InstanceType<Three["OrthographicCamera"]>;
type WebGLRenderer = InstanceType<Three["WebGLRenderer"]>;
type HemisphereLight = InstanceType<Three["HemisphereLight"]>;
type DirectionalLight = InstanceType<Three["DirectionalLight"]>;

export type OrbState = "queued" | "planning" | "acting" | "reporting" | "verifying" | "waiting_user" | "stopping" | "round";
export type OrbTone = "accent" | "sup" | "warn";
export type OrbStatus = "pending" | "live" | "fallback";

export interface OrbSpec {
  id: string;
  params: SigilParams;
  state: OrbState;
  tone: OrbTone;
}

/** CSS colour strings read from the --sw-* tokens, plus whether the page is dark, which
 * softens the rim and the key light: dark is matte everywhere else. */
export interface OrbPalette {
  accent: string;
  sup: string;
  warn: string;
  dark: boolean;
}

export interface OrbSubscription {
  update(spec: Partial<Pick<OrbSpec, "state" | "tone">>): void;
  dispose(): void;
}

/** Tile edge in CSS pixels. Orbs draw at 28 to 36 px, so a 40 px tile keeps the one-pixel
 * link lines near one device pixel after the copy instead of fading to a smear. */
const TILE = 40;
const COLS = 4;
const MIN_ROWS = 2;
const MAX_ROWS = 4;
const FRAME_MS = 1000 / 30;
const TILT = (28 * Math.PI) / 180;
const PRECESS = (Math.PI * 2) / 40;
const TEARDOWN_MS = 500;
const DEFAULT_PALETTE: OrbPalette = { accent: "#20232a", sup: "#2a2f3b", warn: "#b45309", dark: false };

interface Motion {
  spin: number;
  satRadius: number;
  breatheAmp: number;
  breatheHz: number;
  links: number;
  coreDim: number;
  outerSpin: number;
}

const REST: Record<OrbState, Motion> = {
  queued: { spin: 0.25, satRadius: 0.6, breatheAmp: 0.04, breatheHz: 0.3, links: 0.35, coreDim: 1, outerSpin: -0.2 },
  planning: { spin: 0.8, satRadius: 1, breatheAmp: 0.06, breatheHz: 0.35, links: 0.6, coreDim: 1, outerSpin: -0.3 },
  acting: { spin: 1.5, satRadius: 1, breatheAmp: 0.03, breatheHz: 0.6, links: 0.85, coreDim: 1, outerSpin: -0.5 },
  reporting: { spin: 0.6, satRadius: 0.85, breatheAmp: 0.08, breatheHz: 0.3, links: 0.9, coreDim: 1, outerSpin: -0.25 },
  verifying: { spin: 0.2, satRadius: 1, breatheAmp: 0.06, breatheHz: 0.42, links: 1, coreDim: 1, outerSpin: 0.8 },
  waiting_user: { spin: 0.12, satRadius: 1, breatheAmp: 0.03, breatheHz: 0.2, links: 0.5, coreDim: 0.7, outerSpin: -0.1 },
  stopping: { spin: 0, satRadius: 1, breatheAmp: 0, breatheHz: 0.2, links: 0.5, coreDim: 0.85, outerSpin: 0 },
  round: { spin: 0.9, satRadius: 1, breatheAmp: 0.05, breatheHz: 0.35, links: 0.7, coreDim: 1, outerSpin: -0.3 },
};

interface Variant {
  key: string;
  spec: OrbSpec;
  tile: number;
  refs: number;
  group: Group;
  ringGroup: Group;
  core: Mesh;
  coreMat: MeshStandardMaterial;
  rimMat: MeshBasicMaterial;
  sats: Mesh[];
  satMat: MeshStandardMaterial;
  satBase: number[];
  links: LineLoop;
  linkMat: LineBasicMaterial;
  linkOrder: number[];
  outer: LineLoop | null;
  outerMat: LineBasicMaterial | null;
  inner: Mesh | null;
  innerMat: MeshBasicMaterial | null;
  current: Motion;
  spinAngle: number;
  outerAngle: number;
  precess: number;
  t: number;
}

interface Sub {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  spec: OrbSpec;
  onStatus: (status: OrbStatus) => void;
  variant: Variant | null;
}

interface Engine {
  three: Three;
  renderer: WebGLRenderer;
  gl: HTMLCanvasElement;
  scene: Scene;
  camera: OrthographicCamera;
  hemi: HemisphereLight;
  key: DirectionalLight;
  dpr: number;
  rows: number;
  variants: Map<string, Variant>;
  free: number[];
  raf: number;
  last: number;
  lost: boolean;
  motionObserver: MutationObserver | null;
  teardown: number;
}

const subs = new Set<Sub>();
let engine: Engine | null = null;
let loading: Promise<void> | null = null;
let failed = false;
let palette: OrbPalette = DEFAULT_PALETTE;

function keyOf(spec: OrbSpec): string {
  return `${spec.id}|${spec.state}|${spec.tone}`;
}

function toneColour(tone: OrbTone): string {
  return tone === "sup" ? palette.sup : tone === "warn" ? palette.warn : palette.accent;
}

function reduceMotion(): boolean {
  return document.querySelector(".db-app")?.classList.contains("db-reduce-motion") ?? false;
}

function dprNow(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

function isSoftwareRenderer(renderer: WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return false;
  const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  return /swiftshader|llvmpipe|software/i.test(name);
}

function setColour(target: { color: InstanceType<Three["Color"]> }, css: string, fallback: string) {
  try {
    target.color.setStyle(css || fallback);
  } catch {
    target.color.setStyle(fallback);
  }
}

/** One orb: the manager's sigil in three dimensions. Sizes are the SVG's 24-unit box
 * divided by 12, so the mark reads the same at the avatar and on the card. */
function buildVariant(e: Engine, spec: OrbSpec, tile: number, seed: Motion | null): Variant {
  const T = e.three;
  const { nodes, twist, star, radius, ring } = spec.params;
  const colour = toneColour(spec.tone);
  const group = new T.Group();
  group.rotation.x = TILT;

  const coreR = (ring === 1 ? 2.6 : 2.1) / 12;
  const coreMat = new T.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05, emissiveIntensity: 0.18 });
  setColour(coreMat, colour, DEFAULT_PALETTE.accent);
  coreMat.emissive.copy(coreMat.color);
  const core = new T.Mesh(new T.SphereGeometry(coreR, 28, 18), coreMat);
  group.add(core);

  const rimMat = new T.MeshBasicMaterial({ transparent: true, opacity: palette.dark ? 0.18 : 0.35, side: T.BackSide, depthWrite: false });
  setColour(rimMat, colour, DEFAULT_PALETTE.accent);
  const rim = new T.Mesh(new T.SphereGeometry(coreR * 1.12, 28, 18), rimMat);
  core.add(rim);

  const ringGroup = new T.Group();
  group.add(ringGroup);
  const satMat = new T.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
  setColour(satMat, colour, DEFAULT_PALETTE.accent);
  const satBase: number[] = [];
  const sats: Mesh[] = [];
  for (let i = 0; i < nodes; i++) {
    const a = twist + (i / nodes) * Math.PI * 2;
    const x = Math.cos(a) * (radius / 12);
    const z = Math.sin(a) * (radius / 12);
    satBase.push(x, z);
    const sat = new T.Mesh(new T.SphereGeometry(((i === 0 ? 2 : 1.45) / 12) * 0.82, 16, 12), satMat);
    sat.position.set(x, 0, z);
    ringGroup.add(sat);
    sats.push(sat);
  }
  const linkOrder = Array.from({ length: nodes }, (_, i) => (star ? (i * 2) % nodes : i));
  const linkGeom = new T.BufferGeometry();
  linkGeom.setAttribute("position", new T.Float32BufferAttribute(new Float32Array(nodes * 3), 3));
  const linkMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.85 });
  setColour(linkMat, colour, DEFAULT_PALETTE.accent);
  const links = new T.LineLoop(linkGeom, linkMat);
  ringGroup.add(links);

  let outer: LineLoop | null = null;
  let outerMat: LineBasicMaterial | null = null;
  if (ring === 0) {
    const r = (radius + 2.4) / 12;
    const pts = new Float32Array(64 * 3);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts[i * 3] = Math.cos(a) * r;
      pts[i * 3 + 2] = Math.sin(a) * r;
    }
    const geom = new T.BufferGeometry();
    geom.setAttribute("position", new T.Float32BufferAttribute(pts, 3));
    outerMat = new T.LineDashedMaterial({ transparent: true, opacity: 0.55, dashSize: 0.06, gapSize: 0.08 });
    setColour(outerMat, colour, DEFAULT_PALETTE.accent);
    outer = new T.LineLoop(geom, outerMat);
    outer.computeLineDistances();
    group.add(outer);
  }

  let inner: Mesh | null = null;
  let innerMat: MeshBasicMaterial | null = null;
  if (ring === 2) {
    innerMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
    setColour(innerMat, colour, DEFAULT_PALETTE.accent);
    inner = new T.Mesh(new T.TorusGeometry(4.2 / 12, 0.012, 6, 48), innerMat);
    inner.rotation.x = Math.PI / 2;
    group.add(inner);
  }

  group.visible = false;
  e.scene.add(group);
  return {
    key: keyOf(spec),
    spec,
    tile,
    refs: 0,
    group,
    ringGroup,
    core,
    coreMat,
    rimMat,
    sats,
    satMat,
    satBase,
    links,
    linkMat,
    linkOrder,
    outer,
    outerMat,
    inner,
    innerMat,
    current: seed ? { ...seed } : { ...REST[spec.state] },
    spinAngle: twist,
    outerAngle: 0,
    precess: 0,
    t: 0,
  };
}

function destroyVariant(e: Engine, v: Variant) {
  e.scene.remove(v.group);
  v.core.geometry.dispose();
  v.coreMat.dispose();
  v.rimMat.dispose();
  for (const s of v.sats) s.geometry.dispose();
  v.satMat.dispose();
  v.links.geometry.dispose();
  v.linkMat.dispose();
  v.outer?.geometry.dispose();
  v.outerMat?.dispose();
  v.inner?.geometry.dispose();
  v.innerMat?.dispose();
  e.variants.delete(v.key);
  e.free.push(v.tile);
}

function recolour(v: Variant) {
  const colour = toneColour(v.spec.tone);
  setColour(v.coreMat, colour, DEFAULT_PALETTE.accent);
  v.coreMat.emissive.copy(v.coreMat.color);
  setColour(v.rimMat, colour, DEFAULT_PALETTE.accent);
  v.rimMat.opacity = palette.dark ? 0.18 : 0.35;
  setColour(v.satMat, colour, DEFAULT_PALETTE.accent);
  setColour(v.linkMat, colour, DEFAULT_PALETTE.accent);
  if (v.outerMat) setColour(v.outerMat, colour, DEFAULT_PALETTE.accent);
  if (v.innerMat) setColour(v.innerMat, colour, DEFAULT_PALETTE.accent);
}

function applyLighting(e: Engine) {
  e.hemi.intensity = palette.dark ? 0.7 : 0.95;
  e.key.intensity = palette.dark ? 0.75 : 1.1;
}

function tileRect(e: Engine, tile: number): { x: number; yGl: number; yImg: number; size: number } {
  const size = TILE * e.dpr;
  const col = tile % COLS;
  const row = Math.floor(tile / COLS);
  return { x: col * size, yGl: row * size, yImg: e.gl.height - (row + 1) * size, size };
}

function sizeAtlas(e: Engine) {
  const size = TILE * e.dpr;
  e.renderer.setSize(COLS * size, e.rows * size, false);
}

/** Grow the atlas by a row of tiles, up to MAX_ROWS. Returns false when full. */
function growAtlas(e: Engine): boolean {
  if (e.rows >= MAX_ROWS) return false;
  const first = e.rows * COLS;
  e.rows += 1;
  for (let i = first; i < e.rows * COLS; i++) e.free.push(i);
  sizeAtlas(e);
  return true;
}

function acquireVariant(e: Engine, spec: OrbSpec, seed: Motion | null): Variant | null {
  const key = keyOf(spec);
  let v = e.variants.get(key);
  if (!v) {
    if (e.free.length === 0 && !growAtlas(e)) return null;
    const tile = e.free.shift() as number;
    v = buildVariant(e, spec, tile, seed);
    e.variants.set(key, v);
  }
  v.refs += 1;
  return v;
}

function releaseVariant(e: Engine, v: Variant) {
  v.refs -= 1;
  if (v.refs <= 0) destroyVariant(e, v);
}

function attach(e: Engine, sub: Sub) {
  const v = acquireVariant(e, sub.spec, null);
  sub.variant = v;
  sub.onStatus(v ? "live" : "fallback");
}

function detach(e: Engine, sub: Sub) {
  if (sub.variant) releaseVariant(e, sub.variant);
  sub.variant = null;
}

function pose(v: Variant, dt: number, still: boolean) {
  const target = REST[v.spec.state];
  const c = v.current;
  const k = still ? 1 : 1 - Math.exp(-dt * 6);
  c.spin += (target.spin - c.spin) * k;
  c.satRadius += (target.satRadius - c.satRadius) * k;
  c.breatheAmp += (target.breatheAmp - c.breatheAmp) * k;
  c.breatheHz += (target.breatheHz - c.breatheHz) * k;
  c.links += (target.links - c.links) * k;
  c.coreDim += (target.coreDim - c.coreDim) * k;
  c.outerSpin += (target.outerSpin - c.outerSpin) * k;
  if (!still) {
    v.t += dt;
    v.spinAngle += c.spin * dt;
    v.outerAngle += c.outerSpin * dt;
    v.precess += PRECESS * dt;
  }

  const state = v.spec.state;
  const phase = v.t * c.breatheHz * Math.PI * 2;
  let breathe = still ? 0 : Math.sin(phase) * c.breatheAmp;
  if (state === "verifying" && !still) breathe = (Math.sin(phase) + Math.sin(phase * 2) * 0.5) * c.breatheAmp;
  v.core.scale.setScalar(1 + breathe);
  v.coreMat.emissiveIntensity = 0.18 * c.coreDim;

  let linksOpacity = c.links;
  if (state === "planning" && !still) linksOpacity = 0.35 + (Math.sin(v.t * Math.PI) * 0.5 + 0.5) * 0.5;
  v.linkMat.opacity = linksOpacity;

  v.group.rotation.y = v.precess;
  v.group.rotation.x = TILT + (state === "acting" && !still ? Math.sin(v.t * 1.7) * ((4 * Math.PI) / 180) : 0);
  v.ringGroup.rotation.y = v.spinAngle;
  if (v.outer) v.outer.rotation.y = v.outerAngle;

  const positions = v.links.geometry.getAttribute("position") as { setXYZ(i: number, x: number, y: number, z: number): void; needsUpdate: boolean };
  const lead = state === "acting" && !still ? Math.floor(v.t / 1.2) % v.sats.length : -1;
  for (let i = 0; i < v.sats.length; i++) {
    const x = v.satBase[i * 2] * c.satRadius;
    const z = v.satBase[i * 2 + 1] * c.satRadius;
    v.sats[i].position.set(x, 0, z);
    v.sats[i].scale.setScalar(i === lead ? 1.35 : 1);
  }
  for (let i = 0; i < v.linkOrder.length; i++) {
    const n = v.linkOrder[i];
    positions.setXYZ(i, v.satBase[n * 2] * c.satRadius, 0, v.satBase[n * 2 + 1] * c.satRadius);
  }
  positions.needsUpdate = true;
}

function drawFrame(e: Engine, dt: number, still: boolean) {
  const r = e.renderer;
  r.setScissorTest(true);
  for (const v of e.variants.values()) {
    pose(v, dt, still);
    const { x, yGl, size } = tileRect(e, v.tile);
    r.setViewport(x, yGl, size, size);
    r.setScissor(x, yGl, size, size);
    r.clear(true, true, false);
    v.group.visible = true;
    r.render(e.scene, e.camera);
    v.group.visible = false;
  }
  r.setScissorTest(false);

  for (const sub of subs) {
    if (!sub.variant || !sub.ctx || !sub.canvas.isConnected) continue;
    const { x, yImg, size } = tileRect(e, sub.variant.tile);
    const ctx = sub.ctx;
    ctx.clearRect(0, 0, sub.canvas.width, sub.canvas.height);
    ctx.drawImage(e.gl, x, yImg, size, size, 0, 0, sub.canvas.width, sub.canvas.height);
  }
}

function loopWanted(e: Engine): boolean {
  return subs.size > 0 && !document.hidden && !e.lost && !reduceMotion();
}

function tick(now: number) {
  const e = engine;
  if (!e) return;
  e.raf = 0;
  if (!loopWanted(e)) return;
  const elapsed = now - e.last;
  if (elapsed >= FRAME_MS) {
    e.last = now - (elapsed % FRAME_MS);
    drawFrame(e, Math.min(elapsed, 100) / 1000, false);
  }
  e.raf = requestAnimationFrame(tick);
}

/** Start the loop, or with reduce motion on draw one still frame instead. */
function wake(e: Engine) {
  if (e.lost || subs.size === 0) return;
  if (reduceMotion() || document.hidden) {
    if (e.raf) {
      cancelAnimationFrame(e.raf);
      e.raf = 0;
    }
    if (!document.hidden) drawFrame(e, 0, true);
    return;
  }
  if (!e.raf) {
    e.last = performance.now();
    e.raf = requestAnimationFrame(tick);
  }
}

function onVisibility() {
  if (engine) wake(engine);
}

function onResize() {
  const e = engine;
  if (!e) return;
  const dpr = dprNow();
  if (dpr === e.dpr) return;
  e.dpr = dpr;
  sizeAtlas(e);
  wake(e);
}

function onContextLost(event: Event) {
  event.preventDefault();
  const e = engine;
  if (!e) return;
  e.lost = true;
  if (e.raf) {
    cancelAnimationFrame(e.raf);
    e.raf = 0;
  }
  for (const sub of subs) sub.onStatus("fallback");
}

function onContextRestored() {
  const e = engine;
  if (!e) return;
  e.lost = false;
  for (const sub of subs) if (sub.variant) sub.onStatus("live");
  wake(e);
}

function buildEngine(three: Three): Engine | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new three.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power", premultipliedAlpha: true });
  } catch {
    return null;
  }
  if (isSoftwareRenderer(renderer)) {
    renderer.dispose();
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  const scene = new three.Scene();
  const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const hemi = new three.HemisphereLight(0xffffff, 0x1a2a28, 0.95);
  const key = new three.DirectionalLight(0xffffff, 1.1);
  key.position.set(-1.2, 1.6, 2.2);
  scene.add(hemi, key);
  const e: Engine = {
    three,
    renderer,
    gl: renderer.domElement,
    scene,
    camera,
    hemi,
    key,
    dpr: dprNow(),
    rows: MIN_ROWS,
    variants: new Map(),
    free: Array.from({ length: COLS * MIN_ROWS }, (_, i) => i),
    raf: 0,
    last: 0,
    lost: false,
    motionObserver: null,
    teardown: 0,
  };
  sizeAtlas(e);
  applyLighting(e);
  e.gl.addEventListener("webglcontextlost", onContextLost);
  e.gl.addEventListener("webglcontextrestored", onContextRestored);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  const app = document.querySelector(".db-app");
  if (app) {
    e.motionObserver = new MutationObserver(() => wake(e));
    e.motionObserver.observe(app, { attributes: true, attributeFilter: ["class"] });
  }
  return e;
}

function destroyEngine() {
  const e = engine;
  if (!e) return;
  engine = null;
  if (e.raf) cancelAnimationFrame(e.raf);
  e.motionObserver?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("resize", onResize);
  e.gl.removeEventListener("webglcontextlost", onContextLost);
  e.gl.removeEventListener("webglcontextrestored", onContextRestored);
  for (const v of Array.from(e.variants.values())) destroyVariant(e, v);
  e.renderer.dispose();
  e.renderer.forceContextLoss();
}

function scheduleTeardown() {
  const e = engine;
  if (!e || subs.size > 0 || e.teardown) return;
  e.teardown = window.setTimeout(() => {
    if (engine === e) {
      e.teardown = 0;
      if (subs.size === 0) destroyEngine();
    }
  }, TEARDOWN_MS);
}

function cancelTeardown() {
  const e = engine;
  if (e?.teardown) {
    window.clearTimeout(e.teardown);
    e.teardown = 0;
  }
}

function ensureEngine() {
  if (engine || failed || loading) return;
  loading = import("./swarmOrbThree")
    .then((three) => {
      loading = null;
      if (subs.size === 0) return;
      const built = buildEngine(three);
      if (!built) {
        failed = true;
        for (const sub of subs) sub.onStatus("fallback");
        return;
      }
      engine = built;
      for (const sub of subs) attach(built, sub);
      wake(built);
    })
    .catch(() => {
      loading = null;
      failed = true;
      for (const sub of subs) sub.onStatus("fallback");
    });
}

/** Colours for every orb, read by SwarmOrb from its own --sw-* tokens. A no-op when
 * nothing changed, so every mounted orb may call it freely. */
export function setOrbPalette(next: OrbPalette) {
  if (next.accent === palette.accent && next.sup === palette.sup && next.warn === palette.warn && next.dark === palette.dark) return;
  palette = next;
  const e = engine;
  if (!e) return;
  applyLighting(e);
  for (const v of e.variants.values()) recolour(v);
  wake(e);
}

export function subscribeOrb(canvas: HTMLCanvasElement, spec: OrbSpec, onStatus: (status: OrbStatus) => void): OrbSubscription {
  const sub: Sub = { canvas, ctx: canvas.getContext("2d"), spec: { ...spec }, onStatus, variant: null };
  subs.add(sub);
  cancelTeardown();
  if (failed) {
    onStatus("fallback");
  } else if (engine) {
    attach(engine, sub);
    wake(engine);
  } else {
    onStatus("pending");
    ensureEngine();
  }
  let live = true;
  return {
    update(next) {
      if (!live) return;
      const spec = { ...sub.spec, ...next };
      if (keyOf(spec) === keyOf(sub.spec)) return;
      sub.spec = spec;
      const e = engine;
      if (!e) return;
      // Carry the motion over so a state flip eases from where the orb is instead of snapping.
      const seed = sub.variant ? { ...sub.variant.current } : null;
      const was = sub.variant;
      sub.variant = acquireVariant(e, spec, seed);
      if (was) releaseVariant(e, was);
      sub.onStatus(sub.variant ? "live" : "fallback");
      wake(e);
    },
    dispose() {
      if (!live) return;
      live = false;
      subs.delete(sub);
      if (engine) detach(engine, sub);
      scheduleTeardown();
    },
  };
}
