import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { HelpCircle } from "lucide-react";
import { DiscordIcon } from "./DiscordIcon";

type Phase = "help" | "discord";

const DWELL_MS = 4000;

/** The sidebar's Help entry, rolling between "Get help" and "Join Discord".
 * Both words lead to the Help page, where the Discord invite lives; the roll
 * is an invitation, not a mode, so nothing pauses it except the window being
 * hidden. */
export function HelpDiscordNavLink({ collapsed }: { collapsed: boolean }) {
  const [phase, setPhase] = useState<Phase>("help");
  // The shine through the letters is keyed off phase changes; gating it on the
  // first flip keeps it from running on mount.
  const [flipped, setFlipped] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      setPhase((current) => (current === "help" ? "discord" : "help"));
      setFlipped(true);
    }, DWELL_MS);
    return () => window.clearInterval(timer);
  }, [hidden]);

  return (
    <NavLink
      to="/help"
      className={({ isActive }) => `db-nav-item db-nav-item-help${isActive ? " db-nav-item-active" : ""}`}
      data-phase={phase}
      data-flipped={flipped ? "" : undefined}
      aria-label="Help"
      title={collapsed ? "Help · Join Discord" : undefined}
    >
      <span className="db-nav-help-icons" aria-hidden>
        <HelpCircle size={20} className="db-nav-icon db-nav-help-icon-help" aria-hidden />
        <DiscordIcon size={20} className="db-nav-icon db-nav-help-icon-discord" />
      </span>
      <span className="db-nav-label db-nav-help-labels" aria-hidden>
        <span className="db-nav-help-word db-nav-help-word-help">Get help</span>
        <span className="db-nav-help-word db-nav-help-word-discord">Join Discord</span>
      </span>
    </NavLink>
  );
}
