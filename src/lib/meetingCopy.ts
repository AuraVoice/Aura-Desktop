/** All user-facing strings for meeting notes. A separate file from copy.ts
 * only because copy.ts carries unrelated uncommitted work in the current
 * working tree; these can fold in later. Same rules: plain human phrasing,
 * no em-dashes anywhere. */

/** Product name for a detected call app (detect.rs app strings). Product
 * names, not platform strings, so they live here rather than platformKeys. */
export function callLabel(app: string | null): string {
  switch (app) {
    case "google-meet": return "Google Meet";
    case "teams-web": return "Microsoft Teams";
    case "zoom-web": return "Zoom";
    case "teams": return "Microsoft Teams";
    case "zoom": return "Zoom";
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
  excluded_sensitive: "This meeting was skipped by your private-meeting rules.",
  processing_timeout: "Processing did not finish in time.",
};

export function meetingFailureCopy(code: string | null): string {
  return code && failureCopy[code]
    ? failureCopy[code]
    : "Aura could not finish this meeting yet.";
}
