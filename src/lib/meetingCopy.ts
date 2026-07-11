/** All user-facing strings for meeting notes. A separate file from copy.ts
 * only because copy.ts carries unrelated uncommitted work in the current
 * working tree; these can fold in later. Same rules: plain human phrasing,
 * no em-dashes anywhere. */

export const meetingNotes = {
  // CalendarAgendaCard
  autoNotesOn: "Auto meeting notes: on",
  autoNotesOff: "Auto meeting notes: off",
  armTooltip: "Take notes for this meeting",
  disarmTooltip: "Skip notes for this meeting",

  // KebabMenu
  captureNow: "Capture this call",
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
} as const;
