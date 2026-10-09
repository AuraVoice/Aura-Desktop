import { useState } from "react";
import type {
  SwarmAutoApprove,
  SwarmManager,
  SwarmRoutine,
  SwarmRoutineInput,
  SwarmWatch,
  SwarmWatchInput,
  SwarmWatchKind,
} from "../../../lib/swarmApi";
import { MAX_REPO_SCOPES } from "../../../lib/swarmApi";
import { CONNECTOR_LABEL } from "./SwarmWork";
import { BeaconGlyph, CycleGlyph, DartGlyph, DismissGlyph, KeepGlyph, SparkGlyph } from "./SwarmGlyphs";
import { exportMemory, forgetMemory, importMemory, listMemory, type MemoryRow, type MemoryRowType } from "../../../lib/swarmMemory";
import { displayName } from "./swarmThread";
import { relativeTime } from "../../format";

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

const WATCH_KIND_LABEL: Record<SwarmWatchKind, string> = {
  version_heading: "New versions",
  feed: "New feed entries",
  list_items: "New items",
  page_text: "Any change",
};

// The backend's typed poll failures (watches.FAILURE_COPY), for the paused line.
const WATCH_ERROR_COPY: Record<string, string> = {
  url_not_allowed: "The address is not a public page.",
  redirect_not_allowed: "The page redirected somewhere private.",
  too_large: "The page is larger than 2 MB.",
  timeout: "The site did not answer in 30 seconds.",
  network: "The site could not be reached.",
  nothing_extracted: "Nothing on the page matched what this watch looks for. Check the address or the kind.",
  not_a_feed: "The address is not an RSS or Atom feed.",
  filter_invalid: "The watch settings are not valid. Edit and save them again.",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function whenLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function watchLine(watch: SwarmWatch): string {
  if (!watch.url) return `Waiting for the link to "${watch.pendingHint || "the page"}". Reply in #group.`;
  if (watch.paused) return WATCH_ERROR_COPY[watch.lastError] ?? "It stopped after repeated failures. Edit it to try again.";
  if (watch.armingQuestion) return `Waiting for your go-ahead in #group: ${watch.armingQuestion}`;
  const parts = [`every ${watch.intervalH} h`];
  if (watch.lastIdentity) parts.push(`last saw ${watch.lastIdentity}`);
  if (watch.enabled && watch.nextPollAt) parts.push(`next check ${whenLabel(watch.nextPollAt)}`);
  return parts.join(" · ");
}

function WatchForm({
  watch,
  onSave,
  onCancel,
}: {
  watch: SwarmWatch;
  onSave: (input: SwarmWatchInput) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(watch.url);
  const [kind, setKind] = useState<SwarmWatchKind>(watch.kind);
  const [intervalH, setIntervalH] = useState(watch.intervalH);
  const [cssSelector, setCssSelector] = useState(watch.cssSelector);
  const [brief, setBrief] = useState(watch.brief);
  const valid = url.trim().startsWith("https://") && brief.trim().length > 0 && (kind !== "list_items" || cssSelector.trim().length > 0);
  return (
    <form
      className="db-swarm-routine-form db-swarm-watch-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSave({
          managerId: watch.managerId,
          kind,
          url: url.trim(),
          intervalH: Math.min(168, Math.max(1, intervalH || 6)),
          cssSelector: cssSelector.trim(),
          versionRegex: watch.versionRegex,
          brief: brief.trim(),
          // Saving a paused watch re-arms it: the edit is the fix the pause asked for.
          enabled: watch.enabled || watch.paused,
          dailyLimit: watch.dailyLimit,
        });
      }}
    >
      <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" aria-label="Page or feed address" />
      <div className="db-swarm-watch-fields">
        <select value={kind} onChange={(event) => setKind(event.target.value as SwarmWatchKind)} aria-label="What counts as new">
          {(Object.keys(WATCH_KIND_LABEL) as SwarmWatchKind[]).map((k) => (
            <option key={k} value={k}>{WATCH_KIND_LABEL[k]}</option>
          ))}
        </select>
        <select value={intervalH} onChange={(event) => setIntervalH(Number(event.target.value))} aria-label="How often">
          {[1, 3, 6, 12, 24, 72, 168].map((h) => (
            <option key={h} value={h}>{h < 24 ? `Every ${h} h` : h === 24 ? "Daily" : h === 168 ? "Weekly" : `Every ${h / 24} days`}</option>
          ))}
        </select>
      </div>
      {kind === "list_items" && (
        <input value={cssSelector} onChange={(event) => setCssSelector(event.target.value)} placeholder="One item, like .job-card or ul.list > li" aria-label="Item selector" />
      )}
      <textarea value={brief} maxLength={600} rows={3} onChange={(event) => setBrief(event.target.value)} placeholder="What should it do when this changes?" aria-label="Watch brief" />
      <div className="db-swarm-routine-actions">
        <button type="button" className="db-swarm-pill-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="db-swarm-pill-btn is-primary" disabled={!valid}>Save</button>
      </div>
    </form>
  );
}

/** What a manager watches. Watches are derived from what the user asked for in #group,
 * so there is no "add" here: only the switch, an edit for when a page moves, and delete. */
export function WatchList({
  watches,
  pending,
  onSave,
  onDelete,
}: {
  watches: SwarmWatch[];
  pending: boolean;
  onSave: (watchId: string, input: SwarmWatchInput) => void;
  onDelete: (watchId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (watches.length === 0) return null;
  return (
    <div className="db-swarm-routines">
      <span className="db-swarm-tools-label">Watches</span>
      {watches.map((watch) =>
        editing === watch.id ? (
          <WatchForm
            key={watch.id}
            watch={watch}
            onCancel={() => setEditing(null)}
            onSave={(input) => {
              onSave(watch.id, input);
              setEditing(null);
            }}
          />
        ) : (
          <div
            key={watch.id}
            className={`db-swarm-routine db-swarm-watch${watch.enabled && !watch.paused ? " is-on" : ""}${watch.paused ? " is-paused" : ""}${!watch.url || watch.armingQuestion ? " is-waiting" : ""}`}
          >
            <BeaconGlyph size={15} />
            <button type="button" className="db-swarm-routine-main" onClick={() => setEditing(watch.id)} title="Edit">
              <strong>{watch.url ? `${WATCH_KIND_LABEL[watch.kind]} on ${hostOf(watch.url)}` : "A page to find"}</strong>
              <span>{watchLine(watch)}</span>
            </button>
            {watch.url && !watch.armingQuestion ? (
              <button
                type="button"
                role="switch"
                aria-checked={watch.enabled && !watch.paused}
                aria-label={watch.enabled && !watch.paused ? "Stop watching" : "Start watching"}
                disabled={pending}
                className={`db-swarm-grant is-mini${watch.enabled && !watch.paused ? " is-on" : ""}`}
                onClick={() =>
                  onSave(watch.id, {
                    managerId: watch.managerId,
                    kind: watch.kind,
                    url: watch.url,
                    intervalH: watch.intervalH,
                    cssSelector: watch.cssSelector,
                    versionRegex: watch.versionRegex,
                    brief: watch.brief,
                    enabled: !(watch.enabled && !watch.paused),
                    dailyLimit: watch.dailyLimit,
                  })
                }
              >
                <i aria-hidden="true" />
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="db-swarm-icon-btn is-small" disabled={pending} onClick={() => onDelete(watch.id)} aria-label="Delete watch" title="Delete">
              <DismissGlyph size={14} />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

// The writes a manager can be allowed to make without asking, as the backend's
// AUTO_APPROVE_TARGETS lists them. Writes into the user's own systems only.
const AUTO_APPROVE_WRITES: { tool: string; connector: string; label: string }[] = [
  { tool: "github_create_issue", connector: "github", label: "Open issues" },
];

/** "Act without asking", per write and per repository, under a daily limit. Shown only
 * when the manager can do that write at all (its connector granted, a repository picked). */
export function AutoApproveSwitches({
  granted,
  repos,
  policy,
  pending,
  onSet,
}: {
  granted: string[];
  repos: string[];
  policy: Record<string, SwarmAutoApprove>;
  pending: boolean;
  onSet: (tool: string, rule: { scopes: string[]; dailyLimit: number } | null) => void;
}) {
  const writes = AUTO_APPROVE_WRITES.filter((w) => granted.includes(w.connector));
  const rows = writes.flatMap((w) => {
    const rule = policy[w.tool];
    const scopes = [...new Set([...repos, ...(rule?.scopes ?? [])])];
    return scopes.map((scope) => ({ ...w, scope, rule, on: Boolean(rule?.scopes.includes(scope)) }));
  });
  if (rows.length === 0) return null;
  return (
    <div className="db-swarm-auto">
      <span className="db-swarm-tools-label">Act without asking</span>
      {rows.map(({ tool, label, scope, rule, on }) => {
        const limit = rule?.dailyLimit || 5;
        const others = (rule?.scopes ?? []).filter((s) => s !== scope);
        return (
          <div key={`${tool}:${scope}`} className="db-swarm-auto-row">
            <button
              type="button"
              role="switch"
              aria-checked={on}
              disabled={pending}
              className={`db-swarm-grant${on ? " is-on" : ""}`}
              onClick={() => {
                const scopes = on ? others : [...others, scope].slice(0, MAX_REPO_SCOPES);
                onSet(tool, scopes.length ? { scopes, dailyLimit: limit } : null);
              }}
            >
              <i aria-hidden="true" />
              {label} in <strong>{scope}</strong>
            </button>
            {on && <span>{rule?.usedToday ?? 0} of {limit} today</span>}
          </div>
        );
      })}
      <p className="db-swarm-tools-hint">Off, every change waits for your review in the report. On, it runs right after the report, up to the daily limit, and says what it did.</p>
    </div>
  );
}

const MEMORY_TYPE_LABEL: Record<MemoryRowType, string> = {
  fact: "Knows",
  outcome: "Site and tool lessons",
  preference: "Your preferences",
  thread: "Open commitments",
  reported: "Already told you",
};
const MEMORY_TYPE_ORDER: MemoryRowType[] = ["preference", "thread", "fact", "outcome", "reported"];

/** What this manager remembers, read from the sealed store on this computer when the
 * section opens. Forget tombstones a row here and drops the server's last envelope
 * (`onForgot`), so a routine firing before the next send cannot see it either. Export
 * writes plain JSON the user owns; Import reads one back under this manager. */
export function MemoryList({
  manager,
  onForgot,
}: {
  manager: SwarmManager;
  onForgot: (managerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setRows(await listMemory(manager.id));
    } catch (err) {
      setRows([]);
      setNote(typeof err === "string" ? err : "Aura couldn't read this manager's memory.");
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) void load();
  };

  const forget = async (row: MemoryRow) => {
    setBusy(true);
    setNote("");
    try {
      await forgetMemory(manager.id, [row.id]);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      onForgot(manager.id);
    } catch (err) {
      setNote(typeof err === "string" ? err : "Aura couldn't forget that.");
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    setBusy(true);
    setNote("");
    try {
      const { path } = await exportMemory(manager.id, displayName(manager));
      setNote(`Saved to ${path}`);
    } catch (err) {
      setNote(typeof err === "string" ? err : "Aura couldn't save the file.");
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote("");
    try {
      const summary = await importMemory(manager.id, await file.text());
      setNote(`Brought in ${summary.added + summary.updated} row${summary.added + summary.updated === 1 ? "" : "s"}${summary.skipped ? `, skipped ${summary.skipped}` : ""}.`);
      await load();
    } catch (err) {
      setNote(typeof err === "string" ? err : "That file isn't a memory export Aura can read.");
    } finally {
      setBusy(false);
    }
  };

  const grouped = MEMORY_TYPE_ORDER.map((type) => ({ type, rows: (rows ?? []).filter((r) => r.type === type) })).filter((g) => g.rows.length > 0);
  const count = rows?.length ?? 0;

  return (
    <div className="db-swarm-memory">
      <button type="button" className="db-swarm-memory-head" onClick={toggle} aria-expanded={open}>
        <KeepGlyph size={15} />
        <span className="db-swarm-tools-label">Memory</span>
        {rows !== null && <em>{count === 0 ? "nothing yet" : `${count} row${count === 1 ? "" : "s"}`}</em>}
      </button>
      {open && (
        <div className="db-swarm-memory-body">
          {rows === null && <p className="db-swarm-tools-hint">Reading…</p>}
          {rows !== null && grouped.length === 0 && (
            <p className="db-swarm-tools-hint">Nothing remembered yet. Each finished run leaves what it learned here, on this computer only.</p>
          )}
          {grouped.map((group) => (
            <div key={group.type} className="db-swarm-memory-group">
              <span className="db-swarm-memory-type">{MEMORY_TYPE_LABEL[group.type]}</span>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id} className={row.closed ? "is-closed" : ""}>
                    <span className="db-swarm-memory-text" title={row.key}>
                      {row.type === "reported" ? row.key : row.text}
                    </span>
                    <span className="db-swarm-memory-meta">
                      {row.type !== "reported" && row.type !== "preference" && (
                        <i className="db-swarm-memory-conf" aria-label={`confidence ${row.confidence} of 10`}>
                          <b style={{ width: `${Math.max(10, row.confidence * 10)}%` }} />
                        </i>
                      )}
                      {row.source === "user_stated" && <span>you said</span>}
                      <span>{relativeTime(row.updatedAtMs, true)}</span>
                    </span>
                    <button type="button" className="db-swarm-icon-btn is-small" aria-label="Forget" title="Forget" disabled={busy} onClick={() => void forget(row)}>
                      <DismissGlyph size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="db-swarm-memory-foot">
            <button type="button" className="db-swarm-pill-btn" disabled={busy || count === 0} onClick={() => void doExport()}>Export</button>
            <label className={`db-swarm-pill-btn${busy ? " is-disabled" : ""}`}>
              Import
              <input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => { void doImport(event.target.files?.[0]); event.target.value = ""; }} />
            </label>
          </div>
          <p className="db-swarm-tools-hint">Kept encrypted on this computer. A reinstall gets back only the last 7 days of runs, so export if it matters.</p>
          {note && <p className="db-swarm-tools-hint">{note}</p>}
        </div>
      )}
    </div>
  );
}
