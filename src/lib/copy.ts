/** Verbatim UI copy ported from the Flutter app's desktop screens/widgets. Don't paraphrase - these strings are already product-tuned. */

export const overlayStorePath = "overlay-window.json";

export const getAuraAppUrl = "https://auravoiceapp.com/app";
export const privacyUrl = "https://auravoiceapp.com/privacy";
export const termsUrl = "https://auravoiceapp.com/terms";
export const webAuthUrl = "https://auravoiceapp.com/auth";
export const dashboardUrl = "https://auravoiceapp.com/dashboard";

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
