import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { logError } from "../../lib/log";
import { meetingActionFailureCopy, meetingSettingsCopy as copy } from "../../lib/meetingCopy";
import {
  getMeetingWordList,
  MeetingActionError,
  putMeetingWordList,
  type MeetingWordListName,
} from "../../lib/meetings";

/** How each list reads and normalises. Skip words match titles case-blind,
 *  so they are stored lower-case; vocabulary keeps the user's casing because
 *  the transcriber spells a term exactly as given. */
const LISTS: Record<
  MeetingWordListName,
  { label: string; hint: string; placeholder: string; normalize: (word: string) => string }
> = {
  exclude_keywords: {
    label: copy.skipLabel,
    hint: copy.skipHint,
    placeholder: copy.addPlaceholder,
    normalize: (word) => word.toLowerCase(),
  },
  vocabulary: {
    label: copy.vocabularyLabel,
    hint: copy.vocabularyHint,
    placeholder: copy.vocabularyPlaceholder,
    normalize: (word) => word,
  },
};

/** One editable word list under /meetings/settings: Settings > Data and
 *  privacy > Private meetings (skip words), and Settings > General > Meeting
 *  Notes (vocabulary). The words live on the server
 *  (users/{uid}/settings/meeting_notes) because synthesis is what reads them;
 *  every change is saved at once and the server's normalised list is what
 *  the chips show afterwards. */
export function MeetingWordList({ list }: { list: MeetingWordListName }) {
  const spec = LISTS[list];
  const [words, setWords] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMeetingWordList(list)
      .then((loaded) => {
        if (!cancelled) setWords(loaded);
      })
      .catch((err) => {
        logError(`MeetingWordList(${list}): load`, err);
        if (!cancelled) {
          setError(meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : ""));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [list]);

  const save = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setWords(await putMeetingWordList(list, next));
      setSaved(true);
      trackEvent(`meeting_${list}_saved`, { count: next.length });
      return true;
    } catch (err) {
      logError(`MeetingWordList(${list}): save`, err);
      setError(meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : ""));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async () => {
    const word = spec.normalize(draft.trim().replace(/\s+/g, " "));
    if (!word || !words) return;
    if (words.some((item) => item.toLowerCase() === word.toLowerCase())) {
      setDraft("");
      return;
    }
    if (await save([...words, word])) setDraft("");
  };

  return (
    <div className="db-panel db-settings-panel">
      <div className="db-setting-row db-skip-words">
        <span>
          <span className="db-setting-label">{spec.label}</span>
          <span className="db-setting-description">{spec.hint}</span>
          {words && (
            <span className="db-skip-words-chips">
              {words.length === 0 && <span className="db-setting-description">{copy.empty}</span>}
              {words.map((word) => (
                <span key={word} className="db-skip-word">
                  {word}
                  <button
                    type="button"
                    aria-label={copy.remove(word)}
                    disabled={saving}
                    onClick={() => void save(words.filter((item) => item !== word))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </span>
          )}
          <form
            className="db-skip-words-add"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <input
              className="db-skip-words-input"
              value={draft}
              maxLength={40}
              placeholder={spec.placeholder}
              disabled={saving || words === null}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
              }}
            />
            <button
              type="submit"
              className="db-secondary-btn"
              disabled={saving || words === null || draft.trim().length === 0}
            >
              {copy.add}
            </button>
          </form>
          {error && <span className="db-skip-words-error" role="alert">{error}</span>}
          {saved && !error && <span className="db-setting-description" role="status">{copy.saved}</span>}
        </span>
      </div>
    </div>
  );
}
