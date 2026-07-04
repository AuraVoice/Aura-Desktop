import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { invoke } from "@tauri-apps/api/core";
import { bar as copy } from "../lib/copy";
import { logError } from "../lib/log";
import { EyeIcon } from "./icons";
import type { VoiceBarState } from "./useVoiceBar";
import modelUrl from "../assets/models/buddy.glb";
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
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, width / height, 0.1, 100);
    camera.position.set(0, 1.4, 3.4);
    camera.lookAt(0, 1.0, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(1.2, 2.4, 2);
    scene.add(keyLight);

    // No setDecoderPath call: DRACOLoader's own default paths already
    // resolve via `new URL(..., import.meta.url)`, which Vite bundles and
    // serves locally out of the box - no manual asset copying needed.
    const dracoLoader = new DRACOLoader();
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
        }
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
    <div
      className="avatar-pill"
      role="button"
      tabIndex={0}
      data-tauri-drag-region="deep"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      {screenSight.armed && (
        <span className="avatar-pill-sight-indicator">
          <EyeIcon />
        </span>
      )}
      <canvas ref={canvasRef} className="avatar-pill-canvas" />
      <span className="avatar-pill-caption">{caption}</span>
    </div>
  );
}
