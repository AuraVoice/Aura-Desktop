# Dictation data report: what the local history can support for a formatter fine-tune

Generated 2026-10-01 from `%LOCALAPPDATA%\com.aura.desktop\dictation\` on this machine. Read only: no code
changed, nothing written to the live store, nothing pushed.

**Bottom line.** You have 101 real (raw, polished) pairs with audio, all decryptable. You have **zero**
human-corrected labels: `final_text`, `training_text`, `edits`, `label_source` and `label_quality` are empty on every
row, because sharing consent v3 was never given on this install, so the observer never ran. Prod holds 42 traces from
your account, all from Android, none from desktop. That is enough data to bootstrap a formatter (weak labels plus your
own corrections), but not enough to fine-tune on as it stands.

## How this was read

```
history.sqlite3 (copied to scratchpad; live app was running)
      │
      ▼
throwaway harness in the scratchpad (not in the repo)
  #[path] mod crypto       ← src-tauri/src/crypto.rs, compiled unchanged
  #[path] mod sealed_store ← src-tauri/src/sealed_store.rs, compiled unchanged
  mod fsx                  ← stub that always errors, so the harness CANNOT mint or replace key.bin
      │
      ├─ crypto::load_or_create_key_at(dictation/key.bin)   DPAPI unwrap, same as keystore.rs
      ├─ sealed_store::unseal_with(cipher, blob, aad)       same as dictation_history_list
      │     aad = sealed_store::aad("aura-dictation-history-v1", [uid, id, slot])  = history.rs::row_aad
      └─ crypto::decrypt_with_aad(clip, aad slot "audio")   same as dictation_history_audio
      │
      ▼
plaintext dump in the scratchpad only (deleted after this report), stdout printed counts only
```

`dictation_history_list` itself could not be called directly: it needs a live `AppHandle`, and it only returns
`text` and `raw_text`, not `final_text`, `training_text`, `edits` or `context`. The harness uses the exact same
functions and AAD grammar it does, plus the same slots `share.rs` reads. Result: **101 of 101 transcripts and
101 of 101 clips decrypted, 0 failures.**

## 1. Size, dates, audio

| Measure | Value |
|---|---|
| Total rows | **101** (one account, uid `Qx12s9…`) |
| Date range (local, PDT) | **2026-09-24 19:40** to **2026-10-01 12:24** |
| Rows per day | 09-24: 3, 09-25: 14, 09-26: 4, 09-28: 15, 09-29: 28, 09-30: 20, 10-01: 17 |
| Rows with `has_audio = true` | **101** (every `audio_path` non-null and every clip file present and decryptable) |
| Total audio, from the FLAC headers | **1,650.05 s = 27.50 min** (16 kHz mono) |
| Total audio, from `duration_ms` | 1,674.0 s = 27.90 min |
| Clip length | min 2.08 s, median 14.20 s, max 62.11 s |
| Encrypted clip bytes | 22,666,356 |

Two notes:
- `duration_ms` is the **hold wall clock**, not the audio length (the known `durationMs` bug). Use the FLAC figure.
- The range starts on 2026-09-24 even though the log shows dictation since 2026-09-09. `share_stats` holds a second
  uid (`tpcIFd…`), and `retain_only_for_session` deletes every other account's rows on each sign-in change. Older
  rows were wiped by an account switch, not by the 90-day cap.
- `clips/` holds 109 files but only 101 are referenced by a row. 8 are orphans (not investigated).

## 2. Label counts

| `label_source` / `label_quality` | Rows |
|---|---|
| corrected_gold | **0** |
| confirmed_gold | **0** |
| unchanged_silver | **0** |
| corrected_silver | **0** |
| other: NULL (never observed) | **101** |

`observed_at_ms` is NULL on all 101 rows, and `share_state` is 0 (ineligible) on all 101.

**Why.** The observer only runs `if shareable && sharing` (`mod.rs`, at the `record_later` call site), and `sharing`
is `share::sharing_hint()`, which React sets from consent v3. This install's stored settings read
`improveConversations: false`, `improveActions: false`, `improvementConsentVersion: 0`. Consent was never given
against v3 copy, so nothing was ever read back from a field.

## 3. Which fields are filled

| Field | Non-empty rows | Note |
|---|---|---|
| raw transcript (`raw_text`) | **90** | Stored only when polish changed the text |
| inserted / polished text (`text`) | **101** | |
| `final_text` | **0** | Observer never ran |
| `training_text` | **0** | Observer never ran |
| `edits` | **0** | Observer never ran |
| `context` | **101** | Keys: `app` 101, `controlRole` 101, `language` 101, `windowTitleStem` 93, `prefixText` 88 |

For the 11 rows with no `raw_text`, the recognizer text IS `text` (see section 4), so you effectively have a raw
transcript on all 101 rows.

Other plaintext columns: `insert_outcome` is inserted 95, focus_changed 5, keys_held 1 (`shareable` 95 / 6). `flagged`
is 0 on every row. The columns a newer build added (`polish_outcome`, `asr_request_id`, `asr_confidence`,
`asr_alternatives`, `asr_words`, `hold_ms`, `peak_dbfs`, `rms_dbfs`, `clipped_samples`, `silence_ratio`, `insert_sink`,
`focus_verdict`, `baseline_parked`) exist in the file but are **NULL on all 101 rows**. Something else wrote them to
the schema; this branch's `history.rs` does not declare them.

## 4. What produced the inserted text, and is the raw kept separately

```
mic ─► Deepgram nova-3 (asr/deepgram.rs, asr::provider() is hard-wired to Deepgram)
          │ final transcript
          ▼
      asr::scrub_transcript   strips tags like [BLANK_AUDIO] / <...>, collapses whitespace,
          │                   drops one-word phantoms on very short holds
          ▼  = "corrected"
      POST /dictation/polish (juno-backend, opt-in: polish.json {"enabled": true})
          │  model: GROQ_POLISH_MODEL = "openai/gpt-oss-20b" on Groq, temperature 0,
          │         reasoning_effort "low", 2.0 s provider timeout, no fallback model
          │  prompt: DICTATION_POLISH_SYSTEM_PROMPT (Aura/backend/src/prompts.py)
          │          + list rule: ALLOWED only for list-safe apps ("code" is one), BLOCKED otherwise
          │          + "Target app is {app}" + context lines; then U+2011 → "-" post-pass
          ▼
      text   ──► typed into the app, sealed into `text`
      raw_text = corrected   ONLY IF polish returned something different
```

- **Model: confirmed `openai/gpt-oss-20b` via Groq.** `deploy.sh` sets only `GROQ_API_KEY` and does not override the
  model. The setting has not changed since it was introduced on 2026-08-28.
- **Prompt:** the polish prompt and handler last changed in commit `73582ea` (2026-09-22), before the first row, so
  all 101 rows should have used the prompt at HEAD. I did not verify the Cloud Run deploy time.
- **Is the raw Deepgram transcript stored separately? Partly.** `raw_text` holds the post-`scrub_transcript` text,
  not Deepgram's bytes, and only when polish changed it (90 rows). The scrub is lossless for normal speech, so for
  training purposes it is the recognizer output. Deepgram's alternatives, confidences and word timings are not
  stored (`asr_*` columns are all NULL).
- **The 11 rows without `raw_text`:** 3 are 2 to 3 word fragments. The other **8 are unpunctuated multi-word
  sentences** (rows 3, 24, 31, 42, 67, 76, 81, 91 in the dump order), which means polish did not run or its reply was
  thrown away. The local log for this window has 117 polish calls: 114 `ok`, **3 `invalid`** (reply rejected by
  `polish::validate`, raw typed instead), 0 timeouts. Log lines carry no row id, and `polish_outcome` is NULL, so I
  cannot map these 3 to specific rows. The other 5 have no recorded cause.
- Polish latency in that window, from the log: median 537 ms, p90 837 ms, max 1,891 ms (n = 117).

## 5. Raw transcript shape

Raw words per row (`raw_text` if present, else `text`):

| min | median | p90 (nearest rank) | max | total |
|---|---|---|---|---|
| 2 | 25 | 55 | 132 | 3,092 |

- **Language tags:** `en-US` on 101 of 101.
- **App stems:** there are only 9 distinct stems, so this is the full list, not a top 10:

| app stem | rows | control role |
|---|---|---|
| code | 42 | Edit 36, Pane 6 |
| windowsterminal | 38 | Text 38 |
| chrome | 10 | Edit 10 |
| claude | 5 | Pane 3, Edit 2 |
| comet | 2 | |
| perplexity | 1 | |
| grok bot | 1 | |
| chatgpt classic | 1 | |
| aura-desktop | 1 | Pane |

Content skew: almost all of it is spoken prompts to coding agents (Claude Code in the terminal and in VS Code). Very
little prose, email or chat. A formatter trained on this would be a "prompt to an agent" formatter.

## 6. Fifteen rows, raw → inserted → final

`final` is **unknown on every row**: the observer never ran, so there is no record of whether you fixed anything
afterwards. ✗ marks a polish error. "Not fixed?" can only be answered as *unknown* for all 15.

| # | App | Raw (recognizer) | Inserted (polished) | Final | Verdict |
|---|---|---|---|---|---|
| 1 | comet | Should I know about the inference optimization and the definitions or should I dive into how aws neuron maps all of these models into their own xlas what should I do | Should I know about the inference optimization and the definitions, or should I dive into how AWS Neuron maps all of these models into their own XLAs? What should I do? | n/a | OK |
| 2 | windowsterminal | …currently for this user I have two managers who are the job job manager and this neuron manager and they then you create a supervisor agent… | …currently for this user I have two managers: the job manager and this neuron manager. Then you create a supervisor agent… | n/a | OK (stutter and restart collapsed) |
| 3 | code | I've changed my mind instead of using or instead of fine tuning on lora I wanted to write custom kernels… | I've changed my mind. Instead of using LoRA or fine-tuning, I want to write custom kernels… | n/a | ✗ changed meaning (you meant "instead of fine-tuning with LoRA"); curly apostrophes added. Fixed: unknown |
| 4 | code | So if I'm doing inference should I not just take my user input to test this model or do I have to do anything stuff to this existing open source model like transporting this model switch to and all of this shit first… | So if I'm doing inference, should I just take my user input to test this model, or do I have to do anything to this existing open-source model, like transporting this model, switching to it, and all of this stuff first?… | n/a | ✗ dropped "not" (meaning flipped); "shit" → "stuff". Fixed: unknown |
| 5 | code | Did you just I did not understand anything I told you try to explain to me as if you're explaining to an undergrad student… | Did you just say I did not understand anything? I told you to try to explain to me… | n/a | ✗ invented "say", turned an abandoned start into a question. Fixed: unknown |
| 6 | windowsterminal | Also research about computer using agents that are cheapest or any other shortcut way to optimally get those note that this is just plan only… | Also research about computers using agents that are cheapest or any other shortcut way to optimally get those notes. Note that this is just a plan… | n/a | ✗ "computer using agents" → "computers using agents"; invented "notes". Fixed: unknown |
| 7 | code | Notice so how so if I what truck number should I what number should I tell… now on the whole transcript starting to the end including the load then where do I get the otp from | How should I tell the truck number and the time we're supposed to do? … Provide the whole transcript from the start to the end, including the load. Where do I get the OTP from? | n/a | ✗ rewrite with an invented verb ("Provide"). Fixed: unknown |
| 8 | windowsterminal | Why didn't you commit the files… dammit all of them only coding files not documents… | Why didn't you commit the files…? Dammit, all of them—only coding files, not documents… | n/a | ✗ em dash inserted. Fixed: unknown |
| 9 | code | Give me a few all test case scenarios that I have to try in one call give me the whole transcript… | Give me a few all test case scenarios that I have to try in one call.␠␠⏎Give me the whole transcript… | n/a | ✗ line break you did not ask for ("code" takes the list-ALLOWED branch). Fixed: unknown |
| 10 | windowsterminal | Create a github issue in this repository saying that the hud doesn't work I mean the dictation doesn't work inside the app… | Create a GitHub issue in this repository saying that the HUD doesn't work. I mean the dictation doesn't work inside the app… | n/a | ✗ missed self-correction despite the "I mean" cue. Fixed: unknown |
| 11 | chrome | Let me know if you wanna hang out for a cough cup of coffee or not | Let me know if you wanna hang out for a cough cup of coffee or not. | n/a | ✗ cut-off fragment "cough" kept. Fixed: unknown |
| 12 | windowsterminal | Can you add the prompt instructions or the file name into plot dot m d … that clorc can access… | Can you add the prompt instructions or the file name into plot.m.d … that clorc can access… | n/a | ✗ wrong names from the recognizer ("CLAUDE.md", "Claude"), made worse. Fixed: unknown |
| 13 | code | Not all voice input are going to be less than thirty seconds right I mean not exactly thirty… | Not all voice input are going to be less than thirty seconds, right? I mean not exactly thirty… | n/a | ✗ numerals rule not applied ("30 seconds"). Fixed: unknown |
| 14 | code | Note that asking these bullshit small questions gonna trigger something that the recruiter doesn't like… | Note that asking these small questions will trigger something that the recruiter doesn't like… | n/a | ✗ dropped a word (profanity sanitized; other rows keep it). Fixed: unknown |
| 15 | chatgpt classic | Pick a base resume out of all these and look at the job description below… (132 words, no punctuation) | identical to raw, unpunctuated | n/a | ✗ polish did not apply (fallback). Fixed: unknown |

## 7. Failures in the inserted text

Method: I read all 90 rows where polish changed the text, plus the 11 where it did not. One annotator (me), one pass.
A row can appear in more than one category. Row numbers are 0-based positions in `recorded_at_ms` order, so you can
audit each one.

| Failure type | Rows | Which (0-based) |
|---|---|---|
| Dropped words | **9** | 4, 7, 26, 27, 53, 71, 83, 89, 95 |
| Changed meaning | **4** | 9, 21, 27, 94 |
| Filler left in | **1** | 79 |
| Missed self-correction | **8** | 9, 11, 15, 41, 43, 79, 88, 95 |
| Bad punctuation or casing | **9** | 12, 14, 28, 32, 55, 57, 70, 89, 97 |
| Missed list formatting | **0** | No row contains spoken ordinals used as a list, so the rule never had a chance to fire |
| Wrong names | **11** | 6, 10, 13, 32, 35, 56, 57, 66, 72, 89, 96 |
| Hallucinated text | **6** | 8, 9, 14, 73, 94, 98 |
| Other: numbers left as words | **2** | 25, 43 |
| Other: line break you did not ask for | **1** | 69 |
| Other: polish did not apply (unpunctuated fallback) | **8** | 3, 24, 31, 42, 67, 76, 81, 91 |

Totals: **39 of 90** polished rows have at least one error. Excluding rows whose only problem is a wrong name, **31 of
90** have an error the formatter itself caused.

What the categories mean for training:
- **All 11 wrong names started in the recognizer**, not the formatter: "Amit bush" (commit push), "clorc" (Claude),
  "plot dot m d" (CLAUDE.md), "aura swamps" (Aura Swarms), "deep info" (DeepInfra), "twelve"/"twin" (Twilio),
  "Anapuna lab" (Annapurna Labs), "AWS Neural" (Neuron), "AJ" (AGI), "XLE" (XLA). Polish passed them through and in
  rows 13 and 72 made them worse ("plot.m.d", "12"). A formatter only fixes these if it gets a vocabulary or the
  `prefixText` context. These are the cheapest wins.
- **Profanity is handled inconsistently:** removed or replaced in rows 7, 27 and 83, kept in 16 others. That
  inconsistency would end up in training labels taken straight from this model's outputs.
- Separate from the formatter, **11 rows** carry recognizer mishearings that are not names ("as for", "spirometer",
  "responsible", "short 29 prompt", "irrespective", "keyword diagnostics", "on a desk app"…: rows 11, 15, 17, 18, 40,
  63, 70, 78, 90, 95, 98). These need the audio to fix, not a formatter.

## 8. Privacy, before you open-source anything

Regex scan of raw + inserted text and of `context` (`prefixText` + `windowTitleStem`), then a manual read:

| Category | Speech (raw + inserted) | Context (sealed) |
|---|---|---|
| Email addresses | 0 | 0 |
| Phone numbers | 0 (2 rows talk about a phone number, none dictate one) | 1 regex hit (row 75); manual read: a load/rate string, not a phone number |
| Street addresses | 0 | 0 |
| Location | 0 | **1** (row 41: "I live in U-district, Seattle", from a LinkedIn message under the caret) |
| Your real name | 0 | **5** (rows 0 and 1: window title "Varun Tej"; 22 and 69: `C:\Users\varun\…` paths; 42: GitHub owner `varuntej07`) |
| Local file paths | 0 | **2** (22, 69; 69 also shows `…\Jobs\Happy Robot\`) |
| URLs | 0 | 2 (24, 66: claude.ai and public pricing pages) |
| Secrets or API keys | 0 | 0 (3 holds had `.env` as the window title, but in all 3 the caret prefix came from the Claude Code panel, not the file) |
| Other people's names | 0 real ("Amit" in row 17 is a mishearing) | 0 |
| Your own job search (recruiter, resume, the HappyRobot assessment) | **12** (3, 23, 36, 42, 65, 66, 67, 70, 71, 76, 79, 83) | several titles (`SUBMISSION_CHECKLIST.md`, `New repository: happy-robot-fde`) |
| Profanity | **16** | |
| Text from OTHER conversations | 0 | **88 rows have a `prefixText`**, mostly the last 200 characters of a Claude Code transcript, a LinkedIn thread or a GitHub form |

To release a dataset: speech text is close to publishable after removing the 12 job-search rows (or accepting them)
and deciding on profanity. **Do not publish `context` as is.** It holds third-party text and identifying details.
Window titles also reveal project and file names.

**This report itself now contains dictation text and sits untracked at the repo root. Do not commit it** (or add it to
`.gitignore`; I did not, since this task was read only).

## 9. Did these reach prod?

| Where | Count |
|---|---|
| Local: rows with `share_state` 2 (uploaded) / `share_trace_id` / `shared_at_ms` | **0 / 0 / 0** |
| Local: `share_uploaded` ledger | **0** rows |
| Local: `share_stats` | uploaded 0, failed 0, skipped 0 for both uids |
| Prod Firestore `users/*/dictation_traces` (collection group, all users) | **42** |
| …under your uid `Qx12s9…` | **42**, platform `android` on **42 of 42** |
| …from desktop (any uid) | **0** |
| …under the second local uid `tpcIFd…` | 0 |

Queried read only with the `varuntej07.cv@gmail.com` gcloud account (the `.wa` account lacks Firestore read on
`juno-2ea45`). A `platform ==` filter needs a collection-group index that does not exist, so the platform split comes
from listing the 42 documents' `platform` field. GCS audio objects were not checked separately.

**None of the 101 desktop rows were uploaded.** Same cause as section 2: no v3 consent, so `enqueue_backlog` never
queued anything.

## What this means for the fine-tune

| You have | You don't have |
|---|---|
| 101 audio + recognizer text + gpt-oss-20b output, all aligned | Any human-verified target text |
| 27.5 min of 16 kHz audio, one speaker, en-US | Variety: 80 of 101 rows go to a coding agent |
| Context (app, role, title, prefix) on every row | Deepgram word timings and confidences |
| 42 more Android traces in prod (some may carry gold labels) | Desktop traces in prod |

Possible next steps, ordered by cost:
1. **Turn on consent v3 on this machine** (Settings, the improvement toggles). From then on, every inserted row gets
   `final_text`/`training_text` and a gold or silver label, and gets uploaded. This is the only way to get
   labels with no extra work.
2. **Hand-label these 101 rows yourself.** At 25 median words it is about an hour. The errors in section 7 show where
   to start. 101 hand-checked pairs make a good eval set, but they are too few to train on alone.
3. **Pull the 42 Android traces** and check their `label_quality` before mixing them in.
4. For training volume, use a public disfluency or formatting corpus and keep these rows as the held-out eval. They
   are your real distribution.
