import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { invoke } from "@tauri-apps/api/core";
import { bar as copy } from "../lib/copy";
import { logError } from "../lib/log";
import { IncognitoOnIcon } from "./icons";
import type { VoiceBarState } from "./useVoiceBar";
import modelUrl from "../assets/models/buddy.glb";
import dracoWasmWrapperUrl from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url";
import dracoWasmBinaryUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm?url";
import "./AvatarPill.css";

interface AvatarPillProps {
  voice: VoiceBarState;
  screenSight: { armed: boolean; toggleArmed: () => void };
}

/**
 * The "pill" presentation: Buddy rendered as a rigged 3D character (idle
 * animation looping) instead of a text bar. No boxed glass panel behind
 * it - the character floats directly over the transparent desktop.
 */
export function AvatarPill({ voice, screenSight }: AvatarPillProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const caption = voice.errorMessage || voice.assistantCaption || copy.pillFallbackCaption;

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvas: HTMLCanvasElement = canvasEl;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

    // Fallback bounding box for the one frame before the model has loaded and
    // been measured for real (bind/T-pose: centered at the origin, feet at
    // y=-1.0, head top at y=1.0, size (1.66, 2.0, 0.943)). Overwritten below
    // with the real, *posed* measurement once the model loads - the T-pose
    // this ships in is never what's actually on screen (see loader.load).
    let modelHalfWidth = 0.83;
    let modelHalfHeight = 1.0;
    const fitMargin = 1.15; // 15% breathing room so nothing touches the edge

    // Derives camera distance from the model's real size and the canvas's
    // real aspect ratio, instead of a hand-picked constant that only happens
    // to be correct for one assumed aspect ratio. Takes whichever of
    // width/height is more constraining, so it can't crop either axis
    // regardless of what the canvas's actual measured shape turns out to be.
    function frameCamera(aspect: number) {
      const halfVFov = THREE.MathUtils.degToRad(camera.fov) / 2;
      const distanceForHeight = (modelHalfHeight * fitMargin) / Math.tan(halfVFov);
      const distanceForWidth = (modelHalfWidth * fitMargin) / (Math.tan(halfVFov) * aspect);
      const distance = Math.max(distanceForHeight, distanceForWidth);
      // Level shot, no vertical offset. Raising the camera and re-aiming at
      // the origin (previously `distance * 0.12`) tilts it down, which pulls
      // the frustum's top/bottom edges out of symmetry around the look-at
      // point: the head - above the look-at point - loses margin, the feet -
      // below it - gain margin they don't need. That shrank the head's margin
      // below fitMargin's intended 15% (clipping it during Idle's motion)
      // while padding the feet's margin well past it (the visible gap before
      // the caption). A level camera keeps both edges at the same margin.
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);
    }

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // clientWidth/clientHeight right at mount can't be trusted here: this
    // effect fires the instant Suspense resolves, right after Rust just
    // resized the native window and before the canvas's own flex layout
    // (sized off its .avatar-pill parent) has necessarily settled.
    // ResizeObserver's first callback always reports the real, settled size,
    // and keeps tracking it if the window is ever resized again while the
    // pill is showing.
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

    // DRACOLoader's own default decoder paths resolve via
    // `new URL('../libs/draco/...', import.meta.url)` inside its own module -
    // under Vite dev mode, once esbuild pre-bundles DRACOLoader.js into
    // node_modules/.vite/deps/, that relative path points nowhere, the fetch
    // 404s, and Vite's dev-server fallback serves index.html in its place -
    // which then gets fed into the decoder Worker as JS and throws a
    // SyntaxError. DRACOLoader never wires up worker.onerror, so that failure
    // is swallowed and the load just hangs forever with no error. Pointing it
    // at Vite-resolved URLs for the exact same files sidesteps that entirely.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath({ js: dracoWasmWrapperUrl, wasm: dracoWasmBinaryUrl });
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    let disposed = false;
    let mixer: THREE.AnimationMixer | undefined;
    let frameId = 0;

    loader.load(
      modelUrl,
      (gltf) => {
        if (disposed) return;
        scene.add(gltf.scene);
        const idleClip = gltf.animations.find((clip) => clip.name === "Idle") ?? gltf.animations[0];
        if (idleClip) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          mixer.clipAction(idleClip).play();
          // Evaluate the clip's first frame and propagate it through the
          // skeleton immediately, before anything measures or renders the
          // model - mixer.update() alone doesn't recompute matrixWorld, and
          // the render loop hasn't run yet.
          mixer.update(0);
          gltf.scene.updateMatrixWorld(true);
        }

        // Measure the actual POSED character, not the T-pose the GLB ships
        // in - confirmed via debug-pill.html that they don't match. The
        // retargeted Idle clip's root bone sits about one unit higher than
        // this mesh's own bind-pose origin convention (T-pose spans
        // y=-1..1 centered on the origin; Idle-posed spans roughly y=0..2,
        // arms at the sides instead of spread out to x=-0.83..0.83).
        // Framing off the bind pose was camera-correct for a pose that's
        // never actually on screen: it clipped the real (higher) head and
        // left a dead gap where the real (higher) feet never reached the
        // bottom of the frame. Recentering the loaded scene on the posed
        // box's real vertical center - and refitting the camera to its real
        // width/height - fixes both without touching the camera math itself.
        const posedBox = new THREE.Box3().setFromObject(gltf.scene);
        const centerY = (posedBox.min.y + posedBox.max.y) / 2;
        gltf.scene.position.y -= centerY;
        modelHalfHeight = (posedBox.max.y - posedBox.min.y) / 2;
        modelHalfWidth = Math.max(Math.abs(posedBox.min.x), Math.abs(posedBox.max.x));
        frameCamera(camera.aspect);
        camera.updateProjectionMatrix();
      },
      undefined,
      (err) => logError("AvatarPill: load model", err),
    );

    const clock = new THREE.Clock();
    function tick() {
      frameId = requestAnimationFrame(tick);
      mixer?.update(clock.getDelta());
      renderer.render(scene, camera);
    }
    tick();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(frameId);
      mixer?.stopAllAction();
      dracoLoader.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        }
      });
    };
  }, []);

  function activate() {
    invoke("pill_activated").catch((err) => logError("AvatarPill: pill_activated", err));
  }

  return (
    // A real <button>, not a div with role="button": this repo's drag-region
    // rule only auto-excludes real inputs/buttons/links from the "deep" drag
    // region (see CLAUDE.md) - an ARIA-role div doesn't qualify, so clicks
    // here were being swallowed as window-drag attempts instead of firing.
    <button
      type="button"
      className="avatar-pill"
      data-tauri-drag-region="deep"
      onClick={activate}
    >
      {screenSight.armed && (
        <span className="avatar-pill-sight-indicator">
          <IncognitoOnIcon />
        </span>
      )}
      <canvas ref={canvasRef} className="avatar-pill-canvas" />
      <span className="avatar-pill-caption">{caption}</span>
    </button>
  );
}
