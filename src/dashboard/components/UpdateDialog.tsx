import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { update as copy } from "../../lib/copy";
import { dismiss, install, messageFor, type InstallPhase } from "../../lib/updateInstall";
import { DetailModal } from "./DetailModal";

/** How long the post-install confirmation stays up before closing itself. It has
 * no action on it, so it reads and goes. Deliberately NOT taken from
 * useUpdateReady's UPDATED_NOTICE_MS: that constant times the overlay notch
 * banner, a different surface, and editing it there would retime both. */
const UPDATED_NOTICE_MS = 2000;

type Mode = "prompt" | "notice";

/** The ready-to-install prompt, centered over the whole window.
 *
 * This replaced a thin banner strip rendered between TopBar and TrialBanner. The
 * strip was the ONLY place the install button existed, and Settings' "Check for
 * updates" reports "Update ready" as plain text with no action on it, so a user
 * who checked from Settings was told an update was ready and then handed nowhere
 * to go: the one button was behind the dialog they were looking at.
 *
 * Wraps DetailModal rather than reimplementing a dialog, the same way
 * ResearchPaywallDialog does, which is what gets the portal into `.db-app` (and
 * with it the dashboard tokens and the hidden scrollbar), Esc, scrim dismissal,
 * focus restore and the exit animation. Only the panel surface differs, via the
 * `panelClassName` hook DetailModal exposes for exactly this.
 *
 * Unlike the paywall this is app-wide rather than page-scoped, so it is NOT
 * added to the `padding-left` rule that shifts the connector and paywall dialogs
 * to center over the content area. It centers over the window. */
export function UpdateDialog({
  version,
  updatedVersion = null,
}: {
  version: string | null;
  updatedVersion?: string | null;
}) {
  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [noticeDone, setNoticeDone] = useState(false);

  // The confirmation closes itself. Keyed on the version so a second notice in
  // the same session still gets its own timer.
  useEffect(() => {
    if (!updatedVersion) return;
    setNoticeDone(false);
    const timer = setTimeout(() => setNoticeDone(true), UPDATED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [updatedVersion]);

  // The install prompt outranks the confirmation: they cannot both be live in
  // practice, and if they ever were, the one with an action is the useful one.
  const mode: Mode | null = version !== null
    ? "prompt"
    : updatedVersion !== null && !noticeDone
      ? "notice"
      : null;

  // DetailModal stays mounted for its 170ms exit animation, so the body has to
  // keep rendering the mode that is closing. Reading `mode` directly would swap
  // the content the instant it went null and flash the other mode's markup (or
  // an empty panel) through the fade.
  const shownRef = useRef<{ mode: Mode; version: string } | null>(null);
  if (mode === "prompt" && version !== null) {
    shownRef.current = { mode: "prompt", version };
  } else if (mode === "notice" && updatedVersion !== null) {
    shownRef.current = { mode: "notice", version: updatedVersion };
  }
  const shown = shownRef.current;

  // An install ends in a restart, so there is nothing useful to go back to and a
  // stray scrim or ✕ click should not tear the dialog down mid-flight. The two
  // buttons are already disabled for the same reason.
  const installing = phase === "installing";
  const close = () => {
    if (installing) return;
    if (shown?.mode === "prompt") void dismiss(shown.version);
    else setNoticeDone(true);
  };

  if (!shown) return null;

  const heading = shown.mode === "prompt"
    ? copy.ready(shown.version)
    : copy.updatedNotice(shown.version);

  return (
    <DetailModal
      open={mode !== null}
      onClose={close}
      title={heading}
      panelClassName="db-update-dialog"
    >
      <div className="db-update-dialog-body">
        <span className="db-update-dialog-glyph" aria-hidden="true">
          <Download size={30} />
        </span>
        <h2>{heading}</h2>
        {shown.mode === "prompt" && (
          <>
            <p role={phase === "failed" || phase === "blocked" ? "alert" : "status"}>
              {messageFor(phase)}
            </p>
            <div className="db-update-dialog-actions">
              <button
                type="button"
                className="db-update-dialog-primary"
                disabled={installing}
                onClick={() => void install(shown.version, setPhase)}
              >
                {installing ? copy.restartBusy : copy.restartIdle}
              </button>
              <button
                type="button"
                className="db-update-dialog-dismiss"
                disabled={installing}
                onClick={() => void dismiss(shown.version)}
              >
                {copy.later}
              </button>
            </div>
          </>
        )}
      </div>
    </DetailModal>
  );
}
