// Copy for the notification inbox + toasts. Plain human phrasing, no em-dashes
// anywhere (house rule, mirrors meetingCopy.ts). A separate feature file for
// now; fold into copy.ts later if it stays small.

export const notifications = {
  // Kebab menu row + inbox.
  menuRow: "Notifications",
  inboxTitle: "Notifications",
  empty: "You're all caught up.",
  dismissTooltip: "Dismiss",
  closeTooltip: "Close",
  markAllRead: "Mark all read",

  // Row action labels (the inbox owns these; toasts are informational only).
  viewMeeting: "View insights",
  retryUpload: "Retry upload",
  openSettings: "Settings",

  // Generic, privacy-safe toast copy. The meeting title, insights, action
  // items, and participants NEVER appear on a lock screen.
  toastMeetingReady: "Your meeting insights are ready. Open Aura to view.",
  toastMeetingNeedsAttention: "A meeting needs your attention. Open Aura for details.",
  toastGeneric: "Aura has an update for you. Open Aura to view.",

  // Permission explainer, shown in-app BEFORE the OS prompt (never at startup).
  permissionExplainer:
    "Let Aura show a quick desktop alert when your meeting insights are ready or need attention.",
  permissionEnable: "Turn on alerts",
  permissionDismiss: "Not now",

  // Relative-time helper for a row timestamp.
  relativeTime: (ms: number): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  },
} as const;
