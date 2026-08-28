import { useEffect, useMemo, useState } from "react";
import {
  getSessionDetail,
  type RawHistorySession,
} from "../lib/dashboardApi";
import { dashboardCacheKey, readCache, writeCache } from "../lib/dashboardCache";
import { logError } from "../lib/log";
import {
  countWords,
  durationSeconds,
  tokenize,
  topCatchphrases,
  wordFrequencies,
  type WordCount,
} from "../lib/voiceInsights";
import { useDashboardScopeUid } from "./useDashboardResource";

/**
 * Mines the user's own spoken turns (role === "user") from recent voice
 * conversations into word/phrase frequencies for the Insights voice tab.
 *
 * Cost discipline: transcripts require one GET per session, so the mine is
 * bounded to the 20 most recent sessions, fetched in chunks of 4, and the
 * result is persisted via dashboardCache keyed by a fingerprint of the
 * session-id set. The input set fully determines the output, so there is no
 * TTL: the mine reruns only when the recent-session set itself changes.
 */

const MAX_SESSIONS = 20;
const FETCH_CHUNK = 4;
// v3: catchphrase became catchphrases[]; the version suffix invalidates older
// envelopes whose payload has a different shape.
const CACHE_NAME = "insights:voice-lexicon:v3";

export interface VoiceLexicon {
  fingerprint: string;
  topWords: WordCount[];
  catchphrases: WordCount[];
  totalUserWords: number;
  /** Whitespace word count across BOTH speakers' turns. Divided by
   * minedSeconds this gives dialogue pace, which equals the user's speaking
   * pace under proportional floor-time allocation; the user's words alone
   * over the whole session would understate pace several-fold since the
   * session clock includes Aura's speech, model latency, and silence. */
  totalDialogueWords: number;
  /** Total voice seconds across the mined sessions, so words-per-minute is
   * computed over the same corpus as the word count. */
  minedSeconds: number;
  minedAt: number;
}

/** Same FNV-1a shape dashboardCache uses internally (its hashPayload is
 * module-private); here it fingerprints the mined session-id set. */
function fingerprintIds(ids: string[]): string {
  const json = JSON.stringify([...ids].sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function useVoiceLexicon(
  sessions: RawHistorySession[] | undefined,
): VoiceLexicon | null {
  const uid = useDashboardScopeUid();
  const [lexicon, setLexicon] = useState<VoiceLexicon | null>(null);

  const recentIds = useMemo(() => {
    if (!sessions || sessions.length === 0) return [];
    return [...sessions]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .slice(0, MAX_SESSIONS)
      .map((item) => item.session_id);
  }, [sessions]);

  useEffect(() => {
    if (recentIds.length === 0) return;
    const fingerprint = fingerprintIds(recentIds);
    const cacheKey = dashboardCacheKey(uid, CACHE_NAME);
    let cancelled = false;

    const mine = async () => {
      const cached = await readCache<VoiceLexicon>(cacheKey);
      if (cancelled) return;
      if (cached?.data.fingerprint === fingerprint) {
        setLexicon(cached.data);
        return;
      }
      // Stale-while-remine: show the previous lexicon while the fresh set loads.
      if (cached) setLexicon(cached.data);

      const turnTokens: string[][] = [];
      let minedSeconds = 0;
      let totalDialogueWords = 0;
      for (let i = 0; i < recentIds.length; i += FETCH_CHUNK) {
        const chunk = recentIds.slice(i, i + FETCH_CHUNK);
        const settled = await Promise.allSettled(chunk.map((id) => getSessionDetail(id)));
        if (cancelled) return;
        for (const result of settled) {
          if (result.status !== "fulfilled") continue;
          minedSeconds += durationSeconds(result.value.total_duration);
          for (const turn of result.value.raw_turns ?? []) {
            if (!turn.text) continue;
            totalDialogueWords += countWords(turn.text);
            if (turn.role !== "user") continue;
            const tokens = tokenize(turn.text);
            if (tokens.length > 0) turnTokens.push(tokens);
          }
        }
      }

      const allTokens = turnTokens.flat();
      const mined: VoiceLexicon = {
        fingerprint,
        topWords: wordFrequencies(allTokens).slice(0, 3),
        catchphrases: topCatchphrases(turnTokens),
        totalUserWords: allTokens.length,
        totalDialogueWords,
        minedSeconds,
        minedAt: Date.now(),
      };
      if (cancelled) return;
      setLexicon(mined);
      void writeCache(cacheKey, mined, mined.minedAt);
    };

    mine().catch((err) => logError("voiceLexicon: mine", err));
    return () => {
      cancelled = true;
    };
  }, [uid, recentIds]);

  return lexicon;
}
