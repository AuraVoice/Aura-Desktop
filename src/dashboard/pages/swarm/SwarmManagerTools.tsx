import { useState } from "react";
import type { SwarmManager, SwarmRoutine, SwarmRoutineInput } from "../../../lib/swarmApi";
import { CONNECTOR_LABEL } from "./SwarmWork";
import { CycleGlyph, DartGlyph, DismissGlyph, SparkGlyph } from "./SwarmGlyphs";

/** A manager's two controls: which connectors it may read (on when the account is connected
 * and the manager asked for it, one switch each) and its routines. A routine fires with the laptop closed, so nothing is scheduled until
 * its switch is on; a shaper suggestion is shown as a one-click "Turn on". */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = [0, 1, 2, 3, 4];

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function scheduleLabel(weekdays: number[], hour: number, minute: number): string {
  const days = [...new Set(weekdays)].sort();
  const when = new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days.length === 0 || days.length === 7) return `Every day, ${when}`;
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return `Weekdays, ${when}`;
  return `${days.map((d) => DAYS[d]).join(", ")}, ${when}`;
}

function newRoutineId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function GrantSwitches({
  manager,
  grantable,
  granted,
  pending,
  onToggle,
}: {
  manager: SwarmManager;
  grantable: string[];
  granted: string[];
  pending: boolean;
  onToggle: (connector: string, on: boolean) => void;
}) {
  if (grantable.length === 0) return null;
  // The ones the shaper asked for first, so the obvious grant is at the top.
  const ordered = [...grantable].sort(
    (a, b) => Number(manager.connectors.includes(b)) - Number(manager.connectors.includes(a)),
  );
  return (
    <div className="db-swarm-grants">
      <span className="db-swarm-tools-label">Can read</span>
      <div className="db-swarm-grant-list">
        {ordered.map((connector) => {
          const on = granted.includes(connector);
          return (
            <button
              key={connector}
              type="button"
              role="switch"
              aria-checked={on}
              disabled={pending}
              className={`db-swarm-grant${on ? " is-on" : ""}${manager.connectors.includes(connector) ? " is-asked" : ""}`}
              onClick={() => onToggle(connector, !on)}
            >
              <i aria-hidden="true" />
              {CONNECTOR_LABEL[connector] ?? connector}
            </button>
          );
        })}
      </div>
      <p className="db-swarm-tools-hint">Accounts the manager asked for start on when they are already connected. Switch any off here. The web is always allowed; nothing is ever sent.</p>
    </div>
  );
}

function RoutineForm({
  managerId,
  initial,
  onSave,
  onCancel,
}: {
  managerId: string;
  initial?: SwarmRoutine;
  onSave: (input: SwarmRoutineInput) => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState(initial?.brief ?? "");
  const [days, setDays] = useState<number[]>(initial?.weekdays.length ? initial.weekdays : WEEKDAYS);
  const [time, setTime] = useState(initial ? `${pad(initial.hour)}:${pad(initial.minute)}` : "08:00");
  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  const [hour, minute] = time.split(":").map((v) => Number(v) || 0);
  return (
    <form
      className="db-swarm-routine-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!brief.trim() || days.length === 0) return;
        onSave({
          managerId,
          brief: brief.trim(),
          weekdays: days.length === 7 ? [] : days,
          hour,
          minute,
          timezone: initial?.timezone || localZone(),
          enabled: initial?.enabled ?? true,
        });
      }}
    >
      <textarea
        value={brief}
        maxLength={600}
        rows={2}
        onChange={(event) => setBrief(event.target.value)}
        placeholder="What should it do each time?"
        aria-label="Routine brief"
      />
      <div className="db-swarm-days" role="group" aria-label="Days">
        {DAYS.map((label, d) => (
          <button
            key={label}
            type="button"
            className={`db-swarm-day${days.includes(d) ? " is-on" : ""}`}
            aria-pressed={days.includes(d)}
            onClick={() => toggleDay(d)}
          >
            {label.slice(0, 2)}
          </button>
        ))}
        <input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="Time" />
      </div>
      <div className="db-swarm-routine-actions">
        <button type="button" className="db-swarm-pill-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="db-swarm-pill-btn is-primary" disabled={!brief.trim() || days.length === 0}>
          Save
        </button>
      </div>
    </form>
  );
}

export function RoutineList({
  manager,
  routines,
  pending,
  onSave,
  onDelete,
  onRunNow,
}: {
  manager: SwarmManager;
  routines: SwarmRoutine[];
  pending: boolean;
  onSave: (routineId: string, input: SwarmRoutineInput) => void;
  onDelete: (routineId: string) => void;
  onRunNow: (brief: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const suggestions = manager.suggestedRoutines.filter((s) => !routines.some((r) => r.brief === s.brief));
  return (
    <div className="db-swarm-routines">
      <span className="db-swarm-tools-label">Routines</span>
      {routines.map((routine) =>
        editing === routine.id ? (
          <RoutineForm
            key={routine.id}
            managerId={manager.id}
            initial={routine}
            onCancel={() => setEditing(null)}
            onSave={(input) => {
              onSave(routine.id, input);
              setEditing(null);
            }}
          />
        ) : (
          <div key={routine.id} className={`db-swarm-routine${routine.enabled ? " is-on" : ""}`}>
            <CycleGlyph size={15} />
            <button type="button" className="db-swarm-routine-main" onClick={() => setEditing(routine.id)} title="Edit">
              <strong>{scheduleLabel(routine.weekdays, routine.hour, routine.minute)}</strong>
              <span>{routine.brief}</span>
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={routine.enabled}
              aria-label={routine.enabled ? "Turn off" : "Turn on"}
              disabled={pending}
              className={`db-swarm-grant is-mini${routine.enabled ? " is-on" : ""}`}
              onClick={() => onSave(routine.id, { ...routine, enabled: !routine.enabled })}
            >
              <i aria-hidden="true" />
            </button>
            <button type="button" className="db-swarm-icon-btn is-small" disabled={pending || manager.status !== "active"} onClick={() => onRunNow(routine.brief)} aria-label="Run now" title="Run now">
              <DartGlyph size={14} />
            </button>
            <button type="button" className="db-swarm-icon-btn is-small" disabled={pending} onClick={() => onDelete(routine.id)} aria-label="Delete routine" title="Delete">
              <DismissGlyph size={14} />
            </button>
          </div>
        ),
      )}
      {suggestions.map((s) => (
        <div key={s.brief} className="db-swarm-routine is-suggested">
          <SparkGlyph size={15} />
          <span className="db-swarm-routine-main">
            <strong>Suggested: {scheduleLabel(s.weekdays, s.hour, s.minute)}</strong>
            <span>{s.brief}</span>
          </span>
          <button
            type="button"
            className="db-swarm-pill-btn"
            disabled={pending}
            onClick={() =>
              onSave(newRoutineId(), {
                managerId: manager.id,
                brief: s.brief,
                weekdays: s.weekdays,
                hour: s.hour,
                minute: s.minute,
                timezone: localZone(),
                enabled: true,
              })
            }
          >
            Turn on
          </button>
        </div>
      ))}
      {editing === "new" ? (
        <RoutineForm
          managerId={manager.id}
          onCancel={() => setEditing(null)}
          onSave={(input) => {
            onSave(newRoutineId(), input);
            setEditing(null);
          }}
        />
      ) : (
        <button type="button" className="db-swarm-pill-btn db-swarm-add-routine" onClick={() => setEditing("new")} disabled={pending}>
          <CycleGlyph size={14} /> Add a routine
        </button>
      )}
    </div>
  );
}
