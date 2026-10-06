import { useEffect, useState } from "react";
import type { SwarmManager, SwarmRoster as Roster, SwarmRoutine, SwarmRoutineInput } from "../../../lib/swarmApi";
import { GrantSwitches, RoutineList } from "./SwarmManagerTools";
import { managerInitial, SwarmAvatar } from "./SwarmAvatar";
import { CaretGlyph, CellGlyph, HubGlyph, DismissGlyph, HoldGlyph, SignalGlyph, WatchGlyph } from "./SwarmGlyphs";
import { displayName, hueOf } from "./swarmThread";

interface Props {
  roster: Roster;
  focusedManagerId: string;
  /** Managers with a live session right now. */
  working: ReadonlySet<string>;
  freshManagers: ReadonlySet<string>;
  supervisorFresh: boolean;
  open: boolean;
  onClose: () => void;
  grants: Record<string, string[]>;
  grantable: string[];
  routines: SwarmRoutine[];
  pending: boolean;
  onToggleGrant: (managerId: string, connector: string, on: boolean) => void;
  onSaveRoutine: (routineId: string, input: SwarmRoutineInput) => void;
  onDeleteRoutine: (routineId: string) => void;
  onRunNow: (managerId: string, brief: string) => void;
}

type ManagerTools = Pick<Props, "grants" | "grantable" | "routines" | "pending" | "onToggleGrant" | "onSaveRoutine" | "onDeleteRoutine" | "onRunNow">;

const W = 268;
const H = 156;

/** The org as a small live graph: Supervisor on top when there is one, managers in a
 * row, their subagents as satellites. Edges draw themselves in when the shape changes. */
function Constellation({ roster, working, freshManagers, supervisorFresh }: Pick<Props, "roster" | "working" | "freshManagers" | "supervisorFresh">) {
  const managers = roster.managers;
  const sup = roster.supervisor;
  const hasTop = sup !== null;
  const rowY = hasTop ? 84 : 46;
  const subY = rowY + 46;
  const step = managers.length > 1 ? (W - 60) / (managers.length - 1) : 0;
  const xOf = (i: number) => (managers.length > 1 ? 30 + i * step : W / 2);
  const shape = `${sup?.status ?? "none"}-${managers.map((m) => `${m.id}:${m.subagents.length}:${m.status}`).join(",")}`;

  if (managers.length === 0 && !sup) {
    return (
      <svg className="db-swarm-constellation is-empty" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="No agents yet">
        <circle className="db-swarm-orbit" cx={W / 2} cy={H / 2} r="44" />
        <circle className="db-swarm-orbit is-inner" cx={W / 2} cy={H / 2} r="24" />
        <circle className="db-swarm-orbit-dot" cx={W / 2 + 44} cy={H / 2} r="4" />
        <circle className="db-swarm-orbit-dot is-inner" cx={W / 2 - 24} cy={H / 2} r="3" />
      </svg>
    );
  }

  return (
    <svg key={shape} className="db-swarm-constellation" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${managers.length} manager${managers.length === 1 ? "" : "s"}${sup ? " under a Supervisor" : ""}`}>
      {hasTop &&
        managers.map((m, i) => (
          <path
            key={`e-${m.id}`}
            className={`db-swarm-edge${sup?.status === "archived" || m.status === "paused" ? " is-dim" : ""}`}
            d={`M ${W / 2} 40 C ${W / 2} ${rowY - 18}, ${xOf(i)} ${rowY - 30}, ${xOf(i)} ${rowY - 16}`}
            pathLength={1}
            style={{ animationDelay: `${120 + i * 70}ms` }}
          />
        ))}
      {managers.map((m, i) =>
        m.subagents.map((s, j) => {
          const spread = (j - (m.subagents.length - 1) / 2) * 12;
          return (
            <g key={`s-${m.id}-${s.id}`}>
              <path
                className="db-swarm-edge is-sub"
                d={`M ${xOf(i)} ${rowY + 16} L ${xOf(i) + spread} ${subY - 5}`}
                pathLength={1}
                style={{ animationDelay: `${260 + i * 70 + j * 40}ms` }}
              />
              <circle
                className={`db-swarm-sat is-hue-${hueOf(m.id)}${s.isVerifier ? " is-verifier" : ""}`}
                cx={xOf(i) + spread}
                cy={subY}
                r={s.isVerifier ? 4.5 : 3.6}
                style={{ animationDelay: `${340 + i * 70 + j * 40}ms` }}
              >
                <title>{s.title}{s.isVerifier ? " (verifier)" : ""}</title>
              </circle>
            </g>
          );
        }),
      )}
      {hasTop && sup && (
        <g className={`db-swarm-node is-supervisor${sup.status === "archived" ? " is-dim" : ""}${supervisorFresh ? " is-fresh" : ""}`} style={{ transformOrigin: `${W / 2}px 24px` }}>
          <rect className="db-swarm-node-ring" x={W / 2 - 21} y={3} width={42} height={42} rx={13} />
          <rect className="db-swarm-node-core" x={W / 2 - 16} y={8} width={32} height={32} rx={10} />
          <HubGlyph x={W / 2 - 11} y={13} size={22} className="db-swarm-node-glyph" />
          <title>{sup.title}</title>
        </g>
      )}
      {managers.map((m, i) => (
        <g
          key={`n-${m.id}`}
          className={`db-swarm-node is-hue-${hueOf(m.id)}${m.status === "paused" ? " is-dim" : working.has(m.id) ? " is-working" : ""}${freshManagers.has(m.id) ? " is-fresh" : ""}`}
          style={{ transformOrigin: `${xOf(i)}px ${rowY}px`, animationDelay: `${60 + i * 70}ms` }}
        >
          <rect className="db-swarm-node-ring" x={xOf(i) - 19} y={rowY - 19} width={38} height={38} rx={12} />
          <rect className="db-swarm-node-core" x={xOf(i) - 14} y={rowY - 14} width={28} height={28} rx={8} />
          <text className="db-swarm-node-glyph" x={xOf(i)} y={rowY} textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize={13} fontWeight={700}>{managerInitial(displayName(m))}</text>
          <title>{m.name ? `${m.name} · ${m.title}` : m.title}</title>
        </g>
      ))}
    </svg>
  );
}

function Chips({ label, items, warn = false }: { label: string; items: string[]; warn?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="db-swarm-chips">
      <span>{label}</span>
      <div>
        {items.map((item, i) => (
          <em key={item} className={warn ? "is-warn" : ""} style={{ animationDelay: `${i * 35}ms` }}>{item}</em>
        ))}
      </div>
    </div>
  );
}

function ManagerCard({
  manager,
  expanded,
  fresh,
  working,
  onToggle,
  tools,
}: {
  manager: SwarmManager;
  expanded: boolean;
  fresh: boolean;
  working: boolean;
  onToggle: () => void;
  tools: ManagerTools;
}) {
  const paused = manager.status === "paused";
  const routines = tools.routines.filter((r) => r.managerId === manager.id).length;
  return (
    <li className={`db-swarm-card${expanded ? " is-open" : ""}${paused ? " is-paused" : ""}${fresh ? " is-fresh" : ""}`}>
      <button type="button" className="db-swarm-card-head" onClick={onToggle} aria-expanded={expanded}>
        <SwarmAvatar author={{ id: manager.id, name: displayName(manager), role: "manager", hue: hueOf(manager.id) }} state={paused ? "paused" : working ? "working" : "idle"} />
        <span className="db-swarm-card-title">
          <strong>{displayName(manager)}</strong>
          <span>
            {paused ? "Paused" : manager.isCoordinator ? `${manager.name ? manager.title : "Manager"} · also coordinates` : manager.name ? manager.title : "Manager"}
            {" · "}
            {manager.subagents.length === 0 ? "works solo" : `${manager.subagents.length} subagent${manager.subagents.length === 1 ? "" : "s"}`}
            {manager.connectors.length > 0 && ` · ${manager.connectors.length} connector${manager.connectors.length === 1 ? "" : "s"}`}
            {routines > 0 && ` · ${routines} routine${routines === 1 ? "" : "s"}`}
          </span>
        </span>
        {working && !paused && <span className="db-swarm-status-chip">Working</span>}
        {paused ? <HoldGlyph size={16} className="db-swarm-card-chev" /> : <CaretGlyph size={16} className="db-swarm-card-chev" />}
      </button>
      <div className="db-swarm-card-body">
        <div className="db-swarm-card-inner">
          {manager.description && <p className="db-swarm-card-desc">{manager.description}</p>}
          <Chips label="Owns" items={manager.owns} />
          <Chips label="Connectors" items={manager.connectors} />
          <Chips label="Missing" items={manager.missingCapabilities} warn />
          {manager.approvalBoundary && <p className="db-swarm-card-boundary"><SignalGlyph size={14} /> {manager.approvalBoundary}</p>}
          {manager.subagents.length > 0 && (
            <ul className="db-swarm-subs">
              {manager.subagents.map((s, i) => (
                <li key={s.id} style={{ animationDelay: `${i * 45}ms` }}>
                  <span className={`db-swarm-sub-icon${s.isVerifier ? " is-verifier" : ""}`}>{s.isVerifier ? <WatchGlyph size={15} /> : <CellGlyph size={15} />}</span>
                  <div>
                    <strong>{s.title}{s.isVerifier && <em>verifier</em>}</strong>
                    {s.contextScope && <span>{s.contextScope}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <GrantSwitches
            manager={manager}
            grantable={tools.grantable}
            granted={tools.grants[manager.id] ?? []}
            pending={tools.pending}
            onToggle={(connector, on) => tools.onToggleGrant(manager.id, connector, on)}
          />
          <RoutineList
            manager={manager}
            routines={tools.routines.filter((r) => r.managerId === manager.id)}
            pending={tools.pending}
            onSave={tools.onSaveRoutine}
            onDelete={tools.onDeleteRoutine}
            onRunNow={(brief) => tools.onRunNow(manager.id, brief)}
          />
        </div>
      </div>
    </li>
  );
}

/** Right panel: who is on the team, at a glance and in detail. */
export function SwarmRoster({ roster, focusedManagerId, working, freshManagers, supervisorFresh, open, onClose, ...tools }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focusedManagerId ? [focusedManagerId] : []));

  // Opening a manager's DM, or hiring one, unfolds its card.
  useEffect(() => {
    const ids = [focusedManagerId, ...freshManagers].filter(Boolean);
    if (ids.length === 0) return;
    setExpanded((prev) => (ids.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ids])));
  }, [focusedManagerId, freshManagers]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sup = roster.supervisor;

  return (
    <aside className={`db-swarm-roster${open ? " is-open" : ""}`} aria-label="Roster">
      <div className="db-swarm-roster-head">
        <span className="db-swarm-group-label">Team <span className="db-swarm-group-count">{roster.managers.length + (sup ? 1 : 0)}</span></span>
        <button type="button" className="db-swarm-icon-btn db-swarm-roster-close" onClick={onClose} aria-label="Close team panel">
          <DismissGlyph size={16} />
        </button>
      </div>
      <div className="db-swarm-roster-scroll">
        <div className="db-swarm-constellation-wrap">
          <Constellation roster={roster} working={working} freshManagers={freshManagers} supervisorFresh={supervisorFresh} />
        </div>

        {sup && <div className="db-swarm-group-label">Supervisor</div>}
        {sup && (
          <section className={`db-swarm-card is-supervisor is-open${sup.status === "archived" ? " is-paused" : ""}${supervisorFresh ? " is-fresh" : ""}`}>
            <div className="db-swarm-card-head is-static">
              <SwarmAvatar author={{ id: "supervisor", name: sup.title, role: "supervisor", hue: 0 }} />
              <span className="db-swarm-card-title">
                <strong>{sup.title}</strong>
                <span>{sup.status === "archived" ? "Archived, one manager left" : `Coordinates ${roster.managers.length} managers`}</span>
              </span>
            </div>
            {(roster.handoverFacts.length > 0 || sup.routines.length > 0) && (
              <div className="db-swarm-card-inner is-static">
                {roster.handoverFacts.length > 0 && (
                  <ul className="db-swarm-facts">
                    {roster.handoverFacts.map((fact, i) => <li key={i}>{fact}</li>)}
                  </ul>
                )}
                <Chips label="Routines" items={sup.routines} />
              </div>
            )}
          </section>
        )}

        {roster.managers.length > 0 && <div className="db-swarm-group-label">Managers</div>}
        {roster.managers.length > 0 && (
          <ul className="db-swarm-cards">
            {roster.managers.map((m) => (
              <ManagerCard key={m.id} manager={m} expanded={expanded.has(m.id)} fresh={freshManagers.has(m.id)} working={working.has(m.id)} onToggle={() => toggle(m.id)} tools={tools} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
