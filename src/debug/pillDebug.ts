import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import modelUrl from "../assets/models/buddy.glb";
import dracoWasmWrapperUrl from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url";
import dracoWasmBinaryUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm?url";
import "../overlay/AvatarPill.css";

// Throwaway debug page: mirrors AvatarPill.tsx's real camera/framing logic
// exactly (same DOM/CSS, same fixed 280x374 box - the real
// PILL_WIDTH/PILL_HEIGHT from overlay.rs) so the fix can be looked at
// directly in a normal browser tab instead of inferred from angles on paper
// or from a native Tauri window that can't be screenshotted remotely.
// Delete once the pill's framing is confirmed visually correct in the real app.

const frame = document.getElementById("pill-frame") as HTMLDivElement;
const info = document.getElementById("info") as HTMLPreElement;

const root = document.createElement("button");
root.className = "avatar-pill";
const canvas = document.createElement("canvas");
canvas.className = "avatar-pill-canvas";
const caption = document.createElement("span");
caption.className = "avatar-pill-caption";
caption.textContent = "how's it going buddy";
root.appendChild(canvas);
root.appendChild(caption);
frame.appendChild(root);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

// Copied verbatim from AvatarPill.tsx - keep in sync.
let modelHalfWidth = 0.83;
let modelHalfHeight = 1.0;
const fitMargin = 1.15;

function frameCamera(aspect: number) {
  const halfVFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distanceForHeight = (modelHalfHeight * fitMargin) / Math.tan(halfVFov);
  const distanceForWidth = (modelHalfWidth * fitMargin) / (Math.tan(halfVFov) * aspect);
  const distance = Math.max(distanceForHeight, distanceForWidth);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
}

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

function resize(width: number, height: number) {
  if (width === 0 || height === 0) return;
  const aspect = width / height;
  camera.aspect = aspect;
  frameCamera(aspect);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}
const resizeObserver = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (!entry) return;
  resize(entry.contentRect.width, entry.contentRect.height);
});
resizeObserver.observe(canvas);

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(1.2, 2.4, 2);
scene.add(keyLight);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath({ js: dracoWasmWrapperUrl, wasm: dracoWasmBinaryUrl });
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

let mixer: THREE.AnimationMixer | undefined;

loader.load(
  modelUrl,
  (gltf) => {
    scene.add(gltf.scene);

    const idleClip = gltf.animations.find((clip) => clip.name === "Idle") ?? gltf.animations[0];
    if (idleClip) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(idleClip).play();
      mixer.update(0);
      gltf.scene.updateMatrixWorld(true);
    }

    // Real fix under test: measure the actual posed character and recenter/
    // refit off of it, instead of trusting the T-pose the GLB ships in.
    const posedBox = new THREE.Box3().setFromObject(gltf.scene);
    const centerY = (posedBox.min.y + posedBox.max.y) / 2;
    gltf.scene.position.y -= centerY;
    modelHalfHeight = (posedBox.max.y - posedBox.min.y) / 2;
    modelHalfWidth = Math.max(Math.abs(posedBox.min.x), Math.abs(posedBox.max.x));
    frameCamera(camera.aspect);
    camera.updateProjectionMatrix();

    // Reference wireframe now drawn around the POSED (post-recenter) box,
    // to visually confirm it now sits flush within the fitMargin.
    const recheckedBox = new THREE.Box3().setFromObject(gltf.scene);
    scene.add(new THREE.Box3Helper(recheckedBox, new THREE.Color(0x00ff00)));

    info.textContent = [
      `canvas: ${canvas.clientWidth}x${canvas.clientHeight}`,
      `cameraZ: ${camera.position.z.toFixed(3)}`,
      `posed bbox (pre-recenter) min y=${posedBox.min.y.toFixed(3)} max y=${posedBox.max.y.toFixed(3)}`,
      `centerY applied: ${centerY.toFixed(3)}`,
      `modelHalfWidth=${modelHalfWidth.toFixed(3)} modelHalfHeight=${modelHalfHeight.toFixed(3)}`,
      `recentered bbox min=(${recheckedBox.min.x.toFixed(3)}, ${recheckedBox.min.y.toFixed(3)}, ${recheckedBox.min.z.toFixed(3)})`,
      `                max=(${recheckedBox.max.x.toFixed(3)}, ${recheckedBox.max.y.toFixed(3)}, ${recheckedBox.max.z.toFixed(3)})`,
    ].join("\n");
  },
  undefined,
  (err) => {
    info.textContent = `FAILED TO LOAD: ${err instanceof Error ? err.message : String(err)}`;
    console.error(err);
  },
);

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  mixer?.update(clock.getDelta());
  renderer.render(scene, camera);
}
tick();
