# Aura Integrations Wave 2: GitHub, Job Pipeline, LinkedIn, X, Google Classroom

Status: code-complete for all five phases on 2026-09-14, not yet deployed or verified against live provider accounts. Source proof only: backend imports, the six new tools pass the MCP canonical-contract check, the job feeds were fetched live, and the desktop type-checks.

**As built, and where it differs from the plan below:**
- **Approval is click-only.** Voice and chat can put an approval card up but can never approve it; "yes, post it" does nothing by design. Use-case 12 below is superseded.
- **Pending actions reuse `services/chat_completion/approval_store.py`** (the existing, previously unused `users/{uid}/pending_actions` store) rather than a new collection.
- **X bookmarks live in `UserAura/{uid}/x_bookmarks`, not memory atoms.** Atoms dedupe on text across sources, so "disconnect X deletes what X brought in" could not be exact. Search is keyword over the capped store; a stale store refreshes in the background when searched.
- **Bookmark reads are billed at $0.005 each** for users who do not own the developer app, so the per-user allowance is 100 a month, not 200.
- **LinkedIn tokens cannot be refreshed** (60 days), so the row shows a reconnect-by date. API version pinned to `202608`.
- **The connector descriptor is desktop-only** (`src/lib/connectorCatalog.ts`); the backend equivalent is `OAuth2ProviderSpec` in `services/oauth2_connector.py`. Calendar, Gmail and Notion are untouched.
- **The approval card outranks chat** in the notch slot and yields only to a live Interview Companion and its paste box.
- **Not built:** a scheduled bookmark sweep for every user, a Post button on the dashboard Drafts page, and Vercel/Supabase.

**Before any of it works in production:** create the GitHub App (user-to-server tokens with expiry, callback `/connectors/oauth/github/callback`, Setup URL `/connectors/github/installed` with Redirect on update, webhook off, permissions Contents read, Actions read, Pull requests read, Metadata read; read-only since 2026-09-22, so no Issues write and no `create_github_issue`), the LinkedIn app (Sign In with LinkedIn using OpenID Connect + Share on LinkedIn), the X app (OAuth 2.0, confidential client, pay-per-use billing), add the two Classroom scopes to the Google consent screen, then add these Secret Manager secrets and wire them in `deploy.sh`: GitHub, LinkedIn and X client ids and secrets, plus env vars `GITHUB_APP_SLUG` and the three `*_REDIRECT_URI`s.

## Context

Aura is a personal companion, not a work tool (`STRATEGY.md:146`). It is built for three groups:

| Who | What they do on the computer | What Aura already does for them |
|---|---|---|
| **Job seekers** | Apply, research companies, answer recruiters, sit live interviews, post on LinkedIn | Interview Companion, `linkedin_post` and `email` draft skills (`src/lib/draft.ts:13`), Gmail + Calendar connectors |
| **Vibe coders** | Build side projects with Cursor, Claude Code, Lovable; deploy; post progress on X | Screen Sight reads the editor, `tweet` draft skill, voice buddy |
| **Students** | Lectures, assignments, deadlines, notes, internship hunting | Meeting Notes (works on lectures), Notion connector, Calendar |

The first version of this plan picked Slack, Linear and Microsoft 365. Those are employee tools and were dropped. The research brief had described the users as "knowledge workers", which was wrong.

Decisions from you (2026-09-14):
- **Users:** mix across all three groups.
- **X:** reads bookmarks into memory and posts after you confirm.
- **Google:** not verified yet, so the 100-user cap is live.
- **Direction:** balanced. Every integration gets one read and one confirmed write.

---

## 1. The five integrations

| # | Integration | Serves | Read | Confirmed write | Cost | Hurdle | Risk |
|---|---|---|---|---|---|---|---|
| 1 | **GitHub** (GitHub App) | Vibe coders, CS students, job seekers (portfolio) | Repos the user picks: PRs, issues, failing Actions runs | Open an issue from the screen ("file this bug"); refresh a portfolio README | Free | None. No review, 5,000 requests/hour per user. | Low |
| 2 | **Job pipeline** (public job-board feeds from Greenhouse, Lever, Ashby, Workable, SmartRecruiters) | Job seekers, students hunting internships | Full job description, location and pay from the posting URL on screen | Save to a tracker (Aura's own store, optionally Notion) | Free, no auth | None. One company per call, and it is not a search API. | Low |
| 3 | **LinkedIn** (Sign In + Share on LinkedIn) | Job seekers, students | Name, headline and photo only | Publish a `linkedin_post` draft | Free | Self-serve, no review. 150 requests/member/day. No automated or bulk posting. | Low |
| 4 | **X** | Vibe coders (building in public), job seekers | Bookmarks and likes into memory | Publish a `tweet` draft | $0.001 per read, $0.015 per post ($0.20 with a link) | Pay-per-use billing account | Low to medium |
| 5 | **Google Classroom** | Students whose school uses it | Courses, coursework due dates and announcements for the user | None in v1 (the student turns work in on Classroom itself) | Free | Sensitive scopes on the unverified Google project; school admins may block apps for under-18 users | Medium |

**Runner-up: Vercel + Supabase deploy status** for vibe coders ("did my deploy fail?"). It is self-serve but lower demand than GitHub. It is the first swap if Classroom's verification stalls.

### Rejected for these users, with evidence

| Candidate | Why not |
|---|---|
| **Canvas / Blackboard / Moodle** | Each school's admin must issue a developer key. Canvas's API policy forbids asking students to paste a token, and since late 2025 admins can disable student tokens. Student AI apps reach Canvas only through school partnerships. |
| **YouTube lecture transcripts** | `captions.download` needs edit rights on the video, and the unofficial routes break on cloud IPs. Instead, "summarize this lecture" = capture the audio locally and run it through Aura's existing speech-to-text, which web-only competitors cannot do. |
| **Discord** | Reading DMs is partner-only. OAuth cannot read message content. |
| **LinkedIn reading** (connections, messages, saved jobs, Easy Apply) | Partner-only or closed. Apply with LinkedIn stopped taking new partners in October 2025. |
| **Indeed, Handshake, Wellfound** | Indeed's API is closed to new integrations, Handshake's is for career offices only, and Wellfound's was taken down. |
| **Cursor, Lovable, Bolt, v0** | No OAuth. Some take a user-pasted API key, which breaks the backend-held-token rule. Screen Sight already covers them. |
| **Slack, Linear, Microsoft 365** | Employee tools. Microsoft 365 can come back later for students with school Outlook accounts. |
| **Spotify** | Extended quota needs a registered business with 250K+ MAU. |

---

## 2. Verified current state

| Capability | Status | Evidence | Reuse decision |
|---|---|---|---|
| OAuth attempt + PKCE + callback + `aura://connectors/complete` | Exists, locked to 3 connector names | `backend/src/services/connector_oauth.py:37`, `src-tauri/src/connector_oauth.rs:13-51` | Extend the name list; one callback per provider |
| Token encryption with a rotatable keyring | Exists | `backend/src/services/token_crypto.py` | Reuse |
| Rotating refresh + per-user lock | Exists (Notion) | `notion_connector.py:164-213, 275-365` | Copy for X (rotating) and GitHub App user tokens (expiring) |
| Shared tool definitions + import-time contract check | Exists | `shared/tools.py`, `handlers/mcp.py:214,562` | New tools are defined there first |
| Voice write gate (finalized turn, STT ≥ 0.65, no write after an untrusted read) | Exists | `agent/voice/action_policy.py:107-157` | Inherited |
| Draft skills for LinkedIn, X, email | Exist, copy only, no Post button | `src/lib/draft.ts:13`, `DraftCard.tsx:175-195` | The Post button goes here |
| Interview Companion + calendar-aware meeting detection | Exists | `src-tauri/src/interview.rs`, `meeting/detect.rs` | The job pipeline feeds its prep, and must NEVER gate Start |
| Desktop connector UI | Exists, hand-written per connector (~6 edit sites each) | `connectors.ts:44-52`, `connectorOAuth.ts:31`, `useConnectors.ts:85-95,143,438`, `ConnectorsPage.tsx:223-405` | **Missing foundation A:** a descriptor table |
| **Server-side approval for writes** | **Missing.** Prompt-only today; desktop chat denies `send_email` | `tool_executor.py:72-76, 118-127` | **Missing foundation B:** pending actions + approval card |
| Connector data into memory | **Unverified.** No write path from a connector into `memory_atoms` | backend inventory | Phase 0 spike |
| GitHub, LinkedIn, X, Classroom, job feeds | Missing | none | Build |

**Proof level:** source inspection plus vendor docs. Nothing here was checked against the deployed backend or a real OAuth consent screen.

---

## 3. Two foundations (built once)

### A. Connector descriptor

One entry replaces ~6 hand edits. It applies to new connectors only, so Gmail, Calendar and Notion are untouched (honors `future-features.txt:1010`).

```ts
// src/lib/connectorCatalog.ts  (new)
{ name: "github", label: "GitHub", icon: GitHubIcon,
  authHosts: ["github.com"], tier: "free",
  reads:  ["Repos you choose: PRs, issues, build status"],
  writes: ["Issues you approve"],
  actions: { enable: "/connectors/github/enable", disable: "/connectors/github/disable" } }
```

On the backend, one `OAuth2ProviderSpec` per new provider covers the authorize URL, token URL, scopes, PKCE and refresh style. It sits beside `GoogleConnectorBase` and does not refactor it. The job feeds need no OAuth, so they are not connectors at all (see 4.2).

### B. Pending actions: the one approval path for LinkedIn posts, X posts and GitHub issues

```
voice/chat turn: "post this to LinkedIn"
  │
  ├─ tool linkedin_post(draft_id)                 [backend, shared/tools.py]
  │    └─ does NOT post. Writes users/{uid}/pending_actions/{id}
  │         {connector:"linkedin", verb:"post", preview:{text, chars:1180},
  │          idempotency_key: sha256(uid|session|message_id|verb),
  │          status:"proposed", expires_at: now+10min}             1 Firestore write
  │
  ├─ LiveKit data msg  action.proposed {id, preview}   (SSE event on chat)
  │    └─ agentData.ts validates, then ActionApprovalCard in the notch slot
  │         slot priority: approval > chat > draft > inbox > catch-up
  │
  ├─ user clicks Post, or says "yes, post it" in a finalized turn
  │    └─ POST /actions/{id}/approve     transaction: proposed → executing
  │         second click or voice-yes sees status≠proposed, so no-op
  │
  ├─ executor calls the LinkedIn /rest/posts API once
  │    └─ status → done {external_url} | failed {reason}
  │
  └─ action.completed → notch caption "Posted to LinkedIn" + open link
```

State machine: `proposed → executing → done | failed` and `proposed → rejected | expired`. A sweeper fails `executing` rows older than 2 minutes and never retries a write on its own. A duplicate public post is worse than a missing one, and LinkedIn's terms forbid automated posting anyway.

---

## 4. Journeys

### 4.1 GitHub (vibe coders)

- **Connect:** Connectors page, then "Connect GitHub" (a GitHub App install where the user picks repos), then back to Aura through the deep link.
- **Read:** "why is my build red?"
  1. `GET /repos/{r}/actions/runs?status=failure&per_page=1`, then the failed job's log tail (last 200 lines).
  2. Buddy explains it, using Screen Sight on the editor for context.
- **Write:** Screen Sight on a stack trace, then "file this". The approval card shows the repo, title and body before `POST /repos/{r}/issues`.
- **Not in v1:** a notifications inbox. That API only accepts classic tokens with the broad `repo` scope.

### 4.2 Job pipeline (job seekers, students): no OAuth, and it works for day-one users

> **As built (Phase 1, 2026-09-14):** v1 is a paste box on the Applications page, not "save this job" by voice, because neither the desktop nor the voice worker knows the browser URL. Links on the five feeds are fetched; any other link asks for the pasted description, which a cheap-tier call extracts. The saved job feeds interview prep through the existing Interview page workspace. The flow below is the eventual voice version.

```
user is on jobs.lever.co/acme/1234 (or boards.greenhouse.io/acme/jobs/567)
  │  says "save this job"  or clicks "Save job" on the notch
  ├─ desktop sends the active tab URL (already in the screen context)
  ├─ backend job_feeds.match(url) → provider=lever, company=acme, id=1234
  │    └─ GET api.lever.co/v0/postings/acme/1234          ~300ms, free
  │    no match (a custom careers page) → fall back to Screen Sight text extraction
  ├─ writes users/{uid}/job_applications/{sha256(provider|company|id)}
  │    {title, company, location, pay, jd_text, url, status:"saved", saved_at}
  │    same id twice = update, never a duplicate
  └─ notch: "Saved Acme, Senior Frontend. Want interview prep?"

later, an Interview Companion session starts
  └─ if a saved job's company matches the calendar title or the detected call,
     the JD is offered as prep context. It is a suggestion only; Start is never gated.
```

- **Statuses:** saved, applied, interviewing, offer, rejected. They change by voice ("I applied to Acme") or on a new dashboard Applications page.
- **Optional write:** "also put it in my Notion tracker" goes through the existing Notion connector.
- **Gmail:** recruiter-email detection is a later add-on. It needs `gmail.readonly`, which is restricted and needs a paid CASA audit, so the pipeline must not depend on it.

### 4.3 LinkedIn (job seekers, students)

- **Connect:** Sign In with LinkedIn using `openid profile email w_member_social`.
- **Read:** only the name, headline and photo, used to personalize the voice in drafts.
- **Write:** a `linkedin_post` draft gets a Post button, then the approval card, then `/rest/posts`. Image posts in v1 come from a screenshot the user picks.
- **Rule:** never schedule and never post in bulk.

### 4.4 X (vibe coders)

- **Connect:** OAuth 2.0 PKCE with `tweet.read users.read bookmark.read like.read tweet.write offline.access`.
- **Read:** a daily bookmark sync (capped at 200 items a month per user) writes memory atoms {author, text, url, saved_at}. "What was that Supabase auth thread I bookmarked?" then works.
- **Write:** a `tweet` draft ("shipped dark mode today") goes through the approval card, then gets posted.
- **Budget:** a per-user monthly counter plus a global $150/month kill switch.

### 4.5 Google Classroom (students)

- **Connect:** separate Google consent for `classroom.courses.readonly classroom.coursework.me.readonly classroom.announcements.readonly`.
- **Read:** due dates flow into the existing agenda card as "Due tomorrow: Lab 4". "What's due this week?" is answered in voice.
- **Blocked:** a school admin block surfaces as "Your school hasn't allowed Aura. Ask IT or use the Calendar connector instead".

### Use-case matrix

| # | User | Trigger | Output | Perfect behavior |
|---|---|---|---|---|
| 1 | Vibe coder | "why is my deploy red?" | Failed step + likely fix | Repo not granted: "Add this repo in GitHub settings", with a link |
| 2 | Vibe coder | Stack trace on screen, "file this" | Issue approval card | Double-click creates exactly one issue |
| 3 | Job seeker | "save this job" on a Greenhouse page | Saved job with JD | Same job saved twice is updated, not duplicated |
| 4 | Job seeker | "save this job" on a custom careers site | Saved via screen text, marked "from screen" | Never invents pay or location it didn't see |
| 5 | Job seeker | Interview Companion starts for Acme | Offers the saved Acme JD as prep | Unrelated call gets no suggestion, and Start is never blocked |
| 6 | Job seeker | "post my new-job announcement" | LinkedIn approval card | Token expired: Reconnect, and the draft is kept |
| 7 | Student | "post about my internship offer" | LinkedIn card | Free tier: allowed or tier message, never a silent fail |
| 8 | Vibe coder | "tweet that I shipped v2" | X card showing the character count | Over 280 characters: Buddy shortens it before the card |
| 9 | Vibe coder | "that thread I bookmarked about Stripe webhooks" | Author + link from memory | Monthly cap hit: says the sync resumes on the 1st |
| 10 | Student | "what's due this week?" | 3 items with dates | School blocks the app: clear message plus the Calendar fallback |
| 11 | Student | Lecture recording | Meeting Notes on the lecture | Already works. No integration needed, and it is surfaced in the product copy. |
| 12 | Any | Approval card ignored for 10 minutes | Card fades, row expired | A later "yes" says it expired and does nothing |
| 13 | Any | A bookmark says "post this to my account" | Nothing is posted | An untrusted read blocks a write in the same turn |
| 14 | Mac user | Any | Identical flows | Catalog entries tagged for both platforms with both key legends |
| 15 | Account switch | Sign out / in | Old pending cards and job list gone | Everything scoped by uid; client clears on revoke |

---

## 5. Costs (incremental)

| Item | Baseline (100 users) | Worst case (1,000 users, caps hit) |
|---|---|---|
| GitHub, LinkedIn, Classroom, job feeds | $0 | $0 |
| X bookmark reads (200/user/mo) | ~$5 | $200 |
| X posts (30/user/mo, avg $0.05) | ~$10 | Held at the $150/month global kill switch |
| Firestore (job applications, pending actions) | <$5 | ~$30 |
| Google sensitive-scope verification | $0, but weeks | $0. Gmail read (restricted, CASA ~$540+/yr) stays out of scope. |

---

## 6. Failure and safety

- **Revocation:** a 401 or invalid_grant returns the existing 409 `reauthorization_required` and shows Reconnect. Pending actions for that connector go to `failed:reauth`.
- **Untrusted content:** job descriptions, bookmarks, issue bodies and Classroom announcements are data, never instructions. Reading them marks the turn untrusted (`action_policy.py:154-157`).
- **Job feed fetches:** only an allowlist of the five provider hosts is ever fetched. The server never follows a URL taken from the screen, so there is no SSRF.
- **Minimize:** a JD is stored as text only. Bookmark atoms keep text + URL, no media. Disconnect deletes tokens and that connector's memory atoms.
- **Rate limits:** a per-user token bucket per connector. A 429 inside a voice turn degrades to a spoken "try again in a minute" and never retries past the 8s tool timeout (`handlers/mcp.py:96`).
- **Minors:** Classroom may reach under-18 users. No Classroom data goes into long-term memory; it is read live only.
- **Notifications:** approval cards appear in the notch only, never as a toast or on the lock screen.
- **Telemetry:** connector, verb, outcome and latency only. Never content.

---

## 7. Phased build

| Phase | Ships | Depends on |
|---|---|---|
| **0** (no code) | Create the GitHub App, LinkedIn app, X developer app with billing, and Google Classroom scopes on the consent screen; submit Google verification. Spike: the memory-atom write API. | none |
| **1** | **Job pipeline**: save job from screen, Applications page, JD offered to Interview Companion. No OAuth, so it works for every user on day one. | none |
| **2** | Foundation A + B, proven with **GitHub** (read build status, confirmed issue) | 0 |
| **3** | **LinkedIn** Post button on drafts through pending actions | 2 |
| **4** | **X** bookmarks into memory + confirmed post, with budget counters | 2, memory spike |
| **5** | **Google Classroom** due dates in the agenda | Google verification (swap to Vercel/Supabase if it stalls) |
| Each phase | `product_knowledge_v1.json` entry (platforms `["windows","macos"]`, both key legends); `ECOSYSTEM.md` update for new `/connectors/*`, `/actions/*`, `/jobs/*` contracts | none |

### Critical files

- **Backend (`../Aura/backend/src`):**
  - Edit: `services/connector_oauth.py`, `handlers/connectors.py`, `main.py`, `shared/tools.py`, `handlers/mcp.py`, `services/chat_completion/tool_executor.py`, `agent/voice/capabilities.py`.
  - New: `services/job_feeds/`, `services/{github,linkedin,x,google_classroom}_connector.py`, `services/pending_actions/`.
- **Desktop:**
  - Edit: `src/lib/connectors.ts`, `src/lib/connectorOAuth.ts`, `src/dashboard/useConnectors.ts`, `src/dashboard/pages/ConnectorsPage.tsx`, `src/overlay/agentData.ts`, `src/overlay/OverlayRoot.tsx`, `src/overlay/DraftCard.tsx`.
  - New: `src/lib/connectorCatalog.ts`, `src/overlay/ActionApprovalCard.tsx`, `src/dashboard/pages/ApplicationsPage.tsx` (bright glass recipe).

---

## 8. Verification (test freeze in force: no new tests)

1. `node_modules` tsc `--noEmit`; `cargo check` in PowerShell; backend `python -c "import src.main; print('OK')"` then the existing suite.
2. A throwaway `python -c` confirms `job_feeds.match()` on real Greenhouse, Lever and Ashby URLs, and that the tool registry passes the import-time contract check.
3. Live: `curl` each public feed endpoint for one real company; `curl /connectors` after deploy.
4. By hand in `npm run tauri dev` (you run it):
   - save the same job twice and confirm one row;
   - double-click Post and confirm one LinkedIn post;
   - let a card expire;
   - revoke GitHub access and confirm Reconnect.
5. Start an Interview Companion session for a saved company and confirm the JD suggestion appears and Start is never blocked.

## Known risks and contradictions (attack these first)

1. **The strategy doc forbids new features.** `STRATEGY.md:295-303` says "Do not build a new feature," and `STRATEGY.md:276` only allows connectors that feed the memory. LinkedIn and X posting go the other way. `STRATEGY.md` was not edited.
2. **Interview Companion must never be gated.** The JD suggestion must stay a side panel. Any code that makes Start wait on a job match repeats the 2026-09-11 lost-interview incident.
3. **The Google project is unverified**, and Gmail already requests restricted `gmail.readonly`. If Google reviews the project together, Classroom waits on a CASA audit. It may need a separate OAuth client.
4. **Job-board terms are not confirmed everywhere.** Lever says postings "may be scraped by third parties". Aggregation terms for Greenhouse, Ashby and Workable could not be verified, which is fine for a user fetching a job they are viewing and not fine for a crawler. Never crawl.
5. **Earlier plan ruled out a registry.** Foundation A stays clear of the three shipped connectors (`future-features.txt:1010-1012`).
6. **No approval surface when the notch is hidden.** Undecided whether a proposed action waits for the next summon or expires.
7. **The research agent's ban.** `BACKGROUND_RESEARCH_AGENT_ARCHITECTURE.md` bans connectors and external writes in research runs. No pending action may originate from a research job.

## Open unknowns

- The memory-atom write API for connector data (Phase 0 spike).
- Google Classroom scope class (believed sensitive; confirm in the Cloud Console).
- GitHub App user-token expiry handling versus a non-expiring OAuth App token.
- Supabase OAuth scope list (docs page returned 404), if it replaces Classroom.
