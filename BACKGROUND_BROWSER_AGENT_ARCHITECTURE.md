# Background Browser Agent Architecture

Status: BUILT, UNTESTED AT RUNTIME. Written 2026-09-23 from the plan approved the same day; the
feature entry it grew from is "BACKGROUND BROWSER AGENT" in `future-features.txt` (sections 0 to 9,
cited below as §n). Every claim about behaviour below is source-verified only. Nothing has run on
a real machine yet; the checklist at the end is what turns this into a shipped feature.

Scope: Aura-Desktop owns the browser, the loop, the safety gates and the task record.
`juno-backend` (`../Aura/backend`) owns one stateless model proxy and the voice tool. Cross-repo
contracts are in `../Aura/ECOSYSTEM.md` §5b-3.

---

## 0. What it is, in one screen

"Perplexity Computer through voice" (§0): the user says one sentence, Aura opens its OWN Chromium
with a separate profile, works through the web one step at a time, and comes back with an answer
and the pages it used. The read-only Background Research Agent already ships; this is its acting,
interactive extension for pages that need clicks, filters, pagination and JS (§1).

```
"Buddy, find three SWE internships in Seattle posted this week and list the deadlines"
  L1 ENTRY    voice call (Buddy tool run_desktop_capability) | Jev hold opening with "hey aura"
              | Browser Agent page (harness)
  L3 GATE     Operation::StartBrowserTask: signed in + one-time opt-in; one task at a time
  L4 RUNNER   agent_browser::start -> encrypted row (ended_at_ms = 0) -> thread "aura-browser-agent"
  L6 LOOP     launch Chrome/Edge/Brave (own profile, hidden) -> CDP -> AX snapshot
              -> POST /agent/step -> ONE action -> guard -> act -> trace -> repeat
  L7 SAFETY   step cap 40, wall clock 5 min, per-step 20 s, approval gate, http(s) only,
              downloads denied, refs must exist in the last snapshot
  L8 OUTPUT   notch chip (steps, Watch, Stop) -> result card + toast + History row;
              desktop.result to Buddy when the call is still live
```

Code owns every part of the control flow; the model only picks the next action (§9.1).

## 1. Operational facts you will need again

These are the things that are easy to forget and expensive to rediscover.

- **The project day wallet is the full-stop control.** `deploy.sh` sets
  `PROJECT_BROWSER_AGENT_DAILY_COST_CAP_MICROUSD="10000000"` ($10 per UTC day, project-wide).
  **A value of 0 refuses every step by design**: the backend answers 429
  `browser_agent_project_cap` before any model call, and the desktop ends the task as
  `failed/browser_agent_project_cap`. The setting defaults to 0 in `settings.py`, so a backend
  that was deployed without the deploy script's line, or a local `.env` without it, runs the whole
  feature into that refusal. If every task fails on step 1 with that code, check the deployed
  env var before anything else. It is a budget value on purpose, not a feature flag.
- **The desktop calls the LIVE Cloud Run URL** (`API_BASE_URL` in `agent_browser/mod.rs`, the same
  constant `command_brain.rs` and `polish.rs` carry). The backend must be deployed before any task
  can run; until then every step is a 404 and the task ends `failed/backend_http_404`.
- **Per-user allowance** is a monthly step counter in `users/{uid}/usage/browser_steps_{YYYYMM}`
  (`services/browser_agent/quota.py`): pro 600, companion 300, starter 150, free 0. Free tier is
  402 `browser_agent_paid`. These numbers are PHASE A PENDING placeholders, like the research
  credits.
- **Per-step cost estimate** `PER_STEP_ESTIMATE_MICROUSD = 60_000` ($0.06) is what the wallet holds
  before the call and corrects after. Size it from real traces before Phase B reaches users.
  Sonnet 5 at ~8k input tokens a step is roughly $0.60 to $1.50 per 25-step task (§2); Haiku 4.5
  at a third of the price is the lever to measure.
- **The reliability bar (§5.1) must be met before the voice entry is enabled for anyone else:** 3
  of the 4 §3 use cases succeed on 4 of 5 runs, measured from the trace table on the Browser Agent
  page. Use case 3c (job boards) is the headline test (§5.6).
- **Consent is a file plus a mirror.** `browser-agent-consent.json` (tauri-plugin-store) is the
  truth; `security.rs` keeps a `browser_task_consented` bool that `agent_browser::on_startup` and
  `set_browser_task_consent` write. Turning it off on the page withdraws the opt-in; the next
  start is refused with "browser tasks are not enabled in settings".
- **The task record has its own key file** (`agent-browser/key.bin`), never the meeting or
  dictation key: deleting one feature's data must not brick another. Text, answer, sources and
  the trace are sealed; state, counts and timestamps are clear.
- **Chrome policy keys** `RemoteDebuggingAllowed = 0` or `DeveloperToolsAvailability = 2` (HKLM or
  HKCU, `Policies\Google\Chrome`, `Policies\Microsoft\Edge`) make CDP impossible. The launcher
  checks them first and reports `browser_policy_blocked`; on a managed machine there is nothing to
  retry.

## 2. Verified state that changed the feature entry's assumptions

| Entry claim | Reality (source-verified 2026-09-23) | Consequence |
|---|---|---|
| §9.1 Buddy "already has run_desktop_capability" | Backend never read `?manifest=`; the tool was absent from the voice registry (`lessons-learnt.txt:1706`) | Built in Phase B as one generic tool driven by the manifest; the four older capabilities work through it too |
| §8.2 "three callers" | Chat tools all run server-side; no client-executed chat tool exists | Callers are voice, Jev, and the page. Chat composer is a later slice |
| §8.3 Node sidecar | No shell plugin, no `externalBin`, no Node shipped; `tokio-tungstenite` already pinned | Hand-rolled CDP in Rust (§8.5b) |
| §5.5 "interactive PageReader" | `PageReader` is a backend Protocol stepped by Cloud Tasks | A local browser cannot serve it; capability preset instead |
| §8.5c "reuse the research wallet" | `reserve_project_spend` requires a spendable `research_runs` document | Own day wallet, `browser_agent_budget/{day}` |
| §9.2a consent "gated by a new Operation" | `SecurityState` is memory-only | Persisted store plus a mirrored bool |
| Dictation phase gate | Phase 0 exit criteria unobserved | Jev entry is an approved exception, recorded in the dictation plan's backlog |

## 3. Why Jev is a shortcut, not the primary entry (the stress test)

| # | Case | Jev hold | Buddy call |
|---|---|---|---|
| 1 | 14-word brief | Capped at 12 words unless the hold opens with an address word | Works |
| 2 | "Compare X, Y, Z prices" in a Google Doc | Confidence splits with `web_search`; below the gate the sentence is TYPED | Nothing typed |
| 3 | Dictating a to-do item that reads like a task | Would fire a task and drop the text | No ambiguity |
| 4 | "Book the cheapest flight" | Cannot ask "which airport" first | One clarification, precise brief |
| 5 | "Actually only remote ones" 20 s later | Stateless per hold | Has the task id |
| 6 | Two sentences | Address-word escape only | Works |
| 7 | Result ready mid-call | Card and toast only | Buddy reads it out |
| 8 | No command token | Silently types | Session already authenticated |

Resolution: the 12-word cap stays. It becomes 30 only when the hold opens with `buddy`, `aura`,
`hey buddy`, `hey aura`, `ok buddy`, `ok aura`, and `browser_task` executes only when Jev answers
`addressed = yes` at `GATE_ADDRESSED`, regardless of field focus (`command_brain.rs`).

## 4. Components

### 4.1 Desktop runner, `src-tauri/src/agent_browser/`

| File | Owns |
|---|---|
| `mod.rs` | Handle (one live task, epoch, cancel generation), commands, the worker under `catch_unwind`, the loop (`drive`), the `POST /agent/step` client, status and approval events |
| `launch.rs` | Executable discovery (App Paths, known paths, `/Applications`), policy pre-check, spawn with own profile, `DevToolsActivePort` wait (stale file deleted first, mtime must postdate spawn, early exit = profile locked), Job Object on Windows, pid file and startup orphan sweep, HWND hide/show |
| `cdp.rs` | Socket task on tauri's runtime, `call` with a 20 s deadline, flatten-mode attach, the actions (click, type, scroll, navigate, back), load and settle waits, popup and dialog handling |
| `snapshot.rs` | AX tree to `[eN] role "name" state` lines, 60k-char cap with `read_more` paging, the ref map the guard trusts |
| `guard.rs` | Ref must exist; approval regex on role/name for click and type-with-submit; http(s) only; text bound |
| `store.rs` | `tasks.sqlite3`, sealed columns, `ended_at_ms = 0` open sentinel, orphan finalisation on every read/write, 90 days / 100 rows, per-account pruning |
| `consent.rs` | Store file plus the `security.rs` mirror |

State machine: `starting -> launching -> running <-> awaiting_approval -> done | partial | failed | stopped`.
Cleanup order: `Browser.close`, `Child::kill`, drop job, delete pid file, `store::finish`, release
handle, terminal emit. A voice call ending never stops a task; sign-out does.

Failure codes the row and card carry (`browserTaskFailureMessage` in `src/lib/browserTask.ts` is
the copy): `browser_not_installed`, `browser_policy_blocked`, `browser_profile_locked`,
`browser_launch_failed`, `cdp_connect_failed`, `cdp_attach_failed`, `no_credential`,
`browser_agent_paid`, `browser_steps_exhausted`, `browser_agent_project_cap`, `backend_*`,
`step_cap`, `time_cap`, `approval_denied`, `page_closed`, `snapshot_failed`, `app_crash`,
`worker_panic`, `blocked:login_required|captcha|paywall|not_found|unsafe`.

### 4.2 Backend proxy, `POST /agent/step`

`src/handlers/agent.py`, wired beside the dictation command route. Order per call: paid tier
(402) -> monthly step reservation (429, fail-closed) -> day wallet estimate (429, fail-closed) ->
`get_model_provider().expert(...)` with `response_model=StepDecision` (flat model: strict
structured output rejects a discriminated union) -> settle the wallet to the actual cost. The
worker prompt is `services/browser_agent/prompt.py`, versioned by `PROMPT_VERSION`, and the trace
records it. 503 for meter or model failures (the desktop retries once), 422 `action_malformed`
counts as a step and is fed back as history. Neither the brief nor the page text is ever logged.

### 4.3 Entry points

1. **Voice.** `GET /voice/token?manifest=...` (already sent by `voice.ts`) is now parsed
   (`shared/desktop_capabilities.py`) into `participant_metadata.desktop_capabilities`;
   `LaunchMetadata` carries it; `BuddyAgent` renders it into the prompt and exposes ONE tool,
   `run_desktop_capability(id, args_json)` (`voice/desktop_run.py`), which refuses any id not on
   the session's list and publishes `desktop.run {id, args}`. `useSystemControl.ts` dispatches it;
   `system_control.rs` routes `browser_task` to `agent_browser::start` before the live-voice gate.
   When a task ends during a call the desktop publishes `desktop.result` on `client_events` and
   Buddy reads it out at the next turn boundary.
2. **Jev.** `command_brain.rs`: `browser_task` action, `Verb::BrowserTask(brief)`, the two gates in
   §3, caption "Working on it in the background".
3. **Browser Agent page.** `src/dashboard/pages/BrowserAgentPage.tsx`, route `/browser-agent`,
   shown after Settings > System > Experimental > "Browser Agent page". Consent card, composer,
   live status with Watch and Stop, history, per-task detail with the trace table.

### 4.4 Delivery

`useBrowserTask.ts` folds the two events into the slot card (`BrowserTaskCard.tsx`: chip, approval,
result), summons the bar for the approval and result, toasts once through
`desktopNotifications.ts` with the new `browser_task_ready|partial|failed` types and the
`view_browser_task` action, and publishes `desktop.result` to a live room.

## 5. Non-goals (still §6's later milestones)

Cloud browsers, schedules, sub-agents and a planner; logins in the profile (§9.2b "Sign in to
LinkedIn in Aura's browser"); a chat composer entry; cross-device task visibility; Firefox and
Safari (no CDP).

## 6. End-to-end test checklist

Run in this order; each phase assumes the previous one passed. Record every task's trace numbers
(steps, ms, tokens) from the page: they are the Phase A deliverable.

### Before anything

- [ ] Deploy `juno-backend` (`deploy.sh`), then confirm the live env var:
      `gcloud run services describe juno-backend --region us-central1 --format=json | python -c "..."`
      shows `PROJECT_BROWSER_AGENT_DAILY_COST_CAP_MICROUSD=10000000`. **0 means every step is
      refused.**
- [ ] Your account resolves to a paid tier (pro/companion/starter); free gets 402 on step 1.
- [ ] Chrome, Edge or Brave is installed and not policy-blocked.
- [ ] Quit any running Aura, then `npm run tauri dev`.

### Phase A: the page (proves the loop and produces the numbers)

- [ ] Settings > System > Experimental: turn on "Browser Agent page". The sidebar shows Browser
      Agent (Beta).
- [ ] The page shows the consent card. "Turn on browser tasks" replaces it with the composer.
- [ ] Type "What is the current price of the Dell U2723QE on dell.com?" and Start. Expected within
      3 s: the overlay's notch shows the chip ("Opening a browser", then "Step N on dell.com"); no
      Chrome window is visible and NO taskbar button (a sub-second flash at launch is acceptable).
- [ ] Within 40 steps / 5 min: the result card appears in the notch with an answer and a source
      button, a toast fires, and the page's history gains a row. Open it: answer, sources, trace
      table with per-step ms and tokens. A 10-step task stays under 120k input tokens.
- [ ] Click Watch on the chip: the browser window appears on screen. Click again: it hides.
- [ ] Start a task, click Stop: the chip goes away within 2 s and `tasklist | findstr chrome`
      shows no process whose command line contains `agent-browser\profile`.
- [ ] Start a task, kill Aura from Task Manager: no browser process survives (Job Object). Relaunch
      Aura: the row shows "Failed" with reason app_crash.
- [ ] Brief "buy a 27 inch 4k monitor on bhphotovideo.com under 400 dollars": the task pauses on
      Add to cart / Checkout with the approval card and a 60 s drain. Click Don't: the task ends
      "Stopped early" with approval_denied after the second refusal, or continues on another path.
- [ ] Sign out mid-task: the task stops and the page's history is empty for the next account.
- [ ] Firestore: `users/{uid}/usage/browser_steps_YYYYMM.steps` equals the sum of steps across
      your tasks; `browser_agent_budget/{today}.spent_microusd` moved; `users/{uid}/cost/{day}`
      carries `feature=browser_agent` rows.
- [ ] The four §3 cases, five runs each (3c first): "Compare the monthly price of Cursor, Windsurf
      and Claude Code Pro from their pricing pages", "Find the 3 most cited 2026 arXiv papers on
      speculative decoding and summarize each", "List the open SWE internships in Seattle on
      <company> careers page", "What did Perplexity's blog say about Comet this month?". Record
      done / partial / failed and the trace totals. The bar is 3 of 4 cases on 4 of 5 runs.

### Phase B: voice

- [ ] Start a Buddy call on the desktop. Say "Buddy, find me the cheapest flight from SFO to SEA
      next Friday on Google Flights". Buddy answers with the started line ("On it. I'll work through
      that in my own browser...") and the chip appears within 3 s.
- [ ] Hang up while the task runs: the task keeps going and finishes with a card and a toast.
- [ ] Stay on the call until it finishes: Buddy reads the answer out at the next pause.
- [ ] Ask Buddy for a single fact ("what's the capital of Peru"): no browser task starts.
- [ ] On the Android app, the tool never appears (no `desktop_capabilities` in the token).
- [ ] With browser tasks turned OFF on the page, the voice request is refused: Buddy says it
      started, the desktop logs "browser tasks are not enabled in settings", nothing launches.
      (Known gap: Buddy has no way to learn the refusal this turn; the desktop's `desktop.result`
      only fires for a task that ran. Flag for Phase B polish.)

### Phase C: Jev

- [ ] Focus a text field (Notepad). Hold the dictation chord and say "hey aura go check whether
      the Costco near me has the Kirkland 12 pack in stock" (18 words). The HUD shows "Working on
      it in the background", NOTHING is typed, the chip appears.
- [ ] Same sentence without "hey aura": it is typed into Notepad as dictation.
- [ ] A 13-word command without an address word ("open chrome and search for the weather in
      Seattle please thanks") falls to dictation exactly as before (the 12-word cap is unchanged).
- [ ] "buddy, play some music" still routes to the music verb, not to a browser task.

### macOS (after Windows passes)

- [ ] Build the signed bundle (`MACOS_RELEASE_CHECKLIST.md`) and repeat Phase A steps 1 to 5. The
      browser's Dock icon is expected to show; the window stays off screen.

## 7. Known gaps and open decisions

- Buddy cannot be told that a voice-started task was refused before it launched (consent off, no
  credential, already running). The tool returns "started"; only a task that ran reports back.
- The Windows window hide happens right after CDP connect, so a taskbar button may flash for
  under a second. If that is visible in practice, hide the HWND from a `Target.targetCreated`
  event instead.
- Heavy pages: if `Accessibility.getFullAXTree` exceeds the 20 s call deadline the task fails
  `snapshot_failed`. The planned fallback (an in-page walker over interactive elements) is not
  built yet.
- The chat composer entry, cross-device history, and a per-user monthly wallet in dollars (rather
  than steps) are deferred.
