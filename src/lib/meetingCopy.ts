/** All user-facing strings for meeting notes. A separate file from copy.ts
 * only because copy.ts carries unrelated uncommitted work in the current
 * working tree; these can fold in later. Same rules: plain human phrasing,
 * no em-dashes anywhere. */

/** Product name for a detected call app (detect.rs app strings). Product
 * names, not platform strings, so they live here rather than platformKeys. */
export function callLabel(app: string | null, appName?: string): string {
  switch (app) {
    case "google-meet": return "Google Meet";
    case "teams-web": return "Microsoft Teams";
    case "zoom-web": return "Zoom";
    case "teams": return "Microsoft Teams";
    case "zoom": return "Zoom";
    case "discord": return "Discord";
    case "slack": return "Slack";
    case "whatsapp": return "WhatsApp";
    case "webex": return "Webex";
    case "skype": return "Skype";
    case "signal": return "Signal";
    case "telegram": return "Telegram";
    case "facetime": return "FaceTime";
    // Detected from a browser holding the microphone, not from a tab title, so
    // the site is genuinely unknown. "Record this browser call?" is honest;
    // naming a platform here would be a guess the user would catch.
    case "browser-call": return "browser";
    // Some other app holding the microphone. The detector sends its name in
    // windowTitle, so the card can say which one.
    case "mic-call": return appName || "app";
    default: return "Supported call";
  }
}

/** The notch's "Record this meeting?" card (MeetingPromptCard). */
export const meetingPrompt = {
  title: (appLabel: string) => `Record this ${appLabel} call?`,
  titleForEvent: (eventTitle: string) => `Record ${eventTitle}?`,
  recordNow: "Record now",
  snooze: "Snooze 2 min",
  dismiss: "Dismiss",
  starting: "Starting...",
  capReached: "Monthly meeting limit reached.",
  failed: "Couldn't start recording.",
  // Aura records without joining as a bot, so nobody else on the call is told.
  consentNote: "Let everyone on the call know you're recording.",
} as const;

export const meetingNotes = {
  // CalendarAgendaCard
  armTooltip: "Take notes for this meeting",
  disarmTooltip: "Skip notes for this meeting",

  // KebabMenu
  captureNow: "Capture this call",
  stopCaptureNow: "Stop recording",
  captureNowBusy: "Capturing...",

  // MeetingTicker
  armedTooltip: "Notes are on for this meeting",

  // VoiceBar recording indicator + stop confirm
  recordingTooltip: "Recording this meeting. Click to stop.",
  recordingPausedTooltip: "Recording paused while your screen is locked.",
  stopConfirm: "Stop capturing this meeting?",
  stopConfirmYes: "Stop",
  stopConfirmNo: "Keep going",

  // Monthly cap (Free and Companion plans)
  capReached: "Monthly meeting notes used up. Upgrade to Pro for unlimited.",
  capUpgradeTooltip: "Meeting notes resets monthly on the free plan. Pro removes the cap.",

  // Delivery card
  cardTitle: "Meeting notes",
  actionItemsHeading: "Action items",
  decisionsHeading: "Decisions",
  // Interview notes: one row per question asked, and what to do next time.
  debriefHeading: "Interview debrief",
  debriefImprove: "Next time",
  oneSidedCaveat: "Only your side of the call was captured, so this may be partial.",
  partialCaveat: "Part of the audio may be missing from an audio device change.",
  languageCaveat: (language: string) =>
    `This meeting was in ${language}, where note quality is limited.`,
  viewAll: "View all",
  dismissTooltip: "Dismiss",
  turnOff: "Turn these cards off",
  savedLocal: (segments: number) =>
    `Saved securely on this device${segments > 0 ? ` (${segments} segment${segments === 1 ? "" : "s"})` : ""}.`,
  uploading: (uploaded: number, total: number) =>
    `Uploading ${Math.min(uploaded + 1, total)} of ${total} saved segments.`,
  processingTranscript: "Processing the transcript securely.",
  buildingInsights: "Building your meeting insights.",
  processing: "Processing your meeting.",
  retryNow: "Retry now",

  // Meetings page detail
  keyPointsHeading: "Key points",
  blockersHeading: "Blockers",
  sinceLastTimeHeading: "Since last time",
  openQuestionsHeading: "Open questions",
  chaptersHeading: "Chapters",
  copyNotes: "Copy notes",
  copied: "Copied",
  askAura: "Ask Aura",
  edit: "Edit",
  save: "Save",
  saving: "Saving...",
  cancel: "Cancel",
  editedTag: "Edited",
  editHint: "One item per line. The AI version is kept, and you can restore it.",
  restoreAi: "Restore AI version",
  exportMarkdown: "Export as Markdown",
  exportText: "Export transcript as text",
  exportSubtitles: "Export subtitles (.vtt)",
  savedTo: (path: string) => `Saved to ${path}`,
  regenerateAs: (kind: string) => `Regenerate as ${kind}`,
  regenerating: (kind: string) => `Rewriting these notes as ${kind}. This can take a minute.`,
  regenerateReplacesEdits: "Regenerating replaces your edits with a new AI version.",
  pin: "Pin",
  pinned: "Pinned",
  pinnedMeta: "Pinned, kept until you delete it",
  expiresIn: (days: number) =>
    days <= 0 ? "Deleted later today" : days === 1 ? "Deleted tomorrow" : `Deleted in ${days} days`,
  pinHint: "Notes are deleted 7 days after they're ready. Pin up to 3 to keep them.",
} as const;

/** Display names for each note kind. */
export const meetingKindLabels: Record<string, string> = {
  meeting: "Meeting",
  interview: "Interview",
  lecture: "Lecture",
  one_on_one: "One-on-one",
  standup: "Stand-up",
};

/** Why a meeting action was refused, keyed by the backend's detail.code. */
const actionFailureCopy: Record<string, string> = {
  pin_limit_reached: "You can pin 3 notes. Unpin one first.",
  meeting_expired: "This note has already been deleted.",
  meeting_not_found: "This note no longer exists.",
  meeting_not_ready: "This note isn't ready yet.",
  no_transcript: "There's no transcript to rewrite these notes from.",
  regenerate_in_progress: "These notes are already being rewritten.",
  regenerate_truncated: "This meeting is too long to rewrite in one pass.",
  regenerate_failed: "Aura couldn't rewrite these notes. Try again in a moment.",
  summary_too_long: "The summary is too long. Keep it under 4,000 characters.",
  timeout: "Aura took too long to answer. Try again.",
  network: "Aura couldn't reach the server. Check your connection and try again.",
  exclude_keyword_too_short: "Each word needs at least 3 characters.",
  exclude_keyword_too_long: "Each entry can be at most 40 characters.",
  exclude_keywords_too_many: "You can add up to 20 words.",
  vocabulary_term_too_short: "Each word needs at least 2 characters.",
  vocabulary_term_too_long: "Each entry can be at most 40 characters.",
  vocabulary_too_many: "You can add up to 50 words.",
  note_missing: "This meeting has no notes to write a follow-up from.",
  follow_up_failed: "Aura couldn't write the follow-up. Try again in a moment.",
  follow_up_timeout: "Writing the follow-up took too long. Try again.",
  settings_unavailable: "Aura couldn't load these settings. Try again in a moment.",
};

export function meetingActionFailureCopy(code: string): string {
  if (actionFailureCopy[code]) return actionFailureCopy[code];
  if (/_too_many$/.test(code)) return "That section has too many items. Keep it to 30.";
  if (/_item_too_long$/.test(code)) return "One item is too long. Keep each under 500 characters.";
  return "Aura couldn't do that. Try again.";
}

/** The notch card when a live recording has heard no one for ten minutes. */
export const meetingSilenceCopy = {
  title: "No one's talking",
  detail: (seconds: number) => `Aura stops recording in ${seconds} seconds.`,
  keepRecording: "Keep recording",
  stopNow: "Stop now",
} as const;

/** Record in person and Upload recording, on the Meetings page. */
export const meetingCaptureModeCopy = {
  inPerson: "Record in person",
  inPersonTitle: (time: string) => `In person, ${time}`,
  upload: "Upload recording",
  preparing: "Reading the recording...",
  confirm: (name: string, duration: string) =>
    `"${name}" is ${duration} long. Transcribing it uses one of this month's meetings.`,
  transcribe: "Transcribe",
  cancel: "Cancel",
  queued: "Uploading. Your notes will appear here when they are ready.",
  capReached: "You've used this month's meetings. Upgrade for unlimited.",
  failed: "Aura couldn't start that. Try again in a moment.",
  refusal: {
    unsupported_format: "Aura can't read this file. Try an mp3, m4a, wav, ogg, flac or webm recording.",
    no_audio: "Aura couldn't find any speech in this file.",
    too_long: "This recording is longer than 2 hours. Trim it and try again.",
    decode_failed: "This file looks damaged. Try exporting it again.",
    import_expired: "That took too long. Choose the file again.",
  } as Record<string, string>,
} as const;

/** The Meetings page's follow-up email. */
export const meetingFollowUpCopy = {
  button: "Draft follow-up",
  heading: "Follow-up email",
  drafting: "Writing a follow-up from these notes...",
  to: "To",
  toPlaceholder: "Add email addresses",
  subject: "Subject",
  body: "Email",
  copy: "Copy",
  copied: "Copied",
  openGmail: "Open in Gmail",
  retry: "Try again",
  close: "Close",
} as const;

/** Send to Notion / Slack from the Meetings page. */
export const meetingShareCopy = {
  notion: "Send to Notion",
  confirmNotion: (title: string, workspace: string) =>
    `Save "${title}" to ${workspace ? `${workspace}'s` : "your"} Aura Meeting Notes in Notion?`,
  slack: "Send to Slack",
  confirmSlack: (title: string, channel: string) =>
    `Post the notes from "${title}" to #${channel} as you?`,
  pickChannel: "Post to which channel?",
  loadingChannels: "Loading your Slack channels...",
  noChannels: "You're not in any Slack channels Aura can see.",
  channelsFailed: "Aura couldn't load your Slack channels. Try again in a moment.",
  reconnectSlack: "Slack needs to be reconnected under Connectors.",
  next: "Next",
  save: "Save",
  cancel: "Cancel",
  close: "Close",
  saving: "Saving...",
  open: "Open",
  notConnected: "Connect Notion under Connectors first.",
  failed: "Aura couldn't prepare that. Try again in a moment.",
} as const;

/** Meetings page search, kind chips and paging. */
export const meetingSearchCopy = {
  label: "Search meetings",
  placeholder: "Search what was said",
  kindLabel: "Kind of meeting",
  results: (count: number, query: string) =>
    count === 0 ? `Nothing found for "${query}"` : `${count} ${count === 1 ? "meeting" : "meetings"} about "${query}"`,
  failed: "Aura couldn't search your meetings. Try again in a moment.",
  emptyHeading: "No matching meetings",
  emptyCopy: "Try other words. Search looks through notes and transcripts by meaning, not exact words.",
  noKind: "None of this kind yet",
  noKindCopy: "Pick All to see every meeting.",
  loadMore: "Load more",
  loadingMore: "Loading...",
} as const;

/** Settings > Data and privacy > Private meetings. */
export const meetingSettingsCopy = {
  heading: "Private meetings",
  description: "Keep chosen meetings out of Meeting Notes.",
  skipLabel: "Skip meetings whose title contains",
  skipHint:
    "A recording whose meeting title contains one of these words is skipped and never transcribed. Only the title is checked.",
  addPlaceholder: "Add a word, then press Enter",
  add: "Add",
  remove: (keyword: string) => `Remove ${keyword}`,
  empty: "No words yet.",
  saved: "Saved",
  vocabularyHeading: "Meeting Notes",
  vocabularyDescription: "Help Aura get names and terms right in your meeting transcripts.",
  vocabularyLabel: "Words Aura should know",
  vocabularyHint:
    "Names, course codes, product names and jargon. Aura spells them the way you type them here.",
  vocabularyPlaceholder: "Add a name or term, then press Enter",
} as const;

const failureCopy: Record<string, string> = {
  upload_storage_unavailable:
    "Your recording is safe on this device. Aura could not upload it yet.",
  upload_auth_required: "Sign in to finish processing this meeting.",
  upload_expired: "This saved recording expired before it could be processed.",
  no_audio: "Aura did not capture enough audio to create insights.",
  audio_rejected: "Aura could not read this recording.",
  transcription_unavailable: "Transcription is taking longer than expected.",
  insight_generation_failed: "Aura could not build insights for this recording.",
  excluded_sensitive:
    "This meeting was skipped because its title contains one of your words under Settings, Data and privacy, Private meetings.",
  processing_timeout: "Processing did not finish in time.",
};

export function meetingFailureCopy(code: string | null): string {
  return code && failureCopy[code]
    ? failureCopy[code]
    : "Aura could not finish this meeting yet.";
}
