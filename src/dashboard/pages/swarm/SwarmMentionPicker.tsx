import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { SwarmRoster } from "../../../lib/swarmApi";
import { useOutsideClick } from "../../components/useOutsideClick";
import { SwarmAvatar } from "./SwarmAvatar";
import { mentionCandidates } from "./swarmThread";

/** The "@sa" the caret sits at the end of, or null when it is not inside a mention. */
function tokenAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

const MAX_SHOWN = 6;

/**
 * "@" in the composer lists who can be named: the Supervisor, then every active
 * manager, narrowed as the user types. Arrows move, Enter or Tab picks, Escape closes.
 * The hook owns the state; the textarea calls `refresh` on every change and click, and
 * `onKeyDown` first so Enter picks a name instead of sending the message.
 */
export function useMentionPicker(roster: SwarmRoster, text: string, onText: (value: string) => void, composerRef: RefObject<HTMLTextAreaElement | null>) {
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => mentionCandidates(roster), [roster]);
  const candidates = useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    if (!q) return all.slice(0, MAX_SHOWN);
    return all
      .filter((c) => c.name.toLowerCase().startsWith(q) || `${c.name} ${c.title}`.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)))
      .slice(0, MAX_SHOWN);
  }, [all, token]);
  const open = token !== null && candidates.length > 0;

  const refresh = useCallback((value: string, caret: number) => {
    const next = tokenAt(value, caret);
    setToken((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
  }, []);
  const close = useCallback(() => setToken(null), []);

  // The composer emptied (a send) or lost its "@": nothing to pick from.
  useEffect(() => {
    if (token && (token.start >= text.length || text[token.start] !== "@")) setToken(null);
  }, [text, token]);
  useEffect(() => setActive(0), [token?.query, candidates.length]);

  useOutsideClick(popoverRef, close, open, composerRef);

  const pick = useCallback((index: number) => {
    const chosen = candidates[index];
    const el = composerRef.current;
    if (!chosen || !token) return;
    const caret = el ? el.selectionStart : token.start + 1 + token.query.length;
    const inserted = `@${chosen.name} `;
    const next = `${text.slice(0, token.start)}${inserted}${text.slice(caret)}`;
    onText(next);
    setToken(null);
    const pos = token.start + inserted.length;
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }, [candidates, composerRef, onText, text, token]);

  /** True when the key was the picker's; the caller then leaves it alone. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  const popover = open ? (
    <div className="db-swarm-mentions" ref={popoverRef} role="listbox" id="swarm-mentions" aria-label="Mention a manager">
      {candidates.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="option"
          id={`swarm-mention-${c.id}`}
          aria-selected={i === active}
          className={`db-swarm-mention-row${i === active ? " is-active" : ""}`}
          onPointerEnter={() => setActive(i)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => pick(i)}
        >
          <SwarmAvatar author={c.author} size="sm" />
          <span className="db-swarm-mention-text">
            <strong>{c.name}</strong>
            <span>{c.title}</span>
          </span>
        </button>
      ))}
    </div>
  ) : null;

  return {
    open,
    popover,
    refresh,
    onKeyDown,
    activeId: open ? `swarm-mention-${candidates[active]?.id ?? ""}` : undefined,
  };
}
