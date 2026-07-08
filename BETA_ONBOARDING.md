# Aura Desktop beta — getting started

## Install

1. Download the latest installer from the [releases page](https://github.com/AuraVoice/Aura-Desktop/releases/latest).
2. Run it. If Windows shows a "Windows protected your PC" SmartScreen prompt, that's expected for now (the installer isn't code-signed yet — see `todo.txt` section 3) — choose "More info" then "Run anyway."
3. If your machine is missing the WebView2 runtime, the installer handles that automatically (it bundles the WebView2 bootstrapper); you shouldn't need to do anything extra.
4. Aura Desktop starts automatically after install and lives in the system tray.
5. It also starts with Windows by default (v0.1.5+).
   You can turn that off via right-click on the tray icon, "Start with Windows".
   When Windows launches it at login it stays quietly in the tray instead of popping the panel open over whatever you're doing.

## First run

You'll be asked to accept the Privacy Policy, Terms of Service, and a short desktop-specific addendum before anything else happens — this covers what the desktop app captures (voice, and screen content only when you explicitly arm screen-sight) and how telemetry works. Nothing is sent anywhere until you accept.

## Pairing with the mobile app

- **From a fresh install**: onboarding shows a QR code that gets you the Aura mobile app (it links to the app download page, not a pairing code).
  Once you have the mobile app, it shows an 8-character pairing code; type that into the desktop's pairing screen (it auto-submits at full length).
- **Already have an account**: sign in directly with email/password, or use "Sign up with Google" from the sign-in screen.

## Using it

- **Ctrl+Alt+B** — summon or hide the overlay.
- **Ctrl+Alt+S** — arm or disarm screen-sight (lets Buddy see and point at things on your screen during a call — only while explicitly armed, never ambient).
- **Ctrl+Shift+D** — immediate sign-out (bypasses the usual confirm step, for when you need to switch accounts fast).
- Click the tray icon to summon/hide; right-click for the tray menu (includes the app version, useful when reporting a bug).
- **Open Dashboard** (v0.1.5+): right-click the tray icon and pick "Open Dashboard", or click the dashboard button in the bar.
  Your browser opens the web dashboard already signed in; a one-time code handles the handoff, no second login.
- During a call, minimize to the floating "pill" avatar and click it to bring the full panel back.

## Known issues at launch

- The installer is not yet code-signed — expect a SmartScreen warning on first run.
- Crash reporting (Sentry) is live and consent-gated, but it only sees crashes, so please still use the in-app feedback button liberally for anything that feels off.
- Multi-monitor and DPI-change-mid-session edge cases are not yet fully verified — if the overlay ends up in the wrong place after unplugging/replugging a monitor, a restart of the app fixes it.
- See the release's own "Known issues" section (per `RELEASE_NOTES_TEMPLATE.md`) for anything specific to the build you're on.

## Sending feedback

Use the "Send feedback" button in the overlay (reachable without ending a call). It attaches your app version, OS version, current state, and recent log lines automatically — tokens/secrets are stripped before anything leaves your machine — plus whatever you type. It opens your email client with all of this prefilled; just hit send.

If the button isn't visible in your build yet, email us directly with your app version (tray menu → version) and a description of what happened.
