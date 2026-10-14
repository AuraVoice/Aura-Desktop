import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, LoaderCircle, Mail } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { emailWithSignature, gmailComposeUrl, resolveEmailSignature } from "../../lib/emailDraft";
import { logError } from "../../lib/log";
import { meetingActionFailureCopy, meetingFollowUpCopy as copy } from "../../lib/meetingCopy";
import { draftMeetingFollowUp, MeetingActionError } from "../../lib/meetings";
import { useAuth } from "../../state/AuthProvider";
import { useGeneralSettings } from "../../state/useGeneralSettings";

/** The Meetings page's "Draft follow-up": Aura writes the email from the note,
 *  the user edits it here, and Open in Gmail starts a new message with the
 *  invitees, subject and text filled in. Nothing is sent from Aura; the user
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

  if (state === "drafting") {
    return (
      <p className="db-meeting-action-status" role="status">
        <LoaderCircle size={15} className="db-meeting-spin" />
        {copy.drafting}
      </p>
    );
  }
  if (state === "error") {
    return (
      <div className="db-meeting-action-status is-error" role="alert">
        <span>{error}</span>
        <button type="button" className="db-secondary-btn" onClick={() => setAttempt((n) => n + 1)}>
          {copy.retry}
        </button>
        <button type="button" className="db-secondary-btn" onClick={onClose}>
          {copy.close}
        </button>
      </div>
    );
  }
  return (
    <section className="db-meeting-follow-up" aria-label={copy.heading}>
      <h2>{copy.heading}</h2>
      <label className="db-meeting-follow-up-field">
        <span>{copy.to}</span>
        <input
          className="db-meeting-editor-field"
          value={to}
          placeholder={copy.toPlaceholder}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <label className="db-meeting-follow-up-field">
        <span>{copy.subject}</span>
        <input
          className="db-meeting-editor-field"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>
      <textarea
        className="db-meeting-editor-field"
        rows={Math.min(18, Math.max(8, body.split("\n").length + 1))}
        value={body}
        aria-label={copy.body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="db-meeting-editor-actions">
        <button type="button" className="db-secondary-btn" onClick={onClose}>
          {copy.close}
        </button>
        <button
          type="button"
          className="db-secondary-btn"
          onClick={() => {
            void writeText(subject ? `${subject}\n\n${body}` : body)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch((err) => logError("MeetingFollowUp: copy", err));
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? copy.copied : copy.copy}
        </button>
        <button
          type="button"
          className="db-primary-btn"
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
      </div>
    </section>
  );
}
