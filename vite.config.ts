/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  test: {
    // The GitHub runner is slow enough that fake-timer chains in the guide
    // tests occasionally register a timer after the advance that should fire
    // it, and one under-executed test leaves residue for its neighbor. A
    // retry re-runs just the failed test with a fresh beforeEach, which
    // clears that class; a real regression still fails all three attempts.
    // Local runs stay strict so new flakiness is felt at the desk first.
    retry: process.env.CI ? 2 : 0,
  },
  // .glb isn't in Vite's default recognized-asset list; without this the
  // AvatarPill model import fails to resolve to a URL.
  assetsInclude: ["**/*.glb"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
