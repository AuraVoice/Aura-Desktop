import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "../lib/log";

/** Esc always collapses the overlay, scoped to whatever has OS focus (same as the Flutter source's HardwareKeyboard handler - no global hook needed). */
export function useEscHotkey(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      invoke("esc_pressed").catch((err) => logError("useEscHotkey", err));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
