import { useCallback, useLayoutEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CloseIcon } from "./icons";
import { boundedDraftSlotHeight } from "./DraftCard";
import { logError } from "../lib/log";
import type { PendingAction } from "../lib/pendingActions";
import type { PendingActionsState } from "./usePendingActions";
import "./ActionApprovalCard.css";

const CONNECTOR_NAMES: Record<PendingAction["connector"], string> = {
  x: "X",
  linkedin: "LinkedIn",
  github: "GitHub",
};

function approveLabel(action: PendingAction): string {
  return action.tool === "create_github_issue" ? "Create issue" : "Post";
}

function outcomeCopy(action: PendingAction): string {
  const name = CONNECTOR_NAMES[action.connector];
  if (action.status === "done") {
    return action.tool === "create_github_issue" ? "Issue created on GitHub." : `Posted to ${name}.`;
  }
  if (action.status === "expired") return "This expired. Ask again to prepare it.";
  if (action.status === "rejected") return "Discarded. Nothing was posted.";
  if (action.status === "unknown" || action.status === "executing") {
    return `Aura couldn't confirm it went through. Check ${name} before trying again.`;
  }
  switch (action.resultReason) {
    case "reauthorization_required":
      return `${name} needs to be reconnected. Turn it back on in Connectors.`;
    case "budget_user":
      return "You've reached this month's posting limit for X.";
    case "budget_global":
      return "Posting to X is paused for now. Try again later.";
    case "rate_limited":
      return `${name} is limiting requests right now. Try again in a few minutes.`;
    case "no_issue_access":
    case "repo_no_access":
      return "Aura can't open issues in that repository. Add it to the Aura app on GitHub.";
    case "repo_ambiguous":
    case "repo_not_found":
      return "Aura couldn't tell which repository you meant. Ask again with its full name.";
    case "issues_disabled":
      return "Issues are turned off for that repository.";
    default:
      return `${name} didn't accept it. Nothing was posted.`;
  }
}

/**
 * The approval card for one connector write. Nothing is posted until the user
 * clicks the primary button here; voice and chat can only put the card up.
 * Rendered by OverlayRoot above chat and drafts, below only a live Interview
 * Companion, and measured like DraftCard so the slot fits the text.
 */
export function ActionApprovalCard({
  actions,
  onHeightChange,
}: {
  actions: PendingActionsState;
  onHeightChange?: (height: number) => void;
}) {
  const action = actions.current;
  const innerRef = useRef<HTMLDivElement>(null);

  const measureHeight = useCallback(() => {
    const inner = innerRef.current;
    if (!inner || !onHeightChange) return;
    const style = window.getComputedStyle(inner);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const children = Array.from(inner.children) as HTMLElement[];
    const childrenHeight = children.reduce(
      (total, child) => total + Math.max(child.scrollHeight, child.getBoundingClientRect().height),
      0,
    );
    onHeightChange(boundedDraftSlotHeight(
      padding + childrenHeight + gap * Math.max(0, children.length - 1),
      window.screen?.availHeight ?? 700,
    ));
  }, [onHeightChange]);

  useLayoutEffect(() => {
    measureHeight();
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureHeight);
    observer.observe(inner);
    Array.from(inner.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [measureHeight, action, actions.error, actions.busy]);

  if (!action) return null;
  const name = CONNECTOR_NAMES[action.connector];
  const showingOutcome = actions.showingOutcome;
  const overLimit = action.preview.charLimit !== null && action.preview.chars > action.preview.charLimit;

  return (
    <GlassSurface className="action-card ph-no-capture" draggable={false}>
      <div className="action-card-inner" ref={innerRef}>
        <div className="action-card-header">
          <span className="action-card-title">
            {showingOutcome
              ? name
              : `${action.title}${action.preview.account ? ` as ${action.preview.account}` : ""}`}
          </span>
          <BarIconButton
            title={showingOutcome ? "Close" : "Not now"}
            onClick={() => (showingOutcome ? actions.dismissOutcome() : actions.reject(action.approvalId))}
          >
            <CloseIcon />
          </BarIconButton>
        </div>

        {showingOutcome ? (
          <p className={`action-card-outcome${action.status === "done" ? "" : " action-card-outcome-error"}`}>
            {outcomeCopy(action)}
          </p>
        ) : (
          <>
            {action.tool === "create_github_issue" && (
              <p className="action-card-meta">
                {action.preview.repo}
                <span className="action-card-issue-title">{action.preview.title}</span>
              </p>
            )}
            {action.preview.text && <p className="action-card-text">{action.preview.text}</p>}
            <p className="action-card-meta">
              {action.preview.charLimit !== null
                ? `${action.preview.chars} / ${action.preview.charLimit} characters`
                : `${action.preview.chars} characters`}
              {action.connector === "x" && action.preview.hasLink && (
                <span className="action-card-warning">Has a link</span>
              )}
            </p>
          </>
        )}

        {actions.error && <p className="action-card-outcome action-card-outcome-error">{actions.error}</p>}

        <div className="action-card-buttons">
          {showingOutcome ? (
            action.status === "done" && action.resultUrl && (
              <button
                type="button"
                className="action-card-button action-card-button-primary"
                onClick={() => {
                  const url = action.resultUrl;
                  if (url) void openUrl(url).catch((err) => logError("ActionApprovalCard: open", err));
                  actions.dismissOutcome();
                }}
              >
                Open on {name}
              </button>
            )
          ) : (
            <>
              <button
                type="button"
                className="action-card-button action-card-button-primary"
                disabled={actions.busy || overLimit || action.status !== "pending"}
                onClick={() => actions.approve(action.approvalId)}
              >
                {actions.busy ? "Working" : approveLabel(action)}
              </button>
              <button
                type="button"
                className="action-card-button"
                disabled={actions.busy}
                onClick={() => actions.reject(action.approvalId)}
              >
                Not now
              </button>
            </>
          )}
        </div>
      </div>
    </GlassSurface>
  );
}
