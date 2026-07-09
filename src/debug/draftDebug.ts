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
