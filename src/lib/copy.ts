/** Verbatim UI copy ported from the Flutter app's desktop screens/widgets. Don't paraphrase - these strings are already product-tuned. */

export const getAuraAppUrl = "https://auravoiceapp.com/app";
export const privacyUrl = "https://auravoiceapp.com/privacy";
export const termsUrl = "https://auravoiceapp.com/terms";

export const onboarding = {
  welcome: {
    heading: "Meet Buddy, your AI friend on this PC.",
    body: "Talk things through, stay on track, and pick up right where your phone left off.",
    trayHint: "Buddy lives in your system tray. Press Ctrl+Alt+B anytime to bring it back.",
    button: "Get set up",
    skipLink: "Already have Aura? Link now",
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
  privacyLabel: "Privacy",
  termsLabel: "Terms",
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
  screenSightOffTooltip: "Let Buddy see your screen (Ctrl+Alt+S)",
  micTryAgainTooltip: "Try again",
  micEndCallTooltip: "End the conversation",
  micTalkTooltip: "Talk to Buddy",
  signOutTooltip: "Sign out",
} as const;

export const signOut = {
  warning: "Sign out of Aura on this device?",
  trigger: "Sign out",
  cancel: "Cancel",
  confirmIdle: "Sign out",
  confirmBusy: "Signing out...",
  error: "Couldn't sign out. Try again.",
} as const;

export const desktopOnboardingSeenKey = "desktop_onboarding_seen";
