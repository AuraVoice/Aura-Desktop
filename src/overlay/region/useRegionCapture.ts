import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseChatCapture } from "../../lib/chatScreenCapture";
import { REGION_CAPTURE_READY, type RegionCaptureReadyPayload } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import { asArrayBuffer } from "../../lib/screenFrame";
import { useTauriEvent } from "../../lib/useTauriEvent";

/** A circled area nobody has acted on stops being worth holding. Memory only,
 * so this bounds how long a crop of the user's screen sits in the overlay. */
const IDLE_CLEAR_MS = 120_000;

export interface RegionPreview {
  generation: number;
  /** Object URL for the thumbnail. Owned and revoked by this hook. */
  url: string;
  /** The JPEG itself, for whatever answers it later. */
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  capturedAtMs: number;
  wholeDisplay: boolean;
}

/**
 * Collects the crop a circle-to-ask gesture produced and holds it for the notch
 * preview chip. No model sees it yet; this is the frontend half on its own.
 *
 * `take_region_capture` MOVES the frame out of Rust, so once collected this
 * hook holds the only copy. That is what makes dismiss, sign-out and the idle
 * clear real deletions rather than a hidden thumbnail over a frame that is
 * still collectable.
 */
export function useRegionCapture(signedIn: boolean) {
  const [preview, setPreview] = useState<RegionPreview | null>(null);
  const previewRef = useRef<RegionPreview | null>(null);
  previewRef.current = preview;
  // The newest gesture wins: a slow take for an older generation must not
  // replace a newer preview.
  const latestGenerationRef = useRef<number | null>(null);
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  const adopt = useCallback((next: RegionPreview | null) => {
    setPreview((current) => {
      if (current && current.url !== next?.url) URL.revokeObjectURL(current.url);
      return next;
    });
  }, []);

  useTauriEvent<RegionCaptureReadyPayload>(
    REGION_CAPTURE_READY,
    (payload) => {
      if (!signedInRef.current) return;
      const { generation, wholeDisplay } = payload;
      latestGenerationRef.current = generation;
      void (async () => {
        try {
          const capture = parseChatCapture(asArrayBuffer(await invoke("take_region_capture")));
          if (!capture) return;
          if (latestGenerationRef.current !== generation || !signedInRef.current) return;
          const url = URL.createObjectURL(new Blob([capture.bytes as BlobPart], { type: "image/jpeg" }));
          adopt({
            generation,
            url,
            bytes: capture.bytes,
            widthPx: capture.widthPx,
            heightPx: capture.heightPx,
            capturedAtMs: capture.capturedAtMs,
            wholeDisplay,
          });
          // The bar, never summon: the user is still in the app they circled,
          // and focus has to stay there.
          await invoke("summon_bar");
        } catch (err) {
          logError("useRegionCapture: take", err);
        }
      })();
    },
    "useRegionCapture: listen region-capture-ready",
  );

  useEffect(() => {
    if (!signedIn) adopt(null);
  }, [signedIn, adopt]);

  useEffect(() => {
    if (!preview) return;
    const timeoutId = setTimeout(() => adopt(null), IDLE_CLEAR_MS);
    return () => clearTimeout(timeoutId);
  }, [preview, adopt]);

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    };
  }, []);

  const dismiss = useCallback(() => adopt(null), [adopt]);

  return { preview, dismiss };
}
