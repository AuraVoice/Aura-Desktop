/** Dev-only harness for the Buddy Drafts card, following the pillDebug.ts
 * precedent: exercise the UI without a live voice call. useDraftCard installs
 * this under import.meta.env.DEV only, wiring window.__injectDraftEvent to the
 * SAME handler the LiveKit data channel feeds, so every card state is drivable
 * from the webview devtools console:
 *
 *   __injectDraftEvent({type: "draft.generating", payload: {draft_id: "d1", channel: "email_reply", length: "short", mode: "new"}})
 *   __injectDraftEvent({type: "draft.created", payload: {draft_id: "d1", revision: 1, channel: "email_reply", length: "short", text: "Hi Sarah,\n\nThanks for the invite but I have to pass this week.\n\nVarun", context_summary: "Declining Sarah's invite.", recipient_hint: "Sarah"}})
 *   __injectDraftEvent({type: "draft.updated", payload: {draft_id: "d1", revision: 2, length: "short", text: "Hey Sarah, thank you so much! I have to sit this one out."}})
 *   __injectDraftEvent({type: "draft.failed", payload: {draft_id: null, reason: "quota_exceeded"}})
 *   __injectDraftEvent({type: "draft.created", payload: {draft_id: "d2", revision: 1, channel: "snippet", length: "short", text: "Add-Content $PROFILE \"Set-Location C:\\Users\\varun\\MobileApps\"", context_summary: "Appends a Set-Location line to the PowerShell profile.", recipient_hint: ""}})
 *   __injectDraftEvent({type: "draft.created", payload: {draft_id: "a1", revision: 1, channel: "snippet", length: "short", text: "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned", context_summary: "", recipient_hint: "", artifact_kind: "command", content_format: "code", title: "Fix execution policy", language: "powershell", persisted: false}})
 *   __injectDraftEvent({type: "draft.created", payload: {draft_id: "a2", revision: 1, channel: "snippet", length: "short", text: "# Investigate this error\n\nInspect the authentication flow shown on screen.\n\n## Return\n- Root cause\n- Exact source locations\n- Minimal fix\n- Verification commands", context_summary: "", recipient_hint: "", artifact_kind: "prompt", content_format: "markdown", title: "Codebase investigation prompt", language: "", persisted: false}})
 *   __injectDraftEvent({type: "draft.created", payload: {draft_id: "a3", revision: 1, channel: "snippet", length: "short", text: "## Next steps\n\n1. Open **PowerShell** as your normal user.\n2. Run the command in the error output.\n3. Retry the original script.\n\n- [ ] Policy updated\n- [ ] Script rerun", context_summary: "", recipient_hint: "", artifact_kind: "checklist", content_format: "markdown", title: "Next steps", language: "", persisted: false}})
 *
 * The chips hit the real REST refine endpoint, and copy lands on the real
 * clipboard, so those two flows verify end-to-end from here too. */

export function installDraftDebugInjector(
  handler: (event: unknown) => void,
): () => void {
  const w = window as unknown as { __injectDraftEvent?: (event: unknown) => void };
  w.__injectDraftEvent = handler;
  return () => {
    if (w.__injectDraftEvent === handler) {
      delete w.__injectDraftEvent;
    }
  };
}
