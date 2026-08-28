/**
 * Local text mining for the Insights "Your voice" tab. Everything here runs on
 * the user's own conversation turns already fetched from the backend; nothing
 * leaves the device. Deliberately tiny: a tokenizer, a stopword set, frequency
 * counts, and a weekday-by-hour peak finder.
 */

export interface WordCount {
  word: string;
  count: number;
}

export interface PeakMoment {
  weekday: string;
  hour: number;
  count: number;
  share: number;
}

/** English function words plus spoken-filler tokens that would otherwise win
 * every "most used word" slot. "aura" is filtered because the assistant's own
 * name is not an interesting fact about the speaker. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "all",
  "can", "her", "was", "one", "our", "out", "day", "get", "has", "him",
  "his", "how", "man", "new", "now", "old", "see", "two", "way", "who",
  "did", "its", "let", "put", "say", "she", "too", "use", "that", "with",
  "have", "this", "will", "from", "they", "know", "want", "been", "good",
  "much", "some", "time", "very", "when", "come", "here", "just", "like",
  "long", "make", "many", "more", "only", "over", "such", "take", "than",
  "them", "well", "were", "what", "would", "there", "their", "about",
  "which", "could", "other", "after", "first", "these", "thing", "things",
  "think", "where", "being", "every", "going", "should", "still", "those",
  "because", "actually", "basically", "literally", "really", "right",
  "yeah", "yes", "okay", "kay", "hey", "umm", "uhh", "hmm", "gonna",
  "wanna", "gotta", "kind", "sort", "mean", "into", "then", "also", "does",
  "doing", "done", "need", "needs", "something", "anything", "everything",
  "nothing", "someone", "please", "thanks", "thank", "little", "maybe",
  "even", "back", "down", "each", "few", "got", "had", "has", "having",
  "itself", "myself", "off", "once", "own", "same", "so", "up", "us",
  "why", "won't", "you're", "i'm", "it's", "that's", "don't", "can't",
  "didn't", "doesn't", "isn't", "let's", "we're", "what's", "there's",
  "aura",
]);

/** Lowercase word tokens; keeps apostrophes inside words, drops anything
 * shorter than 3 characters. */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z']*[a-z]|[a-z]{3,}/g) ?? [];
  return matches.filter((token) => token.length >= 3);
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Plain whitespace word count, for pace math. Unlike tokenize() it keeps
 * every word ("I", "a", "to"), since dropping short words would understate
 * words-per-minute by a third. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Descending frequency of non-stopword tokens. */
export function wordFrequencies(tokens: string[]): WordCount[] {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

function ngramCounts(turns: string[][], size: number, minCount: number): WordCount[] {
  const counts = new Map<string, number>();
  for (const tokens of turns) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const gram = tokens.slice(i, i + size);
      // A phrase made entirely of stopwords ("and then the") is noise.
      if (gram.every((token) => STOPWORDS.has(token))) continue;
      const key = gram.join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= minCount)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

/** Most repeated phrases across turns, best first: trigrams said at least 3
 * times ranked ahead of bigrams, and a bigram already contained in a chosen
 * longer phrase is skipped. N-grams never bridge turns. */
export function topCatchphrases(turnTokens: string[][], limit = 3): WordCount[] {
  const picked = ngramCounts(turnTokens, 3, 3).slice(0, limit);
  for (const bigram of ngramCounts(turnTokens, 2, 3)) {
    if (picked.length >= limit) break;
    if (picked.some((phrase) => phrase.word.includes(bigram.word))) continue;
    picked.push(bigram);
  }
  return picked;
}

/** Parses the backend's session `total_duration` strings: "h:mm:ss" / "mm:ss"
 * clock forms and "1h 2m 3s" human forms. Unrecognized input counts as 0. */
export function durationSeconds(value: string): number {
  const clock = value.trim().match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (clock) {
    return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const human = value.trim().match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/i);
  if (!human || !human.slice(1).some(Boolean)) return 0;
  return (
    Number(human[1] ?? 0) * 3600 +
    Number(human[2] ?? 0) * 60 +
    Number(human[3] ?? 0)
  );
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** Mode of weekday-by-hour session starts; null until a slot repeats. */
export function peakMoment(dates: Date[]): PeakMoment | null {
  if (dates.length === 0) return null;
  const counts = new Map<number, number>();
  for (const date of dates) {
    const slot = date.getDay() * 24 + date.getHours();
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  let bestSlot = -1;
  let bestCount = 0;
  for (const [slot, count] of counts) {
    if (count > bestCount) {
      bestSlot = slot;
      bestCount = count;
    }
  }
  if (bestCount < 2) return null;
  return {
    weekday: WEEKDAYS[Math.floor(bestSlot / 24)],
    hour: bestSlot % 24,
    count: bestCount,
    share: bestCount / dates.length,
  };
}

/** 0-23 to "12 a.m." / "3 p.m." style. */
export function formatHour(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${hour < 12 ? "a.m." : "p.m."}`;
}
