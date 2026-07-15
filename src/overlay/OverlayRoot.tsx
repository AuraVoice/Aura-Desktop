import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "../state/AuthProvider";
import { logError } from "../lib/log";
import { openDashboard } from "../lib/dashboardLink";
import { useEscHotkey } from "./useEscHotkey";
import { useVoiceBar } from "./useVoiceBar";
import { useScreenSight } from "./useScreenSight";
import { useDraftCard } from "./useDraftCard";
import { useCallbackCard } from "./useCallbackCard";
import { useMeetings } from "./useMeetings";
import { isEligibleForNotes, useMeetingArm } from "./useMeetingArm";
import { useMeetingCapture } from "./useMeetingCapture";
import { useMeetingNotes } from "./useMeetingNotes";
import { useEntitlement } from "../state/useEntitlement";
import { GlassSurface } from "./GlassSurface";
import { VoiceBar } from "./VoiceBar";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard } from "./DraftCard";
import { CallbackCard } from "./CallbackCard";
import { CalendarAgendaCard } from "./CalendarAgendaCard";
import { MeetingNotesCard } from "./MeetingNotesCard";
import { KebabMenu } from "./KebabMenu";
import { NotificationInboxCard } from "./NotificationInboxCard";
import { useDesktopNotifications } from "../state/useDesktopNotifications";
import type { StoredNotification } from "../lib/desktopNotifications";
import "./DraftCard.css";
import "./CallbackCard.css";

// The below-bar slot's fixed extra window height per surface (gap 6 + card
// body). Must agree with each surface's CSS. React resolves which one wins
// the single slot; Rust just grows the window by the winner's height.
const DRAFT_CARD_HEIGHT = 270;
const CALLBACK_CARD_HEIGHT = 180;
const AGENDA_CARD_HEIGHT = 236;
const MEETING_NOTES_CARD_HEIGHT = 240;
// The compact kebab popover is content-sized and anchored top-right, so this
// only needs to be >= its natural height; any extra is invisible transparent
// slot area (see KebabMenu.css). Sized for the plan line + separator atop the
// five action rows (Capture this call joined the original four).
const MENU_HEIGHT = 276;
// Notification inbox: a scrollable list, sized like the kebab menu. The list
// scrolls internally, so this is the fixed slot height, not a per-row total
// (see NotificationInboxCard.css).
const NOTIFICATION_INBOX_CARD_HEIGHT = 300;

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
  const callLive =
    voice.status !== "disconnected" && voice.status !== "ended" && voice.status !== "error";
  const callbackCard = useCallbackCard({
    presentation,
    signedIn: user !== null,
    callLive,
    draftActive: draftCard.phase !== "idle",
  });
  const meetings = useMeetings({ presentation, signedIn: user !== null, callLive });
  const meetingArm = useMeetingArm(user?.uid ?? null);
  const meetingCapture = useMeetingCapture({
    uid: user?.uid ?? null,
    appHidden: presentation !== "panel",
    events: meetings.events,
    isArmed: meetingArm.isArmed,
    armRevision: meetingArm.revision,
  });
  const entitlement = useEntitlement({ signedIn: user !== null, uid: user?.uid ?? null });
  // Aura is "hidden" for toast purposes whenever it is not showing the panel
  // (pill, pointing, or fully hidden), which drives the broker's when_hidden
  // toast policy.
  const desktopNotifications = useDesktopNotifications({
    signedIn: user !== null,
    uid: user?.uid ?? null,
    appHidden: presentation !== "panel",
  });
  const notificationMeetingIds = useMemo(
    () => desktopNotifications.inbox
      .filter((row) =>
        (row.type === "meeting_ready" || row.type === "meeting_needs_attention")
        && row.resourceId)
      .map((row) => row.resourceId as string),
    [desktopNotifications.inbox],
  );
  const meetingNotes = useMeetingNotes({
    presentation,
    signedIn: user !== null,
    callLive,
    draftActive: draftCard.phase !== "idle",
    activities: meetingCapture.activities,
    retryUpload: meetingCapture.retryNow,
    notificationMeetingIds,
  });
  const resetDraftCard = draftCard.reset;
  const resetCallbackCard = callbackCard.reset;
  const resetMeetingNotes = meetingNotes.reset;
  const resetDesktopNotifications = desktopNotifications.reset;
  const markAllNotificationsSeen = desktopNotifications.markAllSeen;
  const markNotificationSeen = desktopNotifications.markSeen;
  const notificationUnreadCount = desktopNotifications.unreadCount;
  useEscHotkey();

  // The kebab overflow menu and the calendar agenda both live in the single
  // below-bar slot (siblings of the bar, so neither can render inside VoiceBar).
  const [menuOpen, setMenuOpen] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  // Raised by the menu's Sign out; VoiceBar consumes it into its confirm UI.
  const [signOutRequested, setSignOutRequested] = useState(false);

  // A draft or visible artifact can outlive its call, but never its session: signing out clears
  // the cards and menu (and shrinks the window) without firing dismiss analytics.
  useEffect(() => {
    if (!user) {
      resetDraftCard();
      resetCallbackCard();
      resetMeetingNotes();
      resetDesktopNotifications();
      setMenuOpen(false);
      setAgendaOpen(false);
      setNotificationsOpen(false);
      setSignOutRequested(false);
    }
  }, [user, resetDraftCard, resetCallbackCard, resetMeetingNotes, resetDesktopNotifications]);

  // The single below-bar slot, resolved by fixed priority. A draft or visible artifact (result of
  // an active ask) wins outright; then the two surfaces the user just opened
  // (agenda, menu) outrank the ambient once-a-day catch-up, so a kebab click is
  // never swallowed by a catch-up card sitting in the slot.
  const showDraftCard = user !== null && draftCard.phase !== "idle";
  const showAgendaCard = user !== null && !showDraftCard && agendaOpen;
  const showMenu = user !== null && !showDraftCard && !showAgendaCard && menuOpen;
  // The notification inbox is a user-opened surface like the agenda and menu, so
  // it sits with them above the ambient meeting-note/catch-up cards.
  const showNotifications =
    user !== null && !showDraftCard && !showAgendaCard && !showMenu && notificationsOpen;
  // A fresh meeting note outranks the once-a-day catch-up (it's the direct
  // result of something the user armed) but never covers a surface the user
  // just opened (agenda, menu, notifications).
  const showMeetingNotesCard =
    user !== null &&
    !showDraftCard &&
    !showAgendaCard &&
    !showMenu &&
    !showNotifications &&
    meetingNotes.visible;
  const showCallbackCard =
    user !== null &&
    !showDraftCard &&
    !showAgendaCard &&
    !showMenu &&
    !showNotifications &&
    !showMeetingNotesCard &&
    callbackCard.visible;
  const slotHeight = showDraftCard
    ? DRAFT_CARD_HEIGHT
    : showAgendaCard
      ? AGENDA_CARD_HEIGHT
      : showMenu
        ? MENU_HEIGHT
        : showNotifications
          ? NOTIFICATION_INBOX_CARD_HEIGHT
          : showMeetingNotesCard
            ? MEETING_NOTES_CARD_HEIGHT
            : showCallbackCard
              ? CALLBACK_CARD_HEIGHT
              : null;

  // The one place the window's slot height is driven, in a single synchronous
  // step: the winning surface hands Rust its height, or null to collapse back to
  // a bare bar. Kept effect-free of any delayed "exit" hold on purpose - holding
  // the window open after a surface is logically closed caused an intermediate
  // render where the bar unpinned into the still-tall window (a dark "fat
  // bubble" flash) plus a null->height->null resize thrash on every close.
  useEffect(() => {
    invoke("set_slot_height", { height: slotHeight }).catch((err) =>
      logError("OverlayRoot: set_slot_height", err),
    );
  }, [slotHeight]);

  // A draft taking the slot, a live call, or leaving the panel all close the
  // user-opened menu/agenda so they don't linger or reappear later. (A catch-up
  // card doesn't close them - menu/agenda outrank it and simply cover it.)
  useEffect(() => {
    if (showDraftCard || callLive || presentation !== "panel") {
      setMenuOpen(false);
      setAgendaOpen(false);
      setNotificationsOpen(false);
    }
  }, [showDraftCard, callLive, presentation]);

  const handleToggleMenu = useCallback(() => {
    setAgendaOpen(false);
    setNotificationsOpen(false);
    setMenuOpen((open) => !open);
  }, []);
  const handleOpenCalendar = useCallback(() => {
    setMenuOpen(false);
    setNotificationsOpen(false);
    setAgendaOpen(true);
  }, []);
  // Opening the inbox counts as reading it: mark all seen so the unread badge
  // (kebab row + tray) clears. Individual rows keep their own read state via the
  // "Mark all read" button and row actions.
  const handleOpenNotifications = useCallback(() => {
    setMenuOpen(false);
    setAgendaOpen(false);
    setNotificationsOpen(true);
    void markAllNotificationsSeen();
  }, [markAllNotificationsSeen]);
  const handleCloseNotifications = useCallback(() => setNotificationsOpen(false), []);
  const handleNotificationAction = useCallback(
    (notification: StoredNotification) => {
      markNotificationSeen(notification.notificationId);
      desktopNotifications.acknowledgeAction(notification);
      if (notification.action === "retry_meeting_upload" && notification.resourceId) {
        // retryNow only fires when a retryable local recording still exists. If
        // it's gone (queue purged / marked failed after restart), fall through
        // to the dashboard instead of closing the inbox on a dead action.
        if (meetingCapture.retryNow(notification.resourceId)) {
          setNotificationsOpen(false);
          return;
        }
      }
      void openDashboard();
    },
    [desktopNotifications, markNotificationSeen, meetingCapture],
  );
  const handleMenuSignOut = useCallback(() => {
    setMenuOpen(false);
    setSignOutRequested(true);
  }, []);
  const handleSignOutConsumed = useCallback(() => setSignOutRequested(false), []);
  const handleCloseAgenda = useCallback(() => setAgendaOpen(false), []);
  // Not-connected CTA: open the web dashboard straight to the Connectors panel
  // where the user connects Google Calendar (the ?settings deep-link lands once
  // Aura-Web reads it; harmless before then).
  const handleConnectCalendar = useCallback(() => {
    void openDashboard({ settings: "connectors" });
  }, []);

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

  // The tray's "Notifications" item summons the overlay and asks us to open the
  // inbox slot (mirrors "open-dashboard-requested").
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("open-notifications-requested", () => {
      setMenuOpen(false);
      setAgendaOpen(false);
      setNotificationsOpen(true);
      void markAllNotificationsSeen();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OverlayRoot: listen open-notifications-requested", err));
    return () => unlisten?.();
  }, [markAllNotificationsSeen]);

  // Keep the tray menu item's unread badge in sync with the broker's count.
  useEffect(() => {
    invoke("set_tray_unread", { count: notificationUnreadCount }).catch((err) =>
      logError("OverlayRoot: set_tray_unread", err),
    );
  }, [notificationUnreadCount]);

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

  // Surfaces only ever render under the signed-in bar, one at a time in a single
  // slot (resolved above). The wrapper column is always present so opening or
  // closing a surface never remounts VoiceBar (the GlassSurface keeps its tree
  // position; only its height pinning toggles). The bar is pinned to 64px
  // whenever it's the signed-in bar (not just while a card shows), so during the
  // brief lag between "slot closed in React" and "window shrunk in Rust" it can
  // never stretch to fill the still-tall window (the dark "fat bubble" flash).
  // The unsigned SetupPanel still fills its own taller window.
  return (
    <div className="overlay-column">
      <GlassSurface className={user ? "overlay-column-bar" : undefined}>
        {user ? (
          <VoiceBar
            voice={voice}
            screenSight={screenSight}
            soonestMeeting={meetings.soonest}
            onDismissMeeting={meetings.dismiss}
            meetingCapture={meetingCapture}
            tickerNotesArmed={
              meetings.soonest !== null &&
              isEligibleForNotes(meetings.soonest.meeting) &&
              meetingArm.isArmed(meetings.soonest.meeting.id)
            }
            menuOpen={menuOpen}
            onToggleMenu={handleToggleMenu}
            signOutRequested={signOutRequested}
            onSignOutConsumed={handleSignOutConsumed}
          />
        ) : (
          <SetupPanel />
        )}
      </GlassSurface>
      {showDraftCard && <DraftCard card={draftCard} />}
      {showMeetingNotesCard && <MeetingNotesCard card={meetingNotes} />}
      {showCallbackCard && <CallbackCard card={callbackCard} />}
      {showNotifications && (
        <NotificationInboxCard
          notifications={desktopNotifications}
          onClose={handleCloseNotifications}
          onAction={handleNotificationAction}
        />
      )}
      {showAgendaCard && (
        <CalendarAgendaCard
          meetings={meetings}
          arm={meetingArm}
          onClose={handleCloseAgenda}
          onConnect={handleConnectCalendar}
        />
      )}
      {showMenu && (
        <KebabMenu
          voiceStatus={voice.status}
          entitlement={entitlement}
          onCalendar={handleOpenCalendar}
          onCaptureNow={meetingCapture.captureNow}
          capturing={meetingCapture.recording}
          onNotifications={handleOpenNotifications}
          unreadCount={notificationUnreadCount}
          onSignOut={handleMenuSignOut}
        />
      )}
    </div>
  );
}
