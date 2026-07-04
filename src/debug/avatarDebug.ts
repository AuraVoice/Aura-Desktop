import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import modelUrl from "../assets/models/buddy.glb";
import dracoWasmWrapperUrl from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url";
import dracoWasmBinaryUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm?url";

// Throwaway debug page (debug-avatar.html) to validate buddy.glb actually
// renders and find real camera numbers before touching AvatarPill.tsx -
// avoids needing a live voice call/agent session per iteration. Delete both
// files once the pill's camera framing is confirmed.

const info = document.getElementById("info") as HTMLPreElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(2, 2, 2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(1.2, 2.4, 2);
scene.add(keyLight);
scene.add(new THREE.AxesHelper(1));
scene.add(new THREE.GridHelper(4, 40, 0x444444, 0x333333));

const dracoLoader = new DRACOLoader();
// DRACOLoader's own default decoder paths resolve via
// `new URL('../libs/draco/...', import.meta.url)` inside its own module -
// under Vite dev mode, once esbuild pre-bundles DRACOLoader.js into
// node_modules/.vite/deps/, that relative path points nowhere, the fetch
// 404s, and Vite's dev-server fallback serves index.html in its place -
// which then gets fed into the decoder Worker as JS and throws a
// SyntaxError. DRACOLoader never wires up worker.onerror, so that failure
// is swallowed and the load just hangs forever with no error. Pointing it
// at Vite-resolved URLs for the exact same files sidesteps that entirely.
dracoLoader.setDecoderPath({ js: dracoWasmWrapperUrl, wasm: dracoWasmBinaryUrl });
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

let mixer: THREE.AnimationMixer | undefined;

loader.load(
  modelUrl,
  (gltf) => {
    scene.add(gltf.scene);

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const clipNames = gltf.animations.map((clip) => clip.name).join(", ") || "none";
    const idleClip = gltf.animations.find((clip) => clip.name === "Idle") ?? gltf.animations[0];
    if (idleClip) {
      mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(idleClip).play();
    }

    // Frame the camera off the real bounding box instead of a guess -
    // distance derived from the diagonal works regardless of the model's
    // actual scale, which is exactly the unknown we're checking here.
    const diagonal = size.length();
    const distance = diagonal * 1.2 || 3;
    camera.position.set(center.x + distance * 0.4, center.y + distance * 0.3, center.z + distance * 0.8);
    controls.target.copy(center);
    controls.update();

    info.textContent = [
      `clips: ${clipNames}`,
      `bbox min: (${box.min.x.toFixed(3)}, ${box.min.y.toFixed(3)}, ${box.min.z.toFixed(3)})`,
      `bbox max: (${box.max.x.toFixed(3)}, ${box.max.y.toFixed(3)}, ${box.max.z.toFixed(3)})`,
      `size:     (${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)})`,
      `center:   (${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)})`,
      "",
      "drag: rotate   scroll: zoom   right-drag: pan",
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
  controls.update();
  renderer.render(scene, camera);
}
tick();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
