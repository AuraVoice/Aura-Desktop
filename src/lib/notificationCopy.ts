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

  // Absolute date + time stamp for the dashboard notification center, where a
  // row can be days old and "3d ago" alone is not enough. `now` is injectable
  // for tests.
  stampTime: (ms: number, now: number = Date.now()): string => {
    const at = new Date(ms);
    const ref = new Date(now);
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (sameDay(at, ref)) return `Today at ${time}`;
    const yesterday = new Date(ref);
    yesterday.setDate(ref.getDate() - 1);
    if (sameDay(at, yesterday)) return `Yesterday at ${time}`;
    const date = at.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      ...(at.getFullYear() !== ref.getFullYear() ? { year: "numeric" as const } : {}),
    });
    return `${date} at ${time}`;
  },

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
