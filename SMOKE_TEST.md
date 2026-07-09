# Manual pre-release smoke test

Run this in full before every tagged release, without exception.
There is no automated end-to-end suite yet, so this is the only thing standing between "cargo check passed" and "the overlay actually works" for a real user.

Use a clean test account where the flow calls for "first run" and a previously-signed-in account where it calls for "returning user."

## Core flows

- [ ] Fresh pairing: scan the pairing QR from the mobile app, confirm the desktop signs in and lands on the Bar panel.
- [ ] Email sign-in: sign in with email/password on a returning-user machine.
- [ ] Voice call happy path: Ctrl+Alt+B, start a call, speak, hear a response, end the call cleanly.
- [ ] Voice call join-timeout: force it by killing network right after starting a call, before the agent joins. Confirm the 30s watchdog fires and shows a clear error, not a silent hang.
- [ ] Voice call silence-timeout: start a call, then go silent past the silence watchdog. Confirm it ends the session with a clear message instead of hanging.
- [ ] Screen-sight arm/point: Ctrl+Alt+S to arm, ask Buddy to point at something on screen, confirm the pointing overlay appears over the right element and auto-cancels correctly.
- [ ] Pill minimize/restore: minimize an active call to the pill, confirm the 3D avatar renders and animates, click it to restore to the Bar.
- [ ] All three hotkeys: Ctrl+Alt+B (summon/hide), Ctrl+Shift+D (immediate sign-out), Ctrl+Alt+S (screen-sight toggle) — confirm each does only its one job from every overlay state you can reach it from.
- [ ] Sign-out: from the VoiceBar button, confirm it tears down any live call before completing.
- [ ] Tray menu: left-click summons/hides; menu items all work; version label (added this pass) shows the right build number.
- [ ] Second-instance launch: with the app already running, launch it again (or double-click the installer's shortcut) and confirm it re-summons the existing window instead of opening a second one.
- [ ] Open Dashboard (v0.1.5+): both the tray menu item and the bar's dashboard button open the web dashboard in the browser already signed in; a rapid double-click on the bar button opens one tab, not two.
- [ ] "Start with Windows" toggle (v0.1.5+): flip it off and on from the tray menu and confirm the check mark tracks the real registry state each time.
- [ ] Autostart boot launch (v0.1.5+): sign out of Windows and back in (or launch the release exe with `--autostart`); confirm the app comes up tray-only without popping the panel over the login desktop, and that hotkey/tray summon still work afterwards.
- [ ] Screen-sight save confirmation (v0.1.5+): while armed, ask Buddy to save something on screen and confirm the "Saved to ..." caption appears in the bar and fades after a few seconds.

## Race conditions (documented here because they can't be automated yet — see todo.txt section 2)

- [ ] Press the summon hotkey at the exact instant a screen-sight pointing takeover starts. Confirm it doesn't leave the overlay stuck in Pointing or crash.
- [ ] Trigger a tray click or a second-instance launch while a voice call is mid-teardown (right as you end a call). Confirm no stale window state.
- [ ] Press Ctrl+Shift+D during the pairing flow, before any session exists. Confirm it's a no-op, not a crash.
- [ ] Click minimize-to-pill at the same moment the call ends server-side (easiest to force by ending the call from another device right as you click minimize). Confirm the pill doesn't get stuck or double-transition.
- [ ] Double-press the summon hotkey faster than a human normally would (rapid repeat). Confirm no visual glitch or wrong final state.

## This pass's changes specifically

- [ ] CSP sanity check: with `npm run tauri dev`, confirm hot-reload still works and the webview devtools console shows no CSP violation warnings.
- [ ] Avatar pill still renders and animates correctly (the CSP's `worker-src` covers the Draco decoder worker — this is exactly the thing that broke silently once before).
- [ ] Sign-in (both email/password and pairing-code custom-token) still succeeds — CSP's `connect-src` must reach `identitytoolkit.googleapis.com` / `securetoken.googleapis.com`.
- [ ] A voice call still connects — CSP's `connect-src` must reach the LiveKit Cloud project domain.
- [ ] PostHog events still send (check the network tab or PostHog's live events view) — CSP's `connect-src` must reach `us.i.posthog.com`.
- [ ] First-run consent screen appears exactly once on a fresh install, is not shown again on relaunch, and blocks reaching sign-in until accepted.
- [ ] With telemetry consent declined (if a decline path exists) or before consent is given, confirm no PostHog/Sentry event fires.
- [ ] Force a Rust panic in a debug build (temporary test path only, revert after) and confirm it's still written to the local log file.
- [ ] Trigger the update-check path (or simulate one) and confirm the app downloads in the background without installing, the tray menu's "Up to date" item relabels to "Restart to install vX.Y.Z" and becomes clickable, and starting a call before clicking it makes the app defer the install instead of installing mid-call.
- [ ] Send feedback button: confirm it's reachable without ending a live call, opens a mail composer with version/OS/overlay-state/log-tail prefilled, and that the log tail has no raw tokens in it.
- [ ] Confirm the WebView2 install path: if feasible, test on a VM image without WebView2 preinstalled and confirm the bootstrapper runs instead of the app failing silently.

## Uninstall

- [ ] Uninstall the app and check `%APPDATA%` for what's left behind (see `PRIVACY_AUDIT.md` for what's expected to remain vs. be removed).
