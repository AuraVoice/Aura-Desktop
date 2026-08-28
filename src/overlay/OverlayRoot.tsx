import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useTauriEvent } from "../lib/useTauriEvent";
import {
  CAPTURE_NOW_REQUESTED,
  CHAT_REQUESTED,
  CHAT_TOGGLE_REQUESTED,
  END_VOICE_SESSION,
  OPEN_INTERVIEW_HACKER_REQUESTED,
  OPEN_NOTIFICATIONS_REQUESTED,
  OVERLAY_CHANGED,
  START_VOICE_REQUESTED,
} from "../lib/ipcEvents";
import { useVoiceBar } from "./useVoiceBar";
import { useNotchGesture } from "./useNotchGesture";
import { useOnboardingTail } from "./useOnboardingTail";
import { useScreenSight } from "./useScreenSight";
import { useTurnScreenCapture } from "./useTurnScreenCapture";
import { useSystemControl } from "./useSystemControl";
import { useDraftCard } from "./useDraftCard";
import { useMeetings } from "./useMeetings";
import { useMeetingArm } from "./useMeetingArm";
import { useDictationCredential } from "./useDictationCredential";
import { usePolishCredential } from "./usePolishCredential";
import { useDictationUpload } from "./useDictationUpload";
import { useMeetingCapture } from "./useMeetingCapture";
import { useCallbackCard } from "./useCallbackCard";
import { useDesktopNotifications } from "../state/useDesktopNotifications";
import { openDashboardWindow } from "../lib/dashboardWindow";
import type { StoredNotification } from "../lib/desktopNotifications";
import { GlassSurface } from "./GlassSurface";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard, INITIAL_DRAFT_SLOT_HEIGHT } from "./DraftCard";
import { useInterviewMaterial } from "./interview/useInterviewMaterial";
import {
  isInterviewCaptureActive,
  useInterviewHacker,
} from "./interview/useInterviewHacker";
import {
  InterviewHackerCard,
  InterviewHackerControlBar,
  INTERVIEW_HACKER_SLOT_HEIGHT,
  INTERVIEW_HACKER_PITCH_SLOT_HEIGHT,
  INTERVIEW_HACKER_PREFLIGHT_SLOT_HEIGHT,
} from "./interview/InterviewHackerCard";
import {
  InterviewPasteCard,
  INITIAL_INTERVIEW_SLOT_HEIGHT,
} from "./interview/InterviewPasteCard";
import { CallbackCard } from "./CallbackCard";
import { NotificationInboxCard } from "./NotificationInboxCard";
import { NotchBar } from "./NotchBar";
import { NotchMoveOverlay } from "./NotchMoveOverlay";
import { useNotchMove } from "./useNotchMove";
import type { NotchEdge } from "./notchEdge";
import type { OverlayPresentation } from "./overlayPresentation";
import { screenPointFor, type ScreenFrameGeometry } from "../lib/screenFrame";
import { useGuideMode, type GuidePoint } from "./useGuideMode";
import { useGeneralSettings } from "../state/useGeneralSettings";
import { useEntitlement } from "../state/useEntitlement";
import { ChatSlot, INITIAL_CHAT_SLOT_HEIGHT } from "./ChatSlot";
import { useChatScreenCapture } from "./useChatScreenCapture";
import { useChatSession } from "./useChatSession";
import { useOutputMode } from "./useOutputMode";
import { useStatusPillEvents } from "./useStatusPillEvents";
import { useUpdateReady } from "./useUpdateReady";
import { UpdateBanner } from "../UpdateBanner";

// Fixed heights remain for fixed-content surfaces. DraftCard reports its own
// measured content height so a short reply stays compact and a long one grows.
// Each value must fit the surface's rendered CSS (Rust grows the window by
// exactly this many logical px via set_slot_height, and .glass-surface clips
// overflow): NotificationInboxCard.css, CallbackCard.css, UpdateBanner.css.
const NOTIFICATION_INBOX_CARD_HEIGHT = 300;
const CALLBACK_CARD_HEIGHT = 180;
const UPDATE_BANNER_HEIGHT = 112;
const UPDATED_NOTICE_HEIGHT = 72;

interface OverlaySnapshot {
  presentation: OverlayPresentation;
  notchEdge: NotchEdge;
}

export function OverlayRoot() {
  const { user } = useAuth();
  const generalSettings = useGeneralSettings();
  const updateReady = useUpdateReady();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const [notchEdge, setNotchEdge] = useState<NotchEdge>("top");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatFocusNonce, setChatFocusNonce] = useState(0);
  // Signed in is the whole gate. /chat needs a Firebase token, so a signed-out
  // composer could not send anything anyway. What keeps the cold lane safe is
  // the server-enforced surface allowlist that hard-excludes send_email and
  // every other write tool for surface="desktop", not anything decided here.
  const chatEnabled = user !== null;
  const voice = useVoiceBar();
  const interviewHacker = useInterviewHacker(user !== null);
  const showInterviewHacker = interviewHacker.phase !== "idle";
  const [interviewHackerHidden, setInterviewHackerHidden] = useState(false);
  const interviewHackerPhase = interviewHacker.phase;
  const dismissInterviewHacker = interviewHacker.dismiss;
  useEffect(() => {
    if (!showInterviewHacker) setInterviewHackerHidden(false);
  }, [showInterviewHacker]);
  useScreenSight(voice.room, voice.status);
  // Ctrl+Alt+M. Mounted here rather than inside useVoiceBar because the mode
  // outlives any one call: it persists, and it rides the next token.
  // desiredActive is the "the user wants a call" bit, which is what the
  // transient notch show must never hide out from under.
  const outputMode = useOutputMode({
    room: voice.room,
  });
  useStatusPillEvents();
  const visibleChatOpen = chatEnabled && chatOpen && !showInterviewHacker;
  const chatOpenRef = useRef(visibleChatOpen);
  chatOpenRef.current = visibleChatOpen;
  const screenCapture = useChatScreenCapture(visibleChatOpen);
  const chat = useChatSession({
    enabled: chatEnabled,
    uid: user?.uid ?? null,
    resolveAttachments: screenCapture.resolveForSend,
  });
  const previousVoiceActiveRef = useRef(false);

  // Ctrl+Alt+Space is registered only while signed in, so a signed-out machine
  // never opens a composer that could not send anything.
  useEffect(() => {
    setChatOpen(false);
    setChatHistoryOpen(false);
    invoke("set_chat_enabled", { enabled: user !== null }).catch((err) =>
      logError("OverlayRoot: set chat hotkey", err),
    );
  }, [user]);
  const handleGuidePoint = useCallback(
    async (geometry: ScreenFrameGeometry, point: GuidePoint) => {
      const target = screenPointFor(geometry, point.x, point.y);
      await invoke("point_at", {
        targetX: target.x,
        targetY: target.y,
        monitorX: target.monitorX,
        monitorY: target.monitorY,
        monitorW: target.monitorWidth,
        monitorH: target.monitorHeight,
        label: point.label,
      });
    },
    [],
  );
  const guide = useGuideMode({
    room: voice.room,
    status: voice.status,
    signedIn: user !== null,
    onPoint: handleGuidePoint,
  });
  // Per-turn screen context for voice, opt-in only. The hook treats a null room
  // as "do nothing", so the opt-out is the same disable path the hook already
  // uses, and it stays inert while Guide Mode is armed because Guide owns
  // continuous capture. Mounted after useGuideMode because it needs guide.armed.
  const turnCapture = useTurnScreenCapture(
    generalSettings.voiceScreenContext ? voice.room : null,
    guide.armed,
  );
  const guideVoiceEpochRef = useRef<number | null>(null);
  // Same rule as the notch gesture: a muted call never opens the audio-only
  // Realtime leg, so Guide's voice start goes straight to the cold path.
  const startGuideVoiceBridged = voice.startBridgedSession;
  const startGuideVoiceCold = voice.startSession;
  const startGuideVoice = outputMode.muted ? startGuideVoiceCold : startGuideVoiceBridged;
  useEffect(() => {
    if (!guide.armed) {
      guideVoiceEpochRef.current = null;
      return;
    }
    if (!user || guideVoiceEpochRef.current === guide.epoch) return;
    guideVoiceEpochRef.current = guide.epoch;
    if (voice.desiredActive) return;
    void startGuideVoice("guide").catch((error) => {
      logError("OverlayRoot: start Guide voice", error);
      void invoke("disarm_guide").catch((disarmError) =>
        logError("OverlayRoot: disarm after Guide voice failure", disarmError),
      );
    });
  }, [
    guide.armed,
    guide.epoch,
    startGuideVoice,
    user,
    voice.desiredActive,
  ]);
  // Long-press-to-move is only armed on the resting bar (never mid-card or
  // mid-onboarding); the notch itself is the drag handle.
  const notchMove = useNotchMove(presentation === "bar");
  const tail = useOnboardingTail(user?.uid ?? null);
  // Suppress the double-tap-Ctrl notch gesture while dashboard-owned first-run
  // onboarding is active. The native hotkey test consumes the gesture on its
  // own screen; every other onboarding step keeps the hidden overlay dormant.
  // Dismiss keys off actual overlay visibility, not one hardcoded presentation
  // or the voice-session state: any on-screen call/notch surface (bar, the
  // minimized-call pill which reports as "companion", or the drag-mode moving
  // notch) must close on the next double-tap. Keeping this a true boolean is what
  // stops a second tap from re-entering the summon branch and restarting a call
  // while a surface is up.
  const overlayVisible =
    presentation === "bar" || presentation === "companion" || presentation === "movingnotch";
  const notchGesture = useNotchGesture(
    user !== null,
    voice,
    presentation === "pointing" || tail.status === "active",
    overlayVisible && !visibleChatOpen,
  );
  // Kept for its cache side effects: it writes the fetched entitlement to the
  // native cache (cache_entitlement) and clears it on sign-out. Nothing in the
  // overlay renders it any more now that the kebab menu's plan row is gone.
  useEntitlement({
    signedIn: user !== null,
    uid: user?.uid ?? null,
  });
  // Desktop control: dispatches the agent's `desktop.run` messages to native
  // commands. Native side gates on a live voice session, so no extra guard here.
  useSystemControl(voice.room);
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
    uid: user?.uid ?? null,
    callLive,
    autoSummon: false,
  });
  // Drains the dictation trace sharing queue. Mounted here rather than in the
  // dashboard because the overlay is always running and the dashboard is not;
  // it idles on one cheap read per minute when there is nothing to send.
  useDictationUpload(user?.uid ?? null);
  // Keeps the dictation chord's transcription credential warm. Unrelated to
  // the trace queue above beyond sharing a uid: this one is required for
  // dictation to work at all, that one is an opt-in background courtesy.
  useDictationCredential(user?.uid ?? null);
  // Keeps the AI-formatting backend credential warm for the same reason. Rust
  // no-ops with it when the polish toggle is off.
  usePolishCredential(user?.uid ?? null);
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
  const [draftCardHeight, setDraftCardHeight] = useState(INITIAL_DRAFT_SLOT_HEIGHT);
  // Interview Mode's job-description paste box. Driven entirely by the voice
  // worker: it exists only while a live interview setup is asking for it, and
  // "sent" drops straight back to idle rather than lingering as a receipt.
  const interviewMaterial = useInterviewMaterial(voice.room);
  const resetInterviewMaterial = interviewMaterial.reset;
  const showInterviewPaste =
    user !== null
    && (interviewMaterial.phase === "open"
      || interviewMaterial.phase === "sending"
      || interviewMaterial.phase === "error");
  const [interviewSlotHeight, setInterviewSlotHeight] = useState(
    INITIAL_INTERVIEW_SLOT_HEIGHT,
  );

  useEffect(() => {
    if (!showInterviewPaste) setInterviewSlotHeight(INITIAL_INTERVIEW_SLOT_HEIGHT);
  }, [showInterviewPaste]);
  // Reported by ChatSlot from its measured transcript, same contract as the
  // draft card: the window is only ever as tall as what is actually rendered.
  const [chatSlotHeight, setChatSlotHeight] = useState(INITIAL_CHAT_SLOT_HEIGHT);

  useEffect(() => {
    if (!visibleChatOpen) {
      setChatHistoryOpen(false);
      setChatSlotHeight(INITIAL_CHAT_SLOT_HEIGHT);
    }
  }, [visibleChatOpen]);

  useEffect(() => {
    if (!showDraftCard) {
      setDraftCardHeight(INITIAL_DRAFT_SLOT_HEIGHT);
    }
  }, [showDraftCard]);

  const notifications = useDesktopNotifications({
    signedIn: user !== null,
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
  });
  const [inboxOpen, setInboxOpen] = useState(false);
  const callbackCard = useCallbackCard({
    presentation,
    signedIn: user !== null,
    callLive,
    draftActive: showDraftCard,
    enabled: generalSettings.dailyCatchUp,
  });

  // Slot priority (CLAUDE.md): active Interview Companion > chat > draft >
  // inbox > update > daily catch-up. The live companion must keep its capture
  // indicator and stop control visible; outside that explicit session, chat
  // keeps its existing priority because the user may be mid-sentence.
  // The interview paste box sits directly under chat and above everything else:
  // a live voice session has just told the user out loud to look at it, so a
  // draft or an update banner taking the slot would leave that line unanswered.
  // Chat still outranks it for the documented reason, and that degradation is
  // honest: the box never renders, so it is never acknowledged, and the worker's
  // own fallback asks for the role by voice instead.
  const showInbox =
    user !== null
    && inboxOpen
    && !showInterviewHacker
    && !showDraftCard
    && !showInterviewPaste;
  const showUpdateBanner =
    user !== null
    && (updateReady.version !== null || updateReady.updatedNotice !== null)
    && !showInterviewHacker
    && !showInterviewPaste
    && !showDraftCard
    && !showInbox;
  const showCallbackCard =
    user !== null
    && callbackCard.visible
    && !showInterviewHacker
    && !showInterviewPaste
    && !showDraftCard
    && !showInbox
    && !showUpdateBanner;
  // The opening pitch needs room the resting card does not have, so the slot
  // grows while it is expanded and returns when it auto-collapses.
  const interviewHackerHeight = interviewHacker.pitch !== null && interviewHacker.pitchExpanded
    ? INTERVIEW_HACKER_PITCH_SLOT_HEIGHT
    : interviewHacker.phase === "preflight" || interviewHacker.phase === "checking"
      ? INTERVIEW_HACKER_PREFLIGHT_SLOT_HEIGHT
      : INTERVIEW_HACKER_SLOT_HEIGHT;
  const slotHeight = showInterviewHacker
    ? interviewHackerHidden ? 0 : interviewHackerHeight
    : showInterviewPaste
      ? interviewSlotHeight
      : showDraftCard
        ? draftCardHeight
        : showInbox
          ? NOTIFICATION_INBOX_CARD_HEIGHT
          : showUpdateBanner
            ? updateReady.version !== null
              ? UPDATE_BANNER_HEIGHT
              : UPDATED_NOTICE_HEIGHT
            : showCallbackCard
              ? CALLBACK_CARD_HEIGHT
              : null;
  const appliedSlotHeight = visibleChatOpen ? chatSlotHeight : slotHeight;

  useEffect(() => {
    let cancelled = false;
    invoke("set_slot_height", { height: appliedSlotHeight, centered: showInterviewHacker })
      .then(() => {
        if (!cancelled && appliedSlotHeight === null) {
          return invoke("dismiss_idle_bar");
        }
      })
      .catch((err) => logError("OverlayRoot: set_slot_height", err));
    return () => {
      cancelled = true;
    };
  }, [appliedSlotHeight, showInterviewHacker]);

  // The subtitle used to be the only place notices surfaced. With it gone,
  // route the ones that matter - an actionable voice error, the voice shortcut
  // being unavailable, or a screen capture that could not be shared - to a toast
  // so a failure is never silent. De-duped so the same message doesn't re-toast
  // on every render.
  const lastNoticeRef = useRef<string | null>(null);
  const voiceError = voice.errorMessage;
  const captureNotice = turnCapture.notice;
  const shortcutReason =
    !notchGesture.checking && !notchGesture.available ? notchGesture.reason ?? null : null;
  useEffect(() => {
    const notice = voiceError ?? shortcutReason ?? captureNotice;
    if (!notice) {
      lastNoticeRef.current = null;
      return;
    }
    if (notice === lastNoticeRef.current) return;
    lastNoticeRef.current = notice;
    invoke("show_actionable_toast", {
      notificationId: `overlay-notice-${Date.now()}`,
      action: null,
      title: "Aura",
      body: notice,
    }).catch((err) => logError("OverlayRoot: overlay notice toast", err));
  }, [voiceError, shortcutReason, captureNotice]);

  const unreadCount = notifications.unreadCount;
  useEffect(() => {
    invoke("set_tray_unread", { count: unreadCount }).catch((err) =>
      logError("OverlayRoot: set_tray_unread", err),
    );
  }, [unreadCount]);

  // The separate dictation HUD is Aura's persistent resting pill. The larger
  // main waveform is only a live voice surface and must not remain after chat,
  // Interview Companion, or another temporary slot closes. Clear the retired
  // preference in native state as well so an existing enabled value cannot
  // keep the main bar visible during this process.
  useEffect(() => {
    invoke("set_always_show_bar", { enabled: false }).catch((err) =>
      logError("OverlayRoot: set_always_show_bar", err),
    );
  }, []);

  // Tray "Notifications" item: Rust summons the bar, then hands off here to
  // fill the below-bar slot with the inbox.
  useTauriEvent(
    OPEN_NOTIFICATIONS_REQUESTED,
    () => setInboxOpen(true),
    "OverlayRoot: listen open-notifications-requested",
  );

  // Tray entry point for the explicit preflight. It closes chat so the
  // microphone/call source labels cannot be hidden beneath the higher-priority
  // composer while the user is deciding whether to start capture.
  const openInterviewPreflight = interviewHacker.openPreflight;
  useTauriEvent(
    OPEN_INTERVIEW_HACKER_REQUESTED,
    () => {
      setChatOpen(false);
      setInboxOpen(false);
      openInterviewPreflight();
    },
    "OverlayRoot: listen open-interview-hacker-requested",
  );

  // Tray "Capture now" item. Same hand-off shape as the notifications item
  // above: the capture itself is a JS concern (useMeetingCapture owns the arm
  // state and the upload queue), so Rust only fires the intent.
  const captureNow = meetingCapture.captureNow;
  const stopMeetingCapture = meetingCapture.stopCapture;
  const isMeetingRecording = meetingCapture.recording;
  // No confirm step. window.confirm renders as a native WebView2 dialog
  // ("localhost:1420 says ...") anchored to the borderless notch window, where
  // it clips and blocks the webview. The tray item now reads "Stop recording"
  // while a capture is live, so the click is already deliberate.
  const handleCaptureAction = useCallback(() => {
    if (isMeetingRecording) {
      stopMeetingCapture();
      return;
    }
    captureNow();
  }, [captureNow, isMeetingRecording, stopMeetingCapture]);

  useTauriEvent(
    CAPTURE_NOW_REQUESTED,
    () => handleCaptureAction(),
    "OverlayRoot: listen capture-now-requested",
  );

  const dismissChatOverlay = useCallback(() => {
    chatOpenRef.current = false;
    setChatHistoryOpen(false);
    setChatOpen(false);
    invoke("dismiss_bar").catch((err) =>
      logError("OverlayRoot: dismiss chat overlay", err),
    );
  }, []);

  // The global shortcut is a true toggle. Native emits this without summoning
  // first, so closing never flashes the window or steals foreground focus.
  useTauriEvent(
    CHAT_TOGGLE_REQUESTED,
    () => {
      if (!chatEnabled) return;
      if (chatOpenRef.current) {
        dismissChatOverlay();
        return;
      }
      chatOpenRef.current = true;
      invoke("summon_chat").catch((err) => {
        chatOpenRef.current = false;
        logError("OverlayRoot: summon chat from hotkey", err);
      });
    },
    "OverlayRoot: listen chat-toggle-requested",
  );

  // summon_chat shows the Bar first, then this event opens the chat slot below
  // it; ChatSlot focuses its own composer on mount.
  useTauriEvent(
    CHAT_REQUESTED,
    () => {
      if (!chatEnabled) return;
      chatOpenRef.current = true;
      setChatOpen(true);
      setChatHistoryOpen(false);
      // Pressing the hotkey with the slot already open is a no-op for
      // setChatOpen, so the nonce is what tells ChatSlot to take the caret back
      // after the user clicked into another app.
      setChatFocusNonce((current) => current + 1);
    },
    "OverlayRoot: listen chat-requested",
  );

  const resetCallbackCard = callbackCard.reset;
  useEffect(() => {
    if (!user) {
      resetDraftCard();
      resetCallbackCard();
      // Signing out ends the call that armed the paste box, so a box left on
      // screen would collect a paste with nowhere to send it.
      resetInterviewMaterial();
      setChatOpen(false);
      setInboxOpen(false);
      if (guide.armed) guide.stop();
      invoke("dismiss_bar").catch((err) =>
        logError("OverlayRoot: dismiss_bar after sign-out", err),
      );
    }
  }, [
    user,
    resetDraftCard,
    resetCallbackCard,
    resetInterviewMaterial,
    guide.armed,
    guide.stop,
  ]);

  function handleNotificationAction(notification: StoredNotification) {
    notifications.acknowledgeAction(notification);
    if (notification.action === "view_meeting") {
      void openDashboardWindow("/meetings");
    } else if (
      notification.action === "retry_meeting_upload"
      && notification.resourceId
    ) {
      meetingCapture.retryNow(notification.resourceId);
    } else if (
      notification.action === "view_research"
      || notification.action === "answer_research_question"
    ) {
      void openDashboardWindow("/research", notification.resourceId);
    }
  }

  useTauriEvent<OverlaySnapshot>(
    OVERLAY_CHANGED,
    (payload) => {
      setPresentation(payload.presentation);
      setNotchEdge(payload.notchEdge);
      if (payload.presentation === "hidden") setChatOpen(false);
    },
    "OverlayRoot: listen overlay-changed",
  );

  useEffect(() => {
    invoke<OverlaySnapshot>("current_overlay_state")
      .then((snapshot) => {
        setPresentation(snapshot.presentation);
        setNotchEdge(snapshot.notchEdge);
      })
      .catch((err) => logError("OverlayRoot: current_overlay_state", err));
  }, []);

  const endSession = voice.endSession;
  useTauriEvent(
    END_VOICE_SESSION,
    () => {
      void endSession();
    },
    "OverlayRoot: listen end-voice-session",
  );

  const startSession = voice.startSession;
  useEffect(() => {
    const started = voice.desiredActive && !previousVoiceActiveRef.current;
    previousVoiceActiveRef.current = voice.desiredActive;
    if (started && visibleChatOpen && chat.messages.length > 0) {
      chat.noteVoiceSessionStarted();
    }
  }, [chat.messages.length, chat.noteVoiceSessionStarted, visibleChatOpen, voice.desiredActive]);

  useTauriEvent(
    START_VOICE_REQUESTED,
    async () => {
      if (!user || voice.desiredActive) return;
      try {
        await invoke("summon_bar");
        await startSession();
      } catch (err) {
        logError("OverlayRoot: start voice requested", err);
      }
    },
    "OverlayRoot: listen start-voice-requested",
  );

  useEffect(() => {
    if (!user) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (visibleChatOpen && chatHistoryOpen) {
        setChatHistoryOpen(false);
        return;
      }
      // Escape must never kill a live capture, but it stays the way out of the
      // preflight, the error state, and the reflection card - those suppress
      // chat and every other slot surface, so without this they are inescapable.
      if (showInterviewHacker) {
        if (!isInterviewCaptureActive(interviewHackerPhase)) {
          dismissInterviewHacker();
        }
        return;
      }
      setChatOpen(false);
      void endSession();
      invoke("dismiss_bar").catch((err) =>
        logError("OverlayRoot: dismiss_bar on Escape", err),
      );
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    user,
    endSession,
    visibleChatOpen,
    chatHistoryOpen,
    showInterviewHacker,
    interviewHackerPhase,
    dismissInterviewHacker,
  ]);

  // Active capture always keeps a visible native indicator and stop control.
  useEffect(() => {
    if (!showInterviewHacker || presentation !== "hidden") return;
    invoke("summon_bar").catch((err) =>
      logError("OverlayRoot: keep Interview Companion visible", err),
    );
  }, [presentation, showInterviewHacker]);

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

  return (
    <div
      className={`notch-column notch-column-${notchEdge}${
        appliedSlotHeight !== null ? " notch-column-with-draft" : ""
      }${showInterviewHacker ? " notch-column-interview" : ""
      }${showInterviewHacker && interviewHackerHidden ? " notch-column-interview-collapsed" : ""
      }`}
    >
      {visibleChatOpen && (
        <ChatSlot
          messages={chat.messages}
          focusNonce={chatFocusNonce}
          screen={screenCapture.state}
          onNewConversation={chat.newConversation}
          onClose={dismissChatOverlay}
          historyOpen={chatHistoryOpen}
          onHistoryOpenChange={setChatHistoryOpen}
          history={chat.history}
          hasOlderMessages={chat.hasOlderMessages}
          onLoadOlder={chat.loadOlderMessages}
          onSend={chat.send}
          onRetry={chat.retry}
          onClarification={chat.submitClarification}
          sending={chat.sending}
          limitReached={chat.limitReached}
          lane={chat.lane}
          onHeightChange={setChatSlotHeight}
        />
      )}
      {!visibleChatOpen && showInterviewHacker && !interviewHackerHidden && (
        <InterviewHackerCard hacker={interviewHacker} />
      )}
      {!visibleChatOpen && !showInterviewHacker && showInterviewPaste && (
        <InterviewPasteCard
          card={interviewMaterial}
          onHeightChange={setInterviewSlotHeight}
          visible={presentation === "bar" || presentation === "companion"}
        />
      )}
      {!visibleChatOpen
        && !showInterviewHacker
        && !showInterviewPaste
        && showDraftCard && (
          <DraftCard
            card={draftCard}
            onHeightChange={setDraftCardHeight}
            visible={presentation === "bar" || presentation === "companion"}
          />
        )}
      {!visibleChatOpen && showInbox && (
        <NotificationInboxCard
          notifications={notifications}
          onClose={() => setInboxOpen(false)}
          onAction={handleNotificationAction}
        />
      )}
      {!visibleChatOpen && showUpdateBanner && (
        <UpdateBanner
          version={updateReady.version}
          updatedVersion={updateReady.updatedNotice}
          surface="overlay"
        />
      )}
      {!visibleChatOpen && showCallbackCard && <CallbackCard card={callbackCard} />}
      {showInterviewHacker ? (
        <InterviewHackerControlBar
          expanded={!interviewHackerHidden}
          onToggle={() => setInterviewHackerHidden((hidden) => !hidden)}
          onStop={
            isInterviewCaptureActive(interviewHacker.phase) || interviewHacker.phase === "error"
              ? interviewHacker.stop
              : ["ended", "reflecting", "reflection"].includes(interviewHacker.phase)
                ? interviewHacker.dismissReflection
                : interviewHacker.dismiss
          }
        />
      ) : (
        <NotchBar
          key={presentation}
          voice={voice}
          edge={notchEdge}
          dragHandlers={notchMove.dragHandlers}
          guideArmed={guide.armed}
          guideActive={guide.active}
          outputMuted={outputMode.muted}
        />
      )}
    </div>
  );
}
