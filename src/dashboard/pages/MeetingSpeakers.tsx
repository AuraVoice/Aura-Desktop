import { useEffect, useState } from "react";
import { CalendarSearch, LoaderCircle, X } from "lucide-react";
import { meetingNotes } from "../../lib/meetingCopy";
import { useConnectors } from "../useConnectors";

/** The label the call channel gives everyone who is not the user. Only this
 *  one is the whole remote side, so only this one takes calendar invitees. */
export const OTHERS_LABEL = "Others";
const MAX_NAMES_SHOWN = 3;

/** What a transcript speaker label reads as: the user's own name for it wins,
 *  then the calendar invitees for "Others" (joined, since one audio channel
 *  cannot say which of them spoke), then the raw label. */
export function speakerDisplayName(
  label: string,
  speakerNames: Record<string, string>,
  people: string[],
): string {
  const own = speakerNames[label];
  if (own) return own;
  if (label === OTHERS_LABEL && people.length > 0) {
    const shown = people.slice(0, MAX_NAMES_SHOWN).join(", ");
    return people.length > MAX_NAMES_SHOWN ? `${shown} +${people.length - MAX_NAMES_SHOWN}` : shown;
  }
  return label || "Speaker";
}

/** A one-line name editor: Enter saves, Escape or leaving the field cancels. */
export function SpeakerNameInput({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="db-meeting-name-input"
      autoFocus
      value={value}
      maxLength={60}
      placeholder={meetingNotes.renamePlaceholder}
      aria-label={meetingNotes.renameSpeaker(label)}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSave(value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

export type WhoIsState = "checking" | "connect" | "no_event";

/** Above the transcript while "Others" has no name: Aura is looking, needs
 *  Calendar connected to look, or looked and found no event. */
export function WhoIsCard({
  state,
  time,
  onConnected,
  onSaveName,
  onDismiss,
}: {
  state: WhoIsState;
  /** When the recording started, as the user reads it ("12:59 PM"). */
  time: string;
  onConnected: () => void;
  onSaveName: (name: string) => void;
  onDismiss: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const text = state === "checking"
    ? meetingNotes.whoIsChecking
    : state === "connect"
      ? meetingNotes.whoIsConnect(time)
      : meetingNotes.whoIsNoEvent(time);
  return (
    <div className="db-meeting-whois" role="status">
      {state === "checking"
        ? <LoaderCircle size={16} className="db-meeting-spin" />
        : <CalendarSearch size={16} />}
      <p>{text}</p>
      {state !== "checking" && (
        <div className="db-meeting-whois-actions">
          {state === "connect" && <ConnectCalendarButton onConnected={onConnected} />}
          {typing ? (
            <SpeakerNameInput
              initial=""
              label={OTHERS_LABEL}
              onSave={(name) => {
                setTyping(false);
                if (name) onSaveName(name);
              }}
              onCancel={() => setTyping(false)}
            />
          ) : (
            <button type="button" className="db-secondary-btn" onClick={() => setTyping(true)}>
              {meetingNotes.whoIsTypeName}
            </button>
          )}
          <button
            type="button"
            className="db-meeting-whois-close"
            title={meetingNotes.whoIsDismiss}
            aria-label={meetingNotes.whoIsDismiss}
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Its own component so the connectors hook (and its deep-link listener) is
 *  mounted only while the card actually offers to connect. */
function ConnectCalendarButton({ onConnected }: { onConnected: () => void }) {
  const connectors = useConnectors();
  const enabled = connectors.catalog?.googleCalendar.enabled === true;
  useEffect(() => {
    if (enabled) onConnected();
  }, [enabled, onConnected]);
  const busy = connectors.awaitingBrowser || connectors.action !== null;
  return (
    <button
      type="button"
      className="db-primary-btn"
      disabled={busy}
      onClick={() => void connectors.enableCalendar()}
    >
      {connectors.awaitingBrowser ? meetingNotes.whoIsConnecting : meetingNotes.whoIsConnectButton}
    </button>
  );
}
