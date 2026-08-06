import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, History, Send, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BarIconButton } from "./BarIconButton";
import { GlassSurface } from "./GlassSurface";
import type { ChatScreenState } from "./useChatScreenCapture";
import "./ChatSlot.css";

/** The five states the transcript has to render across user and assistant turns.
 * The union is shared rather than split by role. */
export type ChatMessageState = "sent" | "queued" | "failed" | "streaming" | "complete";
export type ChatLane = "cold" | "live";

export interface ChatMessage {
  id: string;
  turnId?: string;
  role: "user" | "assistant" | "system";
  text: string;
  state: ChatMessageState;
  lane?: ChatLane;
  queuePosition?: number;
  kind?: "text" | "status" | "clarification" | "limit" | "error" | "degraded" | "divider" | "reminder";
  clarificationId?: string;
  options?: string[];
  multiSelect?: boolean;
  selectedOptions?: string[];
}

interface ChatSlotProps {
  messages: ChatMessage[];
  onClose: () => void;
  onHistory: () => void;
  onSend: (message: string) => boolean;
  onRetry: (messageId: string) => void;
  onClarification: (messageId: string, selectedOptions: string[]) => void;
  sending: boolean;
  limitReached: boolean;
  lane: ChatLane;
  /** Bumped every time the chat hotkey fires, including while the slot is
   * already open, so the composer takes the caret back. */
  focusNonce: number;
  screen: ChatScreenState;
  /** Reports the card's measured height so OverlayRoot can size the window to
   * the transcript instead of reserving a fixed block of empty glass. */
  onHeightChange?: (height: number) => void;
}

// How close to the bottom still counts as "following along". Anything further
// up means the user scrolled back on purpose and new content must not yank
// them away from what they were reading.
const AUTOSCROLL_STICK_PX = 24;

/** The composer caps typed and pasted input here, but useChatSession enforces
 * it again on the way out: a clarification reply is built from server-supplied
 * option text, which never passes through the textarea. */
export const MAX_MESSAGE_LENGTH: Record<ChatLane, number> = {
  cold: 8_000,
  live: 2_000,
};
const COUNTER_THRESHOLD: Record<ChatLane, number> = {
  cold: 7_200,
  live: 1_800,
};

/** Header (40) + the transcript's 260px floor + the body's own 8px padding +
 * composer (48): what an empty chat
 * renders at, used for the frame before the first measurement lands. The card's
 * height is otherwise never computed here - CSS sizes it to its content and the
 * measured result is what gets reported. Predicting it from row constants and
 * then stretching the card to the window is what put empty glass under the
 * composer for three rounds: two owners, no way to tell which one was wrong. */
export const INITIAL_CHAT_SLOT_HEIGHT = 356;

/** During a call the worker attaches screen frames to spoken turns only, so a
 * chip here would promise something the live lane cannot deliver. */
function screenChipVisible(lane: ChatLane, screen: ChatScreenState): boolean {
  return lane !== "live" && screen.armed && screen.previewUrl !== null;
}

/** Only model prose goes through the markdown renderer. Every other kind is one
 * of our own short strings (a status line, a divider label, an error), where
 * markdown would only add block spacing and could mangle stray punctuation. */
function rendersMarkdown(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.kind === undefined || message.kind === "text" || message.kind === "reminder";
}

function ClarificationChoices({
  message,
  disabled,
  onSubmit,
}: {
  message: ChatMessage;
  disabled: boolean;
  onSubmit: (selectedOptions: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(message.selectedOptions ?? []),
  );
  const answered = message.selectedOptions !== undefined;

  function choose(option: string) {
    if (answered || disabled) return;
    if (!message.multiSelect) {
      setSelected(new Set([option]));
      onSubmit([option]);
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(option)) next.delete(option);
      else next.add(option);
      return next;
    });
  }

  return (
    <div className="chat-clarification-options">
      {message.options?.map((option) => (
        <button
          type="button"
          key={option}
          className={`chat-clarification-option${selected.has(option) ? " selected" : ""}`}
          disabled={answered || disabled}
          onClick={() => choose(option)}
        >
          {option}
        </button>
      ))}
      {message.multiSelect && !answered && !disabled && selected.size > 0 && (
        <button
          type="button"
          className="chat-clarification-done"
          onClick={() => onSubmit(Array.from(selected))}
        >
          Done
        </button>
      )}
    </div>
  );
}

export function ChatSlot({
  messages,
  onClose,
  onHistory,
  onSend,
  onRetry,
  onClarification,
  sending,
  limitReached,
  lane,
  focusNonce,
  screen,
  onHeightChange,
}: ChatSlotProps) {
  const [message, setMessage] = useState("");
  const trimmedMessage = message.trim();
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const maxMessageLength = MAX_MESSAGE_LENGTH[lane];
  // Near the cap the count moves inside the field, so the textarea has to give
  // up room on the right for it.
  const counterVisible = message.length > COUNTER_THRESHOLD[lane];

  // Disabling the textarea mid-turn blurs it, and the browser does not restore
  // focus when it re-enables. Refocusing on every enabled transition (mount
  // included) is what keeps the composer usable from the keyboard after the
  // first reply, and keeps the first Escape on the composer's own handler
  // instead of the overlay's window handler, which would close the panel.
  const composerDisabled = sending || limitReached;
  useEffect(() => {
    if (composerDisabled) return;
    composerRef.current?.focus();
  }, [composerDisabled, focusNonce]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickToBottomRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [messages]);

  function handleBodyScroll() {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= AUTOSCROLL_STICK_PX;
  }

  const chipVisible = screenChipVisible(lane, screen);

  // A readback of what the browser already drew, not a prediction of it: CSS
  // sizes the card to its content, and the window is told that exact number. A
  // stale frame can then only ever show as transparent space beside the card,
  // never as glass the card was stretched to fill.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !onHeightChange) return;
    const report = () => onHeightChange(Math.ceil(card.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [onHeightChange]);

  const screenToggleTitle = lane === "live"
    ? "Ask out loud and Aura already sees your screen"
    : screen.armed
      ? "Screen is attached to your next message"
      : "Attach your screen to the next message";

  function sendMessage() {
    if (!trimmedMessage || trimmedMessage.length > maxMessageLength || sending || limitReached) return;
    // Sending always returns the user to the live end of the transcript.
    stickToBottomRef.current = true;
    if (onSend(trimmedMessage)) setMessage("");
  }

  return (
    <GlassSurface className="chat-slot" draggable={false}>
      <div className={`chat-slot-inner${chipVisible ? " has-chip" : ""}`} ref={cardRef}>
        <header className="chat-slot-header">
          <BarIconButton title="Chat history" onClick={onHistory} className="chat-slot-history">
            <History aria-hidden="true" />
          </BarIconButton>
          <BarIconButton title="Close chat" onClick={onClose} className="chat-slot-close">
            <X aria-hidden="true" />
          </BarIconButton>
        </header>

        <div className="chat-slot-body" aria-live="polite" ref={bodyRef} onScroll={handleBodyScroll}>
          <div className="chat-slot-transcript">
          {messages.map((item) => (
            <div
              key={item.id}
              className={`chat-message chat-message-${item.role} chat-message-${item.state}`}
            >
              <div className={`chat-message-bubble chat-message-kind-${item.kind ?? "text"}`}>
                {rendersMarkdown(item) ? (
                  <div className="chat-markdown">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      skipHtml
                      disallowedElements={["a", "img"]}
                      unwrapDisallowed
                    >
                      {item.text}
                    </Markdown>
                  </div>
                ) : (
                  item.text
                )}
                {item.state === "streaming" && !rendersMarkdown(item) && (
                  <span className="chat-message-caret" aria-hidden="true" />
                )}
                {item.kind === "clarification" && (
                  <ClarificationChoices
                    message={item}
                    disabled={sending}
                    onSubmit={(selectedOptions) => onClarification(item.id, selectedOptions)}
                  />
                )}
              </div>
              {item.state === "queued" && (
                <span className="chat-message-note">
                  {item.queuePosition ? `Queued, ${item.queuePosition} ahead` : "Queued"}
                </span>
              )}
              {item.role === "user" && item.lane === "live" && item.state === "sent" && (
                <span className="chat-message-note">Sending</span>
              )}
              {item.role === "user" && item.state === "failed" && (
                <div className="chat-message-failure">
                  <span className="chat-message-note">Failed</span>
                  <button
                    type="button"
                    className="chat-message-retry"
                    disabled={sending || (item.lane === "live" && lane !== "live")}
                    title={item.lane === "live" && lane !== "live" ? "Start a voice session to retry" : "Retry"}
                    onClick={() => onRetry(item.id)}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          ))}
          </div>
        </div>

        {chipVisible && (
          <div className="chat-screen-chip">
            <img className="chat-screen-thumb" src={screen.previewUrl ?? undefined} alt="" />
            <span className="chat-screen-label">Screen attached</span>
            <button
              type="button"
              className="chat-screen-remove"
              aria-label="Remove screen"
              title="Remove screen"
              onClick={screen.remove}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}

        <form
          className="chat-slot-composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <div className={`chat-slot-input${counterVisible ? " counting" : ""}`}>
            <button
              type="button"
              className={`chat-screen-toggle${screen.armed && lane !== "live" ? " armed" : ""}`}
              aria-pressed={screen.armed && lane !== "live"}
              disabled={lane === "live"}
              title={screenToggleTitle}
              onClick={screen.toggle}
            >
              {screen.armed && lane !== "live"
                ? <Eye aria-hidden="true" />
                : <EyeOff aria-hidden="true" />}
            </button>
            <textarea
              rows={1}
              ref={composerRef}
              value={message}
              maxLength={maxMessageLength}
              aria-label="Chat message"
              placeholder={limitReached ? "Daily chat limit reached" : "Message Aura"}
              disabled={composerDisabled}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // First Escape only drops focus and keeps the draft text. It must
                // not reach the overlay's window-level Escape handler, which
                // closes the slot and would take a half-typed message with it.
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  composerRef.current?.blur();
                  return;
                }
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                sendMessage();
              }}
            />
            {counterVisible && (
              <span className="chat-slot-counter">
                {message.length.toLocaleString()} / {maxMessageLength.toLocaleString()}
              </span>
            )}
          </div>
          <button
            type="submit"
            className="chat-slot-send"
            aria-label="Send message"
            title="Send message"
            disabled={!trimmedMessage || trimmedMessage.length > maxMessageLength || sending || limitReached}
          >
            <Send aria-hidden="true" />
          </button>
        </form>
      </div>
    </GlassSurface>
  );
}
