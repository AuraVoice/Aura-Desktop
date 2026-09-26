import { invoke } from "@tauri-apps/api/core";
import { logError } from "../lib/log";

// The overlay is always-on-top by a static, once-at-creation setting (see
// overlay::set_dialog_friendly on the Rust side for the full story). A native
// file-open dialog is an ordinary, non-topmost window, so left as-is it
// renders trapped underneath the overlay and neither it nor the overlay can
// be clicked. Toggling this around the dialog's lifetime is idempotent on the
// Rust side, so callers never need to track whether it is already applied.
export function setOverlayDialogFriendly(friendly: boolean) {
  void invoke("set_overlay_dialog_friendly", { friendly }).catch((error: unknown) =>
    logError("overlay: set_overlay_dialog_friendly", error),
  );
}
