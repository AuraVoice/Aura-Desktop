import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthRequiredError, TimeoutError } from "../../lib/api";
import {
  answerSession,
  cancelRound,
  cancelSession,
  deleteRoutine,
  getRound,
  getSession,
  getSwarmState,
  importSandbox,
  listChannelMessages,
  mapRoster,
  resetSwarm,
  runManager,
  sendSwarmMessage,
  setGrants,
  SwarmRequestError,
  TERMINAL_SESSION_STATES,
  upsertRoutine,
  type SwarmMessage,
  type SwarmRoster,
  type SwarmRoundView,
  type SwarmRoutineInput,
  type SwarmSessionView,
  type SwarmState,
} from "../../lib/swarmApi";
import { useDashboardResource } from "../useDashboardResource";
import { SwarmChannels } from "./swarm/SwarmChannels";
import { SwarmRoster as SwarmRosterPanel } from "./swarm/SwarmRoster";
import { SwarmStream, type ChannelView } from "./swarm/SwarmStream";
import {
  channelItems,
  frontDoorAuthor,
  groupChannelName,
  hueOf,
  importMessagesOf,
  isChannelId,
  managerChannel,
  managerIdOfChannel,
  supervisorActive,
  type ChannelId,
  type ThreadEntry,
} from "./swarm/swarmThread";

/** Aura Swarm, laid out like a chat app: #group (the front door), #activity, and a DM per
 * manager. The swarm lives on the server: #group routes a message to the manager that
 * owns it, and a DM becomes that manager's brief. The manager then works read-only (plan,
 * search, read what it was granted) and posts a sourced report back into its DM, with a
 * toast if Aura is hidden. This tab only renders and polls. */

/** The pre-Stage-2 sandbox kept the roster and thread here. Read once, offered as an
 * import, then cleared; never written again. */
const LEGACY_KEY = "aura.swarm-sandbox.v1";
const CHANNEL_KEY = "aura.swarm-sandbox.channel";
const SEEN_KEY = "aura.swarm.seen";
const POLL_MS = 2_500;
const POLL_BACKOFF_MS = 15_000;
// How long a new message, manager or Supervisor counts as "just arrived" for motion.
const FRESH_MS = 1600;

interface Legacy {
  rosterWire: unknown;
  thread: ThreadEntry[];
}

function readLegacy(): Legacy | null {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Legacy>;
    const thread = Array.isArray(parsed.thread) ? parsed.thread : [];
    const roster = mapRoster(parsed.rosterWire);
    return thread.length > 0 || roster.managers.length > 0 ? { rosterWire: parsed.rosterWire ?? {}, thread } : null;
  } catch {
    return null;
  }
}

function clearLegacy() {
  try {
    globalThis.localStorage?.removeItem(LEGACY_KEY);
  } catch {
    // Best effort; the banner simply comes back next time.
  }
}

function loadChannel(): ChannelId {
  try {
    const raw = globalThis.localStorage?.getItem(CHANNEL_KEY);
    if (isChannelId(raw)) return raw;
  } catch {
    // Storage can be unavailable; the front door is fine.
  }
  return "group";
}

function saveChannel(channel: ChannelId) {
  try {
    globalThis.localStorage?.setItem(CHANNEL_KEY, channel);
  } catch {
    // Best effort only.
  }
}

function loadSeen(): Record<string, number> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSeen(seen: Record<string, number>) {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Best effort only.
  }
}

function clientId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** One line per cause, so a refusal says what actually went wrong. */
function errorCopy(error: unknown, roster: SwarmRoster): string {
  if (error instanceof AuthRequiredError) return "Your session expired. Sign in again to use Swarm.";
  if (error instanceof TimeoutError) return "No answer after two minutes. The models may be slow right now; try again.";
  if (error instanceof SwarmRequestError) {
    switch (error.reason) {
      case "models_unset":
        return "Swarm models are not chosen yet, so managers cannot start work.";
      case "model_unpriced":
      case "model_unsupported":
        return "A Swarm model is set up wrong on the server, so nothing could run. Nothing was charged.";
      case "wallet_exhausted":
        return "Today's Swarm budget is used up. Managers can work again after midnight UTC.";
      case "meter_unavailable":
        return "Aura could not check the Swarm budget, so nothing ran. Try again in a minute.";
      case "manager_busy":
        return "That manager is still working on something. Stop it, or wait for its report.";
      case "too_many_live":
        return "Four managers are already working. Wait for one to finish, or stop one.";
      case "manager_paused":
        return "That manager is paused. Ask in #group to bring it back.";
      case "brief_empty":
      case "text_empty":
      case "answer_empty":
        return "Type something first.";
      case "roster_conflict":
        return "Another message changed the team at the same moment. Send it again.";
      case "timed_out":
        return "Routing this message took too long, so nothing was changed. Try again, or split it up.";
      case "retries_exhausted":
        return "Every model retry and fallback failed on this message, so nothing was changed. Try again in a few minutes.";
      case "roster_invalid":
        return "This change would push a manager past its limits, so it was not applied. Your team is unchanged.";
      case "invalid_output":
        return "The model's answer did not fit the expected shape. Try again; if it repeats, the prompt needs work.";
      case "draft_not_found":
        return "That question is no longer open.";
      case "manager_not_found":
        return "That manager no longer exists.";
      case "not_waiting":
        return "That manager is no longer waiting for an answer.";
      case "already_has_swarm":
        return "This account already has a Swarm, so the sandbox team was not brought over.";
      case "unavailable":
        return "The model is unavailable right now. Try again in a minute.";
    }
    // A bare 404 means the route itself is missing (a backend without Swarm), not a lost record.
    if (error.status === 404 && !error.reason) return "Swarm isn't available on the server yet, so nothing was sent. Nothing was lost.";
    return `Swarm refused this (${error.status}${error.reason ? `, ${error.reason}` : ""}).`;
  }
  return `Couldn't reach Aura (${roster.managers.length > 0 ? "your team is safe on the server" : "nothing was lost"}). Check your connection and try again.`;
}

function runtimeNotice(problem: string): string {
  switch (problem) {
    case "":
      return "";
    case "models_unset":
      return "Managers cannot start work yet: the Swarm models are not chosen. Routing in #group still works.";
    case "wallet_exhausted":
      return "Today's Swarm budget is used up. Managers can work again after midnight UTC.";
    default:
      return "A Swarm model is set up wrong on the server, so managers cannot start work.";
  }
}

/** Holds a set of keys for FRESH_MS after they are added, so motion plays once. */
function useFreshSet(): [ReadonlySet<string>, (ids: string[]) => void] {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const mark = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setFresh((prev) => new Set([...prev, ...ids]));
    timers.current.push(
      window.setTimeout(() => {
        setFresh((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }, FRESH_MS),
    );
  }, []);
  return [fresh, mark];
}

function channelView(channel: ChannelId, roster: SwarmRoster): ChannelView {
  if (channel === "activity") return { kind: "activity", name: "activity", topic: "Every hire, handover, routine and skip. Read only." };
  const manager = roster.managers.find((m) => m.id === managerIdOfChannel(channel));
  if (manager) {
    return {
      kind: "manager",
      name: manager.title,
      topic: manager.description || "Manager",
      manager,
      author: { id: manager.id, name: manager.title, role: "manager", hue: hueOf(manager.id) },
    };
  }
  const backer = frontDoorAuthor(roster);
  return {
    kind: "group",
    name: groupChannelName(roster),
    topic: supervisorActive(roster)
      ? `${backer.name} routes every message here to the manager that owns it.`
      : backer.role === "manager"
        ? `${backer.name} answers here until a second manager joins.`
        : "Describe something ongoing and Aura decides who should own it.",
  };
}

const EMPTY_STATE: SwarmState = {
  rosterWire: {},
  roster: mapRoster({}),
  rosterExists: false,
  channels: [],
  grants: {},
  grantable: [],
  routines: [],
  liveSessions: [],
  runtimeProblem: "",
};

export function SwarmPage() {
  const resource = useDashboardResource<SwarmState>("swarm:state", getSwarmState, { freshnessMs: 30_000 });
  const state = resource.data ?? EMPTY_STATE;
  const roster = state.roster;
  const reloadState = resource.reload;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [channel, setChannel] = useState<ChannelId>(() => {
    const linked = searchParams.get("run");
    return isChannelId(linked) ? linked : loadChannel();
  });
  const [messages, setMessages] = useState<Record<string, SwarmMessage[]>>({});
  const [sessions, setSessions] = useState<Record<string, SwarmSessionView>>({});
  const [rounds, setRounds] = useState<Record<string, SwarmRoundView>>({});
  const [watched, setWatched] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [text, setText] = useState("");
  const [freeAnswers, setFreeAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [busyChannel, setBusyChannel] = useState<ChannelId>("group");
  const [busySince, setBusySince] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [legacy, setLegacy] = useState<Legacy | null>(readLegacy);
  const [seen, setSeen] = useState<Record<string, number>>(loadSeen);
  const [freshItems, markItems] = useFreshSet();
  const [freshManagers, markManagers] = useFreshSet();
  const [supervisorFresh, setSupervisorFresh] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const loading = useRef<Set<string>>(new Set());
  const lastSeq = useRef<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  // A notification deep link (?run=m:<id>) lands on that DM even with the page mounted.
  const linked = searchParams.get("run");
  useEffect(() => {
    if (isChannelId(linked)) setChannel(linked);
  }, [linked]);

  // A DM to a manager that no longer exists (after a reset) falls back to the front door.
  const liveChannel: ChannelId =
    channel.startsWith("m:") && resource.data && !roster.managers.some((m) => m.id === managerIdOfChannel(channel)) ? "group" : channel;

  /** Fetch everything after the last seq this tab holds for one channel. */
  const pull = useCallback(async (cid: string, markFresh = false) => {
    if (loading.current.has(cid)) return;
    loading.current.add(cid);
    try {
      let after = lastSeq.current[cid] ?? 0;
      const added: SwarmMessage[] = [];
      for (let page = 0; page < 5; page++) {
        const { messages: batch, hasMore } = await listChannelMessages(cid, after);
        added.push(...batch);
        if (batch.length > 0) after = batch[batch.length - 1].seq;
        if (!hasMore) break;
      }
      if (added.length === 0) {
        // Mark an empty channel as loaded, or every other channel's update re-fetches it.
        setMessages((prev) => (prev[cid] === undefined ? { ...prev, [cid]: [] } : prev));
        return;
      }
      lastSeq.current[cid] = after;
      setMessages((prev) => {
        const known = new Set((prev[cid] ?? []).map((m) => m.seq));
        return { ...prev, [cid]: [...(prev[cid] ?? []), ...added.filter((m) => !known.has(m.seq))] };
      });
      if (markFresh) markItems(added.map((m) => `${cid}-${m.seq}`));
    } catch {
      // The next poll or focus retries; a failed page never blanks what is shown.
    } finally {
      loading.current.delete(cid);
    }
  }, [markItems]);

  // The open channel loads on open, and again whenever the server says it grew.
  const serverNext = useMemo(() => Object.fromEntries(state.channels.map((c) => [c.id, c.nextSeq])), [state.channels]);
  useEffect(() => {
    const have = lastSeq.current[liveChannel] ?? 0;
    const next = serverNext[liveChannel] ?? 1;
    if (messages[liveChannel] === undefined || next - 1 > have) void pull(liveChannel, have > 0);
  }, [liveChannel, serverNext, messages, pull]);

  // Unread = messages that landed in a channel since it was last open.
  useEffect(() => {
    const latest = (serverNext[liveChannel] ?? 1) - 1;
    if (latest > 0 && (seen[liveChannel] ?? 0) < latest) {
      const next = { ...seen, [liveChannel]: latest };
      setSeen(next);
      saveSeen(next);
    }
  }, [liveChannel, serverNext, seen]);
  const unread = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of state.channels) out[c.id] = Math.max(0, c.nextSeq - 1 - (seen[c.id] ?? c.nextSeq - 1));
    return out;
  }, [state.channels, seen]);

  // Sessions to poll: the server's live list plus anything this tab just started.
  const liveIds = useMemo(() => {
    const ids = new Set(watched);
    for (const s of state.liveSessions) ids.add(s.sessionId);
    for (const [id, view] of Object.entries(sessions)) if (TERMINAL_SESSION_STATES.has(view.state)) ids.delete(id);
    return [...ids];
  }, [watched, state.liveSessions, sessions]);
  const working = useMemo(() => {
    const ids = new Set<string>();
    for (const s of state.liveSessions) ids.add(s.managerId);
    for (const id of liveIds) if (sessions[id]) ids.add(sessions[id].managerId);
    return ids;
  }, [state.liveSessions, liveIds, sessions]);

  // The Research page's loop: 2.5 s while anything runs, 15 s after an error, nothing
  // while the window is hidden or offline. A changed revision pulls that DM.
  const [pollError, setPollError] = useState(false);
  useEffect(() => {
    if (liveIds.length === 0) return;
    const tick = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      let failed = false;
      let ended = false;
      for (const id of liveIds) {
        try {
          const view = await getSession(id, sessions[id]?.stateRevision);
          if (!view) continue;
          setSessions((prev) => ({ ...prev, [id]: view }));
          void pull(managerChannel(view.managerId), true);
          if (TERMINAL_SESSION_STATES.has(view.state)) ended = true;
        } catch {
          failed = true;
        }
      }
      setPollError(failed);
      if (ended) reloadState();
    };
    const timer = window.setInterval(() => void tick(), pollError ? POLL_BACKOFF_MS : POLL_MS);
    void tick();
    return () => window.clearInterval(timer);
    // `sessions` is read for the rev only; re-arming on every view change would double-poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds.join(","), pollError, pull, reloadState]);

  // #group rounds: the Supervisor's answer lands in #group after the last member ends, a
  // write nothing else re-fetches #group for. Poll each unfinished round this tab knows of
  // (from the send, a member's session view, or a round_started card) and pull #group once
  // it is done.
  const groupRoundIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages.group ?? []) {
      if (m.kind === "round_started" && typeof m.data.round_id === "string") ids.add(m.data.round_id);
    }
    return ids;
  }, [messages.group]);
  const liveRoundIds = useMemo(() => {
    const ids = new Set<string>(groupRoundIds);
    for (const id of Object.keys(rounds)) ids.add(id);
    for (const view of Object.values(sessions)) if (view.roundId) ids.add(view.roundId);
    for (const [id, view] of Object.entries(rounds)) if (view.state === "done") ids.delete(id);
    return [...ids].filter(Boolean);
  }, [groupRoundIds, rounds, sessions]);
  useEffect(() => {
    if (liveRoundIds.length === 0) return;
    const tick = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      let finished = false;
      for (const id of liveRoundIds) {
        try {
          const view = await getRound(id, rounds[id]?.stateRevision);
          if (!view) continue;
          setRounds((prev) => ({ ...prev, [id]: view }));
          if (view.state === "done") finished = true;
        } catch (err) {
          // A round that no longer exists (reset, another account) stops being asked about;
          // anything else is a blip the next tick retries.
          if (err instanceof SwarmRequestError && err.status === 404) {
            setRounds((prev) => ({ ...prev, [id]: { roundId: id, state: "done", stateRevision: 0, members: [] } }));
          }
        }
      }
      if (finished) {
        await pull("group", true);
        reloadState();
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => window.clearInterval(timer);
    // `rounds` is read for the rev only, as with sessions above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRoundIds.join(","), pull, reloadState]);

  const items = useMemo(() => channelItems(messages[liveChannel] ?? [], roster), [messages, liveChannel, roster]);

  // A finished session's working message still wants its final state once.
  useEffect(() => {
    for (const item of items) {
      if (item.kind !== "working" || sessions[item.sessionId] || requested.current.has(item.sessionId)) continue;
      requested.current.add(item.sessionId);
      void getSession(item.sessionId)
        .then((view) => view && setSessions((prev) => ({ ...prev, [item.sessionId]: view })))
        .catch(() => undefined);
    }
  }, [items, sessions]);

  const view = useMemo(() => channelView(liveChannel, roster), [liveChannel, roster]);
  const openDrafts = useMemo(() => new Set(roster.drafts.map((d) => d.id)), [roster]);

  const select = (next: ChannelId) => {
    setChannel(next);
    saveChannel(next);
    setError("");
    setConfirmReset(false);
    setRosterOpen(false);
  };

  const watch = (sessionId: string) => {
    if (sessionId) setWatched((prev) => new Set([...prev, sessionId]));
  };

  const afterRoster = (before: SwarmRoster, after: SwarmRoster) => {
    const known = new Set(before.managers.map((m) => m.id));
    markManagers(after.managers.filter((m) => !known.has(m.id)).map((m) => m.id));
    if (after.supervisor?.status === "active" && !supervisorActive(before)) {
      setSupervisorFresh(true);
      window.setTimeout(() => setSupervisorFresh(false), FRESH_MS * 1.5);
    }
  };

  /** #group, or the answer to a routing question. */
  const route = async (req: { text: string; draftId?: string; choiceLabel?: string; choiceManagerId?: string }) => {
    if (busy) return false;
    setBusy(true);
    setBusyChannel("group");
    setBusySince(Date.now());
    setError("");
    try {
      const result = await sendSwarmMessage({ clientMessageId: clientId(), ...req });
      afterRoster(roster, result.roster);
      result.sessions.forEach((s) => watch(s.sessionId));
      if (result.round) {
        const round = result.round;
        setRounds((prev) => ({ ...prev, [round.roundId]: round }));
      }
      // A round shows each skipped manager on its own card; a banner would repeat it.
      const refused = result.round ? undefined : result.sessions.find((s) => s.refused);
      if (refused) setError(errorCopy(new SwarmRequestError(409, refused.refused), roster));
      reloadState();
      await Promise.all([pull("group", true), pull("activity", true)]);
      return true;
    } catch (err) {
      setError(errorCopy(err, roster));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** A DM, or Run now on a routine: the text is the manager's brief. */
  const run = async (managerId: string, brief: string, origin: "dm" | "run_now") => {
    if (busy) return false;
    setBusy(true);
    setBusyChannel(managerChannel(managerId));
    setBusySince(Date.now());
    setError("");
    try {
      const started = await runManager(managerId, brief, clientId(), origin);
      watch(started.sessionId);
      reloadState();
      await pull(managerChannel(managerId), true);
      return true;
    } catch (err) {
      setError(errorCopy(err, roster));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const message = text.trim();
    if (!message) return;
    const ok = view.kind === "manager" && view.manager ? await run(view.manager.id, message, "dm") : await route({ text: message });
    if (ok) setText("");
  };

  const stop = async (sessionId: string) => {
    setStopping((prev) => new Set([...prev, sessionId]));
    try {
      const viewNow = await cancelSession(sessionId);
      setSessions((prev) => ({ ...prev, [sessionId]: viewNow }));
      await pull(managerChannel(viewNow.managerId), true);
      if (TERMINAL_SESSION_STATES.has(viewNow.state)) reloadState();
    } catch (err) {
      setError(errorCopy(err, roster));
    }
  };

  const stopRound = async (roundId: string) => {
    setStopping((prev) => new Set([...prev, roundId]));
    try {
      const viewNow = await cancelRound(roundId);
      setRounds((prev) => ({ ...prev, [roundId]: viewNow }));
      viewNow.members.forEach((m) => watch(m.sessionId));
    } catch (err) {
      setError(errorCopy(err, roster));
    }
  };

  const answerManager = async (sessionId: string, value: string) => {
    try {
      const viewNow = await answerSession(sessionId, value);
      setSessions((prev) => ({ ...prev, [sessionId]: viewNow }));
      watch(sessionId);
      await pull(managerChannel(viewNow.managerId), true);
    } catch (err) {
      setError(errorCopy(err, roster));
    }
  };

  const withPending = async (work: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await work();
      reloadState();
    } catch (err) {
      setError(errorCopy(err, roster));
    } finally {
      setPending(false);
    }
  };

  const toggleGrant = (managerId: string, connector: string, on: boolean) =>
    void withPending(() => {
      const current = state.grants[managerId] ?? [];
      const next = on ? [...new Set([...current, connector])] : current.filter((c) => c !== connector);
      return setGrants(managerId, next);
    });

  const saveRoutine = (routineId: string, input: SwarmRoutineInput) => void withPending(() => upsertRoutine(routineId, input));
  const removeRoutine = (routineId: string) => void withPending(() => deleteRoutine(routineId));
  const runNow = (managerId: string, brief: string) => {
    select(managerChannel(managerId));
    void run(managerId, brief, "run_now");
  };

  const reset = async () => {
    setConfirmReset(false);
    try {
      await resetSwarm();
      setMessages({});
      setSessions({});
      setWatched(new Set());
      lastSeq.current = {};
      select("group");
      setText("");
      setError("");
      reloadState();
    } catch (err) {
      setError(errorCopy(err, roster));
    }
  };

  const bringOver = async () => {
    if (!legacy) return;
    const legacyRoster = mapRoster(legacy.rosterWire);
    await withPending(async () => {
      await importSandbox(clientId(), legacy.rosterWire, importMessagesOf(legacy.thread, legacyRoster));
      clearLegacy();
      setLegacy(null);
      lastSeq.current = {};
      setMessages({});
    });
  };

  const discardLegacy = () => {
    clearLegacy();
    setLegacy(null);
  };

  const newWorkflow = () => {
    select("group");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  // A failed first load must not read as an empty team that is ready to go.
  const loadFailed = resource.error && !resource.data;
  const notice = loadFailed
    ? "Couldn't load your Swarm. Your team is safe on the server; Aura will retry."
    : runtimeNotice(state.runtimeProblem);
  const status = loadFailed
    ? { text: "Can't reach Swarm", warn: true }
    : state.runtimeProblem
    ? { text: state.runtimeProblem === "wallet_exhausted" ? "Budget used up today" : "Not set up yet", warn: true }
    : { text: working.size > 0 ? `${working.size} working` : "Ready", warn: false };
  const showImport = legacy !== null && resource.data !== null;
  const banner = showImport ? (
          <div className="db-swarm-import" role="status">
            {state.rosterExists ? (
              <>
                <span>This computer still has the team from the old Swarm sandbox. Your account already has a Swarm, so it cannot be merged in.</span>
                <button type="button" className="db-swarm-pill-btn" onClick={discardLegacy}>Clear it</button>
              </>
            ) : (
              <>
                <span>Your Swarm sandbox team is saved on this computer. Bring it into your account so its managers can start working?</span>
                <button type="button" className="db-swarm-pill-btn is-primary" onClick={() => void bringOver()} disabled={pending}>Bring it over</button>
                <button type="button" className="db-swarm-pill-btn" onClick={discardLegacy} disabled={pending}>Start fresh</button>
              </>
            )}
          </div>
        ) : null;

  return (
    <div className={`db-swarm${rosterOpen ? " is-roster-open" : ""}`}>
      <div className="db-swarm-aurora" aria-hidden="true" />
      <SwarmChannels
        roster={roster}
        channel={liveChannel}
        unread={unread}
        working={working}
        status={status}
        freshManagers={freshManagers}
        supervisorFresh={supervisorFresh}
        onSelect={select}
        onNewWorkflow={newWorkflow}
      />
        <SwarmStream
          view={view}
          items={items}
          roster={roster}
          openDrafts={openDrafts}
          fresh={freshItems}
          busy={busy}
          busyHere={busy && busyChannel === liveChannel && liveChannel === "group"}
          busyAuthor={frontDoorAuthor(roster)}
          busySince={busySince}
          error={error}
          onDismissError={() => setError("")}
          notice={notice}
          noticeEverywhere={loadFailed}
          sessions={sessions}
          stopping={stopping}
          onStop={(id) => void stop(id)}
          rounds={rounds}
          onStopRound={(id) => void stopRound(id)}
          onOpenChannel={select}
          onAnswerSession={(id, value) => void answerManager(id, value)}
          grants={state.grants}
          onGrant={(managerId, connector) => toggleGrant(managerId, connector, true)}
          onOpenSource={(url) => void openUrl(url)}
          onOpenResearch={(runId) => navigate(`/agents?tab=research&run=${encodeURIComponent(runId)}`)}
          text={text}
          onText={setText}
          onSubmit={() => void submit()}
          freeAnswers={freeAnswers}
          onFreeAnswer={(draftId, value) => setFreeAnswers((prev) => ({ ...prev, [draftId]: value }))}
          onAnswer={(draftId, label, managerId) => void route({ text: "", draftId, choiceLabel: label, choiceManagerId: managerId })}
          confirmReset={confirmReset}
          onAskReset={setConfirmReset}
          onReset={() => void reset()}
          rosterOpen={rosterOpen}
          onToggleRoster={() => setRosterOpen((open) => !open)}
          composerRef={composerRef}
          banner={banner}
        />
      <SwarmRosterPanel
        roster={roster}
        focusedManagerId={managerIdOfChannel(liveChannel)}
        freshManagers={freshManagers}
        supervisorFresh={supervisorFresh}
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        grants={state.grants}
        grantable={state.grantable}
        routines={state.routines}
        pending={pending}
        onToggleGrant={toggleGrant}
        onSaveRoutine={saveRoutine}
        onDeleteRoutine={removeRoutine}
        onRunNow={runNow}
      />
    </div>
  );
}
