import { deviceNoun, trayNoun } from "./platformKeys";
/** Verbatim UI copy ported from the Flutter app's desktop screens/widgets. Don't paraphrase - these strings are already product-tuned. */

export const overlayStorePath = "overlay-window.json";

export const getAuraAppUrl = "https://auravoiceapp.com/app";
export const privacyUrl = "https://auravoiceapp.com/privacy";
export const termsUrl = "https://auravoiceapp.com/terms";
export const webAuthUrl = "https://auravoiceapp.com/auth";
// Opens Google Calendar's new-event composer directly (the connected calendar
// is Google), for the agenda card's empty-state "Create event" action.
export const createEventUrl = "https://calendar.google.com/calendar/u/0/r/eventedit";

export const consent = {
  heading: "Before we get started",
  body: "Aura Desktop uses your voice to power Buddy. Your screen is shared only when you attach it in text chat, turn on Screen Sight, or start Guide Mode. Aura also detects your configured voice shortcut to start or end voice, without storing or transmitting keyboard input. By continuing, you agree to Aura's Privacy Policy and Terms of Service, including the desktop addendum covering screen sight, global shortcuts, and telemetry.",
  ageLabel: "I confirm I am 18 years of age or older",
  privacyLabel: "Privacy Policy",
  termsLabel: "Terms of Service",
  accept: "I agree, continue",
  quit: "Quit",
} as const;

/** Online dictation disclosure and consent.
 *
 * Dictation used to transcribe entirely on this PC, so there was nothing to
 * disclose. It now streams the microphone to a transcription service while the
 * chord is held, which is a different promise to the user, so it is stated
 * plainly and asked for once before any audio is captured.
 *
 * ONE source of truth on purpose: the HUD prompt and Settings > Dictation both
 * render these strings, so the thing the user agreed to and the thing Settings
 * says they agreed to cannot drift apart. */
export const dictationConsent = {
  /** A first-time ask, not a change notice. The earlier "Dictation now
   * transcribes online" was written for a user whose dictation used to run
   * on-device; nobody has ever run that build, so the "now" only left a new
   * reader wondering what they had missed. */
  heading: "Turn on dictation",
  /** The HUD prompt's own wording. Kept separate from `body` because the card
   * is 396px wide and Settings is a full page: one string for both meant the
   * shorter surface set the ceiling for how much either could say. */
  hudBody:
    `Hold the keys and Aura types what you say. Your speech goes to our transcription service while you hold them, and a copy stays encrypted on this ${deviceNoun()} so you can find it again on the Dictation page. Cloud sharing is separate and stays off until you allow it.`,
  body: `While you hold the keys, your speech is sent to our transcription provider and turned into text. Each finished dictation is then kept encrypted on this ${deviceNoun()} so you can find and replay it. Cloud sharing is separate and starts off.`,
  /** Shown in Settings under the toggle, where there is room for the rest. */
  detail:
    `Your saved dictation words go with each request so they are recognised correctly. Finished dictations stay encrypted on this ${deviceNoun()} for up to 90 days and are erased when you sign out. Cloud sharing is a separate opt-in under Settings > General > Privacy and stays off until you turn it on. Dictation needs you signed in and online.`,
  accept: "Turn on",
  decline: "Not now",
  settingsHeading: "Online dictation",
  enabledLabel: "Online dictation is on",
  disabledLabel: "Online dictation is off",
  turnOff: "Turn off",
  turnOn: "Turn on",
  /** The consequence of turning it off, stated where the user turns it off. */
  offNotice: "The dictation keys will not transcribe until this is back on.",
} as const;

/** The chord's user-facing prose.
 *
 * ONE source of truth for the same reason `dictationConsent` is: Settings >
 * Dictation and Settings > System both describe the same chord, and the
 * sentence used to be hardcoded in one of them, so flipping `DICTATION_CHORD`
 * in chord.rs would have left it saying the old keys. Every string that names
 * the chord takes the live label as an argument instead of baking it in. */
export const dictationChord = {
  sectionHeading: "Dictation keys",
  /** Settings > Dictation, above the rows. */
  sectionDescription: (label: string) =>
    `Hold ${label} while speaking. Release either key to type the result.`,
  /** Settings > System, where the chord sits beside the editable shortcuts and
   * has to explain why it alone cannot be changed. */
  systemDescription: "A fixed hold shortcut that works in supported text fields.",
  rowLabel: "Hold to dictate",
  fixed: "Fixed",
  fixedNote: "Fixed for every supported app.",
  statusLabel: "Status",
  /** The window between mount and the first status reply. */
  statusChecking: "Checking listener...",
  statusReady: "Ready",
} as const;

export const onboarding = {
  welcome: {
    headingAccent: "Meet Buddy",
    headingTail: `, your AI companion on this ${deviceNoun()}.`,
    body: "Talk things through, get help, and complete tasks without leaving the screen you're on.",
    // Takes the live trigger phrase (voiceTriggerPhrase in lib/hotkeys.ts)
    // rather than primaryModifierLabel(): the trigger is user-configurable, and
    // the macOS default is now a chord, so neither the verb "Double-tap" nor a
    // bare modifier name can be baked in here.
    trayHint: (trigger: string) =>
      `Buddy lives in your ${trayNoun()}. ${trigger} anytime to start talking.`,
    button: "Get set up",
    skipLink: "Already have Aura? Link now",
    googleSignupLink: "New here? Sign up with Google",
  },
  getApp: {
    heading: "First, grab Aura on your phone",
    body: "Buddy's memory lives in your Aura account, and the phone app is where it starts. Scan the code, or visit auravoiceapp.com/app.",
    button: "I have the app",
    backLink: "Back",
  },
  newHereLink: "New here?",
} as const;

// First-run attribution question. Answers go to PostHog (person properties) and
// the backend profile - see analytics.ts and profile.ts. Options are stable ids
// (sent to analytics), labels are display-only.
export const whereHeard = {
  heading: "How did you find Aura?",
  body: "Quick one so we know what's working. Pick the closest.",
  options: [
    { id: "search", label: "Google or search" },
    { id: "x", label: "X" },
    { id: "linkedin", label: "LinkedIn" },
    { id: "reddit", label: "Reddit" },
    { id: "friend", label: "A friend or colleague" },
    { id: "other", label: "Somewhere else" },
  ],
  otherPlaceholder: "Where, exactly? (optional)",
  button: "Continue",
} as const;

// First-run role question. Same destinations as whereHeard.
export const role = {
  heading: "What's your role?",
  body: "This helps Buddy show up the way you'd want.",
  options: [
    { id: "founder", label: "Founder or building something" },
    { id: "engineer", label: "Engineer or developer" },
    { id: "sales_marketing", label: "Sales or marketing" },
    { id: "student", label: "Student" },
    { id: "creator", label: "Creator or freelancer" },
    { id: "other", label: "Something else" },
  ],
  otherPlaceholder: "Tell us in a few words (optional)",
  button: "Continue",
} as const;

// The live "talk to Buddy" demo step, shown right after sign-in.
export const agentDemo = {
  heading: "Say hi to Buddy",
  body: (trigger: string) =>
    `${trigger}, or hit the button, and just start talking. End it whenever you're ready.`,
  start: "Start talking",
  finish: "Finish",
  skip: "Skip for now",
  connecting: "Connecting you to Buddy...",
  live: "Buddy's listening. Say something.",
  listening: "Buddy is listening",
  userTalking: "You're talking",
  thinking: "Buddy is thinking",
  buddyTalking: "Buddy is talking",
  timeWarning: "You can keep talking. This intro will end in",
  timeEnded: (trigger: string) =>
    `Nice talking with you. Your intro session has ended. You can talk to Buddy anytime: ${trigger.toLowerCase()}.`,
  continue: "Continue",
  errorHint: "Couldn't start the call. Check your mic, or skip for now.",
} as const;

export const signIn = {
  pairingPrompt: "On your phone:",
  pairingPath: `Aura -> Settings -> Link this ${deviceNoun()}`,
  emailPrompt: "Sign in to bring Buddy to your desktop",
  emailHint: "you@email.com",
  passwordHint: "Password",
  pairingCodeHint: "XXXX-XXXX",
  submitEmailIdle: "Sign in",
  submitEmailBusy: "Signing in...",
  submitPairingIdle: `Link this ${deviceNoun()}`,
  submitPairingBusy: "Linking...",
  switchToPairing: "Link with your phone instead",
  switchToEmail: "Use email & password instead",
  switchToGoogle: "Continue with Google instead",
  privacyLabel: "Privacy",
  termsLabel: "Terms",
  googlePrompt: "Sign in or create your Aura account with Google",
  submitGoogleSignInIdle: "Sign in with Google",
  submitGoogleIdle: "Sign up with Google",
  switchFromGoogleToPairing: "Have the phone app instead? Link it",
} as const;

export const bar = {
  title: "Buddy",
  fallbackErrorCaption: "Something went sideways with the call.",
  pillFallbackCaption: "Buddy is listening...",
  openMicSettingsTooltip: "Open mic settings",
  screenSightOnTooltip: "Stop sending Screen Sight images",
  screenSightOffTooltip: "Send Screen Sight images",
  minimizeTooltip: "Minimize (keeps the call going)",
  micTryAgainTooltip: "Try again",
  micEndCallTooltip: "End the conversation",
  micTalkTooltip: "Talk to Buddy",
  signOutTooltip: "Sign out",
  sendFeedbackTooltip: "Send feedback",
  feedbackSentTooltip: "Opened your email client",
  openDashboardTooltip: "Open dashboard",
} as const;

export const update = {
  ready: (version: string) => `Aura v${version} is ready to install.`,
  chipTooltip: (version: string) => `Update ready: restart to install v${version}`,
  confirm: (version: string) => `Update v${version} is ready. Restart Buddy to install it?`,
  later: "Later",
  dismiss: "Dismiss",
  restartIdle: "Update and restart",
  restartBusy: "Restarting...",
  laterHint: `The update will remain available from the Aura ${trayNoun()} menu.`,
  restarting: "Installing the update. Buddy will be right back.",
  deferred: "Buddy is in a call. Try again after it ends.",
  failed: "The update couldn't install. Buddy will retry in the background.",
  updatedNotice: (version: string) => `Updated to v${version}. You're on the latest Buddy.`,
} as const;

export const draftCard = {
  title: (channel: "on_screen" | "email_reply" | "cold_dm" | "snippet") =>
    channel === "snippet"
      ? "Draft · Snippet"
      : channel === "cold_dm"
        ? "Draft · DM"
        : channel === "email_reply"
          ? "Draft · Email reply"
          : "Draft",
  copyTooltip: "Copy draft",
  copyArtifactTooltip: "Copy text",
  copiedTooltip: "Copied!",
  dismissTooltip: "Dismiss draft",
  generating: "Buddy's writing your draft...",
  artifactTitle: (
    kind: "command" | "code" | "config" | "prompt" | "steps" | "checklist" | "note",
  ) =>
    ({
      command: "Command",
      code: "Code",
      config: "Configuration",
      prompt: "Prompt",
      steps: "Next steps",
      checklist: "Checklist",
      note: "Note",
    })[kind],
  refineFailed: "Couldn't update that. Try again.",
  failed: "That draft didn't come together. Ask Buddy to try again.",
  failedTimeout: "That draft took too long. Ask Buddy to try again.",
  failedModel: "The writing model rejected that draft. Ask Buddy to try again.",
  failedInvalid: "Buddy couldn't understand that draft request. Ask again with what to write.",
  failedNoFrame: "Buddy couldn't see the screen context. Turn on screen sight and try again.",
  quotaReached: "You've used today's free drafts. They reset tomorrow.",
  chips: {
    shorter: "Shorter",
    longer: "Longer",
    more_formal: "More formal",
    warmer: "Warmer",
    regenerate: "Regenerate",
  },
} as const;

export const callbackCard = {
  title: "Daily catch-up",
  dismissTooltip: "Dismiss",
  remembers: (n: number) => `Buddy remembers ${n} ${n === 1 ? "thing" : "things"}`,
  deleteTooltip: (key: string) => `Forget "${key}"`,
  deleteFailed: "Couldn't forget that. Try again.",
  turnOff: "Turn off daily catch-ups",
} as const;

export const kebabMenu = {
  openTooltip: "More",
  calendar: "Calendar",
  dashboard: "Dashboard",
  feedback: "Send feedback",
  feedbackSent: "Opened your email client",
  signOut: "Sign out",
} as const;

// The plan line + Upgrade button at the top of the kebab menu. The desktop is a
// pure reader of the account's subscription: it shows the state and links out
// to web checkout. Payments never happen in the app.
export const subscription = {
  trialDaysLeft: (n: number) => `Trial · ${n} days left`,
  trialLastDay: "Trial · last day",
  freePlan: "Free plan",
  paidPlan: (name: string) => `${name} plan`,
  paymentIssue: (name: string) => `${name} · payment issue`,
  upgrade: "Upgrade",
  upgradeOpening: "Opening...",
  upgradeWaiting: "Waiting for payment...",
  upgraded: "You're upgraded",
  upgradeFailed: "Try again",
  voiceCapReached: "You've used today's free voice minutes. They reset tomorrow.",
  voiceCapUpgradeTooltip: "Upgrade for unlimited voice",
} as const;

export const meetingTicker = {
  join: "Join",
  joinTooltip: "Join the meeting",
  dismissTooltip: "Snooze until the next one",
  startingNow: "starting now",
  inMinutes: (n: number) => `in ${n} min`,
} as const;

export const calendarAgenda = {
  title: "Today",
  upcomingTitle: "Upcoming",
  joinTooltip: "Join the meeting",
  openTooltip: "Open in Google Calendar",
  dismissTooltip: "Close",
  join: "Join",
  now: "now",
  notConnected: "Connect Google Calendar to see your meetings here.",
  connectCta: "Connect Google Calendar",
  empty: "No events on your calendar yet.",
  createEvent: "Create event",
  loading: "Checking your calendar...",
  errorTitle: "Couldn't load your calendar.",
  retry: "Try again",
  turnOff: "Turn off meeting alerts",
} as const;

export const signOut = {
  warning: "Sign out of Aura on this device?",
  trigger: "Sign out",
  cancel: "Cancel",
  confirmIdle: "Sign out",
  confirmBusy: "Signing out...",
  error: "Couldn't sign out. Try again.",
  stuck: "Still working on it. You can keep using Buddy while this finishes.",
  dismiss: "Dismiss",
} as const;

export const desktopOnboardingSeenKey = "desktop_onboarding_seen";
export const desktopOnboardingSeenForUidKey = (uid: string) =>
  `${desktopOnboardingSeenKey}_${encodeURIComponent(uid)}`;
// Deliberately its own key, not folded into desktopOnboardingSeenKey above -
// they gate different things (has the onboarding tour been shown vs. has the
// user affirmatively accepted ToS/Privacy/telemetry), and lessons-learnt.txt
// already has one incident from two concerns sharing state in this same store
// file. Telemetry is enabled/disabled by this same flag - see analytics.ts.
export const desktopConsentAcceptedKey = "desktop_consent_accepted";
// First-run attribution answers (option id + optional freetext) and the guard
// that the post-sign-in profile sync ran once. Each is its own key for the same
// reason as the two above - they gate independent concerns in the shared store.
export const desktopWhereHeardKey = "desktop_where_heard";
export const desktopRoleKey = "desktop_role";
export const desktopWhereHeardForUidKey = (uid: string) =>
  `${desktopWhereHeardKey}_${encodeURIComponent(uid)}`;
export const desktopRoleForUidKey = (uid: string) =>
  `${desktopRoleKey}_${encodeURIComponent(uid)}`;
// Set once the post-sign-in profile sync (PostHog alias + $set, backend POST)
// succeeds, so it never re-runs for a returning user.
export const desktopProfileSyncedKey = "desktop_profile_synced";
export const desktopProfileSyncedForUidKey = (uid: string) =>
  `${desktopProfileSyncedKey}_${encodeURIComponent(uid)}`;
// Per-install anonymous id used as the PostHog distinct_id for pre-sign-in
// attribution capture, then aliased to the real uid on sign-in. Deliberately
// NOT the literal "anonymous" - aliasing that would chain-merge every signed-out
// install into a single PostHog person.
export const desktopAnonIdKey = "desktop_anon_id";
export const desktopAnonAliasedUidKey = "desktop_anon_aliased_uid";
// The onboarding phase, persisted so the first-run flow survives the sign-in
// auth transition (OnboardingFlow unmounts once `user` is set; the tail - hotkey
// tour + live demo - reads this to know it should keep running).
export const desktopOnboardingPhaseKey = "desktop_onboarding_phase";
