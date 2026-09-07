import { useNavigate } from "react-router-dom";
import { Telescope } from "lucide-react";
import { DetailModal } from "./DetailModal";

const HEADING = "Deep research is part of a paid plan";

/** What a free-tier user meets when they submit a deep research request.
 *
 * This replaced a flat red inline strip reading "Check your connection and try again",
 * which was wrong twice over: the connection is fine, and the account simply has no
 * research entitlement. Naming the real reason is the whole point of the component.
 *
 * Wraps DetailModal rather than reimplementing a dialog, which is what gets the portal
 * into `.db-app` (and with it the dashboard tokens and the hidden scrollbar), Esc, scrim
 * dismissal, focus restore, and the exit animation. Only the panel's surface differs, via
 * the `panelClassName` hook DetailModal exposes for exactly this.
 *
 * The typed question is deliberately NOT echoed in the dialog; the caller does not clear
 * the composer when it opens this, so the question is still sitting there behind it. */
export function ResearchPaywallDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  // Close FIRST. /billing is a settings route, and DashboardApp keeps the page underneath
  // mounted while the settings dialog is open (`<Routes location={settingsOpen ? mainPath
  // : location}>`), so navigating without closing would leave this dialog stacked against
  // the settings one instead of handing the user cleanly to Plans.
  const seePlans = () => {
    onClose();
    navigate("/billing");
  };

  // `title` is what gives the dialog its aria-label, so it is passed even though the
  // heading is rendered in the body instead: the glyph sits above the heading here, which
  // the shared head cannot express. The head's own copy of it is hidden in CSS, and that
  // does not weaken the name, because aria-label is an attribute on the panel rather than
  // a reference to the hidden node.
  return (
    <DetailModal open={open} onClose={onClose} title={HEADING} panelClassName="db-research-paywall">
      <div className="db-research-paywall-body">
        <span className="db-research-paywall-glyph" aria-hidden="true"><Telescope size={30} /></span>
        <h2>{HEADING}</h2>
        <p>Buddy reads real sources and cites every claim, which costs money to run. Your question is saved right here while you decide.</p>
        <div className="db-research-paywall-actions">
          <button type="button" className="db-research-primary" onClick={seePlans}>See plans</button>
          <button type="button" className="db-research-paywall-dismiss" onClick={onClose}>Not now</button>
        </div>
      </div>
    </DetailModal>
  );
}
