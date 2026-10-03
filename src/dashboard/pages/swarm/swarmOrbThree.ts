/** The slice of three.js the Swarm orb uses. swarmOrbRenderer.ts imports THIS module
 * dynamically, so Vite splits three into its own chunk that loads the first time an orb
 * mounts, and Rollup tree-shakes the chunk down to these exports instead of shipping the
 * whole namespace. Add a class here before using it in the renderer. */
export {
  BackSide,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  SphereGeometry,
  TorusGeometry,
  WebGLRenderer,
} from "three";
