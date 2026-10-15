import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronUp, Copy, Mail, Minus, X } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { emailWithSignature, gmailComposeUrl, resolveEmailSignature } from "../../lib/emailDraft";
import { logError } from "../../lib/log";
import { meetingActionFailureCopy, meetingFollowUpCopy as copy } from "../../lib/meetingCopy";
import { draftMeetingFollowUp, MeetingActionError } from "../../lib/meetings";
import { useAuth } from "../../state/AuthProvider";
import { useGeneralSettings } from "../../state/useGeneralSettings";

/** The Meetings page's "Draft follow-up": Aura writes the email from the note,
 *  the user edits it in a compose card pinned to the window's bottom right,
 *  and Open in Gmail starts a new message with the invitees, subject and text
 *  filled in. Nothing is sent from Aura; the user
 *  presses Send in Gmail. */
export function MeetingFollowUp({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const { user } = useAuth();
  const settings = useGeneralSettings();
  const [state, setState] = useState<"drafting" | "ready" | "error">("drafting");
  const [error, setError] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [copied, setCopied] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("drafting");
    draftMeetingFollowUp(meetingId)
      .then((draft) => {
        if (cancelled) return;
        // The backend already leaves the calendar owner out; this also drops
        // the signed-in address when a different account owns the calendar.
        const own = user?.email?.toLowerCase() ?? "";
        setTo(draft.to.filter((address) => address !== own).join(", "));
        setSubject(draft.subject);
        setBody(emailWithSignature(draft.body, resolveEmailSignature(settings.emailSignature, user?.displayName)));
        setState("ready");
        trackEvent("meeting_follow_up_drafted", { recipients: draft.to.length });
      })
      .catch((err) => {
        if (cancelled) return;
        logError("MeetingFollowUp: draft", err);
        setError(meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : ""));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
    // The signature is read once per draft; editing it in Settings meanwhile
    // must not throw away what the user typed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, attempt]);

  const recipients = to.split(/[,;\s]+/).map((item) => item.trim()).filter((item) => item.includes("@"));

  const copyDraft = () => {
    void writeText(subject ? `${subject}

${body}` : body)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((err) => logError("MeetingFollowUp: copy", err));
  };

  const card = (
    <section
      className={`db-compose${minimized ? " is-minimized" : ""}`}
      role="dialog"
      aria-label={copy.heading}
    >
      <header className="db-compose-head">
        <button
          type="button"
          className="db-compose-title"
          onClick={() => setMinimized((value) => !value)}
          aria-expanded={!minimized}
        >
          {copy.heading}
        </button>
        <button
          type="button"
          className="db-compose-icon"
          title={minimized ? copy.expand : copy.minimize}
          aria-label={minimized ? copy.expand : copy.minimize}
          onClick={() => setMinimized((value) => !value)}
        >
          {minimized ? <ChevronUp size={16} /> : <Minus size={16} />}
        </button>
        <button
          type="button"
          className="db-compose-icon"
          title={copy.close}
          aria-label={copy.close}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      {!minimized && state === "drafting" && <ComposeThinking key={attempt} />}
      {!minimized && state === "error" && (
        <div className="db-compose-state is-error" role="alert">
          <span>{error}</span>
          <button type="button" className="db-compose-link" onClick={() => setAttempt((n) => n + 1)}>
            {copy.retry}
          </button>
        </div>
      )}
      {!minimized && state === "ready" && (
        <>
          <label className="db-compose-field">
            <span>{copy.to}</span>
            <input
              value={to}
              placeholder={copy.toPlaceholder}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="db-compose-field">
            <span className="db-sr-only">{copy.subject}</span>
            <input
              value={subject}
              placeholder={copy.subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          <textarea
            className="db-compose-body"
            value={body}
            aria-label={copy.body}
            onChange={(event) => setBody(event.target.value)}
          />
          <footer className="db-compose-foot">
            <button
              type="button"
              className="db-compose-send"
              onClick={() => {
                trackEvent("meeting_follow_up_opened", { recipients: recipients.length });
                void openUrl(gmailComposeUrl(subject, body, recipients)).catch((err) =>
                  logError("MeetingFollowUp: open gmail", err),
                );
              }}
            >
              <Mail size={15} />
              {copy.openGmail}
            </button>
            <button
              type="button"
              className="db-compose-icon"
              title={copied ? copy.copied : copy.copy}
              aria-label={copied ? copy.copied : copy.copy}
              onClick={copyDraft}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </footer>
        </>
      )}
    </section>
  );

  // Portaled into .db-app so it floats over the page like a mail compose
  // window and keeps the dashboard's tokens and hidden scrollbars.
  const host = document.querySelector(".db-app") ?? document.body;
  return createPortal(card, host);
}

const THINKING_STEP_MS = 2600;

/** The drafting state: centred in the card, stepping through what Aura is
 *  doing and holding on the last line rather than looping back to the first. */
function ComposeThinking() {
  const [step, setStep] = useState(0);
  const last = copy.thinking.length - 1;

  useEffect(() => {
    if (step >= last) return;
    const timer = window.setTimeout(() => setStep((value) => value + 1), THINKING_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [step, last]);

  return (
    <div className="db-compose-thinking" role="status" aria-live="polite">
      <span className="db-compose-thinking-orb" aria-hidden="true" />
      <p key={step} className="db-compose-thinking-line">
        {copy.thinking[step]}
      </p>
    </div>
  );
}
