# Abstraction Audit

Date: 2026-08-27. Read-only audit, no code changed.

> REMEDIATED 2026-08-28: every finding below was fixed across 16 local commits
> (r1-r10 Rust, t1-t6 TS), with dead surface annotated rather than deleted per
> decision. New shared homes: src-tauri/src/{util,fsx,crypto,sealed_store,
> events,window_util}.rs and src/lib/{ipcEvents,useTauriEvent,
> useAgentDataMessage,sseStream}.ts, src/overlay/{overlayPresentation,
> meetingStore}.ts. Deliberate exclusions found during implementation:
> hud.rs's window-centered monitor resolution (documented design, not a
> cursor-copy), capture_into_pending's own security bracket (stored point +
> per-stage logs), streamInterviewAnswer's in-file SSE copy (documented),
> useVoiceBar's AbortController (bridge teardown, not a fetch deadline), and
> multi-type LiveKit handlers keeping their own DataReceived ceremony. The
> alerts_disabled key stays device-scoped by documented design; only the
> snooze maps became uid-scoped (with a one-time legacy seed).

Inspired by Anthropic's daily "abstraction police" routine (Boris Cherny, YC Root Access podcast):
"often in a big code base, there's the same abstraction and it appears multiple times... Claude goes
out every day across all our code bases. It finds these nearly duplicated abstractions and unifies them."

Method: three parallel sweeps (TypeScript side, Rust side, the TS<->Rust IPC boundary), each sweeping
by concept rather than by file, with every flagged site read before flagging. Severity-A findings were
independently re-verified by the orchestrating session. Scope: `src/` (44k lines, 235 files) and
`src-tauri/src/` (33k lines, 77 files).

Overall verdict: this codebase's failure mode is under-abstraction from fast per-feature growth, not
over-abstraction. The over-abstraction sweep found essentially nothing (one dead module, a few stale
`#[allow(dead_code)]`s). The pattern that repeats: a feature copies its neighbor's plumbing, then one
copy gets hardened or extended and the others silently do not. `meeting/` has accidentally become the
util crate (crypto, `now_ms`, durable writes) that unrelated modules import.

Severity key:
- **A** = copies have already drifted in behavior, or the contract is already dead/broken
- **B** = hand-synced shared contract, in sync today, likely to drift
- **C** = verbosity; unify opportunistically when touching the file

---

## Tier A: already drifted or dead (verified)

### A1. The DPAPI/AES-GCM crypto stack exists twice, and the copies have diverged
- `src-tauri/src/meeting/crypto.rs:25-175` vs `src-tauri/src/dictation/vocab.rs:112-167` and `:484-520`.
  `vocab.rs`'s own header admits it: "This mirrors meeting/crypto.rs but mints its own key."
  `dpapi_protect`/`dpapi_unprotect` are byte-identical in both files.
- Drift 1 (durability): meeting/crypto writes its key file with `create_new(true)` + fsync +
  `evidence_store::durable_rename` (write-through, no clobber). vocab (`vocab.rs:131-140`) uses
  `create(true).truncate(true)` + plain `std::fs::rename`. Two processes are expected to coexist
  (installed release + `tauri dev`, see `meeting/runtime_lease.rs`), so two first-runs can each mint a
  DIFFERENT dictation key and last-rename wins; data sealed under the losing key becomes undecryptable.
- Drift 2 (capability): meeting/crypto grew `encrypt_with_aad`/`decrypt_with_aad`; vocab never did, so
  dictation stores cannot adopt row-binding without a third copy.
- Altitude smell: `meeting::crypto` is the de facto app-wide crypto module (`chat_cache.rs:45`,
  `interview_store.rs:41`, `saved_images.rs:19`, `screenshot_store.rs:60`), while
  `dictation/trace/store.rs:141-162` gets crypto via `vocab::`, a vocabulary module moonlighting as a
  crypto provider.
- Fix: promote to `src-tauri/src/crypto.rs`: `dpapi_protect/unprotect`, `encrypt[_with_aad]`,
  `decrypt[_with_aad]`, `load_or_create_key_at(path)` parameterized by key file (both features keep
  their distinct keys). Both keys get the `create_new` + `durable_rename` write. `meeting::crypto` and
  `vocab`'s crypto half become thin re-exports or disappear.

### A2. "Atomic write" (tmp -> rename) implemented at least seven times across an accidental durability gradient
- Strongest to weakest:
  `meeting/evidence_store.rs:694-702` + `:658-692` (create_new, fsync, MOVEFILE_WRITE_THROUGH);
  `meeting/crypto.rs:54-62` (same tier);
  `dictation/trace/store.rs:114-128` (fsync, plain rename; comment: "Same shape as `vocab::write_store`");
  `dictation/vocab.rs:131-140`, `:188-197` (fsync, plain rename);
  `screenshot_store.rs:293-298`, `saved_images.rs:80-85`, `site_icons.rs:128-134` (no fsync).
- The tier each site got is an accident of when it was written, not a decision. Only evidence_store
  documents which guarantees it needs and why (its `sync_directory` comment about Windows lacking
  POSIX dir-fsync is knowledge the other six copies do not have).
- Fix: `src-tauri/src/fsx.rs` with `write_atomic(path, bytes, Durability::BestEffort | Fsync |
  WriteThrough)`. Evidence-store keeps its wrapper; the other six call sites collapse and each names
  its tier explicitly.

### A3. The `listen()` -> unlisten useEffect idiom is hand-rolled ~42 times in 27 files, and the majority idiom leaks listeners
- Race-unsafe majority (if unmount wins the race against the `listen()` promise, the listener attaches
  with nothing left to remove it): `src/overlay/OverlayRoot.tsx:423, 439, 473, 495, 518, 577, 600, 621`
  (eight copies in one file), `src/state/AuthProvider.tsx:77-87`, `src/state/useDesktopNotifications.ts:137-150`,
  `src/state/useHotkeyBindings.ts:18-29`, `src/dashboard/DashboardApp.tsx:144-152`,
  `src/overlay/OnboardingTail.tsx:57-69`, `src/overlay/PointingOverlay.tsx:41-56`,
  `src/overlay/useScreenSight.ts:123-139`, `src/overlay/useInterviewHacker.ts:679-692, 708-733`.
- Race-safe minority (disposed-flag guard): `StatusPill.tsx:30-52`, `useOutputMode.ts:153-165`,
  `useNotchGesture.ts:186-218`, `useMeetingCapture.ts:766-841`, `useDashboardNotifications.ts:74-102`,
  `useGuideMode.ts:862-883`. A third promise-chained idiom lives in `GeneralPage.tsx:101-107`,
  `DictationPage.tsx:296-302`, `DictationHud.tsx:212`.
- This matters most in the overlay, where surfaces mount/unmount on every presentation change.
- Fix: one `useTauriEvent<T>(eventName, handler)` hook (suggest `src/lib/useTauriEvent.ts`)
  implementing the disposed-guard version once, handler held in a ref. ~30 call sites become one-liners
  and the leak class disappears.

### A4. `OverlayPresentation` is re-declared five times on the TS side, already drifted, patched with remap shims
- Canonical but private: `src/overlay/OverlayRoot.tsx:67-73` (6 values incl. `"movingnotch"`).
  Forks: `draftVisibility.ts:1` (5 values), `useMeetings.ts:32` (5), `useMeetingNotes.ts:54` (4, no
  `"bar"`), `useCallbackCard.ts:49` (4, no `"bar"`).
- The drift already forced two adapter shims inside OverlayRoot (`OverlayRoot.tsx:219-222` maps
  movingnotch->bar "the draft/meeting/callback hooks predate movingnotch"; `:296-300` maps
  bar->companion for useCallbackCard). Adding a presentation to `overlay.rs` currently means auditing
  four independent unions plus two remaps, and a miss type-checks clean.
- Fix: export one `OverlayPresentation` from a small `src/overlay/overlayPresentation.ts` mirroring the
  `overlay.rs` enum; the four hooks accept it and keep their "treat X as Y" decisions internally, where
  their explanatory comments already live. Type-level only, no runtime change.

### A5. Dead IPC contract: `desktop-notification-local` has a listener and zero emitters
- Listener: `src/state/useDesktopNotifications.ts:138`; its comment (`:133`) claims "a Rust producer
  (e.g. update ready) can push a raw contract event" over it. Repo-wide, nothing emits this string;
  the updater emits `update-ready` consumed elsewhere. The broker's local-event lane is untested dead
  surface that will mislead the next producer author.
- Fix: delete the listener block, or add the intended Rust producer. Either way record the name in the
  shared event-constants module (B1) so emitter-less listeners are visible at a glance.

### A6. Five commands registered in `generate_handler!` but invoked nowhere in `src/`
- `set_notch_edge` (`lib.rs:304` -> `lib.rs:187`; docking now flows through
  `begin_notch_move`/`commit_notch_move`, so the command wrapper is orphaned),
  `dictation_vocabulary` (`lib.rs:378`), `dictation_add_vocabulary` (`lib.rs:379`),
  `dictation_record_correction` (`lib.rs:380`), `interview_hacker_status` (`lib.rs:385`; TS gets
  status via the event + start command's return value).
- Inverse direction is clean: all ~135 distinct `invoke()` strings resolve to registered handlers,
  including the ternary `invoke(enable ? "arm_guide" : "disarm_guide")` at `useGuideMode.ts:923`.
- Dead registered commands run with full backend authority and mask the day a needed command falls out
  of the list. The vocabulary trio may be deliberately pre-built surface; nothing marks it as such.
- Fix: remove from `generate_handler!` (keeping inner fns where still used internally), or annotate
  each with `// registered ahead of UI: <feature>` so planned vs orphaned is explicit.

---

## Tier B: shared contracts in sync today, likely to drift

### B1. 36 of 37 cross-boundary event names are unprotected string literals on both sides
- 34 Rust-emitted + 3 JS-originated names, each spelled by hand at emit and listen sites. No shared
  constants module exists on either side. Only `desktop-onboarding-completed` shares a const, and only
  because both ends live in one file (`useOnboardingTail.ts:18`). `interview.rs:23-26` defines Rust-side
  consts, but the TS side re-declares the same strings (`interviewBriefMemory.ts:5`,
  `interviewResumeMemory.ts:13`, literals in `useInterviewHacker.ts:1168,1255`).
- No typo pair exists today (checked; `chat-requested` vs `chat-toggle-requested` are two real
  contracts). A one-character drift would compile clean on both sides and fail silently at runtime.
- Fix: paired `src-tauri/src/events.rs` (pub consts, Rust as source of truth since it emits 34/37) and
  `src/lib/ipcEvents.ts` (`as const`), each entry commenting its twin. This is the single
  highest-leverage small change in the audit. Long-term, `tauri-specta`-style generation retires this
  class plus B7 wholesale.

### B2. Event payloads re-typed inline per listen site; `guide-armed` is typed two different ways today
- `useStatusPillEvents.ts:12,20` and `useScreenSight.ts:124` type `guide-armed`/`screen-sight-armed` as
  `{ armed: boolean }`; `useGuideMode.ts:866` types the same `guide-armed` event as
  `GuideArmedWirePayload` through a normalizer. If Rust enriches or renames the payload, useGuideMode
  absorbs it while the status pill silently reads `undefined`. Related fossil: `useGuideMode.ts:69-74`
  hedges with both `sessionId?` and `session_id?` though Rust's `rename_all = "camelCase"`
  (`guide/mod.rs:158-163`) makes snake_case unreachable.
- Fix: export payload types alongside the event constants in B1's `ipcEvents.ts`.

### B3. Encrypted-SQLite store scaffolding forked between `chat_cache.rs` and `interview_store.rs`; the AAD grammar has diverged
- `chat_cache.rs:78-146` vs `interview_store.rs:120-218`: six functions line-for-line identical apart
  from error prefixes. But `row_aad`: chat_cache (`:113`) is unversioned colon-joined
  (`{uid}:{conv}:{msg}`, ids containing `:` can collide); interview_store (`:171`) is the hardened
  successor (`aura-interview-v1\0...`, NUL-separated, versioned). The next encrypted store will copy
  whichever file is open, coin-flipping between weak and strong grammars.
- Fix: `src-tauri/src/sealed_store.rs` owning `cache_key`/`seal`/`unseal` + platform stubs once, plus an
  `aad(namespace_version, parts)` builder that NUL-joins. chat_cache's legacy grammar cannot change
  silently (existing rows), so it keeps its literal behind a named constant with a comment; every new
  store uses the versioned grammar.

### B4. The 28-byte screen-geometry wire header has two independent Rust serializers for three TS readers
- `screenshot.rs:31-43, 87-97` (`ScreenFrameGeometry`, `GEOMETRY_HEADER_LEN = 4 * 7`) vs
  `guide/mod.rs:20, 30-61` (`Geometry`, `GEOMETRY_HEADER_LEN = 28`); `write_le` field-for-field
  identical. Guide's struct also carries `monitor_id`/`rotation` that are NOT serialized, so struct
  fields and wire fields no longer coincide, and the constant is spelled differently in each file so
  grep will not pair them. This is a cross-language binary contract; two serializers doubles the ways
  to break the TS `DataView` readers.
- Fix: one `pub(crate)` struct + `write_le` + const in `screenshot.rs` (Guide already imports
  `downscale_for_model` and `MODEL_FRAME_JPEG_QUALITY` from there, precedent set after a past bug).
  Guide wraps it: `{ wire: ScreenFrameGeometry, monitor_id, rotation }`.

### B5. `meeting-join-detected` has two independent Rust payload structs for one event
- `meeting/detect.rs:48-53` (`JoinPayload`, real detector) vs `meeting/mod.rs:940-946`
  (`JoinDetectedPayload`, `debug_force_join`, whose comment promises it "emits the same event the real
  detector produces"). In sync today; adding a field to one silently forks the dev path from prod.
- Fix: make `JoinPayload` `pub(crate)` and have `debug_force_join` construct it; delete the twin.

### B6. `authFetch` + AbortController timeout ceremony hand-rolled ~12 times with divergent abort semantics
- `entitlement.ts:70-132` (abort bubbles as raw DOMException), `calendar.ts:63-85` (returns null,
  suppresses logging for AbortError), `voicePreferences.ts:29+`, `memory.ts:46+`, `draft.ts:80+`,
  `chatConversation.ts:75+`, `meetings.ts:247, 617, 639`, `useVoiceBar.ts:798`, plus three
  unauthenticated copies in `api.ts:103-121, 173-191, 218-236` (these map to typed timeout errors).
- Fix: `authFetchWithTimeout(path, init, timeoutMs)` (+ plain `fetchWithTimeout`) in `src/lib/api.ts`
  throwing one well-known `TimeoutError`; callers keep their own swallow-vs-throw policy.

### B7. Hand-synced Rust<->TS type mirrors: ~16 pairs, none generated; `VoiceToggleKeyStatus` declared five times
- `voice_toggle_key.rs:100-107` has one canonical TS mirror (`src/lib/hotkeys.ts:11-17`) plus four
  private re-declarations (`AnimatedHotkeyGuide.tsx:8-13`, `DashboardOnboarding.tsx:17-20`,
  `OnboardingTail.tsx:15-18`, `useNotchGesture.ts:13-17`), each a different subset typing the same
  event differently. Fix: import from `lib/hotkeys.ts`, delete the four.
- The other ~15 mirror pairs (interview status/transcript, meeting capture/queue family, status pill,
  overlay snapshot, hotkey binding, update-ready, etc.) were verified field-by-field: in sync,
  unprotected. `StatusPillKind` is the sharpest edge: a Rust variant added without a TS copy entry
  renders `undefined` text (`status_pill.rs:17` vs `StatusPill.tsx:11-23`).
- Direction: comment anchors now (each payload struct names its twin file; only `DOUBLE_TAP_PRESETS`
  and `NOTCH_MAIN` do this today); `tauri-specta` generation when a dependency is acceptable.

### B8. Two writers of `calendar.json` disagree on uid-scoping; store plumbing duplicated across four hooks
- `useMeetings.ts:24` and `useMeetingArm.ts:34` each declare `const CALENDAR_STORE = "calendar.json"`.
  useMeetingArm scopes keys per uid (`scopedKey`, `:133`); useMeetings writes `dismissed_events` /
  `auto_summoned_events` unscoped, so one account's snoozes leak into the next account on a shared
  machine. Same `storeRef + getStore + set/save` block also in `useMeetingNotes.ts:90-140` and
  `useCallbackCard.ts`; the `IdDateMap` prune helper is re-declared with different windows
  (`useMeetings.ts:70-79` today-scoped vs `useMeetingNotes.ts:29-40` 8-day).
- Fix: `src/overlay/meetingStore.ts` exporting the store constant, shared lazy `getStore`,
  `persistKey`, both prune variants; decide the uid-scoping question once while unifying.

### B9. `authGetJson<T>` defined twice under the same name with opposite 404 behavior
- `dashboardApi.ts:38-44` (404 throws) vs `desktopChatApi.ts:101-108` (404 -> null, documented soft
  degrade); `researchApi.ts:182-186` is a third sibling with its own message shape that its own file
  then bypasses (`:197-211` re-inline the check). Same name, inverted contract: a future move between
  clients assumes wrong. Fix: one helper with explicit `softStatuses` opt-in so the divergence is
  visible at call sites.

### B10. SSE pump loop triplicated; two of three parsers cannot survive standard SSE framing
- `chatStream.ts:211-246`, `interviewHackerApi.ts:236-269`, `interviewHackerApi.ts:631-665`. The
  in-file interview pair is documented deliberate (`:626-629`), not flagged. But `chatStream.ts` is an
  undocumented third copy, and only `readEventStream` handles `event:`/comment lines; chat and
  interview-answer silently depend on the backend never emitting a `:keepalive`. A backend move to
  standard SSE keepalives breaks two of three parsers.
- Fix: extract frame-splitting (bytes -> frames, terminator detection) into `src/lib/sseStream.ts`;
  chatStream + readEventStream layer on it; leave the documented copy alone.

### B11. "invoke initial state + subscribe to change event" re-implemented per state bit, including one verbatim x2
- `useHotkeyBindings.ts:15-30` (no unmount guard), `useGeneralSettings.ts:13-32`,
  `useScreenSight.ts:122-149` (seed and listen in separate effects), `useGuideMode.ts:862-883` (the
  only copy that orders listen-before-load to close the missed-event window), and the same
  dictation-status effect duplicated line-for-line in `GeneralPage.tsx:93-108` and
  `DictationPage.tsx:289-303`.
- Fix: minimally a `useDictationStatus()` in `src/lib/dictationStatus.ts` (which already owns the type)
  kills the exact duplicate; better, `useTauriMirroredState<T>(load, eventName)` built on A3's hook,
  implementing listen-before-load once.

### B12. Cursor-monitor resolution repeated 5+ times; one copy re-resolves mid-function
- `overlay.rs:342-361`, `overlay.rs:368-381` (calls the first, then re-runs the cursor->monitor lookup
  for `scale_factor`; if the cursor crosses displays between calls, one monitor's scale is applied to
  another's bounds), `status_pill.rs:74-84` (verbatim), `dictation/hud.rs:388-395`, plus the 5-line
  cursor-point preamble inlined 4x in `screenshot.rs:119-376` while `guide/mod.rs:284-290` already has
  it as `resolve_cursor_monitor`.
- Fix: `monitor_under_cursor(window)` in `overlay.rs` (the geometry home; status_pill and hud already
  import from it), with `active_display_work_area` resolving the monitor once.

### B13. Dead module: `src/lib/connectorPreferences.ts` has zero importers
- A complete persistence API (`FutureConnectorId`, load/save interest, `dashboard_connector_interest`
  key) for a "register interest in future connectors" UI that never shipped or was removed. Confirm
  before deleting; it may be a planned stub, but nothing marks it as one.

### B14. Interview credential minting lacks the guards dictation's has
- `dictationCredential.ts:58-91` (503 -> typed unavailable error, minimum-useful-TTL guard mirrored to
  a Rust constant) vs `interviewHackerApi.ts:75-99` (accepts `expiresInSeconds > 0`, no 503
  distinction). The interview path can accept a 2-second token that dies mid-handshake, the exact case
  dictation's comment explains. Fix: port MIN_USEFUL_TTL + 503 handling, or share a
  `parseSttCredential` core.

---

## Tier C: verbosity, unify opportunistically

- **C1. `now_ms` defined eight times** with an i64/u64 fork (`meeting/mod.rs:136`,
  `evidence_store.rs:529`, `trace/store.rs:671`, `usage.rs:24`, `entitlement.rs:19`,
  `interview_store.rs:113`, `screenshot_store.rs:331` u64, `uia/contract.rs:258` u64, inline in
  `audio_capture.rs:488`). `screenshot.rs:306` calls `crate::meeting::now_ms()`: the screenshot
  pipeline depends on the meeting module for a wall clock. Fix: `timeutil.rs` (or a util module shared
  with A2's `fsx.rs`), `now_ms() -> i64`.
- **C2. Poisoned-mutex idiom spelled inline ~170 times** across 24 files; `screenshot_store.rs:163-165`
  already built the right `lock<T>` helper and kept it private. Promote to `pub(crate)`, adopt when
  touching each file (no big-bang sweep, per the surgical-edits rule).
- **C3. overlay.rs applied-cache is five parallel Option fields** written in lockstep in three places
  (`overlay.rs:172-178, 650-654, 675-679, 742-746`, resets at `:833, :843, :1283, :1293`). The
  after-success rule is correct and stays; the shape makes it violable per-field, and the targeted
  single-field resets already leave four fields stale. Fix: one `#[derive(PartialEq)] struct
  AppliedBounds` and a single `applied: Option<AppliedBounds>`; resets become `applied = None`, which
  is also more correct. `lessons-learnt.txt` already convicted this shape once.
- **C4. Accessory-window construction duplicated verbatim**: `status_pill.rs:43-71 + 102-119` vs
  `dictation/hud.rs:168-198 + 204-221` (9-flag builder chain + entire unsafe `apply_no_activate`
  body). Fix: `build_accessory_window(app, label, title, size)` + shared `apply_no_activate` next to
  `exclude_main_window_from_capture` in overlay.rs (which is misnamed anyway: it excludes any window).
- **C5. The authorize -> capture -> recheck security bracket** is re-inlined in four capture commands
  (`screenshot.rs:110-148, 156-184, 192-224, 269-309`). The persistence tails differ deliberately; the
  load-bearing ordering ("recheck AFTER the blocking capture, drop the frame on failure") is
  guaranteed only by four copies staying in step. Fix: a private `captured_under(op, app)` helper in
  screenshot.rs; each command keeps its own tail.
- **C6. `RoomEvent.DataReceived` scaffolding x7** (~12 identical lines each around the correctly
  centralized `validateAgentDataMessage`). Optional `useAgentDataMessage(room, type, onValid)` next to
  `agentData.ts`; low urgency, file count keeps growing.
- **C7. Three relative-time formatters + two duration formatters** with rounding drift: a notification
  row and a card row for the same timestamp can disagree by a minute (`dashboard/format.ts:6-19`
  Math.round vs `notificationCopy.ts:57-65` Math.floor; `format.ts:32-37` "12m 05s" vs
  `InsightsPage.tsx:149-153` "12 min"). Consolidate into `dashboard/format.ts` with an epoch-ms
  overload.
- **C8. Geometry constant anchoring gaps**: the 7 must-agree Rust/TSX/CSS clusters (~20 constants, ~35
  literal sites: notch 184x29, gap 6, card width 380, interview control 228x52 + gap 8, slot heights,
  dictation HUD hover sizes) are ALL currently in sync, but clusters 4, 5, 7 and OverlayRoot's four
  fixed heights (`OverlayRoot.tsx:62-65`) lack the bidirectional comment anchors that clusters 1-2
  have. Cheapest durable guard: every CSS literal names its Rust const and vice versa.

---

## Highest-leverage moves, in order

1. **Paired `events.rs` / `ipcEvents.ts` constants module** (B1+B2, fixes A5's discoverability):
   removes the largest unprotected contract surface in one small change.
2. **`useTauriEvent` hook** (A3): kills a real leak class at ~30 call sites and becomes the foundation
   for B11's mirrored-state hook.
3. **Unified `crypto.rs` + `fsx.rs`** (A1+A2): closes an actual key-clobber race and turns seven
   accidental durability tiers into explicit decisions.
4. **Export `OverlayPresentation` once** (A4): type-level only, immediately de-risks the next
   presentation added to the state machine.
5. **Dead-surface cleanup** (A5, A6, B13): one listener, five command registrations, one module;
   confirm the dictation-vocabulary trio and `connectorPreferences.ts` are not planned surface first.

Long-term: `tauri-specta`-style generated bindings would retire B1, B2, B7, and the command roster
checks (A6's class) wholesale; worth evaluating when a dependency addition is on the table.

## Examined and deliberately NOT flagged (drift that is on purpose)

- `dictation/audio.rs` vs `audio_capture.rs` WASAPI paths: divergence documented as product decisions;
  the broker (`audio_capture.rs`) is the unification already done right.
- `streamInterviewAnswer`'s in-file SSE copy: documented deliberate (`interviewHackerApi.ts:626-629`).
- `interviewBriefMemory.ts` vs `interviewResumeMemory.ts`: mirroring documented as deliberate.
- Dashboard three-layer split, `chatCache.ts` vs `dashboardCache.ts`, `savedImageCache.ts` vs
  `siteIconCache.ts`: same words, genuinely different substrates/invariants/privacy postures.
- Keyboard input: three mechanisms (`voice_toggle_key.rs` LL hook, `dictation/chord.rs` piggyback,
  `hotkeys.rs` plugin) for three genuinely different input problems, with the hook-ordering fragility
  documented.
- hud.rs "caches NOTHING" placement stance: documented deliberate inversion of the applied-cache rule.
- Generation/sequence guards (status pill, guide toggle, audio broker): same shape, different
  semantics; would change for different reasons.
- Polling loops (outbox, meetings, research tick, dictation upload, web-auth): the shell recurs but
  each core is domain logic; a generic `usePolling` would hide the parts that matter.
- ASR provider traits: two real impls, genuine polymorphism.
- The 141 `invoke().catch(logError)` one-liners: already minimal; a wrapper saves nothing.

## Totals

- Event names: 37 distinct; 36 unprotected literal-on-both-sides; 1 dead listener; 0 typo pairs.
- Commands: 141 registered; ~135 invoked; 5 registered-but-never-invoked; 0 invoked-but-unregistered.
- Must-agree geometry constants: 7 clusters, ~20 constants, ~35 literal sites, 0 disagreements, ~half
  unanchored.
- Serialized type mirrors: ~16 pairs + 4 redundant private copies of one; 0 field-level drift.
- Over-abstraction found: 1 dead module, 2 stale `#[allow(dead_code)]`s. The codebase under-abstracts;
  it does not over-abstract.
