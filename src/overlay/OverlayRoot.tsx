import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useVoiceBar } from "./useVoiceBar";
import { useNotchGesture } from "./useNotchGesture";
import { useTurnScreenCapture } from "./useTurnScreenCapture";
import { useDraftCard } from "./useDraftCard";
import { useUpdateReady } from "./useUpdateReady";
import { useMeetings } from "./useMeetings";
import { useMeetingArm } from "./useMeetingArm";
import { useMeetingCapture } from "./useMeetingCapture";
import { GlassSurface } from "./GlassSurface";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard } from "./DraftCard";
import { NotchBar } from "./NotchBar";

const DRAFT_CARD_HEIGHT = 270;

type OverlayPresentation = "hidden" | "panel" | "bar" | "companion" | "pointing";

interface OverlaySnapshot {
  presentation: OverlayPresentation;
}

export function OverlayRoot() {
  const { user } = useAuth();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const voice = useVoiceBar();
  const notchGesture = useNotchGesture(user !== null, voice, presentation === "pointing");
  useUpdateReady();
  const screenCapture = useTurnScreenCapture(voice.room);
  const notchNotice =
    screenCapture.notice ??
    (!notchGesture.checking && !notchGesture.available ? notchGesture.reason : null);
  const draftCard = useDraftCard(voice.room, presentation);
  const callLive =
    voice.status !== "disconnected" && voice.status !== "ended" && voice.status !== "error";
  // Meeting capture is a background service, not part of the notch UI. Keep
  // polling, join watches, durable upload recovery, and completion alive even
  // while the native window is hidden. The removed meeting controls/cards stay
  // intentionally absent from this visual root.
  const meetings = useMeetings({
    presentation,
    signedIn: user !== null,
    callLive,
    autoSummon: false,
  });
  const meetingArm = useMeetingArm(user?.uid ?? null);
  useMeetingCapture({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
    events: meetings.events,
    isArmed: meetingArm.isArmed,
    armRevision: meetingArm.revision,
  });
  const resetDraftCard = draftCard.reset;
  const showDraftCard = user !== null && draftCard.phase !== "idle";
  const slotHeight = showDraftCard ? DRAFT_CARD_HEIGHT : null;

  useEffect(() => {
    invoke("set_slot_height", { height: slotHeight }).catch((err) =>
      logError("OverlayRoot: set_slot_height", err),
    );
  }, [slotHeight]);

  useEffect(() => {
    if (!user) {
      resetDraftCard();
      invoke("dismiss_bar").catch((err) =>
        logError("OverlayRoot: dismiss_bar after sign-out", err),
      );
    }
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

    invoke<OverlaySnapshot>("current_overlay_state")
      .then((snapshot) => {
        setPresentation(snapshot.presentation);
      })
      .catch((err) => logError("OverlayRoot: current_overlay_state", err));

    return () => unlisten?.();
  }, []);

  const endSession = voice.endSession;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("end-voice-session", () => {
      void endSession();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen end-voice-session", err));
    return () => unlisten?.();
  }, [endSession]);

  useEffect(() => {
    if (!user) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void endSession();
      invoke("dismiss_bar").catch((err) =>
        logError("OverlayRoot: dismiss_bar on Escape", err),
      );
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [user, endSession]);

  if (presentation === "pointing") {
    return <PointingOverlay />;
  }

  if (!user) {
    return (
      <div className="overlay-column">
        <GlassSurface>
          <SetupPanel />
        </GlassSurface>
      </div>
    );
  }

  return (
    <div className={`notch-column${showDraftCard ? " notch-column-with-draft" : ""}`}>
      {showDraftCard && <DraftCard card={draftCard} />}
      <NotchBar key={presentation} voice={voice} notice={notchNotice} />
    </div>
  );
}
