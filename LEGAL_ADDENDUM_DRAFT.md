# Desktop addendum — DRAFT, pending your and/or legal review

This is a first draft, not a finished legal document. It's written from what the code actually does (verified by reading `useScreenSight.ts`, `hotkeys.rs`, `logging.rs`, and `analytics.ts` directly), so the factual claims are accurate to this build — but the language, structure, and any jurisdiction-specific requirements still need a legal read before this goes anywhere near a published Privacy Policy or ToS. Route this to whoever owns the mobile app's existing legal documents so it can be merged in as a section or exhibit, not published standalone.

---

## Aura Desktop addendum to the Aura Terms of Service and Privacy Policy

This addendum describes desktop-specific functionality not present in the mobile app. It supplements, and does not replace, the main Aura Terms of Service and Privacy Policy.

### Screen-sight (screen capture)

- **What is captured**: only the display (monitor) under your mouse cursor at the moment of capture — not your entire desktop, not other monitors, and not continuously.
- **When it's captured**: only while you have explicitly armed screen-sight (Ctrl+Alt+S, or the eye icon) during an active voice session, and only at the moment the assistant needs to look at something during that turn. It is never captured ambiently, on a timer, or outside an active, explicitly-armed session.
- **What happens to it**: the captured frame is sent to the assistant backend as part of the same voice session, to let the assistant understand and point at what's on your screen.
- **Retention**: [PLACEHOLDER — needs a real answer from whoever owns the backend's data retention policy; see `PRIVACY_AUDIT.md` and `todo.txt` section 5's retention-policy item, which is out of this repo's control].

### Global hotkeys

Three keyboard shortcuts are active system-wide while Aura Desktop is running, regardless of which application has focus:

- **Ctrl+Alt+B** — show or hide the Aura overlay.
- **Ctrl+Shift+D** — sign out immediately.
- **Ctrl+Alt+S** — arm or disarm screen-sight for the current voice session.

These are defined by physical key position, not by whatever characters your keyboard layout produces, so they work the same way on non-US keyboards. They do not record or transmit any other keystrokes; Aura Desktop is not a keylogger and does not capture keyboard input beyond recognizing these three specific shortcuts.

### Local log files

Aura Desktop keeps a local log file on your device (under your Windows user profile) containing operational information — window state changes, error messages, connection status, and similar — to help diagnose problems. This log does not contain your voice audio, transcripts, or screen capture content. If you use the in-app "Send feedback" button, recent lines from this log are included in what's sent, with any authentication tokens automatically stripped first.

### Telemetry (PostHog and Sentry)

Aura Desktop uses PostHog for basic usage analytics (e.g. whether a voice call succeeded, which features are used) and Sentry for crash/error reporting, so we can find and fix problems without you having to describe them from scratch. Both are gated behind a single consent choice you make on first run — nothing is sent to either service until you accept. You can find out more about what each collects at [PostHog's privacy documentation] and [Sentry's privacy documentation] (links to be added once available).

---

## Desktop EULA / disclaimer addition — DRAFT

Aura Desktop uses AI to interpret your voice and, when screen-sight is armed, on-screen content. Like any AI system, it can misinterpret what you say or what's on your screen, and may occasionally act on an incorrect interpretation. Aura Desktop is provided "as is," and [company name] disclaims liability for actions taken based on the assistant's misinterpretation, to the fullest extent permitted by applicable law. This is standard language for an AI-assistant product — the mobile app's existing EULA likely already has an equivalent clause that can be extended to cover desktop-specific functionality (screen-sight, global hotkeys) rather than drafted from scratch.

---

## Open items for you / legal, not decided here

- Actual data retention windows for voice audio, screen frames, transcripts, and logs (backend-side, out of this repo).
- Confirming Data Processing Agreements exist with Firebase/Google, LiveKit, PostHog, and Sentry for EU/UK user data.
- Final company name / entity for the disclaimer clause.
- Whether this merges into the existing mobile ToS/Privacy Policy documents as a section, or ships as a linked standalone addendum — a mechanical/publishing decision, not addressed here.
