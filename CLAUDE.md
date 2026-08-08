# Aura Desktop

Tauri v2 + React 19 + TypeScript Windows companion app, a from-scratch rewrite of the sibling Flutter app (`../Aura`, "Buddy") for better UI performance and maintainability. The desktop client talks to the same backend (`juno-backend` on Cloud Run) and Firebase project (`juno-2ea45`) as the Flutter app.

This file is working instructions for Claude Code in this repo. For the full architecture - diagrams, the IPC surface, session flows - see [`README.md`](./README.md). For the incident log behind the rules below, see [`lessons-learnt.txt`](./lessons-learnt.txt).

## Cross-repo ecosystem map

This client is one of three codebases in the Aura system, alongside Aura (mobile app + the shared `juno-backend`) and Aura-Web (marketing site + browser auth handoff).
See [`../Aura/ECOSYSTEM.md`](../Aura/ECOSYSTEM.md) for how they fit together at a system level; this file and `README.md` already cover the desktop-specific detail, including the full three-repo Google sign-in sequence below.
Update that shared file when a change here alters a cross-repo contract (a `/devices/*` or `/voice/token` call shape, the GitHub Releases update/download contract, or shared Firebase identity), not for internal-only changes.

## Architecture

One borderless, transparent, always-on-top window (label `"main"`) that resizes/repositions itself between presentations, rather than separate windows per screen:

- `hidden` / `panel` (`setup` or `bar` variant) / `pill` / `pointing` - see `src-tauri/src/overlay.rs` for the state machine and `src/overlay/OverlayRoot.tsx` for the matching React root.
- Rust owns window geometry, the Left Ctrl double-tap listener, hotkeys (Ctrl+Shift+D immediate sign-out, Ctrl+Alt+G Guide Mode toggle), tray, and focus-forcing (`win_focus.rs`, needed because Windows denies `SetForegroundWindow` while another app owns focus). Force foreground ONLY for the Setup `Panel` (its sign-in fields need keyboard focus). Never force it for the notch/`Bar`: `win_focus` injects a lone Alt tap to win focus, which drops the newly-foreground window into Windows keyboard menu mode and swallows the next Left Ctrl double-tap until the user clicks away. The notch is always-on-top, so it shows without stealing focus - see the 2026-07-16 "fail to dismiss" lesson.
- React owns all visual content and copy (`src/overlay/`), Firebase auth (`src/state/AuthProvider.tsx`), standard per-turn screen capture (`useTurnScreenCapture`), and continuous change-filtered Guide capture (`useGuideMode`).
- The whole overlay is one continuous drag region (`data-tauri-drag-region="deep"` on `GlassSurface`) - real inputs/buttons/links block dragging on themselves automatically (Tauri's own rule), nothing else needs to opt in or out individually. Don't add a narrower `data-tauri-drag-region` (bare, no value) on an inner element unless you mean to shadow/restrict the outer region - a bare attribute closer to the click target short-circuits the walk and blocks the deep region from ever being reached.

## Optimistic "applied" caches

A cache that represents "this side effect already happened" (`OverlayState.applied_presentation`/`applied_variant` in `overlay.rs`) must be written **after** the side effect succeeds, never before. Writing it optimistically means one failed resize/show call permanently desyncs the cache from reality, and every later trigger (hotkey, tray click, second-instance launch) trusts the stale cache and silently no-ops instead of retrying. This exact bug froze the Flutter sibling's desktop overlay from ever showing a window after a first-boot failure - don't reintroduce it here.

## Main-thread blocking (Tauri commands)

A `#[tauri::command]` without `async` runs directly on the thread that pumps the native window's messages. Any real work in one of those (screen capture, file IO, network, image/audio encoding) freezes the window, and Windows eventually shows "(Not Responding)". Default new commands to `async fn`; push CPU-bound work into `tauri::async_runtime::spawn_blocking` rather than doing it inline. This exact bug shipped in `capture_cursor_display_with_geometry` (`screenshot.rs`) - synchronous DXGI capture + JPEG encode + base64 on the main thread, triggered on every spoken turn while screen-sight was armed.

## Rendering the pill's 3D avatar (AvatarPill.tsx)

Three rules, each one cost a full debugging cycle to find. Don't re-learn them.

**DRACOLoader needs an explicit decoder path.**
Never rely on `DRACOLoader`'s own default `import.meta.url`-based path resolution.
Under Vite dev mode, once esbuild's dependency pre-bundler moves `DRACOLoader.js` into `node_modules/.vite/deps/`, that relative path resolves to nothing.
The resulting 404 gets served as `index.html` by Vite's dev-server fallback, which then gets fed into the decoder's own Worker as JavaScript and throws there.
`DRACOLoader` never routes a Worker parse error through `onError`, so `GLTFLoader.load()` just hangs forever with no error anywhere - not the terminal, not the app's log file, nowhere durable.
Always call `dracoLoader.setDecoderPath({ js, wasm })` with the exact decoder files imported via Vite's `?url` suffix, exactly as `AvatarPill.tsx` does - this is correct in both dev and build, regardless of Vite's bundling decisions.

**Frame the posed geometry, never the bind pose (T-pose).**
A GLB's static bind pose is not what actually renders once an animation clip plays.
The retargeted `Idle` clip on `buddy.glb` sits a full unit higher than its own bind pose despite reporting the same total height - a leftover artifact of the external Mixamo retargeting pass, not a scale bug (every `.scale` track is `(1,1,1)`).
Before measuring or framing a camera around any animated model, evaluate the clip's first frame (`mixer.update(0)` + `scene.updateMatrixWorld(true)`, since neither the mixer nor a render has run yet) and take a real `THREE.Box3` of the *posed* result - never the raw loaded scene.
Camera trigonometry that looks correct on paper will still fail if it's fitting the wrong target. That's not a math bug, it's a "what is actually on screen" bug, and no amount of re-deriving the angles fixes it.

**Clickable overlay elements must be real `<button>`s, not `<div role="button">`.**
`data-tauri-drag-region="deep"` makes the whole overlay surface draggable, and Tauri only auto-excludes real inputs/buttons/links from that region automatically - an ARIA-role div doesn't qualify.
Clicks on a `<div role="button">` inside a drag region get swallowed as window-drag attempts instead of ever firing `onClick`.

**When a render looks wrong, build a throwaway harness before touching camera numbers again.**
`debug-avatar.html`/`src/debug/avatarDebug.ts` and `debug-pill.html`/`src/debug/pillDebug.ts` are standalone Vite pages that load the same model with the same loader/camera code, viewable directly in a normal browser tab (`npm run dev`, not `tauri dev`) with no LiveKit session or Tauri window needed per iteration.
Two rounds of pure camera-math guesses made no visible difference precisely because they were guesses - drawing the model's real bounding box as a wireframe and comparing it against the frustum is what actually found the posed-vs-bind-pose mismatch above.

## The Google sign-in flow spans three independently-deployed repos

`SignInForm.tsx`'s "google" mode (`useWebAuthSignIn.ts`) opens the system browser to Aura-Web and polls `juno-backend` until that browser leg completes - see README's sequence diagram. The non-obvious constraint: Aura-Desktop, `juno-backend`, and Aura-Web deploy through completely different mechanisms, so "the code exists on disk" does not mean "the code is live." `juno-backend`'s `deploy.sh` builds its image via a plain `docker build` against the local working directory, which doesn't care about git state at all - an untracked file still ships. Aura-Web ships via a git-triggered deploy (`/ship` → push → platform build), so an untracked file never ships, no matter how correct it looks in a local checkout. This exact split let a fully-implemented Aura-Web auth page sit untracked and never deployed while the matching `juno-backend` route was already live, so every desktop attempt got a valid session code and then polled a 404 for the full 10-minute TTL with nothing to show for it until someone `curl`ed the live endpoints directly. When this flow breaks, verify against the live endpoints first, not just the source in each repo - see the 2026-07-05 entries in `lessons-learnt.txt`. Separately, every entry point into "google" mode must stay reachable from wherever a user actually lands (onboarding's welcome step, and both the pairing and email screens) - it shipped once with no reachable button at all outside a welcome step that's skipped for any returning user.

## Dashboard data pages reuse the web dashboard's live contracts

Conversations, Drafts, and Saved (`src/dashboard/pages/`) read the user's real cross-surface data from the SAME `juno-backend` endpoints the Aura-Web dashboard already uses: `GET /history/sessions?since=<ISO>` (+ `/history/sessions/{id}`), `GET /drafts`, `GET /screen-saves`. Do NOT point them at the `/desktop/*` projections - `/desktop/conversations` filters to `surface == "desktop"` and `/desktop/saved` reads a different `memory_atoms` collection, so both return empty for a user whose data was created on mobile/web. That mismatch was the original "everything is empty" bug (see the 2026-07-17 lesson). When adding a data page, check what the live web client calls before assuming an endpoint needs building, and verify against the live endpoint, not just source on disk.

The client is `src/lib/dashboardApi.ts` (typed, snake_case→camelCase, layered on `authFetch`). Fetch state goes through `useDashboardResource.ts` (stale-while-revalidate: in-memory-over-disk cache via `dashboardCache.ts`, freshness gate, single-flight, hard timeout, out-of-order guard). Screen-save `image_url`s are ephemeral signed URLs - the cache strips them (`toCache`) and they render only from a live fetch. UI is a data-driven fixed shell (`components/DashboardCard` fed a `CardModel`, `CardGrid`, `DetailModal`, `RangeChips`); keep the three-layer split (contracts / cache+fetch / presentational) when extending it. Open external links with `openUrl` from `@tauri-apps/plugin-opener`, never a bare `<a target="_blank">` (the webview ignores those).

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
| `cd src-tauri && cargo check` | Rust compiles, no binary produced. If `cargo` isn't on PATH in the shell, use `& "$env:USERPROFILE\.cargo\bin\cargo.exe"`. Use PowerShell, not Bash - Git Bash's `link.exe` shadows MSVC's. |
| `npx tsc --noEmit` | TypeScript type-checks |

### Releasing

Releases are cut by tag. `.github/workflows/release.yml` builds, signs every artifact with Azure Artifact Signing, and publishes a GitHub Release carrying the updater `.sig` files. `workflow_dispatch` is a three minute preflight (credential + tooling only, no build); add `-f full_build=true` to also rehearse bundling.

```
tag vX.Y.Z pushed
  │
  ├─ version guard        3 files must agree with the tag        fails in ~20s
  ├─ npm ci
  ├─ updater key check    signs a probe, then verify-updater-key.mjs
  │                       confirms the pubkey in tauri.conf.json matches
  ├─ install client tools MSI + dlib/signtool discovery, ~30s, NO Azure needed
  ├─ azure/login          OIDC assertion, alive for exactly 5 MINUTES
  ├─ smoke test  ◄────────signs a throwaway PE ~20s later. Proves credential,
  │                       RBAC, cert profile, dlib and signtool in 10 seconds,
  │                       AND caches an access token good for ~1 hour
  ├─ tauri-action         ~12 min build, then every signature calls
  │                       scripts/sign-windows-artifact.ps1, which mints a
  │                       FRESH OIDC assertion per batch (150s stamp)
  ├─ verify artifacts     Authenticode on the NSIS exe and the MSI, .sig present
  └─ publish              flips the draft to latest
```

To ship:

1. Bump the version in **all three** of `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. They must be identical or the run dies on the guard (this is what killed v0.8.1).
2. Commit, then ask the user to push `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`, then `gh run watch --exit-status`.
4. On failure, `Show what the sign command actually said` dumps the real signtool error, and the tag is one line to undo: `git push --delete origin vX.Y.Z; git tag -d vX.Y.Z`.

**The signing credential lives five minutes, and that is load bearing.** `azure/login` with GitHub OIDC hands back a client assertion valid for exactly five minutes, not a refresh token, and the Azure CLI replays that same string on every later request. `AADSTS700024: Client assertion is not within its valid time range` is what that looks like, and signtool wraps it in a generic `SignerSign() failed` (`0x80004005`), which is also what a wrong region endpoint produces. Read the inner exception, not the exit code. Three rules protect this:

- **Never put a slow step between `Sign in to Azure` and `Smoke test the signing command`.** A fourteen minute dlib sweep sitting there is what broke the whole 0.8.x series. The client tools install is above sign-in for exactly this reason and must stay there.
- **Never remove `Update-AzureSigningLogin` from `scripts/sign-windows-artifact.ps1`.** `tauri.conf.json`'s `signCommand` routes the exe, the WiX extension dlls, the MSI and the NSIS installer through that one script, which makes it the only place a live credential can be guaranteed. It mints a fresh assertion from `ACTIONS_ID_TOKEN_REQUEST_URL`, re-runs `az login`, and exchanges it for a codesigning token, with a 150 second stamp so back to back artifacts do not each pay for a sign-in.
- **Any step that can trigger a signature needs `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` in its `env:`.** Without them the refresh silently no-ops and the run falls back to the cached token alone.

Do not "simplify" this by arranging build steps around the five minute window. That was tried (split compile, second sign-in, separate cache warm) and it works only until the next step gets slower. The refresh belongs at the choke point.

Signing config lives in the Entra app registration (federated credential subject `repo:AuraVoice/Aura-Desktop:environment:production`, audience `api://AzureADTokenExchange`) and the `production` GitHub environment, which holds `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. There is no `AZURE_CLIENT_SECRET` and the workflow does not want one. When signing breaks, query the live resource with `az` rather than reading the portal or the config that is supposed to describe it.

### Adding a new Tauri command

1. Write it in the relevant `src-tauri/src/*.rs` module with `#[tauri::command]`.
2. Register it in the `tauri::generate_handler![...]` list in `lib.rs`.
3. Default to `async fn` (see "Main-thread blocking" above) unless the body is a couple of cheap synchronous reads, e.g. locking the overlay state `Mutex` for a field read.
4. Call it from React with `invoke("command_name", { argName: value })` from `@tauri-apps/api/core` - snake_case Rust params auto-map from camelCase JS args.

### Adding a new Rust → React event

1. `window.emit("event-name", payload)` where `payload: impl Serialize`.
2. In React, `listen("event-name", cb)` from `@tauri-apps/api/event`, inside a `useEffect` that stores the returned unlisten function and calls it on cleanup.

### Touching the overlay state machine

Changes to `OverlayPresentation`/`PanelVariant` or their transitions live in `overlay.rs` (`set_presentation`, `size_for`, `position_for`) with a matching render branch in `OverlayRoot.tsx`. Respect the optimistic-cache rule above. `Pill` renders `AvatarPill.tsx` (a lazy-loaded three.js scene, not `GlassPill.tsx` - deleted) and is reached via the `minimize_to_pill` command, which only fires while a call is live.
The Panel+Bar presentation can also grow downward for one below-bar slot: OverlayRoot resolves which surface wins it (priority draft > agenda > kebab menu > meeting note > daily catch-up) and drives the single `set_slot_height` command; `overlay.rs` tracks it as `slot_height` (with its `applied_slot_height` cache, same after-success rule), and the bar's top edge stays fixed while the window height changes.
The per-card open commands this replaced (`set_draft_card_open`, `set_callback_card_open`) no longer exist; each surface's height constant lives in OverlayRoot and must agree with its CSS.
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

