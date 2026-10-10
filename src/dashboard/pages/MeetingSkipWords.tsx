import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { logError } from "../../lib/log";
import { meetingActionFailureCopy, meetingSettingsCopy as copy } from "../../lib/meetingCopy";
import { getExcludeKeywords, MeetingActionError, putExcludeKeywords } from "../../lib/meetings";

/** Settings > Data and privacy > Private meetings. The words live on the
 *  server (users/{uid}/settings/meeting_notes) because synthesis is what reads
 *  them; every change is saved at once and the server's normalised list is
 *  what the chips show afterwards. */
export function MeetingSkipWords() {
  const [keywords, setKeywords] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getExcludeKeywords()
      .then((loaded) => {
        if (!cancelled) setKeywords(loaded);
      })
      .catch((err) => {
        logError("MeetingSkipWords: load", err);
        if (!cancelled) {
          setError(meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : ""));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setKeywords(await putExcludeKeywords(next));
      setSaved(true);
      trackEvent("meeting_exclude_keywords_saved", { count: next.length });
      return true;
    } catch (err) {
      logError("MeetingSkipWords: save", err);
      setError(meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : ""));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async () => {
    const word = draft.trim().replace(/\s+/g, " ").toLowerCase();
    if (!word || !keywords) return;
    if (keywords.includes(word)) {
      setDraft("");
      return;
    }
    if (await save([...keywords, word])) setDraft("");
  };

  return (
    <div className="db-panel db-settings-panel">
      <div className="db-setting-row db-skip-words">
        <span>
          <span className="db-setting-label">{copy.skipLabel}</span>
          <span className="db-setting-description">{copy.skipHint}</span>
          {keywords && (
            <span className="db-skip-words-chips">
              {keywords.length === 0 && <span className="db-setting-description">{copy.empty}</span>}
              {keywords.map((word) => (
                <span key={word} className="db-skip-word">
                  {word}
                  <button
                    type="button"
                    aria-label={copy.remove(word)}
                    disabled={saving}
                    onClick={() => void save(keywords.filter((item) => item !== word))}
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
              placeholder={copy.addPlaceholder}
              disabled={saving || keywords === null}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
              }}
            />
            <button
              type="submit"
              className="db-secondary-btn"
              disabled={saving || keywords === null || draft.trim().length === 0}
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
