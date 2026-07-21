import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useVoiceBar } from "./useVoiceBar";
import { useNotchGesture } from "./useNotchGesture";
import { useOnboardingTail } from "./useOnboardingTail";
import { OnboardingTail } from "./OnboardingTail";
import { useTurnScreenCapture } from "./useTurnScreenCapture";
import { useSystemControl } from "./useSystemControl";
import { useDraftCard } from "./useDraftCard";
import { useUpdateReady } from "./useUpdateReady";
import { useMeetings } from "./useMeetings";
import { useMeetingArm } from "./useMeetingArm";
import { useMeetingCapture } from "./useMeetingCapture";
import { useCallbackCard } from "./useCallbackCard";
import { useDesktopNotifications } from "../state/useDesktopNotifications";
import { openDashboard } from "../lib/dashboardLink";
import type { StoredNotification } from "../lib/desktopNotifications";
import { GlassSurface } from "./GlassSurface";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard } from "./DraftCard";
import { CallbackCard } from "./CallbackCard";
import { NotificationInboxCard } from "./NotificationInboxCard";
import { NotchBar } from "./NotchBar";
import { NotchMoveOverlay } from "./NotchMoveOverlay";
import { useNotchMove } from "./useNotchMove";
import type { NotchEdge } from "./notchEdge";

// Below-bar slot heights, one per surface. Each must agree with its CSS
// (DraftCard.css, NotificationInboxCard.css, CallbackCard.css).
const DRAFT_CARD_HEIGHT = 270;
const NOTIFICATION_INBOX_CARD_HEIGHT = 300;
const CALLBACK_CARD_HEIGHT = 180;

type OverlayPresentation =
  | "hidden"
  | "panel"
  | "bar"
  | "companion"
  | "pointing"
  | "movingnotch";

interface OverlaySnapshot {
  presentation: OverlayPresentation;
  notchEdge: NotchEdge;
}

export function OverlayRoot() {
  const { user } = useAuth();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const [notchEdge, setNotchEdge] = useState<NotchEdge>("top");
  const voice = useVoiceBar();
  // Long-press-to-move is only armed on the resting bar (never mid-card or
  // mid-onboarding); the notch itself is the drag handle.
  const notchMove = useNotchMove(presentation === "bar");
  const tail = useOnboardingTail(user !== null);
  // Suppress the double-tap-Ctrl notch gesture while the first-run tail is up,
  // so the live demo stays inside the onboarding panel (its own Start button
  // drives the call) instead of jumping to the notch mid-tour.
  const notchGesture = useNotchGesture(
    user !== null,
    voice,
    presentation === "pointing" || tail.status === "active",
  );
  useUpdateReady();
  // Kept for its capture side effects; its transient per-turn notice no longer
  // has a UI home (the subtitle is gone) and is already logged in the hook.
  useTurnScreenCapture(voice.room);
  // Desktop control: dispatches the agent's `desktop.run` messages to native
  // commands. Native side gates on a live voice session, so no extra guard here.
  useSystemControl(voice.room);
  // The draft/meeting/callback hooks predate movingnotch and type their
  // presentation param without it. Move-mode is a transient fullscreen takeover
  // that starts and ends on the bar, so present it to them as "bar".
  const hookPresentation = presentation === "movingnotch" ? "bar" : presentation;
  const draftCard = useDraftCard(voice.room, hookPresentation);
  const callLive =
    voice.status !== "disconnected" && voice.status !== "ended" && voice.status !== "error";
  // Meeting capture is a background service, not part of the notch UI. Keep
  // polling, join watches, durable upload recovery, and completion alive even
  // while the native window is hidden. The removed meeting controls/cards stay
  // intentionally absent from this visual root.
  const meetings = useMeetings({
    presentation: hookPresentation,
    signedIn: user !== null,
    callLive,
    autoSummon: false,
  });
  const meetingArm = useMeetingArm(user?.uid ?? null);
  const meetingCapture = useMeetingCapture({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
    events: meetings.events,
    isArmed: meetingArm.isArmed,
    armRevision: meetingArm.revision,
    automaticCapture: true,
  });
  const resetDraftCard = draftCard.reset;
  const showDraftCard = user !== null && draftCard.phase !== "idle";

  const notifications = useDesktopNotifications({
    signedIn: user !== null,
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
  });
  const [inboxOpen, setInboxOpen] = useState(false);
  // useCallbackCard predates the companion->notch rename and still keys its
  // trigger off the old "companion" presentation; map today's "bar" onto it
  // rather than rewriting the (tested) hook.
  const callbackCard = useCallbackCard({
    presentation: hookPresentation === "bar" ? "companion" : hookPresentation,
    signedIn: user !== null,
    callLive,
    draftActive: showDraftCard,
  });

  // Slot priority (CLAUDE.md): draft > agenda > kebab menu > meeting note >
  // daily catch-up. Only draft, the inbox (opened via kebab/tray, so it sits
  // at the kebab-menu tier), and the daily catch-up are mounted today.
  const showInbox = user !== null && inboxOpen && !showDraftCard;
  const showCallbackCard =
    user !== null && callbackCard.visible && !showDraftCard && !showInbox;
  const slotHeight = showDraftCard
    ? DRAFT_CARD_HEIGHT
    : showInbox
      ? NOTIFICATION_INBOX_CARD_HEIGHT
      : showCallbackCard
        ? CALLBACK_CARD_HEIGHT
        : null;

  useEffect(() => {
    invoke("set_slot_height", { height: slotHeight }).catch((err) =>
      logError("OverlayRoot: set_slot_height", err),
    );
  }, [slotHeight]);

  // The subtitle used to be the only place notices surfaced. With it gone,
  // route the two that matter - an actionable voice error, or the voice shortcut
  // being unavailable - to a toast so a failure is never silent. De-duped so the
  // same message doesn't re-toast on every render.
  const lastNoticeRef = useRef<string | null>(null);
  const voiceError = voice.errorMessage;
  const shortcutReason =
    !notchGesture.checking && !notchGesture.available ? notchGesture.reason ?? null : null;
  useEffect(() => {
    const notice = voiceError ?? shortcutReason;
    if (!notice || notice === lastNoticeRef.current) return;
    lastNoticeRef.current = notice;
    invoke("show_actionable_toast", {
      notificationId: `overlay-notice-${Date.now()}`,
      action: null,
      title: "Aura",
      body: notice,
    }).catch((err) => logError("OverlayRoot: overlay notice toast", err));
  }, [voiceError, shortcutReason]);

  const unreadCount = notifications.unreadCount;
  useEffect(() => {
    invoke("set_tray_unread", { count: unreadCount }).catch((err) =>
      logError("OverlayRoot: set_tray_unread", err),
    );
  }, [unreadCount]);

  // Tray "Notifications" item: Rust summons the bar, then hands off here to
  // fill the below-bar slot with the inbox.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("open-notifications-requested", () => setInboxOpen(true))
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) =>
        logError("OverlayRoot: listen open-notifications-requested", err),
      );
    return () => unlisten?.();
  }, []);

  const resetCallbackCard = callbackCard.reset;
  useEffect(() => {
    if (!user) {
      resetDraftCard();
      resetCallbackCard();
      setInboxOpen(false);
      invoke("dismiss_bar").catch((err) =>
        logError("OverlayRoot: dismiss_bar after sign-out", err),
      );
    }
  }, [user, resetDraftCard, resetCallbackCard]);

  function handleNotificationAction(notification: StoredNotification) {
    notifications.acknowledgeAction(notification);
    if (notification.action === "view_meeting") {
      void openDashboard();
    } else if (
      notification.action === "retry_meeting_upload"
      && notification.resourceId
    ) {
      meetingCapture.retryNow(notification.resourceId);
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlaySnapshot>("overlay-changed", (event) => {
      setPresentation(event.payload.presentation);
      setNotchEdge(event.payload.notchEdge);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen overlay-changed", err));

    invoke<OverlaySnapshot>("current_overlay_state")
      .then((snapshot) => {
        setPresentation(snapshot.presentation);
        setNotchEdge(snapshot.notchEdge);
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

  const startSession = voice.startSession;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("start-voice-requested", async () => {
      if (!user || voice.desiredActive) return;
      try {
        await invoke("summon_bar");
        await startSession();
      } catch (err) {
        logError("OverlayRoot: start voice requested", err);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen start-voice-requested", err));
    return () => unlisten?.();
  }, [user, voice.desiredActive, startSession]);

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

  if (presentation === "movingnotch") {
    return <NotchMoveOverlay />;
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

  // Signed in, but still finishing first-run: the hotkey tour + live demo run
  // here (OnboardingFlow only mounts signed-out), in a panel-sized surface,
  // before the user lands in the dashboard.
  if (tail.status === "active") {
    return (
      <div className="overlay-column">
        <GlassSurface>
          <OnboardingTail voice={voice} onComplete={tail.complete} />
        </GlassSurface>
      </div>
    );
  }

  return (
    <div
      className={`notch-column notch-column-${notchEdge}${
        slotHeight !== null ? " notch-column-with-draft" : ""
      }`}
    >
      {showDraftCard && <DraftCard card={draftCard} />}
      {showInbox && (
        <NotificationInboxCard
          notifications={notifications}
          onClose={() => setInboxOpen(false)}
          onAction={handleNotificationAction}
        />
      )}
      {showCallbackCard && <CallbackCard card={callbackCard} />}
      <NotchBar
        key={presentation}
        voice={voice}
        edge={notchEdge}
        dragHandlers={notchMove.dragHandlers}
      />
    </div>
  );
}
