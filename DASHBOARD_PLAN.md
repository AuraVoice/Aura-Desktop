# Web dashboard, signed in seamlessly from the desktop app

> **Status (2026-07-07)**: Workstream B shipped in v0.1.5 (`src/lib/dashboardLink.ts`, the tray's "Open Dashboard" item emitting `open-dashboard-requested`, the listener in `App.tsx`).
> Two deltas from the plan below: the bar got its own dashboard button alongside the tray path, and the opened URL also carries the current `uid` so an already-signed-in browser can skip the claim (see the comment in `dashboardLink.ts` for why that's safe).
> **Update (2026-07-08)**: the dashboard gained its first real content feed - Buddy Drafts persistence is code-complete across all three repos (backend writes the latest revision of each draft to Firestore with a 7-day TTL, Aura-Web renders a Drafts feed with delete), with deploys still pending: the one-time Firestore TTL-policy command and the worker (`lk agent deploy`).

## Context

Aura Desktop today has no normal "open the app and see my stuff" experience -
just the tray icon and a borderless, `skipTaskbar:true` overlay for voice
(`src-tauri/tauri.conf.json:12-27`, state machine in `src-tauri/src/overlay.rs`).
The in-progress History screen (uncommitted, never shipped) made the gap
concrete: a real "browse history and see usage" experience crammed into a
600x480 floating panel.

Two decisions were made after weighing this against actually building a
second native Tauri window:

1. **Where the dashboard lives: the web, not a second desktop window.**
   A history/stats dashboard needs zero native capability (no hotkey, no
   screen capture, no always-on-top, no tray-specific behavior) - it's a
   signed-in data view over `/history/sessions`, an endpoint that already
   works from anywhere. `Aura-Web` (`auravoiceapp.com`) already has Firebase
   auth (client + admin SDK), its own git-triggered deploy, and pages for
   privacy/terms/pricing - all infrastructure a new native window would have
   to either duplicate or awkwardly bridge. It also ships independently of
   the desktop app's slower, riskier release pipeline (no staged rollout,
   one bad build reaches every install - see `ROLLBACK_RUNBOOK.md`), which
   matters more for a surface like stats/history that will change often.
   Building it native would also mean adding a second window's worth of
   exactly the complexity class (`overlay.rs`-style window/state machine
   code) that's already caused 5 of `lessons-learnt.txt`'s 7 logged
   incidents - for a feature that doesn't need any of it.

2. **How sign-in works: a seamless handoff, not a second login.** Desktop
   already has an authenticated session. Rather than making the user log
   into the website separately, desktop mints a short-lived one-time code
   and opens the browser already pointed at a pre-authenticated dashboard -
   extending a pattern this backend has already built, reviewed, and shipped
   once (see below).

Ctrl+Alt+B, the voice bar, and the pill/avatar overlay are **unchanged** by
any of this - only "where do I see my history and stats" moves, from a
planned-but-unshipped overlay panel to a browser tab.

## The reusable pattern already in this codebase

`Aura/backend/src/handlers/pairing.py` already solves almost exactly this
problem, just in the opposite direction (phone issues a code, desktop claims
it): `POST /devices/pair/start` (authenticated - mints an 8-char, 5-minute,
single-use code via a Firestore transaction) and `POST /devices/pair/claim`
(deliberately unauthenticated - "the code IS the credential" - atomically
marks it used and mints a Firebase custom token via `admin_auth()
.create_custom_token(uid)`). The security model is already reviewed and
battle-tested: single-use transactional claim (no race between two claims),
uniform failure response (not an oracle), per-code attempt cap, per-instance
failure-velocity alarm.

The new "open my dashboard" flow is the same shape, with different actors:

```
Aura-Desktop (already signed in)         juno-backend (Aura/backend)         Aura-Web (browser)
        |                                        |                                 |
        |  POST /devices/dashboard-link/start    |                                 |
        |  Authorization: Bearer <ID token>      |                                 |
        |--------------------------------------->|                                 |
        |                                        | mint short-lived, single-use    |
        |                                        | token (Firestore, mirrors       |
        |                                        | pairing.py's transaction)       |
        |  { code, expires_in_seconds }          |                                 |
        |<---------------------------------------|                                 |
        |                                                                          |
        |  openUrl(`${dashboardUrl}?code=${code}`)                                 |
        |------------------------------------------------------------------------->|
        |                                        |                                 |
        |                                        |   POST /devices/dashboard-      |
        |                                        |   link/claim  { code }          |
        |                                        |<---------------------------------|
        |                                        |  validate + mark used           |
        |                                        |  (transaction, single-use)      |
        |                                        |  mint custom_token              |
        |                                        |  { custom_token }               |
        |                                        |--------------------------------->|
        |                                        |                                 |  signInWithCustomToken
        |                                        |                                 |  -> dashboard renders
```

Deliberately a **new**, small module (`dashboard_link.py`), not a change to
`pairing.py` itself - different side effects (no `linked_devices` write, no
"new device linked" push notification; opening your own dashboard isn't
linking a device) and no reason to risk pairing's already-reviewed security
properties by generalizing it. Two differences from pairing's own code worth
calling out explicitly:

- **Token, not a human-typed code.** Pairing codes use an 8-char
  unambiguous alphabet because a person types them. Nobody types this one -
  it goes straight from `start`'s response into a URL and gets POSTed back
  automatically - so use a long, high-entropy token (`secrets.token_urlsafe(32)`
  or similar) instead of the short pairing alphabet.
- **Much shorter TTL.** 60 seconds is plenty for an automated round trip
  (mint -> open browser -> immediate claim), versus pairing's 5 minutes for
  a human to type a code. Shorter TTL shrinks the window if the URL ever
  ends up somewhere it shouldn't (browser history, a proxy log) - the same
  acceptable trade-off this codebase already made for the existing
  `web_auth_sessions` flow, which puts its own session code in a URL query
  param the same way (`useWebAuthSignIn.ts:121`).

## Workstream A - juno-backend (`Aura/backend`)

New `src/handlers/dashboard_link.py`, modeled directly on `pairing.py`:

- `POST /devices/dashboard-link/start` - authenticated (same
  `resolve_user_id_from_request` check `pairing.py`/`history.py` already
  use). Mints a token, writes it to a new `dashboard_link_codes/{token}`
  collection (`uid`, `created_at`, `expires_at`, `used`) via the same
  create-not-set + transaction pattern `pairing.py`'s `_issue` uses, 60s TTL.
  No per-uid active-code cap needed (nowhere near pairing's abuse surface -
  this is only ever called by the desktop app's own tray action, not
  something a user can trigger repeatedly at will the way a "get me a
  pairing code" button could be).
- `POST /devices/dashboard-link/claim` - unauthenticated by design, same
  reasoning as `pair/claim`. Same transactional validate-and-mark-used
  pattern (reuse `evaluate_claim`'s shape, adapted for the new collection),
  same uniform failure body, mints a custom token via `admin_auth()
  .create_custom_token(uid)` exactly like `pairing.py:340` and
  `AuthPageClient`'s backing route both already do. Returns
  `{"custom_token": ...}` on success, no `linked_devices` write, no push
  notification.
- Register both routes in `src/main.py` next to the existing `/devices/*`
  routes.
- Add tests mirroring `tests/test_pairing.py`'s coverage (expired/used/
  malformed/missing-code all return the same uniform response; a claimed
  code cannot be claimed twice; concurrent claims never both win).

## Workstream B - Aura-Desktop (this repo)

**Retire the in-progress overlay History panel** (uncommitted, never
shipped - a clean removal, not a migration): remove `PanelVariant::History`,
`HISTORY_WIDTH`/`HISTORY_HEIGHT`, and `show_history()` from `overlay.rs`;
revert `OverlayRoot.tsx` to its plain `user ? <VoiceBar/> : <SetupPanel/>`
branch; delete `src/overlay/HistoryScreen.tsx` + `.css`. Delete
`src/lib/history.ts` too - it becomes unused once the panel's gone (the
equivalent data-fetching logic gets rewritten against the same
`/history/sessions` contract on the Aura-Web side in Workstream C, where
it's actually needed).

**New `src/lib/dashboardLink.ts`**, reusing `authFetch` from `src/lib/api.ts`
exactly as `history.ts` did:

```
mintDashboardLink() -> POST /devices/dashboard-link/start via authFetch
                     -> { code, expiresInSeconds }
```

**Tray wiring** (`tray.rs` + a small new Rust->JS event, following this
repo's existing "Adding a new Rust -> React event" convention from
CLAUDE.md): add an `OPEN_DASHBOARD` tray menu item (reusing the slot the
in-progress `VIEW_HISTORY` item occupied) that emits an
`"open-dashboard-requested"` event rather than calling any overlay function -
no window resize/focus needed, since the result is a browser tab, not an
overlay state change. Leave tray **left-click** as `overlay::summon`,
**unchanged** - opening a browser is a heavier, different-weight action than
the fast voice-bar summon that left-click has always meant.

A listener mounted once in `App.tsx` (top-level, always mounted regardless
of overlay presentation) handles the event:

```
listen("open-dashboard-requested", async () => {
  try {
    const { code } = await mintDashboardLink();
    await openUrl(`${dashboardUrl}?code=${code}`);
  } catch {
    // Not signed in, or a transient network failure: open the bare URL.
    // The dashboard page's own no-code state (Workstream C) tells the user
    // to open it from the tray again once signed in, rather than silently
    // doing nothing.
    await openUrl(dashboardUrl);
  }
});
```

New `dashboardUrl` constant in `src/lib/copy.ts` alongside the existing
`webAuthUrl`/`privacyUrl`/`termsUrl`.

## Workstream C - Aura-Web

New `src/app/dashboard/page.tsx` + `DashboardPageClient.tsx`, following the
exact structure `auth/page.tsx` + `AuthPageClient.tsx` already use
(`Suspense` wrapper for `useSearchParams()`, same as the existing page's own
comment explains).

New `src/app/api/dashboard-link/claim/route.ts` - a thin server-to-server
proxy (Node runtime, matching `api/auth/complete/route.ts`'s
`export const runtime = "nodejs"`): takes `{ code }` from the browser,
applies the same `isAllowedOrigin` check `api/auth/complete` already uses,
POSTs to juno-backend's new `/devices/dashboard-link/claim`, and relays back
`{ custom_token }` or the uniform failure. Kept as a pure proxy (not a
second independent Firestore read, unlike `web_auth_sessions`'s
direct-Firestore pattern) so all the security-sensitive validation logic -
expiry, single-use, rate limiting - lives in exactly one place
(`dashboard_link.py`), not duplicated across two admin SDKs touching the
same collection.

`DashboardPageClient.tsx` flow:

```
?code present  -> POST /api/dashboard-link/claim -> signInWithCustomToken
                  -> render the dashboard
?code absent, or claim failed/expired
               -> "Open your dashboard from the Aura tray icon" empty state
                  (no standalone login built for v1 - the seamless handoff
                  is the only intended path in)
```

Dashboard content itself (history list + "recent activity" stats):

- Fetch `GET /history/sessions` directly from the browser (same contract
  `history.ts` used - `session_id, started_at, ended_at, total_duration,
  num_of_turns, num_of_tool_calls, summary, screen_sight_frame_count`, plus
  an `archive` rollup), authenticated with the Firebase ID token from the
  just-completed `signInWithCustomToken`.
- Stats card computed client-side, framed as "recent activity," never a
  calendar-bound claim ("this month," "all time") - the backend's active
  session collection is capped at 30 docs as "a safety cap, not a real
  pagination limit" (`Aura/backend/src/handlers/history.py:38`), with
  anything older physically rolled into `archive` and deleted (only a count
  + prose summary survive). `total_duration`'s format is fully deterministic
  (`"{m}m {s}s"` / `"{m}m"` / `"{s}s"`, from
  `voice_session_summarizer.py:103-110`) - a trivial fixed-pattern parse for
  summing "approximate minutes talked."
- Session delete reuses the same `DELETE /history/sessions/{id}` contract.

## Explicitly out of scope for this pass

- Any standalone (non-desktop-initiated) login for the dashboard page.
- Account/settings changes beyond what already exists - v1 is history +
  stats, read-only except per-session delete.
- A real lifetime-stats backend aggregate.

## How this actually gets built

This plan was written from an Aura-Desktop session. Workstream B happens
here. Workstreams A and C touch `Aura/backend` and `Aura-Web` - each has its
own CLAUDE.md/AGENTS.md this session hasn't loaded, so they need their own
sessions pointed at those repos. Build order: A before C (C's claim route
needs it) before B is fully end-to-end testable (B's mint call needs A live)
- but B's overlay-panel retirement + tray/event plumbing can be built and
verified independently of A/C being done.

## Verification

1. `cargo check` / `npx tsc --noEmit` clean in Aura-Desktop after Workstream B.
2. juno-backend: tests mirroring `tests/test_pairing.py` - expired/used/
   malformed all uniform-fail, no double-claim, no concurrent-claim race.
3. Aura-Web: typecheck/Vitest; confirm `isAllowedOrigin` blocks cross-origin
   POSTs to the new claim route.
4. End-to-end once all three are deployed: tray -> Open Dashboard -> browser
   opens signed in -> history/stats match real data -> delete works.
5. Fallback path: trigger "Open Dashboard" while signed out - browser should
   open to the plain "sign in from the tray" state, not a broken page.

---
Saved to disk 2026-07-06 because the plan-approval step (ExitPlanMode) got
interrupted by low battery - this file is the durable copy. A duplicate also
exists at `C:\Users\varun\.claude\plans\composed-soaring-scott.md`.
