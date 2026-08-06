# Desktop Text Chat: Phase-Gated Implementation Plan

Status: implementation in progress. Owner: Codex. Reviewer: Varun.
Repos touched: `Aura-Desktop` (this repo) and `Aura/backend` (juno-backend).

---

## Implementation audit (2026-08-05)

Checked items are present in the current local source. They do not claim a backend
deployment, an installed-app pass, or manual Windows behavior unless stated.

- [x] Phase 0.1 focus path: chat summons the bar, focuses the composer through the
  dedicated hotkey raise path, and preserves the existing Alt-based setup focus path.
- [ ] Phase 0.1 manual gate: verify `Ctrl+Alt+Space`, typing, then Left Ctrl double-tap
  in the complete Tauri app.
- [ ] Phase 0.2: record desktop `/chat` TTFT P50 and P95 over 20 real requests.
- [ ] Phase 0.3: record PostHog voice latency P50 and P95 grouped by path.
- [x] Phase 1.1 local backend source: desktop surface requests use a server-enforced,
  fail-closed read-only tool allowlist.
- [ ] Phase 1.2 rollout gate: desktop currently enables chat for every signed-in user;
  no `desktop_chat_enabled` profile contract is wired into this branch.
- [ ] Phase 1.3 deployment gate: deploy the matching backend changes and verify the live
  endpoint cannot reach `send_email` for `surface: "desktop"`.
- [x] Phase 2 source: cold-lane SSE chat, all documented stream frames, visible degraded
  states, limits, retries, clarification choices, one-slot priority, two-step Escape,
  upright side layout, and client-owned conversation ids are implemented.
- [x] Phase 2 follow-up desktop source: history switching, explicit new chat with
  cache-race protection, code-block copying, persistent tool activity, and summarized
  reasoning display are implemented.
- [ ] Phase 2 runtime gate: verify a real typed turn makes zero LiveKit calls and that
  Left Ctrl double-tap still starts voice immediately afterward.
- [x] Phase 3 local desktop and backend source: correlated live text events, FIFO queue,
  dedupe, acknowledgements, visible queue state, timeouts, and the 2,000-character cap
  are implemented.
- [ ] Phase 3 runtime gate: verify two sends 100 ms apart stay ordered and a duplicate
  `client_message_id` produces one turn.
- [x] Phase 4 local desktop and backend source: bounded text handoff, shared
  `conversation_id`, token wiring, timeout, and one-shot backend consumption exist.
- [ ] Phase 4 runtime gate: verify the handoff end to end before removing the honest
  voice-session divider.
- [ ] Phase 5: backend turn state exists, but desktop has no durable local pending-turn
  store or startup reconciliation yet.
- [x] Phase 6 local desktop and backend source: persisted output mode, token-stamped
  initial mute, live generation controls and acknowledgements, local audio muting,
  server audio suppression, and Realtime bridge bypass are implemented.
- [ ] Phase 6 runtime gate: verify greeting suppression, mid-reply silence, continued
  text output, acknowledgement state, and no TTS request while muted.
- [ ] Phase 7: approval card wiring and controlled release of consequential write tools
  are not implemented.

---

## How to execute this with Codex

**One phase per Codex session. Never more.** Each phase below is independently
shippable and independently revertible, and every phase has an exit gate that must be
verified before the next one starts. Phases 0 and 1 are blocking: Phase 0.1 can
invalidate the UI design, and Phase 1 must be deployed before desktop makes a single
`/chat` call.

Paste this preamble at the top of every Codex session, then the single phase section:

> You are implementing ONE phase of `TEXT_CHAT_IMPLEMENTATION_PLAN.md` in the
> Aura-Desktop repo (`C:\Users\varun\MobileApps\Aura-Desktop`), with the backend at
> `C:\Users\varun\MobileApps\Aura\backend`. Read `CLAUDE.md` and the "Non-negotiables"
> section of the plan first, and follow both exactly.
>
> Hard rules: a TEST FREEZE is in force, so do not write any new test file, function,
> case, or fixture, including to debug something. Repairing an existing test that has
> drifted is allowed. Keep edits surgical: change only the lines needed, never reflow
> imports or signatures, never run `cargo fmt` or Prettier. No em dashes anywhere. Do
> not commit or push. Do not start any other phase.
>
> Verify with `npx tsc --noEmit` (use the `node_modules` copy, the global is a stale
> 4.9.4), `cargo check` from `src-tauri` in PowerShell not Bash, and
> `python -c "import src.main; print('OK')"` from `Aura/backend`. To inspect a value,
> use a throwaway `python -c` that prints the real object. Never save it to a file.
>
> When done, report: what changed, what you deliberately left untouched, and which
> exit-gate items you could not verify yourself.

Then append the phase, for example: `Implement Phase 2 only. Here it is: <paste>`.

Phase order and blocking relationships:

```
Phase 0  (spike + measurement, no product code)   BLOCKING
   │  0.1 can force a redesign of Phase 2
   ▼
Phase 1  (backend safety + rollout gate)          BLOCKING, must be DEPLOYED
   │
   ▼
Phase 2  (cold lane, one slot)  ──► ship to gated cohort here
   │
   ▼
Phase 3  (live-lane text protocol)
   │
   ├──► Phase 4  (cross-lane continuity)
   ├──► Phase 5  (durable recovery)
   └──► Phase 6  (output mute)
              │
              ▼
        Phase 7  (consequential writes behind approval UX)
```

Phases 4, 5, and 6 are independent of each other and can run in any order once 3 is
done. Phase 7 requires 6 to be complete because a muted user must still see a
confirmation card.

---

## Context

Aura Desktop is voice-only. Every first turn pays a LiveKit cold start (`tokenMs` +
`connectMs` + `agentJoinMs`, all measured in `useVoiceBar.ts`), and voice is socially
unusable in a library, an open office, or on a live call. A text lane fixes both: it
needs no room, and it works when speaking does not.

Two server-side halves already exist and desktop has never called either:

| What | Where | Status |
|---|---|---|
| SSE text agent | `POST /chat` -> `Aura/backend/src/handlers/chat.py:345` | Live, unused by desktop |
| Text turn into the live voice agent | `voice/screen_context.py:118` `deliver_typed_message` | Live, unused by desktop |

A first draft of this plan assumed both were drop-in. Review found seven contract
gaps that would have caused lost turns, duplicated sends, broken continuity, and an
unsafe `send_email` reaching every installed user. **This plan is restructured so
each of those is a gate, not a footnote.** Each phase is independently shippable and
independently revertible.

### The seven findings, and where each is resolved

| # | Finding | Resolved in |
|---|---|---|
| 1 | "Same session" is false; `/chat` history is client-supplied, `conversation_id` is not sent | Phase 1 (honest reset) + Phase 4 (real continuity) |
| 2 | `text_input` is fire-and-forget; concurrent `generate_reply`, no dedupe, no acks | Phase 3 |
| 3 | `/internal/chat/complete` is Cloud Tasks-only; desktop cannot wire it | Phase 5 |
| 4 | Cold lane gets the full `ToolExecutor` including a directly-sending `send_email` | Phase 1, blocking |
| 5 | Output mute misses `session.say`, tool filler, Realtime bridge, and the greeting race | Phase 6 |
| 6 | `prepareSession()` is not transport-only; warm-up breaks the next toggle | **Cut** |
| 7 | No `supportsTextInput` descriptor exists; slot logic is boolean priority | Phase 2 (one slot only) |

---

## Non-negotiables for every phase

- **Test freeze is in force** (`CLAUDE.md`). No new test file, function, case, or
  fixture. Repairing an existing test that drifts is allowed and expected. Verify by
  inspection: `python -c` against live objects, `npx tsc --noEmit`, `cargo check`.
- **Surgical edits only.** No reformatting, no `cargo fmt`, no Prettier, no renames
  outside the named files.
- **No em dashes** anywhere, code or copy.
- **Never push to git** without Varun saying so explicitly.
- `npx tsc` is a stale global 4.9.4. Use the `node_modules` copy. One `DashboardApp`
  test already fails on `main`, unrelated.
- Rust builds run in **PowerShell**, not Bash (Git Bash `link.exe` shadows MSVC's).

---

## Phase 0: Measure and de-risk before writing feature code

Nothing in later phases is safe to size until these three answers exist. No product
code in this phase.

### 0.1 The hotkey focus experiment (highest risk in the whole plan)

`CLAUDE.md` and the 2026-07-16 lesson: `win_focus` force-foreground is safe **only**
for the Setup `Panel`. It injects a lone Alt tap, which drops the window into Windows
keyboard-menu mode and **swallows the next Left Ctrl double-tap**. A chat composer
needs real keyboard focus, so it would be the second presentation ever to force it.

Build a throwaway spike (not a test, not committed): register `Ctrl+Alt+Space`, show
the `Bar` with a focused `<input>`, then check whether Left Ctrl double-tap still
starts voice.

- **Passes** -> Phase 2 builds the keyboard-first panel as designed.
- **Fails** -> stop and escalate. "Click to focus instead" destroys the entire
  keyboard-first use case, which is the reason this feature exists. Do not silently
  downgrade to it. Options to bring back: a dedicated Rust focus path that does not
  use the Alt tap, or an AttachThreadInput-based focus steal.

### 0.2 Measure real desktop TTFT

The ~400ms figure in the first draft was a **target, not a measurement**. Before
building UI, call `POST /chat` from desktop with a real Firebase token and record:
token acquisition, request open, first `text_delta`, `done`. Report P50 and P95 over
20 runs on a real network.

If TTFT is above ~800ms the latency argument for the cold lane weakens and the
priority order in Phase 1 should be revisited.

### 0.3 Pull existing voice latency from PostHog

`voice_first_response` already emits `tapToFirstResponseMs`, `agentJoinMs`, `tokenMs`,
`connectMs`, `path`. Get P50/P95 grouped by `path`. Specifically confirm whether
`path=bridged` is actually winning or silently degrading to `bridge_timeout` /
`bridge_unavailable`. This decides whether any further voice latency work is worth
doing at all, and it is free.

**Exit gate:** written answers to 0.1, 0.2, 0.3. 0.1 must pass or be escalated.

---

## Phase 1: Server-side desktop safety (BLOCKING, backend only)

**This phase must land and deploy before a single desktop chat request is made.**

The cold lane is not "Claude plus Gmail." `handlers/chat.py:593` constructs the full
`ToolExecutor`, and `ToolExecutor._send_email` (`services/tool_executor.py:913`)
**sends directly**. `approval_store.py` exists but source search shows it is not wired
into the chat execution path. A desktop chat field pointed at `/chat` today can send
email on the user's behalf with no confirmation UI anywhere.

### 1.1 Surface-scoped, server-enforced tool allowlist

- Add `surface: "desktop"` to the `ChatRequest` model (`chat.py:47-66`), defaulting to
  the existing behavior so mobile and web are untouched.
- Server-side, derive the permitted tool set from `surface`. **Enforcement lives in
  the executor construction path, not in the prompt.** Prompt wording is not
  authorization.
- Desktop allowlist for Phase 1, read-only and reversible only:
  `list_reminders`, `get_upcoming_events`, `query_memory`, `get_user_context`,
  `web_surf`, `list_emails`, `read_email`, `ask_clarification`, `reason_step`,
  `list_trackers`.
- Explicitly excluded until Phase 7: `send_email`, `create_calendar_event`,
  `update_calendar_event`, `set_reminder`, `cancel_reminder`, `store_memory`,
  `delete_memory`, `track_topic`, `cancel_tracker`.
- The exclusion is a hard filter passed to `ToolExecutor` (there is already an
  `extra_excluded_tools` parameter at `chat.py:607`). An unknown or missing `surface`
  must **fail closed** to the most restrictive set for desktop.

### 1.2 Rollout gate

Review flagged accidental rollout to every installed user. Add a server-owned
per-user gate, not a client build flag:

- Return `desktop_chat_enabled: bool` from an endpoint desktop already calls on
  startup (`POST /devices/profile`, `main.py:380`, is the natural home).
- Desktop renders no chat affordance, registers no chat hotkey, and makes no `/chat`
  call when it is false.
- Default false. Flip per uid for the initial cohort.

### 1.3 Verify

```
cd Aura/backend
python -c "import src.main; print('OK')"
python -c "from src.handlers.chat import ChatRequest; print(ChatRequest.model_fields.keys())"
```
Then a throwaway `python -c` that builds the desktop-surface executor and prints its
resolved tool list. Confirm `send_email` is absent. Do not save the script.

**Exit gate:** deployed to Cloud Run, and the live endpoint verified with `curl`
(not just source on disk, per the 2026-07-05 lesson). A desktop-surface `/chat` call
must not be able to reach `send_email`.

---

## Phase 2: Cold lane only, one slot, honest about continuity

Ship the smallest thing that is genuinely useful. **No LiveKit code in this phase.**

### 2.1 The lane

```
Ctrl+Alt+Space
   │
   ├─ Rust: summon_chat  (Bar + chat slot, voice_active stays FALSE)
   └─ React: ChatSlot mounts, composer focused
        │
   user types + Enter
        │  optimistic bubble, client_message_id minted (uuid v4)
        ▼
   POST /chat  { message, history[], session_id, surface:"desktop",
                 client_message_id }
        │
        ▼  SSE
   text_delta ──► append to streaming bubble
   tool_thinking / tool_status ──► inline chip
   clarification_ui ──► choice buttons
   chat_limit_reached ──► cap card, composer disabled
   error ──► failed bubble + retry
   done ──► persist turn
   [DONE] ──► close stream
```

### 2.2 The full SSE contract, not a subset

`chat.py:1-14` documents the frames. **All of them must be handled**, including the
ones the first draft skipped: `chat_limit_reached`, `clarification_ui` choice
selection and reply, reminder metadata on `done`, `error`, and the `[DONE]`
terminator. An unhandled frame type must render as a visible degraded state, never be
swallowed.

Client caps mirroring the server: `message` max 8000 chars, `history` max 100 entries,
`attachments` max 10. Show a counter past 90 percent, never let the server truncate
silently.

### 2.3 Continuity: say the true thing

`/chat` reconstructs context from the `history` array the **client** sends;
`session_id` there is lifecycle and logging metadata (`chat.py:421`, `chat.py:445`).
`/voice/token` accepts a separate `conversation_id` that desktop does not send
(`main.py:277`, `src/lib/voice.ts:42`), and the voice worker builds its own session and
loads context before that id is used.

So in Phase 2 the two lanes share **nothing**. Do not claim otherwise.

- Desktop mints and owns a `conversation_id` (uuid v4, persisted per session).
- Send it as `/chat`'s `session_id` now, so the plumbing exists ahead of Phase 4.
- The transcript is **visually** unified.
- When the lane changes, render an explicit inline divider: `Voice session started.
  Aura does not carry the text above into this call yet.` Real continuity is Phase 4.

### 2.4 One slot, no co-tenancy promises

Review is correct that no `supportsTextInput` descriptor system exists; slot
resolution is boolean priority logic at `OverlayRoot.tsx:201-216`, Guide Mode is only
a notch indicator, and the meeting cards are not mounted in the visual root.

- Build exactly one `ChatSlot`. Add it to the existing boolean priority chain with
  `chat (explicitly summoned)` at the top, since stealing focus from someone
  mid-sentence is the worst possible failure.
- **Do not** promise or build Guide Mode or meeting-card co-tenancy.
- **Do not** build a descriptor system for one consumer. Revisit when there are three.
- Side-mounted notch edges: the card renders **upright beside the notch**, not
  rotated. `bar_size` (`overlay.rs:440`) vertical branch already gives 380 on the
  cross axis for this.
- Esc with the composer focused blurs and keeps the draft. A second Esc closes.
  One-key close destroying a half-typed message is unacceptable.

### 2.5 Files

New: `src/overlay/ChatSlot.tsx` + `.css`, `src/overlay/useChatSession.ts`,
`src/lib/chatStream.ts`.
Modified: `OverlayRoot.tsx` (slot branch + `CHAT_SLOT_HEIGHT`),
`src-tauri/src/hotkeys.rs` + `lib.rs` (`Ctrl+Alt+Space`), `src-tauri/src/overlay.rs`
(`summon_chat`), `src/lib/profile.ts` (`desktop_chat_enabled`).

Any clickable element must be a real `<button>`, never a `<div role="button">`
(`data-tauri-drag-region="deep"` swallows the latter).

**Exit gate:** typed question gets an answer with zero LiveKit calls in the log.
Left Ctrl double-tap still starts voice immediately afterward. Ship to the Phase 1
cohort here.

---

## Phase 3: Live-lane text protocol (backend + desktop)

Only after Phase 2 is stable with real users.

### 3.1 The actual problem

`voice_agent.py:647` spawns an **independent task per `text_input`**. Two messages
sent close together can wake on the same 500ms poll and call `generate_reply`
concurrently. `_wait_for_turn_boundary` (`voice/screen_context.py:62`) gives up after
15s and proceeds **even if the agent is still busy**. There is no queue owner, no
`client_message_id` dedupe, no acknowledgement of any kind, and no way to associate an
assistant transcription with the typed turn that caused it.

### 3.2 Required protocol

Per-session FIFO with a single owner task. Every message carries `client_message_id`.

Inbound (desktop -> worker), topic `client_events`:
```
{ "type": "text_input", "text": str, "client_message_id": str, "generation": int }
```

Outbound (worker -> desktop), topic `agent_events`:
```
text_input.accepted   { client_message_id, queue_position }
text_input.started    { client_message_id }
assistant.text.delta  { client_message_id, text }
assistant.text.done   { client_message_id, text }
text_input.failed     { client_message_id, reason }
```

Rules:
- A `client_message_id` already seen in this session is **rejected as a duplicate**,
  not re-run. This is the only defense against stress row 17 and against a retry
  double-sending.
- The FIFO owner never starts turn N+1 until turn N reaches a terminal state.
- Replace the 15s give-up with a bounded wait that emits `text_input.failed` on
  timeout rather than proceeding into a busy agent.
- Simplification permitted if the FIFO is too large for one pass: allow exactly **one
  in-flight message** and reject the rest with `text_input.failed { reason: "busy" }`.
  The acks and dedupe are **not** optional in either design.

Register `assistant.text.delta` / `assistant.text.done` / `text_input.*` in
`KNOWN_TYPES` (`src/lib/agentData.ts:130`) so `validateAgentDataMessage` does not
classify them as `agent-unknown`.

### 3.3 Client behavior

Bubble states: `queued` (accepted, position > 0) -> `sending` (started) -> `streaming`
(deltas) -> `done` / `failed`. **A queued message must be visibly queued.** Silent
pending for up to 15s is what makes users think the app dropped their message.

Server-side cap is `_CONTEXT_MAX_CHARS = 2000` on this lane (not 8000). Enforce 2000
client-side with a counter past 1800.

**Exit gate:** two messages 100ms apart produce two ordered turns, never concurrent
generation. The same `client_message_id` sent twice produces one turn.

---

## Phase 4: Cross-lane continuity

Only now is the "one conversation" claim earnable.

- Send the client-owned `conversation_id` as `/voice/token?conversation_id=...`
  (`main.py:277` already accepts it; `src/lib/voice.ts:42` does not send it).
- Specify and implement how recent **text** history is handed into a newly started
  voice agent. The worker builds its session and loads context before
  `conversation_id` is consulted, so this needs a deliberate load path, not a rename.
  Bound it: last N text exchanges, hard token ceiling, consistent with the compaction
  budget in `context_compaction.py`.
- Remove the Phase 2 divider only when the handoff is verified end to end.

If the handoff proves larger than expected, **keep the divider and ship nothing
else**. An honest reset is far better than a silent context loss users cannot see.

---

## Phase 5: Durable recovery

`/internal/chat/complete` (`main.py:646`) is Cloud Tasks-protected. Desktop cannot
call it. The first draft's stress row 5 was not implementable as written.

The backend already writes recoverable turn state and schedules completion. Desktop
needs:

1. **Durable local pending state.** Pending messages and transcript survive a
   restart, written before the request opens, not after.
2. **An authenticated read endpoint**, `GET /chat/turns/{client_message_id}`,
   returning the completed turn and a stable reply id. A direct Firestore read path
   is the alternative and must be explicitly reviewed for rules and cost before being
   chosen.
3. **Startup and resume reconciliation** that replaces the pending bubble in place
   using the stable reply id, never appends a duplicate.
4. **Defined behavior** for: app close mid-turn, sleep/wake, sign-out with pending
   turns (drop, do not leak across accounts), and a second send with the same
   `client_message_id` (dedupe, return the existing turn).

---

## Phase 6: Output mute across every audio path

The design is sound because `BuddyAgent` forks reply text into transcription and TTS
(`buddy_agent.py:2110`), but the first draft's implementation covered only one of five
audio paths.

| Path | Requirement |
|---|---|
| Initial greeting | A mute published after connect **loses the race**. Stamp initial output mode into `/voice/token` participant metadata so the worker knows before it greets |
| `BuddyAgent.tts_node` | Early-return in text mode |
| `session.say` call sites | Audit and gate every one: `tool_filler.py:105`, `bridge_handover.py:177,184`, `draft_outbound.py:271`, `free_tier_limit.py:70,130`, `guide_mode.py:704`, `recorder.py:227`, `screen_context.py:98` |
| Realtime bridge | Uses separate audio elements, not LiveKit tracks. **Skip the audio Realtime bridge entirely while text-output mode is active**, unless Realtime gains a verified text-only mode |
| Client-side | Mute existing tracks, future tracks (`TrackSubscribed`), LiveKit bridge elements, and Realtime elements |

Add an **output-mode acknowledgement** so the client knows whether server suppression
actually applied. Without it the button silently degrades to client-side-only and the
user still pays TTS latency and Cartesia spend. Carry a `generation` counter exactly
as `encodeGuideMode` does (`src/lib/clientControl.ts:11`) so a stale toggle cannot win
a race. Persist via `generalSettings.ts`.

Hotkey: `Ctrl+Alt+M`.

---

## Phase 7: Consequential writes, behind a real confirmation UX

Only after Phases 1-6. Order fixed by
`VOICEOS_COMPETITIVE_IMPLEMENTATION_PLAN.md:286-294`.

1. Wire `approval_store.py` (`COLLECTION = "pending_actions"`, `prepare` / `claim` /
   `finish`) into the chat execution path. It is not wired today.
2. Build the desktop confirmation card: editable fields, Approve / Edit / Cancel,
   expiry. Every edit creates a new canonical arg hash and invalidates the prior
   approval. `outcome_unknown` must **never** auto-retry.
3. Only then remove `send_email` and the calendar/reminder writes from the Phase 1
   desktop exclusion list, one at a time.
4. Add `list_emails` / `read_email` to `VOICE_TOOL_REGISTRY` (`capabilities.py:154`)
   and `mcp.py:224` so voice gets Gmail read. `send_email` on voice stays out until
   the card is proven on text.

---

## Explicitly cut or deferred

- **Speculative room warm-up. Cut.** `prepareSession()` is not transport-only: it sets
  `desiredActive`, changes status, connects, and causes the agent to join
  (`useVoiceBar.ts:339`). The next Left Ctrl double-tap then sees `desiredActive` and
  **ends** the prepared session instead of activating it (`useVoiceBar.ts:874`). It can
  also provoke a greeting with the mic disabled. Revisit only if a distinct `prewarm`
  state exists and Phase 0.3 measurements justify the LiveKit spend.
- Guide Mode and meeting-card text co-tenancy. Deferred past Phase 2.
- `supportsTextInput` descriptor system. Not built for one consumer.
- Hedged LLM / TurnPlan (`VOICE_LOW_LATENCY_TURNPLAN_PLAN.txt`). Follows data, not hunches.
- Guide Mode V2. Independent, untouched.
- Prompt-builder unification between `/chat` and voice. Accepted drift.

---

## Connectors (post-Phase 7, unchanged priority)

1. **Gmail read onto voice.** Zero new integration work, already in `tool_executor.py`.
2. **Slack**, ~1 week. Mirror `gmail_connector.py`, tokens at
   `users/{uid}/integrations/slack`, reuse `connector_oauth.py`. Read-first.
3. **Google Docs then Notion**, ~1 week. Docs first since `google_oauth.py` exists.
4. **Linear only**, then let demand decide Jira/ClickUp. It is three integrations
   wearing one label across a smaller audience than Slack.

Not building: LinkedIn (no usable API), Outlook/Teams (Graph is its own project),
user-supplied MCP servers (needs the policy gateway first).

---

## Release track (parallel, does not block phases)

**Start Azure Trusted Signing identity validation on day 1.** Individual-account
validation takes 2-3 weeks and is outside your control. Then `scripts/sign-windows.ps1`
plus `release.yml`, keeping minisign in parallel. Recipe fixed at
`VOICEOS_COMPETITIVE_IMPLEMENTATION_PLAN.md:162-171`.

Ship Phases 1-2 unsigned to the gated cohort, where the SmartScreen warning can be
explained personally. Gate the **wide** push on the signed build.

Still open in `todo.txt` before any wide push:

- [ ] Authenticode in `release.yml` (only minisign today)
- [ ] Mutex-poisoning recovery in `overlay.rs`
- [ ] DPAs + retention policy (beta includes EU/UK)
- [ ] Sentry symbol upload + dashboards
- [ ] `/feedback` route (still a mail-compose fallback)
- [ ] `LEGAL_ADDENDUM_DRAFT.md` finalised
- [ ] Privacy copy covering text chat, which the current policy does not mention

---

## Stress matrix, mapped to phases

| # | Scenario | Phase |
|---|---|---|
| 1 | Type while agent mid-sentence -> visible `queued` | 3 |
| 2 | Paste past the cap -> client blocks, no silent truncation | 2 (8000) / 3 (2000) |
| 3 | Enter, then immediate Left Ctrl x2 | 2 |
| 4 | No network -> failed bubble + retry | 2 |
| 5 | Close lid mid-turn -> resume or fail visibly | 5 |
| 6 | Two sends 100ms apart -> ordered, never concurrent | 3 |
| 7 | Mute mid-reply -> audio cuts, text continues | 6 |
| 8 | Mute persists across sessions, applies before greeting | 6 |
| 9 | Chat open, draft card fires -> chat holds slot | 2 |
| 10 | Esc with half a message -> draft survives | 2 |
| 11 | Chat open, then Ctrl+Alt+G | deferred |
| 12 | **Hotkey open, then Left Ctrl x2 -> voice starts** | **0.1, blocking** |
| 13 | Notch on left/right -> card upright beside notch | 2 |
| 14 | 4K at 150% -> composer legible | 2 |
| 15 | Chat during meeting capture | 2 |
| 16 | Sign out with chat open / pending | 2, 5 |
| 17 | Same `client_message_id` twice -> one turn | 3 |
| 18 | Cap reached mid-chat -> `chat_limit_reached` card | 2 |

Rows 12, 17, and 6 are the ones that will bite. 12 gates everything.

---

## Verification

Fast checks, run directly:
```
npx tsc --noEmit                          # node_modules copy, global is a stale 4.9.4
cd src-tauri; cargo check                 # PowerShell, not Bash
cd ../../Aura/backend; python -c "import src.main; print('OK')"
```

Existing suite only. Test freeze in force.

Manual, Varun runs and reports back:
1. **Phase 0.1 first.** `Ctrl+Alt+Space`, then Left Ctrl double-tap. Voice must start.
2. Type a question. Answer with zero LiveKit in the log. Record real TTFT.
3. Draft card open -> no composer present.
4. Notch moved to the left edge -> card upright beside it, scrollbar not the OS default.
5. Phase 1 deployed: `curl` the live `/chat` with `surface: "desktop"` and confirm
   `send_email` is unreachable. Live endpoint, not source on disk.
