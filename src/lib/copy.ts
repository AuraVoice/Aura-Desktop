/** Verbatim UI copy ported from the Flutter app's desktop screens/widgets. Don't paraphrase - these strings are already product-tuned. */

export const overlayStorePath = "overlay-window.json";

export const getAuraAppUrl = "https://auravoiceapp.com/app";
export const privacyUrl = "https://auravoiceapp.com/privacy";
export const termsUrl = "https://auravoiceapp.com/terms";
export const webAuthUrl = "https://auravoiceapp.com/auth";
export const dashboardUrl = "https://auravoiceapp.com/dashboard";
// Opens Google Calendar's new-event composer directly (the connected calendar
// is Google), for the agenda card's empty-state "Create event" action.
export const createEventUrl = "https://calendar.google.com/calendar/u/0/r/eventedit";

export const consent = {
  heading: "Before we get started",
  body: "Aura Desktop uses your voice (and, only while you explicitly turn on screen sight, your screen) to power Buddy. Aura also detects a Left Ctrl double-tap to start or end voice, without storing or transmitting keyboard input. By continuing, you agree to Aura's Privacy Policy and Terms of Service, including the desktop addendum covering screen sight, global shortcuts, and telemetry.",
  ageLabel: "I confirm I am 18 years of age or older",
  privacyLabel: "Privacy Policy",
  termsLabel: "Terms of Service",
  accept: "I agree, continue",
  quit: "Quit",
} as const;

export const onboarding = {
  welcome: {
    heading: "Meet Buddy, your AI friend on this PC.",
    body: "Talk things through, stay on track, and pick up right where your phone left off.",
    trayHint: "Buddy lives in your system tray. Press Ctrl+Alt+B anytime to bring it back.",
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
  heading: "How did you find Buddy?",
  body: "Quick one so we know what's working. Pick the closest.",
  options: [
    { id: "search", label: "Google or search" },
    { id: "youtube", label: "YouTube" },
    { id: "social", label: "X, Reddit, or another feed" },
    { id: "friend", label: "A friend or colleague" },
    { id: "work", label: "Someone at work" },
    { id: "other", label: "Somewhere else" },
  ],
  otherPlaceholder: "Where, exactly? (optional)",
  button: "Continue",
} as const;

// First-run role question. Same destinations as whereHeard.
export const role = {
  heading: "What best describes you?",
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

// The hotkey tour step teaches the shortcuts before the live demo. Keycap data
// comes from hotkeyHints below; this is the surrounding copy.
export const hotkeyTour = {
  heading: "Your shortcuts",
  body: "These work anywhere on your PC, even when Buddy is tucked away.",
  button: "Got it, let's try it",
} as const;

// The live "talk to Buddy" demo step, shown right after sign-in.
export const agentDemo = {
  heading: "Say hi to Buddy",
  body: "Double-tap Left Ctrl, or hit the button, and just start talking. End it whenever you're ready.",
  start: "Start talking",
  finish: "Finish",
  skip: "Skip for now",
  connecting: "Connecting you to Buddy...",
  live: "Buddy's listening. Say something.",
  errorHint: "Couldn't start the call. Check your mic, or skip for now.",
} as const;

export const signIn = {
  pairingPrompt: "On your phone: Aura -> Settings -> Link this PC",
  emailPrompt: "Sign in to bring Buddy to your desktop",
  emailHint: "you@email.com",
  passwordHint: "Password",
  pairingCodeHint: "XXXX-XXXX",
  submitEmailIdle: "Sign in",
  submitEmailBusy: "Signing in...",
  submitPairingIdle: "Link this PC",
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

export const hotkeyHints = {
  summon: { keys: ["Ctrl", "Alt", "B"], action: "summon Buddy anywhere" },
  voice: { keys: ["Left Ctrl twice"], action: "start or end voice" },
  screenSight: { keys: ["Ctrl", "Alt", "S"], action: "toggle screen sight" },
  dashboard: { keys: ["Ctrl", "Alt", "D"], action: "open your dashboard" },
} as const;

export const bar = {
  title: "Buddy",
  fallbackErrorCaption: "Something went sideways with the call.",
  pillFallbackCaption: "Buddy is listening...",
  openMicSettingsTooltip: "Open mic settings",
  screenSightOnTooltip: "Stop letting Buddy see your screen",
  screenSightOffTooltip: "Let Buddy see your screen",
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
  chipTooltip: (version: string) => `Update ready: restart to install v${version}`,
  confirm: (version: string) => `Update v${version} is ready. Restart Buddy to install it?`,
  later: "Later",
  dismiss: "Dismiss",
  restartIdle: "Restart now",
  restartBusy: "Restarting...",
  restarting: "Installing the update. Buddy will be right back.",
  deferred: "Buddy is in a call. Try again after it ends.",
  failed: "The update couldn't install. Buddy will retry in the background.",
  updatedNotice: (version: string) => `Updated to v${version}. You're on the latest Buddy.`,
} as const;

export const draftCard = {
  title: (channel: "email_reply" | "cold_dm" | "snippet") =>
    channel === "snippet"
      ? "Draft · Snippet"
      : channel === "cold_dm"
        ? "Draft · DM"
        : "Draft · Email reply",
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
// Set once the post-sign-in profile sync (PostHog alias + $set, backend POST)
// succeeds, so it never re-runs for a returning user.
export const desktopProfileSyncedKey = "desktop_profile_synced";
// Per-install anonymous id used as the PostHog distinct_id for pre-sign-in
// attribution capture, then aliased to the real uid on sign-in. Deliberately
// NOT the literal "anonymous" - aliasing that would chain-merge every signed-out
// install into a single PostHog person.
export const desktopAnonIdKey = "desktop_anon_id";
// The onboarding phase, persisted so the first-run flow survives the sign-in
// auth transition (OnboardingFlow unmounts once `user` is set; the tail - hotkey
// tour + live demo - reads this to know it should keep running).
export const desktopOnboardingPhaseKey = "desktop_onboarding_phase";
