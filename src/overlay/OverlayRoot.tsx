import { lazy, Suspense, useCallback, useEffect, useState } from "react";
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
import { useEntitlement } from "../state/useEntitlement";
import { GlassSurface } from "./GlassSurface";
import { VoiceBar } from "./VoiceBar";
import { SetupPanel } from "./SetupPanel";
import { PointingOverlay } from "./PointingOverlay";
import { DraftCard } from "./DraftCard";
import { CallbackCard } from "./CallbackCard";
import { CalendarAgendaCard } from "./CalendarAgendaCard";
import { KebabMenu } from "./KebabMenu";
import "./DraftCard.css";
import "./CallbackCard.css";

// The below-bar slot's fixed extra window height per surface (gap 6 + card
// body). Must agree with each surface's CSS. React resolves which one wins
// the single slot; Rust just grows the window by the winner's height.
const DRAFT_CARD_HEIGHT = 270;
const CALLBACK_CARD_HEIGHT = 180;
const AGENDA_CARD_HEIGHT = 236;
// The compact kebab popover is content-sized and anchored top-right, so this
// only needs to be >= its natural height; any extra is invisible transparent
// slot area (see KebabMenu.css). Sized for the plan line + separator now atop
// the four action rows.
const MENU_HEIGHT = 240;

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
  const entitlement = useEntitlement({ signedIn: user !== null, uid: user?.uid ?? null });
  const resetDraftCard = draftCard.reset;
  const resetCallbackCard = callbackCard.reset;
  useEscHotkey();

  // The kebab overflow menu and the calendar agenda both live in the single
  // below-bar slot (siblings of the bar, so neither can render inside VoiceBar).
  const [menuOpen, setMenuOpen] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);
  // Raised by the menu's Sign out; VoiceBar consumes it into its confirm UI.
  const [signOutRequested, setSignOutRequested] = useState(false);

  // A draft can outlive its call, but never its session: signing out clears
  // the cards and menu (and shrinks the window) without firing dismiss analytics.
  useEffect(() => {
    if (!user) {
      resetDraftCard();
      resetCallbackCard();
      setMenuOpen(false);
      setAgendaOpen(false);
      setSignOutRequested(false);
    }
  }, [user, resetDraftCard, resetCallbackCard]);

  // The single below-bar slot, resolved by fixed priority. A draft (result of
  // an active ask) wins outright; then the two surfaces the user just opened
  // (agenda, menu) outrank the ambient once-a-day catch-up, so a kebab click is
  // never swallowed by a catch-up card sitting in the slot.
  const showDraftCard = user !== null && draftCard.phase !== "idle";
  const showAgendaCard = user !== null && !showDraftCard && agendaOpen;
  const showMenu = user !== null && !showDraftCard && !showAgendaCard && menuOpen;
  const showCallbackCard =
    user !== null && !showDraftCard && !showAgendaCard && !showMenu && callbackCard.visible;
  const slotHeight = showDraftCard
    ? DRAFT_CARD_HEIGHT
    : showAgendaCard
      ? AGENDA_CARD_HEIGHT
      : showMenu
        ? MENU_HEIGHT
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
    }
  }, [showDraftCard, callLive, presentation]);

  const handleToggleMenu = useCallback(() => {
    setAgendaOpen(false);
    setMenuOpen((open) => !open);
  }, []);
  const handleOpenCalendar = useCallback(() => {
    setMenuOpen(false);
    setAgendaOpen(true);
  }, []);
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
      {showCallbackCard && <CallbackCard card={callbackCard} />}
      {showAgendaCard && (
        <CalendarAgendaCard
          meetings={meetings}
          onClose={handleCloseAgenda}
          onConnect={handleConnectCalendar}
        />
      )}
      {showMenu && (
        <KebabMenu
          voiceStatus={voice.status}
          entitlement={entitlement}
          onCalendar={handleOpenCalendar}
          onSignOut={handleMenuSignOut}
        />
      )}
    </div>
  );
}
