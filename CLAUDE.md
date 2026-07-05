# Aura Desktop

Tauri v2 + React 19 + TypeScript Windows companion app, a from-scratch rewrite of the sibling Flutter app (`../Aura`, "Buddy") for better UI performance and maintainability. The desktop client talks to the same backend (`juno-backend` on Cloud Run) and Firebase project (`juno-2ea45`) as the Flutter app.

This file is working instructions for Claude Code in this repo. For the full architecture - diagrams, the IPC surface, session flows - see [`README.md`](./README.md). For the incident log behind the rules below, see [`lessons-learnt.txt`](./lessons-learnt.txt).

## Architecture

One borderless, transparent, always-on-top window (label `"main"`) that resizes/repositions itself between presentations, rather than separate windows per screen:

- `hidden` / `panel` (`setup` or `bar` variant) / `pill` / `pointing` - see `src-tauri/src/overlay.rs` for the state machine and `src/overlay/OverlayRoot.tsx` for the matching React root.
- Rust owns window geometry, hotkeys (Ctrl+Alt+B summon, Ctrl+Shift+D immediate sign-out, Ctrl+Alt+S screen-sight toggle), tray, and focus-forcing (`win_focus.rs`, needed because Windows denies `SetForegroundWindow` while another app owns focus).
- React owns all visual content and copy (`src/overlay/`), Firebase auth (`src/state/AuthProvider.tsx`), and the voice/screen-sight LiveKit wiring (`useVoiceBar`, `useScreenSight`).
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

## Working style

- Never use em-dashes anywhere, in UI copy or in code/comments. Use plain human phrasing, not AI-sounding wording.
- Ask before running long-running or launching commands (`npm run tauri dev`, etc.) - the user runs those themselves and reports back, since they iterate faster than a tool-call round trip and Claude can't visually verify a GUI window anyway. Fast, silent checks (`cargo check`, `tsc --noEmit`) are fine to run directly.
- Only change what was asked. Don't refactor, rename, reorganize, or reformat anything else in the same pass; mention other issues noticed at the end instead of touching them.
- Before deleting a file, dropping generated assets, or removing a dependency, say what will be affected before doing it.
- End a task with a brief status update: what changed, what was left untouched, what needs the user's attention next.
- When a real bug or a non-obvious constraint gets found and fixed, log it in [`lessons-learnt.txt`](./lessons-learnt.txt) at the repo root: problem, issue, solution, justification, date.
- when explaining a plan potray in examples and data flow rather than simple text.
- NEVER Push code to github without me explicitly saying, this doesn't include a plan where you propose to push commits to git. Always advice me to push. 