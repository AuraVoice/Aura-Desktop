# Privacy audit — what's persisted, and what survives uninstall

Findings from reading the actual code, not assumptions. Ends with a recommendation for you to sign off on, not a decision made unilaterally.

## What's persisted under `%APPDATA%`

Tauri's store plugin (`tauri-plugin-store`) writes plain JSON files under the app's data directory:

- **`auth-state.json`** — one boolean (`has_session`). Low sensitivity: it doesn't contain a token or identity, just "was a session cached last time."
- **`overlay-window.json`** — window center coordinates (numbers). Low sensitivity: just where the window was last positioned.
- **`settings.json`** (v0.1.5+): one boolean (`autostart_disabled`), recording that you turned "Start with Windows" off from the tray. Low sensitivity: a preference, not an identifier.

Neither of these is itself a live credential. Losing or forensically examining either file tells someone "this device had signed in before" and "where the window was," nothing more.

## What Firebase's own SDK persists

Separately from the two files above, the Firebase JS SDK (`firebase/auth`, initialized in `src/lib/firebase.ts`) persists its own session state inside the webview's IndexedDB/localStorage, under the webview's data directory. This is standard Firebase Web SDK behavior — it's how `onAuthStateChanged` survives an app restart without asking you to sign in again. This **does** include Firebase ID and refresh tokens. This is genuinely sensitive: a stolen or forensically examined laptop could potentially use these to resume a signed-in session, subject to Firebase's own token-rotation and expiry rules (ID tokens are short-lived; the refresh token is longer-lived and is the more sensitive of the two).

## Recommendation (needs your sign-off, not decided here)

Two real options, not a false choice:

1. **Accept Firebase's default behavior as-is.** Firebase ID tokens expire in about an hour regardless of what's on disk, and the refresh token can be revoked server-side (Firebase Auth supports revoking refresh tokens for a user). If your threat model is "a stolen laptop, but you can revoke sessions server-side once you know about it," this may already be an acceptable risk — many production apps built on Firebase Auth ship exactly this way.
2. **Move token storage to Windows Credential Manager.** More defense-in-depth against local disk forensics, but real engineering work: Firebase's Web SDK doesn't have a first-party "use an OS credential store" persistence adapter, so this would mean either writing a custom `Persistence` implementation that shells out to Windows Credential Manager via a new Tauri command, or accepting a partial mitigation (e.g., encrypting the IndexedDB directory at rest via Windows' own file-level encryption, which is a Windows/user setting, not something this app controls).

Given the reuse-cost tradeoff and that Firebase's own token rotation already provides a meaningful mitigation, option 1 (document and accept) is the more proportionate choice for a beta — but this is your call given what threat model the privacy policy needs to actually promise, not something to decide silently in code.

## Uninstall behavior

Tauri's Windows bundler (NSIS by default, per `tauri.conf.json`'s `bundle.targets: "all"`) uninstalls the application binaries it installed, but does **not** automatically delete the app's data directory under `%APPDATA%` — this is standard behavior for NSIS-generated uninstallers generally (removing user data on uninstall is opt-in, not default, precisely so a reinstall doesn't lose a user's settings). That means after uninstalling Aura Desktop, `auth-state.json`, `overlay-window.json`, `settings.json`, the log file, and Firebase's IndexedDB/localStorage data (including the refresh token discussed above) are all left behind under `%APPDATA%` until manually deleted.

**This directly affects what the Privacy Policy addendum can truthfully claim.** As drafted in `LEGAL_ADDENDUM_DRAFT.md`, nothing currently promises automatic data deletion on uninstall — if that's the promise you want to make, it needs an explicit uninstall hook (NSIS supports a custom uninstall script via `tauri.conf.json`'s `bundle.windows.nsis` config) added as a follow-up. If the promise is instead "data doesn't automatically delete on uninstall; here's how to clear it manually," that's already true today and just needs stating plainly rather than left unexamined.
