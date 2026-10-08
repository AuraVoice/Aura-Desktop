import type { SwarmRoster } from "../../../lib/swarmApi";
import { SwarmAvatar } from "./SwarmAvatar";
import { CaretGlyph, HoldGlyph, LatticeGlyph, PulseGlyph } from "./SwarmGlyphs";
import {
  displayName,
  groupChannelName,
  hueOf,
  managerChannel,
  roleLabel,
  supervisorActive,
  type ChannelId,
} from "./swarmThread";

interface Props {
  roster: SwarmRoster;
  channel: ChannelId;
  unread: Record<string, number>;
  /** Managers currently working, by id. */
  working: ReadonlySet<string>;
  /** Managers parked on a question for the user, by id. */
  waiting: ReadonlySet<string>;
  /** The roster has not loaded yet, so "None yet" would be a lie. */
  loading: boolean;
  /** One line on whether managers can work right now. */
  status: { text: string; warn: boolean };
  freshManagers: ReadonlySet<string>;
  supervisorFresh: boolean;
  onSelect: (channel: ChannelId) => void;
  /** Folded to a strip of icons, so the conversation gets the width. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="db-swarm-unread">{count > 9 ? "9+" : count}</span>;
}

/** Left rail: the two shared channels, then one DM per manager, then whether the
 * managers can work right now. */
export function SwarmChannels({ roster, channel, unread, working, waiting, loading, status, freshManagers, supervisorFresh, onSelect, collapsed, onToggleCollapsed }: Props) {
  // Folded, the names are visually hidden but still read out; the tooltip names each row.
  const tip = (label: string) => (collapsed ? label : undefined);
  const hasSupervisor = supervisorActive(roster);
  const supervisorArchived = roster.supervisor?.status === "archived";

  return (
    <nav className={`db-swarm-rail${supervisorFresh ? " is-supervisor-fresh" : ""}`} aria-label="Swarm channels">
      <div className="db-swarm-rail-scroll">
        <div className="db-swarm-group-label">Channels</div>
        <button
          type="button"
          className={`db-swarm-ch${channel === "group" ? " is-active" : ""}`}
          aria-current={channel === "group" ? "page" : undefined}
          title={tip(`#${groupChannelName(roster)}`)}
          onClick={() => onSelect("group")}
        >
          <span className="db-swarm-ch-hash"><LatticeGlyph size={17} /></span>
          <span className="db-swarm-ch-name">{groupChannelName(roster)}</span>
          <Badge count={channel === "group" ? 0 : unread.group ?? 0} />
        </button>
        <button
          type="button"
          className={`db-swarm-ch${channel === "activity" ? " is-active" : ""}`}
          aria-current={channel === "activity" ? "page" : undefined}
          title={tip("#activity")}
          onClick={() => onSelect("activity")}
        >
          <span className="db-swarm-ch-hash"><PulseGlyph size={17} /></span>
          <span className="db-swarm-ch-name">activity</span>
          <Badge count={channel === "activity" ? 0 : unread.activity ?? 0} />
        </button>

        <div className="db-swarm-group-label">
          Managers <span className="db-swarm-group-count">{roster.managers.length}</span>
        </div>
        {roster.managers.length === 0 && loading && (
          <div className="db-swarm-skel-list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="db-swarm-skel is-rail">
                <span className="db-shimmer db-swarm-skel-av" />
                <span className="db-swarm-skel-lines">
                  <span className="db-shimmer db-skel-line is-head" />
                  <span className="db-shimmer db-skel-line is-body" />
                </span>
              </div>
            ))}
          </div>
        )}
        {roster.managers.length === 0 && !loading && <p className="db-swarm-rail-empty">None yet</p>}
        {roster.managers.map((m) => {
          const id = managerChannel(m.id);
          const active = channel === id;
          const paused = m.status === "paused";
          const busy = !paused && working.has(m.id);
          // Presence is what the manager is doing for you, never a generic "online" dot.
          const asking = !paused && waiting.has(m.id);
          const presence = paused ? "is-paused" : asking ? "is-waiting" : busy ? "is-working" : "";
          return (
            <button
              key={m.id}
              type="button"
              className={`db-swarm-ch is-manager${active ? " is-active" : ""}${paused ? " is-paused" : ""}${freshManagers.has(m.id) ? " is-fresh" : ""}${working.has(m.id) ? " is-working" : ""}${asking ? " is-waiting" : ""}`}
              aria-current={active ? "page" : undefined}
              title={tip(displayName(m))}
              onClick={() => onSelect(id)}
            >
              <span className="db-swarm-ch-avatar">
                <SwarmAvatar author={{ id: m.id, name: displayName(m), role: "manager", hue: hueOf(m.id) }} size="sm" state={paused ? "paused" : busy ? "working" : "idle"} />
                {presence && <i className={`db-swarm-presence ${presence}`} aria-hidden="true" />}
              </span>
              <span className="db-swarm-ch-text">
                <span className="db-swarm-ch-name">{displayName(m)}{paused && <span className="db-swarm-sr">, paused</span>}</span>
                <span className={`db-swarm-ch-role${asking ? " is-waiting" : busy ? " is-working" : ""}`}>
                  {asking ? "Needs you" : busy ? "Working" : roleLabel({ id: m.id, name: displayName(m), role: "manager", hue: 0 }, roster)}
                </span>
              </span>
              {paused ? <span className="db-swarm-ch-paused" title="Paused"><HoldGlyph size={15} /></span> : <Badge count={active ? 0 : unread[id] ?? 0} />}
            </button>
          );
        })}
        {!hasSupervisor && (
          <div className="db-swarm-ch is-manager is-ghost" title="Aura adds a Supervisor automatically when you have two active managers">
            <span className="db-swarm-ch-avatar"><SwarmAvatar author={{ id: "supervisor", name: "Supervisor", role: "supervisor", hue: 0 }} size="sm" /></span>
            <span className="db-swarm-ch-text">
              <span className="db-swarm-ch-name">Supervisor</span>
              <span className="db-swarm-ch-role">{supervisorArchived ? "Archived" : "Joins at 2 managers"}</span>
            </span>
          </div>
        )}
      </div>

      {/* Idle says nothing; the box only appears while managers work or something is wrong. */}
      {status.text && (
        <div className={`db-swarm-meter${status.warn ? " is-warn" : ""}`}>
          <span>Managers</span>
          <strong>{status.text}</strong>
        </div>
      )}

      <div className="db-swarm-rail-foot">
        <button
          type="button"
          className="db-swarm-rail-collapse"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand channels" : "Collapse channels"}
          title={collapsed ? "Expand channels" : "Collapse channels"}
        >
          <CaretGlyph size={16} />
        </button>
      </div>
    </nav>
  );
}
