import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Eye, EyeOff, Globe2, Loader2, Square, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GlassSurface } from "./GlassSurface";
import { openDashboardWindow } from "../lib/dashboardWindow";
import { browserTaskFailureMessage } from "../lib/browserTask";
import { logError } from "../lib/log";
import type { BrowserTaskState } from "./useBrowserTask";
import type { BrowserTaskStatusPayload } from "../lib/ipcEvents";
import "./BrowserTaskCard.css";

/** Must fit the rendered CSS (Rust grows the window by exactly this many
 * logical px). Four shapes share one card: the running chip (one 24px row
 * plus padding), the approval question (header, question, 28px actions),
 * the result (header, up to four lines of answer, 28px actions) and the
 * notice, a result with nothing to show beyond one sentence, which takes
 * the chip's single row. Each counts the 11px top inset that leaves room
 * for the corner X. The result's constant is only its first-paint guess:
 * the card measures its content and reports the exact height through
 * onHeightChange, so a one-line answer leaves no empty band below it. */
export const BROWSER_TASK_CHIP_HEIGHT = 59;
export const BROWSER_TASK_APPROVAL_HEIGHT = 111;
export const BROWSER_TASK_RESULT_HEIGHT = 129;
/** The corner X's radius: the card is inset by it on top (see the CSS). */
const CARD_TOP_INSET = 11;

/** A terminal payload with no answer and no source: every failure, and a
 * partial that saved nothing. One sentence is all there is to say. */
function isBareResult(result: BrowserTaskStatusPayload): boolean {
  return (result.answer ?? "").trim() === "" && result.sources.length === 0;
}

/** Which shape the card is in, and the slot height that goes with it. */
export function browserTaskSlotHeight(task: BrowserTaskState): number {
  if (task.approval) return BROWSER_TASK_APPROVAL_HEIGHT;
  if (task.live) return BROWSER_TASK_CHIP_HEIGHT;
  if (task.result && isBareResult(task.result)) return BROWSER_TASK_CHIP_HEIGHT;
  return BROWSER_TASK_RESULT_HEIGHT;
}

const APPROVAL_WINDOW_MS = 60_000;

function shortBrief(brief: string | null | undefined): string {
  const text = (brief ?? "").trim();
  if (text.length <= 60) return text;
  return `${text.slice(0, 57)}...`;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The browser task's slot card: a running chip with Watch and Stop, the
 * guard's approval question, or the result. Real <button>s only, per the
 * drag-region rule. Dark in both themes, like the meeting prompt: it sits over
 * whatever app the user is in and must read as "Aura is telling you".
 */
export function BrowserTaskCard({
  task,
  onHeightChange,
}: {
  task: BrowserTaskState;
  /** The result shape's measured slot height; the other shapes are fixed. */
  onHeightChange?: (height: number) => void;
}) {
  if (task.approval) return <ApprovalCard task={task} />;
  if (task.live) return <RunningChip task={task} />;
  if (task.result && isBareResult(task.result)) return <NoticeRow task={task} />;
  if (task.result) return <ResultCard task={task} onHeightChange={onHeightChange} />;
  return null;
}

/** One slim row for a result with nothing but a reason: glyph, the sentence,
 * a small Open, and the corner X. Same height as the running chip. */
function NoticeRow({ task }: { task: BrowserTaskState }) {
  const result = task.result;
  if (!result) return null;
  const message = browserTaskFailureMessage(result.reason);
  return (
    <GlassSurface className="browser-task-card browser-task-notice theme-pinned-dark" draggable={false}>
      <div className="browser-task-clip">
        <div className="browser-task-row">
          <span className={`browser-task-icon${result.phase === "partial" ? " is-warning" : " is-error"}`}>
            <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="browser-task-text" role="status" aria-live="polite">
            <span className="browser-task-message" title={message}>{message}</span>
          </span>
          <button
            type="button"
            className="browser-task-primary browser-task-pill"
            onClick={() => {
              void openDashboardWindow("/agents", result.taskId, "computer");
              task.dismissResult();
            }}
          >
            Open
          </button>
        </div>
      </div>
      <button type="button" className="browser-task-close" onClick={task.dismissResult} aria-label="Dismiss">
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </GlassSurface>
  );
}

function RunningChip({ task }: { task: BrowserTaskState }) {
  const status = task.status;
  const phaseLabel =
    status?.phase === "launching" || status?.phase === "starting"
      ? "Opening a browser"
      : status && status.steps > 0
        ? `Step ${status.steps}${hostOf(status.url) ? ` on ${hostOf(status.url)}` : ""}`
        : "Working on it";
  return (
    <GlassSurface className="browser-task-card browser-task-chip theme-pinned-dark" draggable={false}>
      <div className="browser-task-clip">
        <div className="browser-task-row">
          <span className="browser-task-icon">
            <Loader2 size={14} strokeWidth={2} aria-hidden="true" className="browser-task-spin" />
          </span>
          <span className="browser-task-text" role="status" aria-live="polite">
            <span className="browser-task-title" title={status?.brief ?? ""}>{shortBrief(status?.brief) || "Browser task"}</span>
            <span className="browser-task-message">{phaseLabel}</span>
          </span>
          <button
            type="button"
            className="browser-task-round"
            onClick={task.watch}
            aria-label={task.watching ? "Hide the browser" : "Watch the browser"}
            title={task.watching ? "Hide the browser" : "Watch the browser"}
          >
            {task.watching ? <EyeOff size={15} strokeWidth={2} aria-hidden="true" /> : <Eye size={15} strokeWidth={2} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="browser-task-round browser-task-stop"
            onClick={task.stop}
            aria-label="Stop the browser task"
            title="Stop"
          >
            <Square size={13} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}

function ApprovalCard({ task }: { task: BrowserTaskState }) {
  const approval = task.approval;
  const [openedAt] = useState(() => Date.now());
  const [remaining, setRemaining] = useState(APPROVAL_WINDOW_MS);
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, APPROVAL_WINDOW_MS - (Date.now() - openedAt)));
    }, 1000);
    return () => clearInterval(timer);
  }, [openedAt]);
  if (!approval) return null;
  const host = hostOf(approval.url);
  return (
    <GlassSurface className="browser-task-card browser-task-approval theme-pinned-dark" draggable={false}>
      <div className="browser-task-clip">
        <div className="browser-task-inner">
          <div className="browser-task-row">
            <span className="browser-task-icon is-warning">
              <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="browser-task-text">
              <span className="browser-task-title">{approval.description}</span>
              <span className="browser-task-message">
                {host ? `On ${host}. ` : ""}Buddy waits {Math.ceil(remaining / 1000)}s, then says no.
              </span>
            </span>
          </div>
          <div className="browser-task-actions">
            <button type="button" className="browser-task-secondary" onClick={() => task.approve(false)}>
              Don't
            </button>
            <button type="button" className="browser-task-primary" onClick={() => task.approve(true)}>
              Allow
            </button>
          </div>
        </div>
        <div
          className="browser-task-drain"
          style={{ animationDuration: `${APPROVAL_WINDOW_MS}ms` }}
        />
      </div>
    </GlassSurface>
  );
}

function ResultCard({ task, onHeightChange }: { task: BrowserTaskState; onHeightChange?: (height: number) => void }) {
  const result = task.result;
  const innerRef = useRef<HTMLDivElement>(null);
  // Same measurement as DraftCard: padding plus each child's rendered height
  // plus the gaps, so the window fits the content exactly, then re-measured
  // whenever a child changes size.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || !onHeightChange) return;
    const measure = () => {
      const style = window.getComputedStyle(inner);
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
      const children = Array.from(inner.children) as HTMLElement[];
      const content = children.reduce((total, child) => total + child.getBoundingClientRect().height, 0);
      onHeightChange(Math.ceil(CARD_TOP_INSET + padding + content + gap * Math.max(0, children.length - 1)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    Array.from(inner.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [onHeightChange, result]);
  if (!result) return null;
  const ok = result.phase === "done";
  const partial = result.phase === "partial";
  const title = ok ? "Buddy found it" : partial ? "Buddy stopped early" : "That did not work";
  const answer = (result.answer ?? "").trim();
  const message = answer || browserTaskFailureMessage(result.reason);
  const firstSource = result.sources[0] ?? null;
  return (
    <GlassSurface className="browser-task-card browser-task-result theme-pinned-dark" draggable={false}>
      <div className="browser-task-clip">
        <div className="browser-task-inner" ref={innerRef}>
          <div className="browser-task-row">
            <span className={`browser-task-icon${ok ? " is-ok" : partial ? " is-warning" : " is-error"}`}>
              {ok ? <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" /> : <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />}
            </span>
            <span className="browser-task-text">
              <span className="browser-task-title">{title}</span>
              <span className="browser-task-message" title={result.brief ?? ""}>{shortBrief(result.brief)}</span>
            </span>
          </div>
          <p className="browser-task-answer" title={message}>{message}</p>
          <div className="browser-task-actions">
            {firstSource && (
              <button
                type="button"
                className="browser-task-secondary"
                onClick={() => openUrl(firstSource).catch((err) => logError("BrowserTaskCard: open source", err))}
                title={firstSource}
              >
                <Globe2 size={13} strokeWidth={2} aria-hidden="true" /> {hostOf(firstSource) || "Source"}
              </button>
            )}
            <button
              type="button"
              className="browser-task-primary"
              onClick={() => {
                void openDashboardWindow("/agents", result.taskId, "computer");
                task.dismissResult();
              }}
            >
              Open
            </button>
          </div>
        </div>
      </div>
      <button type="button" className="browser-task-close" onClick={task.dismissResult} aria-label="Dismiss">
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </GlassSurface>
  );
}
