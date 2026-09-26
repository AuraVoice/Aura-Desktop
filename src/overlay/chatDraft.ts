// The composer's unsent text, held outside the ChatSlot component. The slot
// unmounts whenever the chat closes (Escape, the hotkey, the overlay hiding),
// and a half-typed message used to go with it. Memory only, on purpose: a
// draft should not outlive the process or follow a sign-out, and the effort
// level is the only composer state worth persisting (ChatEffortPopover).

let draft = "";

export function readChatDraft(): string {
  return draft;
}

export function storeChatDraft(text: string): void {
  draft = text;
}

export function clearChatDraft(): void {
  draft = "";
}
