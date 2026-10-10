import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isOnline, subscribeOnline } from "../lib/connectivity";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { useTauriEvent } from "../lib/useTauriEvent";
import {
  CAPTURE_NOW_REQUESTED,
  CHAT_ATTACH_REQUESTED,
  CHAT_REQUESTED,
  CHAT_TOGGLE_REQUESTED,
  END_VOICE_SESSION,
  OPEN_NOTIFICATIONS_REQUESTED,
  OVERLAY_CHANGED,
  START_VOICE_REQUESTED,
  type ChatAttachRequest,
} from "../lib/ipcEvents";
import { useVoiceBar } from "./useVoiceBar";
import { useNotchGesture } from "./useNotchGesture";
import { useOnboardingTail } from "./useOnboardingTail";
import { useScreenSight } from "./useScreenSight";
import { useTurnScreenCapture } from "./useTurnScreenCapture";
import { useSystemControl } from "./useSystemControl";
import { useDraftCard } from "./useDraftCard";
import { useMeetings } from "./useMeetings";
import { useDictationCredential } from "./useDictationCredential";
import { usePolishCredential } from "./usePolishCredential";
import { useMeetingCapture } from "./useMeetingCapture";
import { useMeetingExpiryWarnings } from "./useMeetingExpiryWarnings";
import { useMeetingPrompt } from "./useMeetingPrompt";
import {
  MeetingPromptCard,
  MEETING_PROMPT_EXIT_MS,
  MEETING_PROMPT_HEIGHT,
} from "./MeetingPromptCard";
import { usePresence } from "./usePresence";
import { useCallbackCard } from "./useCallbackCard";
import { useDesktopNotifications } from "../state/useDesktopNotifications";
import { useSwarmMemorySync } from "../state/useSwarmMemorySync";
import { openDashboardWindow } from "../lib/dashboardWindow";
import type { StoredNotification } from "../lib/desktopNotifications";
import { GlassSurface } from "./GlassSurface";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard, INITIAL_DRAFT_SLOT_HEIGHT } from "./DraftCard";
import { ActionApprovalCard } from "./ActionApprovalCard";
import { usePendingActions } from "./usePendingActions";
import { PENDING_ACTION_TOOLS, type PendingActionTool } from "../lib/pendingActions";
import { useInterviewContext } from "./interview/useInterviewContext";
import {
  InterviewContextCard,
  INITIAL_INTERVIEW_CONTEXT_SLOT_HEIGHT,
} from "./interview/InterviewContextCard";
import { CallbackCard } from "./CallbackCard";
import { ScreenContextConsentCard } from "./ScreenContextConsentCard";
import { setVoiceScreenContext } from "../lib/generalSettings";
import { screenContextConsent } from "../lib/copy";
import { NotificationInboxCard } from "./NotificationInboxCard";
import { NotchBar } from "./NotchBar";
import { NotchMoveOverlay } from "./NotchMoveOverlay";
import { useNotchMove } from "./useNotchMove";
import type { NotchEdge } from "./notchEdge";
import type { OverlayPresentation } from "./overlayPresentation";
import { screenPointFor, type ScreenFrameGeometry } from "../lib/screenFrame";
import { useGuideMode, type GuidePoint } from "./useGuideMode";
import { useGeneralSettings } from "../state/useGeneralSettings";
import { dictationSharingActive } from "../lib/generalSettings";
import { useDictationUpload } from "./useDictationUpload";
import { ChatSlot, INITIAL_CHAT_SLOT_HEIGHT } from "./ChatSlot";
import { clearChatDraft } from "./chatDraft";
import { useChatScreenCapture } from "./useChatScreenCapture";
import { useChatSession } from "./useChatSession";
import { useOutputMode } from "./useOutputMode";
import { useStatusPillEvents } from "./useStatusPillEvents";
import { useUpdateReady } from "./useUpdateReady";
import { UpdateBanner } from "../UpdateBanner";
import {
  microphoneSettingsLabel,
  openMicrophoneSettings,
  resetMicrophonePermission,
} from "../lib/microphoneAccess";
import { VoiceRecoveryCard, VOICE_RECOVERY_CARD_HEIGHT } from "./VoiceRecoveryCard";
import { BrowserTaskCard, browserTaskSlotHeight } from "./BrowserTaskCard";
import { useBrowserTask } from "./useBrowserTask";
import { useRegionCapture } from "./region/useRegionCapture";
import { RegionPreviewCard, REGION_PREVIEW_CARD_HEIGHT } from "./region/RegionPreviewCard";

// Fixed heights remain for fixed-content surfaces. DraftCard reports its own
// measured content height so a short reply stays compact and a long one grows.
// Each value must fit the surface's rendered CSS (Rust grows the window by
// exactly this many logical px via set_slot_height, and .glass-surface clips
// overflow): NotificationInboxCard.css, CallbackCard.css, UpdateBanner.css.
const NOTIFICATION_INBOX_CARD_HEIGHT = 300;
const CALLBACK_CARD_HEIGHT = 180;
const SCREEN_CONTEXT_CONSENT_HEIGHT = 132;
const UPDATE_BANNER_HEIGHT = 112;
const UPDATED_NOTICE_HEIGHT = 72;

interface OverlaySnapshot {
  presentation: OverlayPresentation;
  notchEdge: NotchEdge;
  /** The Bar has lent its edge to the dictation HUD and is not drawn. */
  dictationHold: boolean;
}

export function OverlayRoot() {
  const { user, initializing } = useAuth();
  const generalSettings = useGeneralSettings();
  const updateReady = useUpdateReady();
  const [presentation, setPresentation] = useState<OverlayPresentation>("hidden");
  const [notchEdge, setNotchEdge] = useState<NotchEdge>("top");
  const [dictationHold, setDictationHold] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // A draft never crosses a sign-out.
  useEffect(() => {
    if (user === null) clearChatDraft();
  }, [user]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatFocusNonce, setChatFocusNonce] = useState(0);
  // A file another window asked the composer to attach (the dashboard's "Ask
  // Aura" on a meeting). Held here because ChatSlot only exists while chat is
  // open, and the request can land just before summon_chat opens it.
  const [chatSeed, setChatSeed] = useState<(ChatAttachRequest & { nonce: number }) | null>(null);
  // Signed in is the whole gate. /chat needs a Firebase token, so a signed-out
  // composer could not send anything anyway. What keeps the cold lane safe is
  // the server-enforced surface allowlist that hard-excludes send_email and
  // every other write tool for surface="desktop", not anything decided here.
  const chatEnabled = user !== null;
  const voice = useVoiceBar();
  const [voiceStartupSlow, setVoiceStartupSlow] = useState(false);
  useScreenSight(voice.room, voice.status);
  // Ctrl+Alt+M. Mounted here rather than inside useVoiceBar because the mode
  // outlives any one call: it persists, and it rides the next token.
  // desiredActive is the "the user wants a call" bit, which is what the
  // transient notch show must never hide out from under.
  const outputMode = useOutputMode({
    room: voice.room,
  });
  const startVoice = useCallback(async () => {
    if (outputMode.muted) {
      await voice.startSession();
    } else {
      await voice.startBridgedSession();
    }
  }, [outputMode.muted, voice.startBridgedSession, voice.startSession]);
  useEffect(() => {
    if (!voice.desiredActive) {
      setVoiceStartupSlow(false);
      return;
    }
    const timeoutId = setTimeout(() => setVoiceStartupSlow(true), 5_000);
    return () => clearTimeout(timeoutId);
  }, [voice.desiredActive]);
  useEffect(() => {
    if (voice.status !== "connecting" && voice.status !== "ready") {
      setVoiceStartupSlow(false);
    }
  }, [voice.status]);
  useStatusPillEvents();
  const visibleChatOpen = chatEnabled && chatOpen;
  const chatOpenRef = useRef(visibleChatOpen);
  chatOpenRef.current = visibleChatOpen;
  const screenCapture = useChatScreenCapture(visibleChatOpen, generalSettings.chatScreenshots);
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
  // Per-turn screen context for voice, opt-in only. The room is passed even
  // with the setting off so a skipped capture can report WHY to the worker
  // (screen_context.unavailable) and so the agent's enable request and
  // notion.saved captions still land; the hook gates the capture itself on
  // the setting and stays inert while Guide Mode owns continuous capture.
  const voiceScreenContextEnabled = generalSettings.voiceScreenContext;
  const [screenContextRequested, setScreenContextRequested] = useState(false);
  const handleScreenContextRequest = useCallback(() => {
    setScreenContextRequested(true);
  }, []);
  const turnCapture = useTurnScreenCapture(
    voice.room,
    guide.armed,
    voiceScreenContextEnabled,
    handleScreenContextRequest,
  );
  // Mirror the privacy setting into Rust's authorization state on load and on
  // every change, so capture_turn_screen_with_geometry is denied at the
  // decision point (security.rs) too, not only by this hook's gate.
  useEffect(() => {
    invoke("set_voice_screen_context", { enabled: voiceScreenContextEnabled }).catch(
      (err) => logError("OverlayRoot: set_voice_screen_context", err),
    );
  }, [voiceScreenContextEnabled]);
  // The consent card is moot once the setting is on, and stale once the call
  // that asked for it is gone.
  useEffect(() => {
    if (voiceScreenContextEnabled || voice.room === null) {
      setScreenContextRequested(false);
    }
  }, [voiceScreenContextEnabled, voice.room]);
  const allowScreenContext = useCallback(() => {
    setScreenContextRequested(false);
    setVoiceScreenContext(true)
      .then(() =>
        invoke("show_actionable_toast", {
          notificationId: "screen-context-enabled",
          action: null,
          title: "Aura",
          body: screenContextConsent.enabledNotice,
          silent: !generalSettings.dictationSounds,
        }),
      )
      .catch((err) => logError("OverlayRoot: enable voice screen context", err));
  }, [generalSettings.dictationSounds]);
  const dismissScreenContextRequest = useCallback(() => {
    setScreenContextRequested(false);
  }, []);
  const guideVoiceEpochRef = useRef<number | null>(null);
  // Guide always starts on the cold LiveKit path, never through the Realtime
  // bridge. The bridge exists to speak first on a chat summon; a watch session
  // must open silent, with the first word coming only when Buddy has a reason,
  // and the bridge has no Guide instructions to give anyway.
  const startGuideVoice = voice.startSession;
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
  // Desktop control: dispatches the agent's `desktop.run` messages to native
  // commands. Native side gates on a live voice session, so no extra guard here.
  useSystemControl(voice.room);
  const draftCard = useDraftCard(voice.room, presentation);
  // Approval cards for connector writes. Voice announces one over the data
  // channel; a chat turn that ran an approval tool is noticed here from its
  // finished activity row; a draft's Post button proposes one directly.
  const pendingActions = usePendingActions(voice.room, user?.uid ?? null);
  const finishedApprovalToolKey = chat.messages
    .filter((message) =>
      message.kind === "activity"
      && message.running === false
      && message.tool !== undefined
      && PENDING_ACTION_TOOLS.has(message.tool))
    .map((message) => message.id)
    .join("|");
  const refreshPendingActions = pendingActions.refresh;
  useEffect(() => {
    if (finishedApprovalToolKey) refreshPendingActions();
  }, [finishedApprovalToolKey, refreshPendingActions]);
  const proposePendingAction = pendingActions.propose;
  const postDraft = useCallback((tool: PendingActionTool, text: string) => {
    void proposePendingAction(tool, { text })
      .then((result) => {
        if (result.kind === "proposed") return;
        if (result.kind === "notConnected") {
          openDashboardWindow("/connectors");
          return;
        }
        return invoke("show_actionable_toast", {
          notificationId: `post-draft-${Date.now()}`,
          action: null,
          title: "Aura",
          body: result.kind === "invalid" && result.reason === "text_too_long"
            ? "That draft is too long to post. Ask Buddy to shorten it."
            : "Aura couldn't set up that post. Try again in a moment.",
          silent: true,
        });
      })
      .catch((err) => logError("OverlayRoot: post draft", err));
  }, [proposePendingAction]);
  const callLive =
    voice.status !== "disconnected" && voice.status !== "ended" && voice.status !== "error";
  // Meeting capture is a background service. Keep calendar polling, durable
  // upload recovery, and completion alive even while the native window is
  // hidden. Its one piece of notch UI is the "Record this meeting?" card
  // below (useMeetingPrompt); the old meeting controls stay absent.
  const meetings = useMeetings({
    presentation,
    signedIn: user !== null,
    uid: user?.uid ?? null,
    callLive,
    autoSummon: false,
  });
  // Keeps the dictation chord's transcription credential warm: required for
  // dictation to work at all.
  useDictationCredential(user?.uid ?? null);
  // Rust learns the webview's network state once and on every change, so a
  // hold while offline fails with "offline" instead of a socket timeout.
  useEffect(() => {
    const report = (online: boolean) => {
      invoke("dictation_set_online", { online }).catch((err) =>
        logError("OverlayRoot: report online state", err),
      );
    };
    report(isOnline());
    return subscribeOnline(report);
  }, []);
  // Keeps the AI-formatting backend credential warm for the same reason. Rust
  // no-ops with it when the polish toggle is off.
  usePolishCredential(user?.uid ?? null);
  // The one live browser task (agent_browser): chip, approval question, result.
  const browserTask = useBrowserTask({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
    room: voice.room,
  });
  // The one live desktop task (agent_operator), on the same card. Only one of
  // the two is drawn at a time; the desktop task wins while it has anything to
  // show, because its Stop is the only way to take the cursor back.
  const desktopTask = useBrowserTask({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
    room: null,
    kind: "desktop",
  });
  const agentTask =
    desktopTask.live || desktopTask.approval !== null || desktopTask.checkin !== null || desktopTask.result !== null
      ? desktopTask
      : browserTask;
  // The result card reports its measured height; null until it has, and
  // again whenever a different result arrives, so the constant guess never
  // outlives the content it guessed for.
  const [browserTaskMeasured, setBrowserTaskMeasured] = useState<number | null>(null);
  useEffect(() => {
    setBrowserTaskMeasured(null);
  }, [agentTask.result]);
  const meetingCapture = useMeetingCapture({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
  });
  useMeetingExpiryWarnings({
    uid: user?.uid ?? null,
    appHidden: presentation !== "bar",
  });
  // Daily drain of the dictation sharing queue. Mounted here rather than in
  // the dashboard because the overlay is the window that is always alive;
  // the dashboard is built on demand and would only upload while open.
  // dictationSharingActive is the only thing that may decide this: the two
  // toggles mean nothing without the consent version they were recorded under.
  // Busy holds uploads off the network while a call or a meeting recording is
  // live, since a catch-up drain can now run in the daytime.
  useDictationUpload(
    user?.uid ?? null,
    dictationSharingActive(generalSettings),
    callLive || meetingCapture.recording,
  );
  // Circle to ask: holds the crop from the region gesture for the preview chip.
  const regionCapture = useRegionCapture(user !== null);
  const resetDraftCard = draftCard.reset;
  const showDraftCard = user !== null && draftCard.phase !== "idle";
  const [draftCardHeight, setDraftCardHeight] = useState(INITIAL_DRAFT_SLOT_HEIGHT);
  // Interview Mode's context card (job description, resume, notes). Driven
  // entirely by the voice worker: it exists only while a live interview setup is
  // asking for it, and "sent" drops straight back to idle rather than lingering
  // as a receipt.
  const interviewContext = useInterviewContext(voice.room);
  const resetInterviewContext = interviewContext.reset;
  const showInterviewContext =
    user !== null
    && (interviewContext.phase === "open"
      || interviewContext.phase === "sending"
      || interviewContext.phase === "error");
  const [interviewSlotHeight, setInterviewSlotHeight] = useState(
    INITIAL_INTERVIEW_CONTEXT_SLOT_HEIGHT,
  );

  useEffect(() => {
    if (!showInterviewContext) setInterviewSlotHeight(INITIAL_INTERVIEW_CONTEXT_SLOT_HEIGHT);
  }, [showInterviewContext]);
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
    busy: callLive || meetingCapture.recording,
  });
  const [inboxOpen, setInboxOpen] = useState(false);
  // Swarm memory lives on this computer; a report notice is the cue to pull what the
  // session learned, so it lands even when the Swarm page is not open.
  useSwarmMemorySync({ signedIn: user !== null, uid: user?.uid ?? null, inbox: notifications.inbox });
  const callbackCard = useCallbackCard({
    presentation,
    signedIn: user !== null,
    callLive,
    draftActive: showDraftCard,
    enabled: generalSettings.dailyCatchUp,
  });
  const voiceNoticeMessage = voice.errorMessage
    ?? (voiceStartupSlow ? "Buddy is taking longer than expected to connect." : null);
  const showVoiceNotice =
    user !== null
    && voiceNoticeMessage !== null
    && !showInterviewContext;
  // An approval card outranks chat and every card below it: the user just asked
  // for this post, and it expires if it waits behind anything. It never covers
  // the job-description box a live Interview Mode session asked for.
  const showApprovalCard =
    user !== null
    && pendingActions.current !== null
    && !showInterviewContext;
  const [approvalCardHeight, setApprovalCardHeight] = useState(INITIAL_DRAFT_SLOT_HEIGHT);
  const lowerCardsHidden = visibleChatOpen || showApprovalCard;
  // The browser task sits under the draft and above the meeting prompt: its
  // approval question expires in 60 s and its running chip is the only Stop
  // control, so neither may queue behind the inbox or a banner.
  const showBrowserTask =
    user !== null
    && (agentTask.live || agentTask.approval !== null || agentTask.result !== null)
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard;

  // Slot priority (CLAUDE.md): chat > voice recovery > draft > inbox > update >
  // daily catch-up. Chat keeps its priority because the user may be mid-sentence.
  // The interview paste box sits directly under chat and above everything else:
  // a live voice session has just told the user out loud to look at it, so a
  // draft or an update banner taking the slot would leave that line unanswered.
  // Chat still outranks it for the documented reason, and that degradation is
  // honest: the box never renders, so it is never acknowledged, and the worker's
  // own fallback asks for the role by voice instead.
  // The "Record this meeting?" card sits under the interview surfaces and the
  // draft: it is a 15 s question, so it must not queue behind the inbox or a
  // banner, and a draft only exists during a voice call, where the prompt is
  // suppressed anyway. The hook already hides itself for a live call, an active
  // capture, or a non-notch presentation.
  const meetingPrompt = useMeetingPrompt({
    uid: user?.uid ?? null,
    ownsRuntime: meetingCapture.ownsRuntime,
    recording: meetingCapture.recording,
    events: meetings.events,
    presentation,
    dictationHold,
    callLive,
    chatOpen: visibleChatOpen,
    recordCall: meetingCapture.recordCall,
  });
  const showMeetingPrompt =
    user !== null
    && meetingPrompt.visible
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard
    && !showBrowserTask;
  // Held on screen (and in the slot) through its exit animation, unless a
  // higher-priority card took the slot, which must not share it.
  const meetingPromptPresence = usePresence(showMeetingPrompt, MEETING_PROMPT_EXIT_MS);
  const meetingPromptOnScreen =
    showMeetingPrompt
    || (meetingPromptPresence.leaving
      && !showInterviewContext
      && !showVoiceNotice
      && !showDraftCard
      && !showBrowserTask);
  // The consent card sits directly under the meeting prompt: the user just
  // told Buddy "yes, turn it on" out loud, so it must not queue behind the
  // inbox or a banner while that sentence is still hanging.
  const showScreenContextConsent =
    user !== null
    && screenContextRequested
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard
    && !showBrowserTask
    && !meetingPromptOnScreen;
  // What the user just circled with the region gesture. Under the live-session
  // surfaces above, which only exist mid-call where the gesture is a no-op, and
  // above the inbox, update banner and catch-up, which would otherwise sit on
  // the answer to something the user did a second ago.
  const showRegionPreview =
    user !== null
    && regionCapture.preview !== null
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard
    && !showBrowserTask
    && !meetingPromptOnScreen
    && !showScreenContextConsent;
  const showInbox =
    user !== null
    && inboxOpen
    && !showVoiceNotice
    && !showDraftCard
    && !showInterviewContext
    && !showBrowserTask
    && !meetingPromptOnScreen
    && !showScreenContextConsent
    && !showRegionPreview;
  const showUpdateBanner =
    user !== null
    && (updateReady.version !== null || updateReady.updatedNotice !== null)
    && !callLive
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard
    && !showBrowserTask
    && !meetingPromptOnScreen
    && !showScreenContextConsent
    && !showRegionPreview
    && !showInbox;
  const showCallbackCard =
    user !== null
    && callbackCard.visible
    && !showInterviewContext
    && !showVoiceNotice
    && !showDraftCard
    && !showBrowserTask
    && !meetingPromptOnScreen
    && !showScreenContextConsent
    && !showRegionPreview
    && !showInbox
    && !showUpdateBanner;
  const slotHeight = showInterviewContext
      ? interviewSlotHeight
      : showApprovalCard
        ? approvalCardHeight
      : showVoiceNotice
        ? VOICE_RECOVERY_CARD_HEIGHT
        : showDraftCard
          ? draftCardHeight
          : showBrowserTask
            ? (browserTaskMeasured ?? browserTaskSlotHeight(agentTask))
          : meetingPromptOnScreen
            ? MEETING_PROMPT_HEIGHT
            : showScreenContextConsent
              ? SCREEN_CONTEXT_CONSENT_HEIGHT
              : showRegionPreview
                ? REGION_PREVIEW_CARD_HEIGHT
                : showInbox
                  ? NOTIFICATION_INBOX_CARD_HEIGHT
                  : showUpdateBanner
                    ? updateReady.version !== null
                      ? UPDATE_BANNER_HEIGHT
                      : UPDATED_NOTICE_HEIGHT
                    : showCallbackCard
                      ? CALLBACK_CARD_HEIGHT
                      : null;
  // A voice notice or a meeting prompt takes the slot away from an open chat the
  // same way the approval card does. Both are fixed-height cards drawn with
  // height: 100%, so leaving the slot at the chat's height stretched a one-line
  // "Buddy hit a snag" into a 400px block with the message floating in the
  // middle of empty space (2026-10-03). The chat is unmounted while the notice
  // is up, which is what the approval card already does, and comes back at its
  // own measured height when the notice goes.
  const noticeOverChat = showVoiceNotice || meetingPromptOnScreen;
  const appliedSlotHeight = showApprovalCard
    ? approvalCardHeight
    : visibleChatOpen && !noticeOverChat ? chatSlotHeight : slotHeight;

  useEffect(() => {
    let cancelled = false;
    invoke("set_slot_height", { height: appliedSlotHeight })
      .then(() => {
        if (!cancelled && appliedSlotHeight === null) {
          return invoke("dismiss_idle_bar");
        }
      })
      .catch((err) => logError("OverlayRoot: set_slot_height", err));
    return () => {
      cancelled = true;
    };
  }, [appliedSlotHeight]);

  // The subtitle used to be the only place notices surfaced. With it gone,
  // route the ones that matter - an actionable voice error, the voice shortcut
  // being unavailable, or a screen capture that could not be shared - to a toast
  // so a failure is never silent. De-duped so the same message doesn't re-toast
  // on every render.
  // De-duped with a cooldown, not only per render: the old Date.now() id
  // bypassed the broker's dedup entirely, so a capture failing on every
  // spoken turn re-toasted every few seconds for the whole call.
  const NOTICE_RETOAST_COOLDOWN_MS = 5 * 60 * 1000;
  const lastNoticeRef = useRef<{ text: string; at: number } | null>(null);
  const voiceError = voice.errorMessage;
  const captureNotice = turnCapture.notice;
  const shortcutReason =
    !notchGesture.checking && !notchGesture.available ? notchGesture.reason ?? null : null;
  useEffect(() => {
    const notice = voiceError ?? shortcutReason ?? captureNotice;
    if (!notice) return;
    const last = lastNoticeRef.current;
    const now = Date.now();
    if (last && last.text === notice && now - last.at < NOTICE_RETOAST_COOLDOWN_MS) {
      return;
    }
    lastNoticeRef.current = { text: notice, at: now };
    invoke("show_actionable_toast", {
      notificationId: `overlay-notice-${now}`,
      action: null,
      title: "Aura",
      body: notice,
      silent: !generalSettings.dictationSounds,
    }).catch((err) => logError("OverlayRoot: overlay notice toast", err));
  }, [voiceError, shortcutReason, captureNotice, NOTICE_RETOAST_COOLDOWN_MS, generalSettings.dictationSounds]);

  const unreadCount = notifications.unreadCount;
  useEffect(() => {
    invoke("set_tray_unread", { count: unreadCount }).catch((err) =>
      logError("OverlayRoot: set_tray_unread", err),
    );
  }, [unreadCount]);

  // The separate dictation HUD is Aura's persistent resting pill. The larger
  // main waveform is only a live voice surface and must not remain after chat
  // or another temporary slot closes. Clear the retired
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

  useTauriEvent<ChatAttachRequest>(
    CHAT_ATTACH_REQUESTED,
    (request) => {
      if (!chatEnabled || !request?.text) return;
      setChatSeed({ ...request, nonce: Date.now() });
    },
    "OverlayRoot: listen chat-attach-requested",
  );

  const resetCallbackCard = callbackCard.reset;
  useEffect(() => {
    if (!user) {
      resetDraftCard();
      resetCallbackCard();
      // Signing out ends the call that armed the context card, so a card left on
      // screen would collect text with nowhere to send it.
      resetInterviewContext();
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
    resetInterviewContext,
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
      void openDashboardWindow("/agents", notification.resourceId, "research");
    } else if (notification.action === "view_browser_task") {
      void openDashboardWindow("/agents", notification.resourceId, "computer");
    } else if (notification.action === "view_desktop_task") {
      // Desktop tasks start from a Swarm Start card in #group, which shows the result.
      void openDashboardWindow("/agents", "group", "swarm");
    } else if (notification.action === "view_swarm_channel") {
      void openDashboardWindow("/agents", notification.resourceId, "swarm");
    }
  }

  useTauriEvent<OverlaySnapshot>(
    OVERLAY_CHANGED,
    (payload) => {
      setPresentation(payload.presentation);
      setNotchEdge(payload.notchEdge);
      setDictationHold(payload.dictationHold === true);
      if (payload.presentation === "hidden") setChatOpen(false);
    },
    "OverlayRoot: listen overlay-changed",
  );

  useEffect(() => {
    invoke<OverlaySnapshot>("current_overlay_state")
      .then((snapshot) => {
        setPresentation(snapshot.presentation);
        setNotchEdge(snapshot.notchEdge);
        setDictationHold(snapshot.dictationHold === true);
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
        await startVoice();
      } catch (err) {
        logError("OverlayRoot: start voice requested", err);
      }
    },
    "OverlayRoot: listen start-voice-requested",
  );

  const allowMicrophoneAndRetry = useCallback(async () => {
    try {
      await resetMicrophonePermission();
      await startVoice();
    } catch (err) {
      logError("OverlayRoot: reset microphone permission", err);
      await openMicrophoneSettings().catch((settingsErr) =>
        logError("OverlayRoot: open microphone settings after reset failure", settingsErr),
      );
    }
  }, [startVoice]);

  const openSystemMicrophoneSettings = useCallback(async () => {
    await openMicrophoneSettings().catch((err) =>
      logError("OverlayRoot: open microphone settings", err),
    );
  }, []);

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
  ]);

  // A click on the overlay borrows the foreground from the app the user was
  // working in (WebView2 needs it to deliver the click at all); this gives it
  // back once the click is handled, so their caret and typing resume. Rust
  // owns the hand-back (win_focus::yield_focus, a no-op on macOS where the
  // panel never took focus). Kept for anything the user types into or steers
  // with keys: text fields, open menus and dialogs, and the Interview Mode
  // context card. The Panel is excluded in Rust as well.
  useEffect(() => {
    if (!user || presentation === "panel") return;
    const KEEPS_FOCUS =
      '.interview-context-card, [role="menu"], [role="dialog"], [role="listbox"]';
    const CLICK_ONLY_INPUTS = ["button", "submit", "reset", "checkbox", "radio", "file", "range"];
    const isEditable = (el: Element | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !CLICK_ONLY_INPUTS.includes(el.type)));
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(KEEPS_FOCUS)) return;
      // The click's own handlers run after this capture listener; let them
      // settle (a menu opening, the composer refocusing) before deciding.
      requestAnimationFrame(() => {
        if (isEditable(document.activeElement)) return;
        if (document.querySelector('[role="menu"], [role="dialog"]')) return;
        // A drag that selected text is the user about to press Ctrl+C. Handing
        // the foreground back now sends that keystroke to their other app, so
        // the copy silently never happens. The next click collapses the
        // selection and yields as usual.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString().trim()) return;
        invoke("overlay_yield_focus").catch((err) =>
          logError("OverlayRoot: give focus back", err),
        );
      });
    };
    document.addEventListener("pointerup", onPointerUp, true);
    return () => document.removeEventListener("pointerup", onPointerUp, true);
  }, [user, presentation]);

  if (presentation === "pointing") {
    return <PointingOverlay />;
  }

  if (presentation === "movingnotch") {
    return <NotchMoveOverlay />;
  }

  if (!user) {
    // Until the persisted session is read, null is "unknown", not "signed out":
    // drawing the sign-in panel here flashed it on every launch.
    if (initializing) return null;
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
      }`}
    >
      {showApprovalCard && (
        <ActionApprovalCard actions={pendingActions} onHeightChange={setApprovalCardHeight} />
      )}
      {visibleChatOpen && !showApprovalCard && !noticeOverChat && (
        <ChatSlot
          messages={chat.messages}
          focusNonce={chatFocusNonce}
          seedAttachment={chatSeed}
          onSeedAttached={() => setChatSeed(null)}
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
          activeTurnId={chat.activeTurnId}
          limitReached={chat.limitReached}
          lane={chat.lane}
          companionAvatar={generalSettings.showCompanionAvatar ? generalSettings.companionAvatar : null}
          onHeightChange={setChatSlotHeight}
        />
      )}
      {!lowerCardsHidden && showInterviewContext && (
        <InterviewContextCard
          card={interviewContext}
          onHeightChange={setInterviewSlotHeight}
          visible={presentation === "bar" || presentation === "companion"}
        />
      )}
      {!lowerCardsHidden &&showVoiceNotice && (
        <VoiceRecoveryCard
          variant={
            voice.showMicSettingsHint ? "mic" : voice.errorMessage ? "error" : "connecting"
          }
          title={
            voice.showMicSettingsHint
              ? "Microphone access needed"
              : voice.errorMessage
                ? "Buddy couldn't start"
                : "Still connecting"
          }
          message={voiceNoticeMessage ?? ""}
          primaryLabel={
            voice.showMicSettingsHint
              ? "Allow microphone"
              : voice.isVoiceCapped
                ? "View plans"
                : voice.errorMessage
                  ? "Retry"
                  : undefined
          }
          secondaryLabel={voice.showMicSettingsHint ? microphoneSettingsLabel() : undefined}
          onPrimary={
            voice.showMicSettingsHint
              ? allowMicrophoneAndRetry
              : voice.isVoiceCapped
                ? () => openDashboardWindow("/billing")
                : voice.errorMessage
                  ? startVoice
                  : undefined
          }
          onSecondary={voice.showMicSettingsHint ? openSystemMicrophoneSettings : undefined}
          onClose={voice.endSession}
        />
      )}
      {!lowerCardsHidden
        && !showInterviewContext
        && !showVoiceNotice
        && showDraftCard && (
          <DraftCard
            card={draftCard}
            onHeightChange={setDraftCardHeight}
            visible={presentation === "bar" || presentation === "companion"}
            onPost={postDraft}
          />
        )}
      {!lowerCardsHidden && showBrowserTask && <BrowserTaskCard task={agentTask} onHeightChange={setBrowserTaskMeasured} />}
      {!lowerCardsHidden &&meetingPromptOnScreen && (
        <MeetingPromptCard prompt={meetingPrompt} leaving={meetingPromptPresence.leaving} />
      )}
      {!lowerCardsHidden &&showScreenContextConsent && (
        <ScreenContextConsentCard
          onAllow={allowScreenContext}
          onDismiss={dismissScreenContextRequest}
        />
      )}
      {!lowerCardsHidden &&showRegionPreview && regionCapture.preview && (
        <RegionPreviewCard preview={regionCapture.preview} onDismiss={regionCapture.dismiss} />
      )}
      {!lowerCardsHidden &&showInbox && (
        <NotificationInboxCard
          notifications={notifications}
          onClose={() => setInboxOpen(false)}
          onAction={handleNotificationAction}
        />
      )}
      {!lowerCardsHidden &&showUpdateBanner && (
        <UpdateBanner
          version={updateReady.version}
          updatedVersion={updateReady.updatedNotice}
          surface="overlay"
        />
      )}
      {!lowerCardsHidden &&showCallbackCard && <CallbackCard card={callbackCard} />}
      <NotchBar
        key={presentation}
        voice={voice}
        edge={notchEdge}
        dragHandlers={notchMove.dragHandlers}
        guideArmed={guide.armed}
        guideActive={guide.active}
        outputMuted={outputMode.muted}
      />
    </div>
  );
}
