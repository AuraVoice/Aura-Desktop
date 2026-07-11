# Aura subscription architecture: web-only billing, one entitlement for phone + desktop

> **Status (2026-07-09)**: Approved architecture, not yet implemented.
> Companion doc: `SUBSCRIPTION_IMPLEMENTATION_PROMPT.md` is the handoff prompt for the session that builds this.
> Grounded in a full exploration of all three repos (exact file paths cited throughout) plus store-policy web research performed 2026-07-09 (sources at the end).

## 0. Decisions locked

| Decision | Value |
|---|---|
| Payment rail | Web checkout only, via Dodo Payments as merchant of record. No in-app purchases anywhere. |
| IAP code | The Flutter app's `in_app_purchase` integration gets deleted, not just disabled. |
| Tiers and prices | Free / Companion **$19.99/mo, $191/yr** / Pro **$34.99/mo, $335/yr**. The web annual numbers win; mobile's hardcoded $179.99/$314.99 get updated to match. |
| Scope of a subscription | One purchase unlocks phone, desktop, and web dashboard together. It belongs to the Firebase account, not to a device. |
| Trial | 45 days for every user, granting the **Pro** experience (reverse trial). Server-stamped, not client-stamped. |
| Trial reset at launch | Every existing user gets a fresh 45 days when payments go live. |
| Source of truth | `users/{uid}/entitlement/current` in Firestore, written **only** by juno-backend. Every client is a reader. |

## 1. Store policy: why web-only is now safe, and why everyone doesn't do it

Verified against current sources on 2026-07-09:

- **Google Play (US only)**: since December 9, 2025, developers may link users out to external web checkout, and Play Billing is no longer required.
  This comes from the Epic v. Google injunction (upheld by the Ninth Circuit September 2025, compliance window runs to November 1, 2027, with a March 2026 settlement pending court approval).
  Google *intends* a 10% service fee on auto-renewing subscriptions completed via external links but **is not currently collecting it** and does not require reporting.
- **Apple App Store (US storefront only)**: external purchase links have been allowed since May 2025 with **zero commission currently**.
  In December 2025 the Ninth Circuit ruled Apple may pursue a cost-based commission on link-outs; that remand is still being litigated as of mid-2026.
- **Everywhere outside the US**: the old anti-steering rules still apply on both stores.
- **The bulletproof fallback that has always been allowed everywhere**: the Netflix model.
  An app that sells nothing and links to nothing, and merely consumes an entitlement the account already has, violates no store rule in any country and never has.

**The architectural consequence**: in-app steering behavior must be a backend-served config, not compiled-in copy.

```
steering config (served by juno-backend, changeable without an app release):
  { android_us: LINK_OUT,   ios_us: LINK_OUT,   row: SILENT }

LINK_OUT = paywall shows "Upgrade on the web" and opens the checkout URL
SILENT   = paywall shows plan status only, no purchase mention at all
```

If either store's policy shifts, or a review rejection lands, flipping one value degrades that storefront to the always-legal Netflix model instantly, with no app-store re-review needed.
This is the "don't let the stores let us down" guarantee: the worst legal outcome is mild purchase friction on phones, never a broken business.

**Why doesn't every business do this?**
Until mid-2025 it was banned: apps selling digital goods in-app had to use IAP, and even *mentioning* a cheaper web price was a rejection.
Only "reader apps" (Netflix, Spotify, Kindle) could sell nothing in-app.
The moment the Epic rulings landed, Spotify, Patreon, and Kindle shipped external purchase links within days, so the big players are doing exactly this now.
The holdouts stay on IAP for three reasons: store billing converts meaningfully better for phone-originated purchases (stored cards, one tap, family sharing), the link-out freedom is US-only, and small developers on the 15% small-business tier feel less fee pain than the headline 30%.
Aura's funnel is desktop-first, so the majority of purchases happen on the web natively, where no store was ever involved and no fee ever applies.
The phone paywall is a minority entry point, which makes the web-conversion friction penalty small for Aura specifically.

## 2. System overview

```
 Flutter app (Android/iOS)    Tauri desktop (Windows)    Aura-Web (Next.js, Vercel)
        |                           |                           |
        |        Firebase ID token as Bearer header             |
        +---------------- (one project: juno-2ea45) ------------+
        |                           |                           |
        v                           v                           v
                 juno-backend (FastAPI, Cloud Run)
                 GET  /entitlement          (new)
                 POST /billing/checkout     (new)
                 POST /billing/webhook      (new)
                 GET  /billing/portal       (new)
                        |                        ^
                        | sole writer            | signed webhooks,
                        v                        | idempotent by event id
          Firestore users/{uid}/...         Dodo Payments
          entitlement/current               (merchant of record,
          billing_events/{event_id}          hosted checkout + portal)
          usage/{daily_*}
```

Nothing about "pay once, unlock everywhere" is a feature to build per platform.
All three clients already authenticate to the same backend with the same Firebase account, so the subscription attaches to the UID and each client is just a screen reading the same document.

## 3. Data model (what gets stored where)

### `users/{uid}/entitlement/current`

The document already exists (defined in the mobile repo's `lib/data/services/subscription_plan.dart` model and read by `backend/src/services/entitlement.py`).
Authorship moves from client to backend, and billing fields are added:

```
{
  tier:                  "free" | "companion" | "pro",
  status:                "trialing" | "active" | "gracePeriod" | "expired",
  source:                "web",                      // was "platform"; ios/android values retire with IAP
  dodo_customer_id:      "...",                      // new
  dodo_subscription_id:  "...",                      // new
  expires_at:            <timestamp from Dodo>,      // authoritative, never client-computed
  cancel_at_period_end:  true | false,               // new
  trial_start_date:      <timestamp>,                // now server-stamped
  trial_end_date:        <timestamp>,                // now server-stamped
  updated_at:            <timestamp>,
  trial_notified_3d:     bool,                       // existing, unchanged
  trial_notified_expired: bool                       // existing, unchanged
}
```

### `billing_events/{dodo_event_id}` (new, top-level collection)

One doc per processed webhook event: `{uid, event_type, processed_at}`.
Existence of the doc means the event was already applied, which makes webhook retries harmless.

### Unchanged

`users/{uid}/usage/{daily_chat | daily_web_surf | daily_outbound_draft | daily_voice}` metering counters keep working exactly as they do today.
`users/{uid}/payment_intent/*` (beta interest capture) and the web repo's `aura-web-pricing-interest` collection stay as historical lead data.

### `firestore.rules`

Client writes to `users/{uid}/entitlement/**` become **denied** (currently owner-writable, which the rules file itself flags as a pre-payments must-fix).
The flip is sequenced in section 7 because doing it early bricks entitlement writes in every installed mobile build.

## 4. Flow 1: the purchase handshake (identical from any client)

The handshake problem: a user taps "upgrade" inside an app, pays in a browser, and every device they own must unlock, without license keys, pairing codes, or a second sign-in.
The solution is binding identity to the checkout session **server-side at creation time**, so the payment webhook already knows which account it belongs to.

```
User taps Upgrade
  (mobile paywall / desktop panel button / web pricing page)
        |
        v
POST /billing/checkout {tier, period}
  - authenticated: Firebase ID token Bearer header, uid resolved server-side
  - backend calls Dodo: create checkout session
  - metadata = {firebase_uid, tier, period}     <-- the handshake
  - returns {checkout_url}
        |
        v
Client opens checkout_url
  - desktop:  system browser (same pattern as the Google sign-in flow)
  - mobile:   external browser / Custom Tab (external = store-compliant)
  - web:      same-tab redirect
        |
        v
User pays $19.99 on the Dodo-hosted page
  (Dodo is merchant of record: they handle card data, global sales tax,
   invoices, and chargebacks; Aura never touches a card number)
        |
        +--> Dodo success page: "You're all set" with a deep link back to
        |    the app (aura:// scheme / Android App Link) plus a plain
        |    "return to the app" line as the no-deep-link fallback
        |
        v
Dodo ---> POST /billing/webhook
  - signature verified against the webhook secret
  - event id checked against billing_events/{id}: already seen -> 200, done
  - reads metadata.firebase_uid
  - upserts users/{uid}/entitlement/current
    {tier, status: active, source: web, expires_at, dodo_* ids}
  - writes billing_events/{id}
        |
        v
Every device converges on the new state through three channels:
  1. POLL   desktop and web poll GET /entitlement every few seconds while
            a checkout they initiated is open (bounded, ~10 min, exactly
            like the web-auth polling that already exists in
            src/lib/api.ts on desktop)
  2. PUSH   mobile receives an FCM data message "entitlement-updated"
            through the existing notification orchestrator and refetches
  3. TTL    any device that was off during purchase picks it up on next
            launch via the normal entitlement check (Flow 2)
```

Example: Sarah trials Aura on her Windows laptop, hits day 45, clicks Upgrade in the overlay, pays in Chrome.
Within seconds the desktop poll sees `companion` and unlocks.
Her phone, which was in her pocket the whole time, gets the FCM nudge (or catches up at next launch) and unlocks too.
No code was entered anywhere.

## 5. Flow 2: the entitlement check (every client, every launch)

```
                    app launch (any platform)
                            |
                            v
                    GET /entitlement
                            |
          +-----------------+---------------------+
          |                                       |
     doc exists                              doc missing
          |                                (first contact ever)
          |                                       |
          |                          backend CREATES the doc:
          |                          tier: free, status: trialing,
          |                          trial_start: now,
          |                          trial_end:   now + 45d
          |                                       |
          +-----------------+---------------------+
                            |
                            v
        response: {tier, status, effective_tier, trial_end_date,
                   expires_at, usage: {chat, web_surf, drafts, voice}}
                            |
              +-------------+--------------+
              |                            |
           success                      failure (network / backend down)
              |                            |
       cache the response           cached copy < 7 days old?
       - desktop: Rust state +        |               |
         tauri store, TTL ~12h       yes              no
       - mobile/web: in-memory        |               |
         + local storage         serve cached     degrade to free
              |                  (offline grace)  (never crash,
              v                                    never lock out)
       gate features off effective_tier
```

Server-stamping the trial on first contact fixes two real holes at once.
Today the trial dates are written by the Flutter client (trivially extendable by anyone with the Firestore SDK), and desktop users have **no entitlement doc at all** because only the mobile app creates one.
After this change, the first `GET /entitlement` from any platform starts the one true 45-day clock for that account.

A behavior change rides along: `backend/src/services/entitlement.py` currently **fails open to "pro"** when Firestore errors.
That was the right call for a free beta and is the wrong call once money exists, because an outage would hand out the paid product.
It becomes: fail to the client's cached value, then fail to free.
The `effective_tier` resolution (trial window counts as pro) stays exactly as implemented today.

## 6. Flow 3: trial lifecycle and the webhook state machine

### Trial lifecycle

```
day 0    first GET /entitlement from any device
         -> doc created: status trialing, Pro experience unlocked
           |
day 42   existing scheduler (backend/src/handlers/scheduler.py,
         run_trial_lifecycle_tick) sends the "3 days left" push
         via entitlement_notifications.py           [already built]
           |
day 45   "trial ended" push, deep link to paywall   [already built]
           |
           v
         GET /entitlement now resolves free
         -> free-tier caps engage (25 chats/day, 10 searches/day,
            5 drafts/day, 10 voice min/day, 7-day history)
         -> every surface shows the upgrade path
           |
           +--> user pays at any point (before or after day 45)
                -> webhook overwrites to status: active
                -> no trial-credit math, paid state simply wins
```

### Webhook state machine (subscription object in Dodo -> entitlement doc)

```
                       subscription.created / renewed
        (trialing) ----------------------------------> (active)
                                                          |
                              payment failed / past due   |
                                    +---------------------+
                                    v
                              (gracePeriod)  keep paid access during dunning
                                    |
                    +---------------+----------------+
                    | payment recovers               | dunning exhausted
                    v                                v
                (active)                         (expired -> tier free)

        user cancels: cancel_at_period_end = true, stays (active)
        until expires_at passes, then (expired)

        refund / chargeback: (expired) immediately
```

One implementation note: the free-tier voice cap is currently **warn-only** (`backend/src/agent/voice/free_tier_limit.py` speaks a nudge but never cuts).
With a paid tier to upsell to, enforcement flips to real at the cap, which also protects the unit economics in `GROWTH_PLAN.md` section 3c.

## 7. Flow 4: IAP removal and the migration sequence

The sequencing is the trap: flipping `firestore.rules` before the reader-only mobile build has shipped breaks entitlement writes in every installed copy of the app.

```
step 1   juno-backend ships the four new routes
         (server can now stamp trials; nothing user-visible changes)
           |
step 2   mobile release N ships:
         - SubscriptionService becomes a READER of entitlement/current
           (deletes _verifyAndGrantEntitlement, newUser() stamping,
            purchase/restore flows)
         - in_app_purchase removed from pubspec.yaml, product ID
           constants deleted
         - paywall CTA driven by the steering config
           (LINK_OUT -> /billing/checkout -> external browser)
         - interest-capture dialog retired
           |
step 3   adoption window: watch Sentry/Crashlytics for
         permission-denied entitlement writes from old builds
           |
step 4   firestore.rules flips: entitlement/** becomes backend-only
         (old builds still running now fail that write; acceptable at
          beta scale, and the app must swallow it gracefully, but the
          window in step 3 shrinks the blast radius first)
           |
step 5   one-time migration script: reset trial_end = launch + 45d for
         every existing user, then announce payments are live
```

## 8. Per-repo work breakdown

### juno-backend (`C:\Users\varun\MobileApps\Aura\backend`) - the bulk

| Change | Where |
|---|---|
| `GET /entitlement` (doc upsert + trial stamp + usage summary) | new route in `src/main.py`, logic beside `src/services/entitlement.py`, uid via `src/services/request_auth.py` |
| `POST /billing/checkout` (Dodo session, uid in metadata) | new `src/services/billing.py` + route |
| `POST /billing/webhook` (signature, idempotency, doc writes) | same new module |
| `GET /billing/portal` (Dodo customer portal link for cancel/manage) | same new module |
| Fail-open-to-pro becomes fail-to-cached/free | `src/services/entitlement.py` |
| Voice cap warn-only becomes enforced | `src/agent/voice/free_tier_limit.py`, `voice_agent.py` |
| Steering config endpoint or static block in `/entitlement` response | `src/main.py` |
| FCM "entitlement-updated" on webhook writes | reuse the existing notification orchestrator |
| Trial-reset migration script | one-off script beside the deploy tooling |
| Secrets: `DODO_API_KEY`, `DODO_WEBHOOK_SECRET` | Cloud Run env, never committed |

### Aura mobile (`C:\Users\varun\MobileApps\Aura`)

| Change | Where |
|---|---|
| Entitlement becomes read-only (via `/entitlement`, not raw Firestore) | `lib/data/services/subscription_service.dart` |
| Delete IAP: dependency, product IDs, purchase/restore/verify flows | `pubspec.yaml` line 40, `subscription_service.dart` |
| Paywall CTA: steering-config driven link-out; annual prices to $191/$335 | `lib/presentation/screens/subscription/paywall_screen.dart` |
| Handle FCM entitlement-updated -> refetch | notification handling layer |
| `firestore.rules`: deny client entitlement writes (step 4 only) | repo root rules file |

### Aura-Web (`C:\Users\varun\MobileApps\Aura-Web`)

| Change | Where |
|---|---|
| Pricing CTAs: interest-capture becomes real checkout (sign-in first if anonymous) | `src/components/sections/Pricing.tsx`, retire `PricingInterestModal.tsx` from the paid tiers |
| Real plan status + manage/cancel portal link | `src/components/dashboard/settings/BillingPanel.tsx` |
| `/entitlement` + `/billing/*` client calls | `src/lib/juno-backend.client.ts` |
| Checkout success/return page (deep link back + fallback copy) | new route |

### Aura-Desktop (this repo)

All four rows are **shipped** (core in v0.1.9, voice-cap surfacing right after); a Phase 4 session verifies against live endpoints instead of rebuilding.

| Change | Where (as built) |
|---|---|
| `useEntitlement` hook: fetch via `authFetch`, expose tier/effectiveTier/status/trialDaysLeft + checkout state machine | `src/state/useEntitlement.ts` + `src/lib/entitlement.ts` (fail-closed parser), riding `src/lib/api.ts` |
| Rust-side cache with 12h TTL + 7-day offline grace (cache written only after a successful fetch, per this repo's applied-cache rule; uid-keyed, cleared on sign-out) | `src-tauri/src/entitlement.rs`, registered in `lib.rs` |
| Trial countdown + Upgrade button; open checkout URL + bounded ~10 min poll | `src/overlay/KebabMenu.tsx` plan row, wired via `OverlayRoot.tsx`, same browser-open pattern as `useWebAuthSignIn.ts` |
| Voice-cap surfacing off the backend denial (no client cap math): `/voice/token` 402 + `{"detail": {"code": "voice_cap_reached", "seconds_until_reset": <optional int>}}` throws a typed `VoiceCapError`, registered non-retryable; the bar shows neutral capped copy + an inline Upgrade button opening the kebab menu. Mid-session cutoff rides the existing `session.error` data message with the same code. | `src/lib/voice.ts`, `src/overlay/useVoiceBar.ts`, `src/overlay/VoiceBar.tsx`, copy in `src/lib/voiceErrorCopy.ts` + `src/lib/copy.ts` |

## 9. Edge cases

| Edge case | Handling |
|---|---|
| Webhook arrives before any entitlement doc exists | Webhook upserts; checkout is only creatable via an authenticated route so `firebase_uid` is always present in metadata. |
| User pays while trial is active | Paid state overwrites `trialing`; remaining trial days are superseded, no credit math. |
| Webhook retries (Dodo retries on non-2xx) | `billing_events/{event_id}` dedup makes reprocessing a no-op 200. |
| Refund, chargeback, failed renewal | State machine in section 6: gracePeriod for dunning, expired for refunds/chargebacks. |
| Two devices polling at once | `/entitlement` is one Firestore doc read, cached client-side ~12h; at 10k users this is noise. |
| Desktop offline for days | Cached entitlement honored up to 7 days, then degrades to free; recovers on next successful fetch. |
| Local clock rolled back on desktop | Can stretch the offline grace window at worst, bounded and accepted (standard desktop-app posture). |
| Old mobile builds after the rules flip | Their entitlement writes get permission-denied; sequenced adoption window first, and the app treats the failure as non-fatal. |
| Dodo checkout/session API outage | `/billing/checkout` fails loudly with a retry message; existing entitlements are unaffected because reads never touch Dodo. |
| "Price locked in" promise to pricing-interest emails | They simply pay the same launch prices; the promise costs nothing. Optionally seed a launch email to `aura-web-pricing-interest` contacts. |
| Store policy reverses on link-outs | Steering config flips that storefront to SILENT (Netflix model), no app update needed. |
| Google starts collecting its intended 10% link-out fee | Worst case economics on the phone-originated minority of purchases; web-originated purchases are forever fee-free. Revisit steering config if it ever exceeds MoR economics. |

## 10. Bottlenecks and cost notes

- The entitlement read path adds one Firestore doc read per client per ~12h; negligible at any plausible scale.
- Webhook volume equals subscription events, not traffic; a single Cloud Run instance absorbs it.
- Dodo's MoR fee (~4% + $0.40) replaces a 15-30% store cut on every sale, and web-originated sales never owed a store anything.
- The steering config means store-policy reactions are config flips, not release cycles, which is the cheapest possible insurance.

## 11. Build order

```
Phase 0  (calendar time, founder, start immediately)
         Dodo merchant onboarding + products at $19.99/$191, $34.99/$335
Phase 1  juno-backend: /entitlement + /billing/* + trial stamping +
         fail-to-cached + voice enforcement
Phase 2  mobile: reader-only entitlement, IAP deleted, steering CTA,
         annual prices corrected
Phase 3  web: real checkout, real BillingPanel, portal link, return page
Phase 4  desktop: useEntitlement + Rust cache + trial countdown +
         upgrade flow + gating
Phase 5  rules flip -> trial-reset migration -> payments live
```

Phases 2, 3, and 4 are independent of each other and can go in any order once Phase 1 is live.
Phase 5 waits for Phase 2's adoption window.

## What this plan deliberately does not do

- It does not enable mobile IAP as a secondary rail; that is explicitly rejected, not deferred.
- It does not build regional pricing, promo codes, or the Max tier; all post-launch.
- It does not decide the dunning window length or the poll interval; those are implementation-time constants with sensible defaults (7 days, 3-5 seconds).
- It does not touch the meeting-notes feature; that plan (`MEETING_NOTES_PLAN.md`) unblocks itself the moment Phase 1 ships.

## Sources

Store policy, verified 2026-07-09:
[Google Play US policy update](https://support.google.com/googleplay/android-developer/answer/15582165), [Play policy announcement Dec 9 2025](https://support.google.com/googleplay/android-developer/answer/16671517), [external content links program](https://support.google.com/googleplay/android-developer/answer/16470497), [Epic v. Google overview](https://en.wikipedia.org/wiki/Epic_Games_v._Google), [Ninth Circuit lets Apple pursue cost-based external-link fees, Dec 2025](https://www.macrumors.com/2025/12/11/apple-app-store-fees-external-payment-links/), [Epic wins reversal of stay, Apr 2026](https://www.macrumors.com/2026/04/29/epic-games-wins-reversal-app-store-fee-battle/), [RevenueCat on the anti-steering ruling](https://www.revenuecat.com/blog/growth/apple-anti-steering-ruling-monetization-strategy/).

Codebase facts: exploration of `C:\Users\varun\MobileApps\Aura` (Flutter + `backend/`), `C:\Users\varun\MobileApps\Aura-Web`, and this repo, 2026-07-09; file paths cited inline.
Strategy context: `GROWTH_PLAN.md` sections 3c and 5b, `todo.txt` section 5.
