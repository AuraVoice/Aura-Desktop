import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useEscHotkey } from "./useEscHotkey";
import { useVoiceBar } from "./useVoiceBar";
import { useScreenSight } from "./useScreenSight";
import { GlassSurface } from "./GlassSurface";
import { GlassPill } from "./GlassPill";
import { VoiceBar } from "./VoiceBar";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";

type OverlayPresentation = "hidden" | "panel" | "pill" | "pointing";
type PanelVariant = "setup" | "bar";

interface OverlaySnapshot {
  presentation: OverlayPresentation;
  panelVariant: PanelVariant;
}

export function OverlayRoot() {
  const { user } = useAuth();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const voice = useVoiceBar();
  const screenSight = useScreenSight(voice.room, voice.status);
  useEscHotkey();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlaySnapshot>("overlay-changed", (event) => {
      setPresentation(event.payload.presentation);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen overlay-changed", err));

    // Covers the race where Rust applies the startup presentation before
    // this listener attaches.
    invoke<OverlaySnapshot>("current_overlay_state")
      .then((snapshot) => setPresentation(snapshot.presentation))
      .catch((err) => logError("OverlayRoot: current_overlay_state", err));

    return () => unlisten?.();
  }, []);

  // Rust ends any live call before collapsing to hidden (hotkey/Esc summon
  // dismissal) - this is the frontend side of that handshake.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("end-voice-session", () => {
      void voice.endSession();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen end-voice-session", err));
    return () => unlisten?.();
  }, [voice]);

  if (presentation === "pointing") {
    return <PointingOverlay />;
  }

  if (presentation === "pill") {
    return (
      <GlassSurface>
        <GlassPill voice={voice} screenSight={screenSight} />
      </GlassSurface>
    );
  }

  return (
    <GlassSurface>
      {user ? <VoiceBar voice={voice} screenSight={screenSight} /> : <SetupPanel />}
    </GlassSurface>
  );
}
