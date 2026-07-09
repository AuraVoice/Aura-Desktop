import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useEscHotkey } from "./useEscHotkey";
import { useVoiceBar } from "./useVoiceBar";
import { useScreenSight } from "./useScreenSight";
import { useDraftCard } from "./useDraftCard";
import { GlassSurface } from "./GlassSurface";
import { VoiceBar } from "./VoiceBar";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard } from "./DraftCard";
import "./DraftCard.css";

// Lazy: keeps three.js out of the overlay's startup bundle - only fetched
// the first time the pill is actually reached.
const AvatarPill = lazy(() => import("./AvatarPill").then((m) => ({ default: m.AvatarPill })));

type OverlayPresentation = "hidden" | "panel" | "pill" | "pointing";

interface OverlaySnapshot {
  presentation: OverlayPresentation;
}

export function OverlayRoot() {
  const { user } = useAuth();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const voice = useVoiceBar();
  const screenSight = useScreenSight(voice.room, voice.status);
  const draftCard = useDraftCard(voice.room, presentation);
  const resetDraftCard = draftCard.reset;
  useEscHotkey();

  // A draft can outlive its call, but never its session: signing out clears
  // the card (and shrinks the window) without firing dismiss analytics.
  useEffect(() => {
    if (!user) resetDraftCard();
  }, [user, resetDraftCard]);

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
      .then((snapshot) => {
        setPresentation(snapshot.presentation);
      })
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
      <Suspense fallback={null}>
        <AvatarPill voice={voice} screenSight={screenSight} />
      </Suspense>
    );
  }

  // The card only ever renders under the signed-in bar. The wrapper column is
  // always present so opening/closing the card never remounts VoiceBar (the
  // GlassSurface keeps its tree position; only its height pinning toggles).
  const showDraftCard = user !== null && draftCard.phase !== "idle";

  return (
    <div className="overlay-column">
      <GlassSurface className={showDraftCard ? "overlay-column-bar" : undefined}>
        {user ? <VoiceBar voice={voice} screenSight={screenSight} /> : <SetupPanel />}
      </GlassSurface>
      {showDraftCard && <DraftCard card={draftCard} />}
    </div>
  );
}
