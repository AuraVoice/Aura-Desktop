import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { logError } from "../../lib/log";
import {
  clearDictationHistory,
  deleteDictationEntry,
  exportDictationAudio,
  exportDictationText,
  listDictationHistory,
  loadDictationAudioUrl,
  loadDictationHistorySettings,
  setDictationFlag,
  type DictationHistoryEntry,
  type DictationHistorySettings,
} from "../../lib/dictationHistory";
import { EmptyState } from "../components/EmptyState";
import { ExpandingSearch } from "../components/ExpandingSearch";
import { PageError } from "../components/PageError";
import { dayHeading, localDateKey } from "../format";
import { useAsyncData } from "../useAsyncData";
import { useDashboardUser } from "../useDashboardUser";
import { DictationFeedbackDialog } from "./dictation/DictationFeedbackDialog";
import { DictationRow, type PlaybackState } from "./dictation/DictationRow";
import { DictationSettingsRail } from "./dictation/DictationSettingsRail";

/** Debounce on the search box, so a fast typist does not re-group the list on
 * every keystroke. Short enough that the filter still feels immediate. */
const SEARCH_DEBOUNCE_MS = 120;

interface DayGroup {
  key: string;
  label: string;
  entries: DictationHistoryEntry[];
}

/** Groups an already-filtered list by local day, newest day first. Days that
 * lose every entry to the filter simply do not appear. */
function groupByDay(entries: DictationHistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const entry of entries) {
    const key = localDateKey(entry.recordedAtMs);
    if (!current || current.key !== key) {
      current = { key, label: dayHeading(entry.recordedAtMs), entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export function DictationPage() {
  const user = useDashboardUser();
  const uid = user?.uid ?? null;
  const signedIn = user !== null;

  const {
    data: entries,
    loading,
    error,
    reload,
  } = useAsyncData(
    () => (uid ? listDictationHistory(uid) : Promise.resolve([])),
    "dictation history",
  );

  // useAsyncData deliberately ignores changes to its fetcher closure, so the
  // uid it captured on mount is the uid it keeps using. Switching accounts
  // without remounting this page would otherwise leave the previous account's
  // list on screen, which is exactly what the Rust-side wipe exists to prevent.
  const loadedUidRef = useRef(uid);
  useEffect(() => {
    if (loadedUidRef.current === uid) return;
    loadedUidRef.current = uid;
    reload();
  }, [uid, reload]);

  const [settings, setSettings] = useState<DictationHistorySettings | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [rawShownIds, setRawShownIds] = useState<Set<string>>(new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<DictationHistoryEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DictationHistoryEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Exactly one clip is alive at a time: one <audio> element and one object
  // URL, so memory is bounded by the 120 second hold cap no matter how long the
  // list is. `loadingId` doubles as an out-of-order guard, so a slow fetch for
  // one row cannot overwrite a later fetch for another.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The live object URL is held in a ref as well as in state, so revoking it is
  // a plain side effect rather than something happening inside a state updater
  // (which React is free to call more than once).
  const activeUrlRef = useRef<string | null>(null);
  const [activePlay, setActivePlay] = useState<{ id: string; url: string } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!uid) return;
    let active = true;
    loadDictationHistorySettings(uid)
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch((err) => logError("DictationPage: history settings", err));
    return () => {
      active = false;
    };
  }, [uid, entries]);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    if (activeUrlRef.current) {
      URL.revokeObjectURL(activeUrlRef.current);
      activeUrlRef.current = null;
    }
    setActivePlay(null);
  }, []);

  // The object URL outlives every render, so it is revoked on unmount rather
  // than left for the webview to collect.
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const filtered = useMemo(() => {
    const all = entries ?? [];
    if (debouncedQuery === "") return all;
    return all.filter((entry) => entry.text.toLowerCase().includes(debouncedQuery));
  }, [entries, debouncedQuery]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  const playbackFor = (id: string): PlaybackState => {
    if (loadingId === id) return "loading";
    if (activePlay?.id === id) return "playing";
    return "idle";
  };

  async function play(entry: DictationHistoryEntry) {
    if (!uid) return;
    if (activePlay?.id === entry.id) {
      stopPlayback();
      return;
    }
    stopPlayback();
    setLoadingId(entry.id);
    setNotice(null);
    try {
      const url = await loadDictationAudioUrl(uid, entry.id);
      const element = audioRef.current;
      if (!element) {
        URL.revokeObjectURL(url);
        return;
      }
      element.src = url;
      activeUrlRef.current = url;
      await element.play();
      setActivePlay({ id: entry.id, url });
    } catch (err) {
      logError("DictationPage: play", err);
      setNotice("The audio for that dictation could not be played.");
      // The row may have been claiming audio it no longer has; a reload
      // recomputes has_audio from what is actually on disk.
      reload();
    } finally {
      setLoadingId(null);
    }
  }

  async function runExport(
    entry: DictationHistoryEntry,
    exporter: (uid: string, id: string) => Promise<string>,
    failure: string,
  ) {
    if (!uid) return;
    setNotice(null);
    let path: string;
    try {
      path = await exporter(uid, entry.id);
    } catch (err) {
      logError("DictationPage: export", err);
      setNotice(failure);
      return;
    }
    // Writing the file and opening it are separate failures with separate
    // fixes. Collapsing them told the user the export failed when the file was
    // sitting in Downloads the whole time, and only the opener scope refused.
    try {
      await openPath(path);
    } catch (err) {
      logError("DictationPage: open export", err);
      setNotice(`Saved to ${path}, but Aura could not open it.`);
    }
  }

  async function remove(entry: DictationHistoryEntry) {
    if (!uid) return;
    if (activePlay?.id === entry.id) stopPlayback();
    setConfirmDelete(null);
    try {
      await deleteDictationEntry(uid, entry.id);
      reload();
    } catch (err) {
      logError("DictationPage: delete", err);
      setNotice("That dictation could not be deleted.");
    }
  }

  async function clearAll() {
    if (!uid) return;
    stopPlayback();
    setConfirmClear(false);
    try {
      await clearDictationHistory(uid);
      reload();
    } catch (err) {
      logError("DictationPage: clear", err);
      setNotice("The history could not be cleared.");
    }
  }

  async function markFlagged(entry: DictationHistoryEntry) {
    if (!uid) return;
    try {
      await setDictationFlag(uid, entry.id, true);
      reload();
    } catch (err) {
      logError("DictationPage: flag", err);
    }
  }

  const toggleExpanded = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Turning the raw view on also expands the row: a clamped final text above
  // an unclamped original reads as two different dictations.
  const toggleRaw = (id: string) =>
    setRawShownIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
        setExpandedIds((expanded) => new Set(expanded).add(id));
      }
      return next;
    });

  const historyOff = settings?.enabled === false;

  return (
    <div className="db-page db-page-wide db-dictation-page">
      <audio
        ref={audioRef}
        onEnded={stopPlayback}
        onError={() => {
          stopPlayback();
          setNotice("The audio for that dictation could not be played.");
        }}
        hidden
      />

      <div className="db-dictation-layout">
        <div className="db-dictation-main">
          <div className="db-dictation-toolbar">
            <ExpandingSearch
              value={query}
              onChange={setQuery}
              placeholder="search for past transcripts"
              label="Search past transcripts"
            />
          </div>

          {notice && <p className="db-trace-note">{notice}</p>}
          {historyOff && (
            <p className="db-trace-note">
              Saving new dictations is turned off. What was already kept is still
              here until you clear it.
            </p>
          )}

          {error ? (
            <PageError authExpired={false} onRetry={reload} />
          ) : !signedIn ? (
            <EmptyState
              Icon={Mic}
              heading="Sign in to see your dictations"
              copy="Your dictation history is stored on this PC under your account."
            />
          ) : groups.length === 0 && !loading ? (
            <EmptyState
              Icon={Mic}
              heading={debouncedQuery ? "No transcripts match that" : "Nothing dictated yet"}
              copy={
                debouncedQuery
                  ? "Try a different word from the dictation you are looking for."
                  : "Hold the dictation keys and speak. What you dictate will show up here."
              }
            />
          ) : (
            groups.map((group) => (
              <section key={group.key} className="db-dictation-day-group">
                <h2 className="db-dictation-day">{group.label}</h2>
                <div className="db-dictation-day-card">
                  {group.entries.map((entry) => (
                    <DictationRow
                      key={entry.id}
                      entry={entry}
                      playback={playbackFor(entry.id)}
                      expanded={expandedIds.has(entry.id) || debouncedQuery !== ""}
                      showRaw={rawShownIds.has(entry.id)}
                      menuOpen={openMenuId === entry.id}
                      onMenuOpenChange={(open) => setOpenMenuId(open ? entry.id : null)}
                      onPlay={() => void play(entry)}
                      onToggleExpanded={() => toggleExpanded(entry.id)}
                      onToggleRaw={() => toggleRaw(entry.id)}
                      onFlag={() => setFeedbackFor(entry)}
                      onDelete={() => setConfirmDelete(entry)}
                      onExportText={() =>
                        void runExport(
                          entry,
                          exportDictationText,
                          "That transcript could not be saved.",
                        )
                      }
                      onExportAudio={() =>
                        void runExport(
                          entry,
                          exportDictationAudio,
                          "That audio could not be extracted.",
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        <DictationSettingsRail
          uid={uid}
          signedIn={signedIn}
          historySettings={settings}
          onHistoryChanged={setSettings}
          onClearHistory={() => setConfirmClear(true)}
        />
      </div>

      {feedbackFor && (
        <DictationFeedbackDialog
          entry={feedbackFor}
          onClose={() => setFeedbackFor(null)}
          onSubmitted={() => {
            const entry = feedbackFor;
            setFeedbackFor(null);
            setNotice("Thanks. That report was sent.");
            void markFlagged(entry);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this transcript?"
          body="The transcript and its audio are removed from this PC. This cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear your dictation history?"
          body="Every stored transcript and audio clip is removed from this PC. This cannot be undone."
          confirmLabel="Clear everything"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearAll()}
        />
      )}
    </div>
  );
}

/** Portalled into `.db-app` rather than document.body, so it keeps the theme
 * tokens and the app-wide scrollbar rule. */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const host = document.querySelector(".db-app");
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  if (!host) return null;

  return createPortal(
    // `db-local-confirm` is the fixed, grid-centred wrapper; the scrim is its
    // absolutely positioned sibling. The panel must not live inside the scrim,
    // or it has nothing centring it and lands in the top left corner.
    <div className="db-local-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        className="db-local-confirm-scrim"
        aria-label="Cancel"
        onClick={onCancel}
      />
      {/* No icon medallion and no glyph on the button: the heading already
          names the action, and the red button already carries the weight. */}
      <div className="db-local-confirm-panel db-dictation-confirm">
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <div className="db-local-confirm-actions">
          <button type="button" className="db-local-confirm-cancel" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="db-local-confirm-delete" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
