# Aura Desktop

Tauri v2 + React 19 + TypeScript desktop companion app, a from-scratch rewrite of the sibling Flutter app (`../Aura`, "Buddy") for better UI performance and maintainability. Windows ships today; macOS is a work in progress (see "Platform support" below). The desktop client talks to the same backend (`juno-backend` on Cloud Run) and Firebase project (`juno-2ea45`) as the Flutter app.

This file is working instructions for Claude Code in this repo. For the full architecture - diagrams, the IPC surface, session flows - see [`README.md`](./README.md). For the incident log behind the rules below, see [`lessons-learnt.txt`](./lessons-learnt.txt).

## Cross-repo ecosystem map

This client is one of three codebases in the Aura system, alongside Aura (mobile app + the shared `juno-backend`) and Aura-Web (marketing site + browser auth handoff).
See [`../Aura/ECOSYSTEM.md`](../Aura/ECOSYSTEM.md) for how they fit together at a system level; this file and `README.md` already cover the desktop-specific detail, including the full three-repo Google sign-in sequence below.
Update that shared file when a change here alters a cross-repo contract (a `/devices/*` or `/voice/token` call shape, the GitHub Releases update/download contract, or shared Firebase identity), not for internal-only changes.

## Architecture

The runtime has three Tauri webview windows:

- `main` is the borderless, transparent, always-on-top companion overlay. It resizes/repositions itself between `hidden`, `panel`, `bar`, `companion`, `pointing`, and `movingnotch`; `panel` carries the `setup` or `companion` variant. See `src-tauri/src/overlay.rs` for the native state machine and `src/overlay/OverlayRoot.tsx` for the matching React root.
- `dashboard` is the opaque, resizable app window built on demand by `src-tauri/src/dashboard.rs`, routed by `src/main.tsx` into `src/dashboard/DashboardApp`.
- `dictation` is the separate transparent HUD built by `src-tauri/src/dictation/hud.rs`, routed by `src/main.tsx` into `src/dictation/DictationHud`. It shares the overlay notch edge, stays out of the taskbar and Dock, and must not steal focus from the target app except for the consent prompt (a `WS_EX_NOACTIVATE` window on Windows; on macOS a non-activating `NSPanel` whose `canBecomeKeyWindow` is phase-gated, because tao's `show()` is `makeKeyAndOrderFront:` and a panel that is always key-eligible takes key on every show). It and the buddy overlay are never both on screen: at rest any visible presentation hides the HUD, and for the length of a hold the notch hides and the HUD takes its edge, then the notch returns on `Idle`. Both directions run through `overlay::apply_result` (the `dictation_hold` flag, set only via `overlay::set_dictation_hold`); a live voice call or an explicit summon keeps the notch and leaves the HUD hidden.
- Rust owns window geometry, the configurable voice trigger (default Left Ctrl double-tap on Windows, Ctrl+Alt+V on macOS, where a double-tapped bare modifier would need an Input Monitoring grant a registered chord does not), global hotkeys (chat is Ctrl+Alt+Space on Windows but Option+Space on macOS, where Ctrl+Alt+Space is already "select next input source"; then Ctrl+Alt+D dashboard, Ctrl+Alt+S Screen Sight, Ctrl+Alt+G Guide Mode, Ctrl+Alt+M output mute, Ctrl+Shift+D sign-out), tray, and foreground handling (`win_focus.rs`: on Windows because it denies `SetForegroundWindow` while another app owns focus, on macOS because `set_focus` activates the whole app and would pull focus off whatever the user was typing in). Force foreground ONLY for the Setup `Panel` or the explicit chat summon path that uses `raise_for_hotkey`. Never force it for the resting notch/`Bar`: the notch is always-on-top, so it shows without stealing focus - see the 2026-07-16 "fail to dismiss" lesson.
- React owns all visual content and copy (`src/dashboard/`, `src/overlay/`, `src/dictation/`), Firebase auth (`src/state/AuthProvider.tsx`), standard per-turn screen capture (`useTurnScreenCapture`), continuous change-filtered Guide capture (`useGuideMode`), and the LiveKit call.
- The overlay drag surface is one continuous drag region (`data-tauri-drag-region="deep"` on `GlassSurface`) - real inputs/buttons/links block dragging on themselves automatically (Tauri's own rule), nothing else needs to opt in or out individually. Don't add a narrower `data-tauri-drag-region` (bare, no value) on an inner element unless you mean to shadow/restrict the outer region - a bare attribute closer to the click target short-circuits the walk and blocks the deep region from ever being reached. Clickable overlay elements must be real `<button>`s, inputs, or links, not `<div role="button">`.

## Platform support

Windows is the shipping target. macOS now runs the same feature set, including dictation and
Meeting Notes. What differs is HOW a few subsystems are implemented, not whether they exist.
Check here before assuming anything about either.

**Cross-platform (one implementation, no gates):** hotkeys, tray, overlay geometry and docking,
screenshots (`xcap`), Guide Mode (slower, no DXGI fast path), updater, autostart, deep links,
plain notifications, atomic writes, dashboard data pages, at-rest encryption, the encrypted
stores built on it (chat cache, interview sessions, saved images, screenshot store), the
dictation ASR socket, dictation's vocabulary/consent/credential/usage/polish/history modules,
the meeting engine, segment queue and evidence store, and the whole capture broker above its
device layer.

**Modules with a platform SEAM (both sides real, seam inside the owning file):**
`crypto.rs` (`keywrap`), `audio_capture.rs` (`backend`: WASAPI vs a Core Audio process tap),
`dictation/audio.rs` (`backend`: WASAPI vs AVAudioEngine), `dictation/insert.rs` (`backend`:
SendInput vs CGEvent), `dictation/hud.rs` (`sync_activation`, `target_center`),
`meeting/session.rs` (`platform`: WTS vs distributed notifications), `meeting/detect.rs`
(`scan`: EnumWindows vs NSWorkspace + AX), `meeting/runtime_lease.rs` (named mutex vs flock),
`uia/` (UIA walker vs an AX focus probe), `overlay.rs`, `win_focus.rs`, `window_util.rs`.

**Windows-only, genuinely:** `audio_ducking.rs`, `toast.rs`, `dictation/import_traces.rs`,
three of four `system_control.rs` verbs, and `interview.rs`. Everything else has a real macOS
implementation. `interview.rs` is the only one still gated wholesale, and only because nobody
has un-gated it: it depends on the now-portable audio broker, and doing so is what would let
`lib.rs`'s `cfg_attr(not(windows), allow(dead_code, ...))` disappear entirely.

**Shared macOS files exist only where several callers need them:** `macos_window.rs` (AppKit
windows), `macos_ax.rs` (Accessibility reads), `macos_audio.rs` (capture and format
conversion), `macos_input.rs` (keycode table, Secure Input). Anything used by ONE module stays
in that module, the way `keywrap` does.

**The rule that keeps this honest:** a module belongs behind `#[cfg(windows)]` ONLY if it
actually calls a Win32 API. Several modules were gated for merely sitting downstream of one
(the whole `asr/` tree and `screenshot_store.rs` contain zero Win32 calls), which made them
vanish on macOS for no reason and left `usePolishCredential.ts` retrying an unregistered command
forever. `meeting/audio.rs`, `meeting/queue.rs` and `dictation/polish.rs` were the same mistake
a second time. Before adding a gate, grep the file for `windows::` and gate the caller instead.

**Porting a Windows module means MOVING it, not rewriting it.** Every Windows body in the seams
above went into its `backend`/`platform` module verbatim - same calls, same order, same error
strings - so that the Windows half of the diff is provably a relocation. The one place shared
code replaced an inline Windows body (`audio_capture::capture_thread`) preserves even the
per-drain `Glitch` event COUNT for that reason. Hold to this: only the `windows-latest` CI leg
can prove it, since the Windows tree cannot be cross-compiled from a Mac (`ring`'s build script
needs the Windows SDK).

**macOS needs four TCC grants, none of them an entitlement.** Microphone; Accessibility (text
insertion via CGEvent, and the focus probe); Input Monitoring (the CGEventTap that feeds the
dictation chord and the optional double-tap voice trigger, the twin of the Windows keyboard
hook); and System Audio Recording for Meeting Notes. The tap is built at launch whenever Input
Monitoring is already granted. The prompt itself is only ever raised for something the user
opted into: when dictation is turned on (`dictation_set_consent`), or at launch when dictation
consent is already on or a double-tap trigger is bound, never for a fresh install. The grant
lands only after a relaunch, so `DictationStatus.blocker` (`inputMonitoring` / `relaunch`) is
how the Dictation page offers the right button; it is checked silently in `with_listener_health`
and must never prompt from a status read. The last one has NO request API - its prompt only
fires when `AudioDeviceStart` runs on the tap-backed aggregate device, so the whole pipeline is
built before macOS asks, and a refusal surfaces as a capture failure rather than a stall. The
process-tap API exists from 14.2 but its TCC category only behaves correctly from 14.4, which
is why `bundle.macOS.minimumSystemVersion` is 14.4.

**A CGEventTap can be switched off underneath you.** macOS disables a tap whose callback is too
slow (`kCGEventTapDisabledByTimeout`) or during certain user input, silently - dictation just
stops responding with nothing in any log. `voice_toggle_key.rs`'s callback re-enables on both
event types, and that branch is not optional. The tap is listen-only because the Windows hook it
mirrors always calls `CallNextHookEx` and never suppresses; since macOS has no `LLKHF_INJECTED`,
the insert path stamps `kCGEventSourceUserData` with a marker the tap drops.

**At-rest encryption has exactly one platform seam.** `crypto.rs` is AES-256-GCM everywhere;
only key WRAPPING differs (DPAPI on Windows, and on macOS a master key derived as
`SHA-256(domain ‖ master.salt ‖ gethostuuid())`), and that lives in its `keywrap` submodule.
Per-feature key files stay in the same place on both, so deleting the meeting captures
directory still cannot brick the dictation vocabulary. Both implementations MUST fail closed:
on macOS only a genuinely absent `master.salt` may mint a new one. Treating an unreadable salt
as "no key" silently mints a replacement and makes every already-sealed row permanently
unreadable while new writes look healthy.

**macOS does NOT use the login Keychain for this, and putting it back is a regression.** A
keychain item's ACL is bound to the code identity that created it, so a `tauri dev` binary, a
locally signed bundle and a release build are three different owners of one secret; every
mismatch raises "Aura Desktop wants to access key com.aura.desktop in your keychain", asking
for the LOGIN KEYCHAIN password, which most users have never knowingly set. The Team ID switch
would do it to every install at once. Apple's prompt-free answer (the data protection keychain)
needs an App-ID-signed binary with the restricted `keychain-access-groups` entitlement
authorised by an embedded provisioning profile, which Tauri does not inject, and its access
group is still Team-ID scoped. The derivation gives DPAPI's "useless on another machine"
property with no dialog on any code path. It also means another process running as this user
can derive the key, which is exactly what DPAPI at current-user scope already allows on
Windows: parity, not a step down. Key files written before this carry no `KEY_FILE_MAGIC`; on
macOS they are unrecoverable and get dropped and re-minted ONCE, and that reset is bounded by
the magic precisely so a marked blob that will not unwrap still fails closed.

**User-visible strings never hardcode a platform.** `src/lib/platformKeys.ts` is the only place that
knows which OS this is: key labels (Ctrl/Win vs the macOS symbols), `deviceNoun`, `trayNoun`,
`osName`, the backend and analytics platform tags, and the System Settings deep links. Adding a
platform-varying string means adding it there, not branching at the call site.

## Optimistic "applied" caches

A cache that represents "this side effect already happened" (`OverlayState.applied`, the single `AppliedBounds` snapshot in `overlay.rs`) must be written **after** the side effect succeeds, never before. Writing it optimistically means one failed resize/show call permanently desyncs the cache from reality, and every later trigger (hotkey, tray click, second-instance launch) trusts the stale cache and silently no-ops instead of retrying. This exact bug froze the Flutter sibling's desktop overlay from ever showing a window after a first-boot failure - don't reintroduce it here.

## Main-thread blocking (Tauri commands)

A `#[tauri::command]` without `async` runs directly on the thread that pumps the native window's messages. Any real work in one of those (screen capture, file IO, network, image/audio encoding) freezes the window, and Windows eventually shows "(Not Responding)". Default new commands to `async fn`; push CPU-bound work into `tauri::async_runtime::spawn_blocking` rather than doing it inline. This exact bug shipped in `capture_cursor_display_with_geometry` (`screenshot.rs`) - synchronous DXGI capture + JPEG encode + base64 on the main thread, triggered on every spoken turn while screen-sight was armed.

## The Google sign-in flow spans three independently-deployed repos

`SignInForm.tsx`'s "google" mode (`useWebAuthSignIn.ts`) opens the system browser to Aura-Web and polls `juno-backend` until that browser leg completes - see README's sequence diagram. The non-obvious constraint: Aura-Desktop, `juno-backend`, and Aura-Web deploy through completely different mechanisms, so "the code exists on disk" does not mean "the code is live." `juno-backend`'s `deploy.sh` builds its image via a plain `docker build` against the local working directory, which doesn't care about git state at all - an untracked file still ships. Aura-Web ships via a git-triggered deploy (`/ship` → push → platform build), so an untracked file never ships, no matter how correct it looks in a local checkout. This exact split let a fully-implemented Aura-Web auth page sit untracked and never deployed while the matching `juno-backend` route was already live, so every desktop attempt got a valid session code and then polled a 404 for the full 10-minute TTL with nothing to show for it until someone `curl`ed the live endpoints directly. When this flow breaks, verify against the live endpoints first, not just the source in each repo - see the 2026-07-05 entries in `lessons-learnt.txt`. Separately, every entry point into "google" mode must stay reachable from wherever a user actually lands (onboarding's welcome step, and both the pairing and email screens) - it shipped once with no reachable button at all outside a welcome step that's skipped for any returning user.

## Dashboard data pages reuse the web dashboard's live contracts

Conversations, Drafts, and Saved (`src/dashboard/pages/`) read the user's real cross-surface data from the SAME `juno-backend` endpoints the Aura-Web dashboard already uses: `GET /history/sessions?since=<ISO>` (+ `/history/sessions/{id}`), `GET /drafts`, `GET /screen-saves`. Do NOT point them at the `/desktop/*` projections - `/desktop/conversations` filters to `surface == "desktop"` and `/desktop/saved` reads a different `memory_atoms` collection, so both return empty for a user whose data was created on mobile/web. That mismatch was the original "everything is empty" bug (see the 2026-07-17 lesson). When adding a data page, check what the live web client calls before assuming an endpoint needs building, and verify against the live endpoint, not just source on disk.

The client is `src/lib/dashboardApi.ts` (typed, snake_case→camelCase, layered on `authFetch`). Fetch state goes through `useDashboardResource.ts` (stale-while-revalidate: in-memory-over-disk cache via `dashboardCache.ts`, freshness gate, single-flight, hard timeout, out-of-order guard). Screen-save `image_url`s are ephemeral signed URLs - the cache strips them (`toCache`) and they render only from a live fetch. UI is a data-driven fixed shell (`components/DashboardCard` fed a `CardModel`, `CardGrid`, `DetailModal`, `RangeChips`); keep the three-layer split (contracts / cache+fetch / presentational) when extending it. Open external links with `openUrl` from `@tauri-apps/plugin-opener`, never a bare `<a target="_blank">` (the webview ignores those).

## Visual language: bright glassmorphism, not flat surfaces

Any new card, panel, tile, or surface in the dashboard or onboarding must use the bright glass recipe, never a flat `var(--db-surface)` fill with a grey border (that is the dated 2005 look that got redesigned out in 2026-08). The canonical recipe, shared by onboarding (`src/overlay/PrivacySetupStep.css`, `src/overlay/OnboardingFlow.css`) and the dashboard stat/briefing cards (`.db-card`, `.db-today-briefing`, `.db-insight-summary-card` in `src/dashboard/dashboard.css`):

```css
border: 1px solid rgba(255, 255, 255, 0.82);
background: linear-gradient(135deg, rgba(255, 255, 255, 0.88), rgba(232, 244, 241, 0.56));
box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.94), 0 5px 14px rgba(63, 86, 78, 0.06);
backdrop-filter: blur(18px) saturate(1.2);   /* always with the -webkit- twin */
```

Rules that follow from it:

- Everything INSIDE a glass surface must be alpha-based too: hovers use translucent white (e.g. `rgba(255, 255, 255, 0.5)`), dividers use soft `rgba(63, 86, 78, 0.1)`, never opaque `--db-border` or cream fills. One opaque child punches a hole in the glass.
- Interactive glass elements get the hover sheen sweep: a rotated white-gradient `::after` bar animated across on hover (`db-glass-sheen` in dashboard.css, ported from `onboarding-glass-sheen`). The parent needs `position: relative; overflow: hidden;`.
- Icons sit bare on the glass (tone-colored glyph, optional soft radial `::before` glow), no boxed chip behind them. Idle animations are long-period and low-amplitude; `.db-reduce-motion` already stills everything app-wide, so no per-animation guard.
- A hand-rolled SVG icon next to lucide glyphs must match lucide's optical live area (~20 of 24 viewBox units); crop the viewBox to the artwork's bounding box rather than redrawing (see `StreakFlameIcon` in `HomePage.tsx`).

## Dictation history is the one place transcripts touch disk

`src-tauri/src/dictation/history.rs` retains every finished dictation and its
audio locally, which reverses what the rest of the dictation module still says
about storage. The reversal is narrow and the invariants around it are not:

- Text is AES-256-GCM in a BLOB column of `dictation/history.sqlite3`; audio is
  AES-256-GCM over FLAC under `dictation/clips/`. Both are sealed with the
  DICTATION key (`vocab.rs`), never meeting's, so "delete my recordings" cannot
  brick dictation. Nothing in this module is ever logged beyond counts, sizes,
  durations and outcomes.
- **A password-field dictation is never recorded.** Aura already refuses to type
  into one; archiving it would be strictly worse. So are failed holds, which have
  no transcript. The single gate is the `InsertOutcome` check at the one
  `history::record_later` call site in `mod.rs`.
- **Text and audio have separate caps**: text is 90 days, audio is 90 days OR
  512 MB, evicted oldest first. Eviction unlinks the clip and NULLs
  `audio_path` while KEEPING the row, so "audio gone, transcript present"
  (`has_audio: false`) is a designed state, not an error. Any new UI must handle
  it as normal.
- `security::session_changed` calls `history::retain_only_for_session` on EVERY
  transition, deleting clip files as well as rows. That is the only thing
  isolating dictations across accounts; do not make it conditional on `revoked`.
- The transcript column is ciphertext, so there is no SQL search and there must
  never be a plaintext-searchable copy. `dictation_history_list` decrypts once
  and the page filters in memory.
- Turning history off stops future capture and deliberately keeps existing rows.
  Clearing is a separate, confirmed action. Do not conflate them.

The flag button writes to the `user_feedback` Firestore collection directly via
the Firebase SDK (`src/lib/dictationFeedback.ts`), the same way the Flutter app
does. There is no `product_feedback` collection, `observed_feedback` is
backend-only with a closed schema, and `POST /feedback/alarm-interest` is
hardcoded to alarm slugs. Writing directly is what keeps this shippable without
a separate `juno-backend` deploy; it needed `firestore.googleapis.com` in the
CSP's `connect-src`.

## Desktop notifications

`src/lib/desktopNotifications.ts` is the ONE broker every producer calls (local Rust/JS events and backend events polled from the outbox). It owns the durable inbox, dedup, permission, and the toast-once guarantee (delivered ids persist across restart, so a relaunch never replays a toast). Two non-obvious rules:

- **Toast copy is the notification's own title + body** (`toastCopyFor`), changed 2026-07-21 from the earlier generic-per-type copy that kept content off the lock screen. Meeting titles now appear on the Windows lock screen and in Action Center - this was a deliberate product call, not an accident. The contract's `sensitive` flag (`desktopNotificationContract.ts`) is parsed and stored but NOT currently enforced; it is the intended escape hatch. If you re-add privacy-generic copy, gate it on `sensitive` inside `toastCopyFor`, do not resurrect the per-type string switch. An empty title/body falls back so a toast never renders blank. Telemetry still never carries title/body - only the user-facing toast and inbox do.
- **Pre-capture meeting misses are silent by design.** A toast fires ONLY for a meeting that actually started capturing (capture-ended local notify, `meeting_upload_pending`, or the backend's `meeting_ready`). An armed meeting that was never detected (Google Meet in a background tab, started outside its scheduled window), an ad-hoc call with no calendar event, or a claim blocked by the monthly cap produces NO toast - the cap only shows an in-bar caption (`useMeetingCapture.ts` header: "every failure path here is silent to the user except the monthly cap"). To notify on any of these, add a new producer + notification type; the broker will not synthesize one.

## Workflows

Dev loop - ask first, the user runs these and reports back (see Working style):

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server only, no native window |
| `npm run tauri dev` | Full app: Rust + webview, hot reload both sides |
| `npm run build` | `tsc && vite build` (frontend only) |
| `npm run tauri build` | Production bundle + installer + updater artifacts |

Fast, silent checks - fine to run directly, no need to ask:

| Command | Does |
|---|---|
| `cd src-tauri && cargo check` | Rust compiles, no binary produced. CI runs this and `cargo clippy -- -D warnings` on BOTH windows-latest and macos-14, so the non-Windows halves cannot rot. If `cargo` isn't on PATH in the shell, use `& "$env:USERPROFILE\.cargo\bin\cargo.exe"`. Use PowerShell, not Bash - Git Bash's `link.exe` shadows MSVC's. |
| `npx tsc --noEmit` | TypeScript type-checks |

### Releasing

Releases are cut by tag. `.github/workflows/release.yml` runs a Windows job (Azure Artifact Signing), then a macOS job (Developer ID + notarization), then one publish job that flips the draft GitHub Release carrying both installers and the updater `.sig` files. `workflow_dispatch` is a three minute preflight (both credential smoke tests, no build); add `-f full_build=true` to also rehearse bundling on both.

```
tag vX.Y.Z pushed
  │
  ├─ job windows (windows-latest)
  │    ├─ version guard        3 files must agree with the tag        fails in ~20s
  │    ├─ npm ci
  │    ├─ updater key check    signs a probe, then verify-updater-key.mjs
  │    │                       confirms the pubkey in tauri.conf.json matches
  │    ├─ install client tools MSI + dlib/signtool discovery, ~30s, NO Azure needed
  │    ├─ azure/login          OIDC assertion, alive for exactly 5 MINUTES
  │    ├─ smoke test  ◄────────signs a throwaway PE ~20s later. Proves credential,
  │    │                       RBAC, cert profile, dlib and signtool in 10 seconds,
  │    │                       AND caches an access token good for ~1 hour
  │    ├─ tauri-action         ~12 min build, then every signature calls
  │    │                       scripts/sign-windows-artifact.ps1, which mints a
  │    │                       FRESH OIDC assertion per batch (150s stamp)
  │    └─ verify artifacts     Authenticode on the NSIS exe and the MSI, .sig present
  │
  ├─ job macos (macos-latest, needs windows: tauri-action's latest.json merge is a
  │            download-then-upload with no lock, so the two jobs must not overlap)
  │    ├─ version guard, npm ci, updater key check    same as above
  │    ├─ Apple smoke test     imports the .p12 into a throwaway keychain, signs a
  │    │                       copy of /bin/ls, runs `notarytool history`. Proves the
  │    │                       cert is a Developer ID Application one and the API key
  │    │                       works, in ~15s instead of after the build
  │    ├─ tauri-action         --target universal-apple-darwin. Tauri itself signs,
  │    │                       notarizes (notarytool --wait, 2 to 20 min) and staples
  │    └─ verify artifacts     codesign/spctl/stapler on the .app AND on the .app
  │                            inside the updater tar.gz, lipo shows both slices,
  │                            DMG signed
  │
  └─ job publish (needs both)
       ├─ latest.json must carry windows-x86_64, darwin-aarch64 AND darwin-x86_64
       └─ flips the draft to latest
```

To ship:

1. Bump the version in **all FOUR** of `package.json`, `package-lock.json` (run `npm install --package-lock-only`; it has TWO root version entries), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, then refresh `src-tauri/Cargo.lock` via `cargo check`. All four must be identical or the run dies on the guard (this is what killed v0.8.1).
2. Commit, then ask the user to push `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`, then `gh run watch --exit-status`.
4. On failure, `Show what the sign command actually said` dumps the real signtool error, and the tag is one line to undo: `git push --delete origin vX.Y.Z; git tag -d vX.Y.Z`.

**The signing credential lives five minutes, and that is load bearing.** `azure/login` with GitHub OIDC hands back a client assertion valid for exactly five minutes, not a refresh token, and the Azure CLI replays that same string on every later request. `AADSTS700024: Client assertion is not within its valid time range` is what that looks like, and signtool wraps it in a generic `SignerSign() failed` (`0x80004005`), which is also what a wrong region endpoint produces. Read the inner exception, not the exit code. Three rules protect this:

- **Never put a slow step between `Sign in to Azure` and `Smoke test the signing command`.** A fourteen minute dlib sweep sitting there is what broke the whole 0.8.x series. The client tools install is above sign-in for exactly this reason and must stay there.
- **Never remove `Update-AzureSigningLogin` from `scripts/sign-windows-artifact.ps1`.** `tauri.conf.json`'s `signCommand` routes the exe, the WiX extension dlls, the MSI and the NSIS installer through that one script, which makes it the only place a live credential can be guaranteed. It mints a fresh assertion from `ACTIONS_ID_TOKEN_REQUEST_URL`, re-runs `az login`, and exchanges it for a codesigning token, with a 150 second stamp so back to back artifacts do not each pay for a sign-in.
- **Any step that can trigger a signature needs `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` in its `env:`.** Without them the refresh silently no-ops and the run falls back to the cached token alone.

Do not "simplify" this by arranging build steps around the five minute window. That was tried (split compile, second sign-in, separate cache warm) and it works only until the next step gets slower. The refresh belongs at the choke point.

Signing config lives in the Entra app registration (federated credential subject `repo:AuraVoice/Aura-Desktop:environment:production`, audience `api://AzureADTokenExchange`) and the `production` GitHub environment, which holds `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. There is no `AZURE_CLIENT_SECRET` and the workflow does not want one. When signing breaks, query the live resource with `az` rather than reading the portal or the config that is supposed to describe it.

**macOS signing is five secrets and no script.** How to obtain each, the run order, and the company-certificate switch are written up in [`MACOS_RELEASE_CHECKLIST.md`](./MACOS_RELEASE_CHECKLIST.md); read it before the first Mac tag. The same `production` environment holds `APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY` (App Store Connect Team key ID), `APPLE_API_ISSUER`, and `APPLE_API_KEY_P8` (the `.p8` body; the job writes it to disk and sets `APPLE_API_KEY_PATH`). `KEYCHAIN_PASSWORD` is generated per run because it only guards a keychain the runner deletes. There is no `APPLE_ID`/`APPLE_PASSWORD` and the workflow does not want them: an app-specific password rides on a human account Apple can lock at any time. Individual keys cannot notarize; the key must be a Team key, Developer role is enough. Tauri does the import, `codesign --options runtime`, `notarytool submit --wait` and `stapler staple` itself from those env vars; a missing notarization credential is a build failure, never a silent skip.

**BEFORE PUBLIC LAUNCH: the certificate is the individual membership's.** Replacing it with the company's Developer ID changes the Team ID, and macOS keys every TCC grant on that identity. Every beta install will re-prompt for Microphone, Accessibility, Input Monitoring and Screen Recording on its first launch after that update. Ship that release with a note that says so; nothing in the code can avoid it. The at-rest master key is NOT affected any more: it is derived locally rather than held in the login Keychain, so no keychain dialog rides along with the Team ID change. The updater itself is unaffected: it trusts the minisign key, not the Apple one. The same release is the moment to test dropping the unproven JIT entitlements (see `entitlements.plist`).

**Local Mac builds.** `tauri dev` runs an unsigned binary, and every rebuild is a new identity to TCC: Accessibility, Input Monitoring and Screen Recording grants vanish each time, and Sequoia refuses screen capture to ad-hoc binaries entirely. To test permissions or capture, build the real bundle with `APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team>)" npm run tauri build -- --target universal-apple-darwin` and run the `.app` from /Applications. A locally built bundle carries no quarantine flag, so it launches without notarization.

The new-identity rule used to hit the at-rest master key too, because it lived in the login Keychain and that item's ACL names the binary that created it. It no longer does: the key is derived from `master.salt` plus the hardware UUID, neither of which cares which binary is asking, so a dev rebuild raises no dialog. If a Mac still has the retired item from an older build, delete it once; nothing recreates it.

```
security delete-generic-password -s com.aura.desktop -a at-rest-master-key
```

### Adding a new Tauri command

1. Write it in the relevant `src-tauri/src/*.rs` module with `#[tauri::command]`.
2. Register it in the `tauri::generate_handler![...]` list in `lib.rs`.
3. Default to `async fn` (see "Main-thread blocking" above) unless the body is a couple of cheap synchronous reads, e.g. locking the overlay state `Mutex` for a field read.
4. Call it from React with `invoke("command_name", { argName: value })` from `@tauri-apps/api/core` - snake_case Rust params auto-map from camelCase JS args.

### Adding a new Rust → React event

1. `window.emit("event-name", payload)` where `payload: impl Serialize`.
2. In React, `listen("event-name", cb)` from `@tauri-apps/api/event`, inside a `useEffect` that stores the returned unlisten function and calls it on cleanup.

### Touching the overlay state machine

Changes to `OverlayPresentation`/`PanelVariant` or their transitions live in `overlay.rs` (`set_presentation`, `size_for`, `position_for`) with a matching render branch in `OverlayRoot.tsx`. Respect the optimistic-cache rule above. The current presentations are `Hidden`, `Panel`, `Bar`, `Companion`, `Pointing`, and `MovingNotch`; the old `Pill`/`minimize_to_pill` command path is gone.
The Bar and Companion presentations can grow a single notch slot: `OverlayRoot` resolves which surface wins it (currently chat > draft > inbox > daily catch-up) and drives the single `set_slot_height` command; `overlay.rs` tracks it as `slot_height` (inside the single `applied: Option<AppliedBounds>` cache, same after-success rule). On top/bottom edges the bar grows inward from the edge; on left/right edges the card grows beside the vertical notch.
The per-card open commands this replaced (`set_draft_card_open`, `set_callback_card_open`) no longer exist; each surface's height constant or measured height lives in OverlayRoot and must agree with its CSS.
Meeting Notes (MEETING_NOTES_PLAN.md) adds `src-tauri/src/meeting/` (WASAPI capture, join detection, encrypted segment queue) plus `useMeetingArm`/`useMeetingCapture`/`useMeetingNotes` on the React side; capture is user-armed only, shows a persistent recording indicator, and gates the updater like `voice_active` does.

## Working style

- **Keep edits surgical.** Change only the lines needed for the requested behavior.
  Never reflow signatures, imports, comments, whitespace, or nearby code. Do not
  run `cargo fmt`, `rustfmt`, Prettier, format-document, or broad autofix tools.
  For `MEETING_RECORDING_V2_ARCHITECTURE.md`, do not run `git diff` or any
  git-diff variant; inspect the exact edited lines directly instead.

- **TEST FREEZE. YOU MUST NOT write any new test file, test function, test case, or fixture.** In force until Varun bumps the version or asks for tests in the current message. Nothing else lifts it: not a rule that "needs" a test, not a bug you just fixed, not a coverage gap you noticed. Never offer to add tests while it is in force.

  **YOU MUST NOT write a test in order to find, reproduce, or diagnose an error.** This is the specific waste the freeze exists to stop: writing a test, compiling it, running it, and iterating on the test itself burns far more time than asking the real object directly. To verify something, in this order:
  1. `cd backend && python -c "import src.main; print('OK')"` for import and wiring.
  2. A throwaway `python -c` that inspects the real value (`print` the live registry, the built prompt, the serialized schema). This is inspection, not a test, and is always allowed. Never save it to a file.
  3. Run the EXISTING suite. It is comprehensive; if a change is wrong it almost always already breaks something.

  Repairing an EXISTING test IS allowed and expected: a stale fake, a drifted import, or an assertion that no longer matches shipped behaviour is a broken verification path, not new test surface. Fixing a fake's signature, re-pointing an assertion at a renamed mechanism, or adding a helper an existing test needs to keep working is repair. A new case, file, or fixture is not.

- Never use em-dashes anywhere, in UI copy or in code/comments. Use plain human phrasing, not AI-sounding wording.
- Commit messages must read like a human wrote them: no Claude-Session links, no AI attribution tags, no generated trailers of any kind.
- Never ship the default OS scrollbar. The dashboard hides scrollbars app-wide via `.db-app *::-webkit-scrollbar` (`dashboard.css`); any new scroll container must either hide its scrollbar or use a slim custom-styled one. Watch portaled elements: anything rendered outside `.db-app` (e.g. a `createPortal` to `document.body`) loses both that scrollbar rule and the `--db-*` tokens, so it falls back to raw chrome and a transparent background. Portal into `.db-app` instead.
- Ask before running long-running or launching commands (`npm run tauri dev`, etc.) - the user runs those themselves and reports back, since they iterate faster than a tool-call round trip and Claude can't visually verify a GUI window anyway. Fast, silent checks (`cargo check`, `tsc --noEmit`) are fine to run directly.
- Only change what was asked. Don't refactor, rename, reorganize, or reformat anything else in the same pass; mention other issues noticed at the end instead of touching them.
- Before deleting a file, dropping generated assets, or removing a dependency, say what will be affected before doing it.
- End a task with a brief status update: what changed, what was left untouched, what needs the user's attention next.
- Log in [`lessons-learnt.txt`](./lessons-learnt.txt) at the repo root ONLY when a real problem was overcome: a bug, a silent failure, a non-obvious constraint that broke (or would have broken) something, or a review finding - with problem, issue, solution, justification, date. Do NOT log routine feature work, additive changes, or design decisions that shipped without a problem being solved; a task producing working code is not a lesson. If nothing failed or surprised you, add nothing.
- when explaining a plan potray in examples and data flow rather than simple text.
- NEVER Push code to github without me explicitly saying, this doesn't include a plan where you propose to push commits to git. Always advice me to push. 

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

