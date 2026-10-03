import type { SwarmRoster } from "../../../lib/swarmApi";
import { SwarmAvatar } from "./SwarmAvatar";
import { CrownGlyph, HoldGlyph, LatticeGlyph, PulseGlyph, SpawnGlyph, SwarmMark } from "./SwarmGlyphs";
import {
  contactDuty,
  displayName,
  frontDoorAuthor,
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
  /** The roster has not loaded yet, so "None yet" would be a lie. */
  loading: boolean;
  /** One line on whether managers can work right now. */
  status: { text: string; warn: boolean };
  freshManagers: ReadonlySet<string>;
  supervisorFresh: boolean;
  onSelect: (channel: ChannelId) => void;
  onNewWorkflow: () => void;
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="db-swarm-unread">{count > 9 ? "9+" : count}</span>;
}

/** Left rail: the two shared channels, then one DM per manager, then whether the
 * managers can work right now. */
export function SwarmChannels({ roster, channel, unread, working, loading, status, freshManagers, supervisorFresh, onSelect, onNewWorkflow }: Props) {
  const hasSupervisor = supervisorActive(roster);
  const contact = frontDoorAuthor(roster);
  const supervisorArchived = roster.supervisor?.status === "archived";

  return (
    <nav className={`db-swarm-rail${supervisorFresh ? " is-supervisor-fresh" : ""}`} aria-label="Swarm channels">
      <div className="db-swarm-rail-head">
        <span className="db-swarm-logo" aria-hidden="true"><SwarmMark size={22} /></span>
        <div className="db-swarm-rail-title">
          <strong>Swarm</strong>
        </div>
      </div>

      <div className="db-swarm-rail-scroll">
        <div className="db-swarm-group-label">Point of contact</div>
        <button
          type="button"
          className="db-swarm-contact"
          onClick={() => onSelect("group")}
          title={`${contact.name} answers everything you send to #${groupChannelName(roster)}`}
        >
          <SwarmAvatar author={contact} size="sm" />
          <span className="db-swarm-ch-text">
            <span className="db-swarm-ch-name">{contact.name}</span>
            <span className="db-swarm-ch-role">{contactDuty(roster)}</span>
          </span>
        </button>

        <div className="db-swarm-group-label">Channels</div>
        <button
          type="button"
          className={`db-swarm-ch${channel === "group" ? " is-active" : ""}`}
          aria-current={channel === "group" ? "page" : undefined}
          onClick={() => onSelect("group")}
        >
          <span className="db-swarm-ch-hash"><LatticeGlyph size={17} /></span>
          <span className="db-swarm-ch-name">{groupChannelName(roster)}</span>
          {hasSupervisor && <span className="db-swarm-admin" title="Supervisor runs this channel">admin</span>}
          <Badge count={channel === "group" ? 0 : unread.group ?? 0} />
        </button>
        <button
          type="button"
          className={`db-swarm-ch${channel === "activity" ? " is-active" : ""}`}
          aria-current={channel === "activity" ? "page" : undefined}
          onClick={() => onSelect("activity")}
        >
          <span className="db-swarm-ch-hash"><PulseGlyph size={17} /></span>
          <span className="db-swarm-ch-name">activity</span>
          <Badge count={channel === "activity" ? 0 : unread.activity ?? 0} />
        </button>

        <div className="db-swarm-group-label">
          Managers <span className="db-swarm-group-count">{roster.managers.length}</span>
          <button type="button" className="db-swarm-new-btn" onClick={onNewWorkflow} title="Describe an ongoing job and Aura hires a manager for it">
            <SpawnGlyph size={14} /> New
          </button>
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
          return (
            <button
              key={m.id}
              type="button"
              className={`db-swarm-ch is-manager${active ? " is-active" : ""}${paused ? " is-paused" : ""}${freshManagers.has(m.id) ? " is-fresh" : ""}${working.has(m.id) ? " is-working" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(id)}
            >
              <span className="db-swarm-ch-avatar">
                <SwarmAvatar author={{ id: m.id, name: displayName(m), role: "manager", hue: hueOf(m.id) }} size="sm" />
                <i className={`db-swarm-presence${paused ? " is-paused" : ""}${working.has(m.id) ? " is-working" : ""}`} aria-hidden="true" />
              </span>
              <span className="db-swarm-ch-text">
                <span className="db-swarm-ch-name">{displayName(m)}</span>
                <span className="db-swarm-ch-role">{roleLabel({ id: m.id, name: displayName(m), role: "manager", hue: 0 }, roster)}</span>
              </span>
              {paused ? <span className="db-swarm-ch-paused" title="Paused"><HoldGlyph size={15} /></span> : <Badge count={active ? 0 : unread[id] ?? 0} />}
            </button>
          );
        })}
        {!hasSupervisor && (
          <div className="db-swarm-ch is-manager is-ghost" title="Aura adds a Supervisor automatically when you have two active managers">
            <span className="db-swarm-ch-avatar"><span className="db-swarm-avatar is-sm is-supervisor"><CrownGlyph size={16} /></span></span>
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
    </nav>
  );
}
