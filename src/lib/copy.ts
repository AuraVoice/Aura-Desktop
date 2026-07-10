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
  body: "Aura Desktop uses your voice (and, only while you explicitly turn on screen sight, your screen) to power Buddy. By continuing, you agree to Aura's Privacy Policy and Terms of Service, including the desktop addendum covering screen sight, the global hotkeys, and telemetry.",
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
  hide: { keys: ["Esc"], action: "hide" },
  screenSight: { keys: ["Ctrl", "Alt", "S"], action: "toggle screen sight" },
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
  title: (channel: "email_reply" | "cold_dm") =>
    channel === "cold_dm" ? "Draft · DM" : "Draft · Email reply",
  copyTooltip: "Copy draft",
  copiedTooltip: "Copied!",
  dismissTooltip: "Dismiss draft",
  generating: "Buddy's writing your draft...",
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
