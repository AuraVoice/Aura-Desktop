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
- [ ] First-run consent (v0.1.5+): the consent screen appears exactly once on a fresh install, is not shown again on relaunch, blocks sign-in until accepted, and no PostHog/Sentry event fires before acceptance.
- [ ] Send feedback (v0.1.5+): reachable without ending a live call, opens a mail composer with version/OS/overlay-state/log-tail prefilled, and the log tail has no raw tokens in it.
- [ ] Update flow (v0.1.5+): trigger or simulate an update check; the download happens in the background, the tray item relabels to "Restart to install vX.Y.Z", installing is deferred while a call is live, and after the restart the one-time "Updated to vX" caption shows once.
- [ ] Buddy Drafts happy path (v0.1.6+): on a call with screen-sight armed and an email on screen, ask Buddy to draft a reply. The card slides out below the bar with the draft text; the agent speaks a short confirmation, never the draft text itself.
- [ ] Draft copy + refine (v0.1.6+): the copy button puts the exact draft text on the clipboard; refine chips update the card during the call AND after the call has ended (the refine path is REST, not the voice session).
- [ ] Draft window growth (v0.1.6+): while the card is open the bar's top edge stays fixed and the window grows downward; closing the card shrinks it back; dragging the overlay still works with the card open.
- [ ] Draft persistence (v0.1.6+): a created draft appears in the web dashboard's Drafts feed, a refine updates it in place (same draft, new revision), and deleting it from the dashboard works. (The 7-day TTL expiry can't be smoke-tested; trust the Firestore TTL policy.)

## Race conditions (documented here because they can't be automated yet — see todo.txt section 2)

- [ ] Press the summon hotkey at the exact instant a screen-sight pointing takeover starts. Confirm it doesn't leave the overlay stuck in Pointing or crash.
- [ ] Trigger a tray click or a second-instance launch while a voice call is mid-teardown (right as you end a call). Confirm no stale window state.
- [ ] Press Ctrl+Shift+D during the pairing flow, before any session exists. Confirm it's a no-op, not a crash.
- [ ] Click minimize-to-pill at the same moment the call ends server-side (easiest to force by ending the call from another device right as you click minimize). Confirm the pill doesn't get stuck or double-transition.
- [ ] Double-press the summon hotkey faster than a human normally would (rapid repeat). Confirm no visual glitch or wrong final state.

## This pass's changes specifically (v0.1.6)

- [ ] Hotkey-collision boot: with another process already holding Ctrl+Alt+B (easiest: a second running install, or a one-line AutoHotkey script), launch the release exe. It must come up in the tray and stay fully usable via tray summon - no panic, no silent death - and exactly one hotkey-registration event should arrive in Sentry.
- [ ] Dev-Sentry silence: force a panic in `npm run tauri dev` (temporary test path, revert after) and confirm it reaches the local log file but does NOT create a Sentry event (the console shows the client dropping it).
- [ ] Updater re-check loop: leave the app running past a re-check window (or shorten `RECHECK_INTERVAL` in a test build) and confirm the 6-hour re-check fires without a restart - a release published after boot still gets picked up.
- [ ] Post-update summon: install an update from a boot-launched (`--autostart`) instance and confirm the app comes back visible after the restart (the just-updated marker), not hidden in the tray.
- [ ] Draft events on the old-client path: sanity-check `__injectDraftEvent` from `src/debug/draftDebug.ts` in a dev session to exercise malformed/failed draft payloads (`draft.failed`, missing fields) without needing the backend to misbehave on cue.

## Uninstall

- [ ] Uninstall the app and check `%APPDATA%` for what's left behind (see `PRIVACY_AUDIT.md` for what's expected to remain vs. be removed).
