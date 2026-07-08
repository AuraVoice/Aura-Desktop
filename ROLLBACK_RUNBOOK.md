# Rollback runbook

What to actually do if a shipped version breaks the overlay, voice, or auth for beta testers.

## Why this exists

`release.yml` only publishes; `updater.rs` polls `https://github.com/AuraVoice/Aura-Desktop/releases/latest/download/latest.json` (the GitHub release marked "latest") and auto-downloads and installs whatever it finds, on every check, with no staged rollout and no user-visible notice before this pass's fix. One bad tagged release reaches every active install automatically. This is the single highest-blast-radius gap in the app, so the process below has to be rehearsed, not improvised under pressure.

## Step 1: confirm it's actually the build, not something else

- Check the reporter's version (About display in the Setup panel / tray menu, added this pass).
- Check Sentry (once wired) or the local log file the tester can send via the in-app feedback button for the actual error.
- Confirm it reproduces on the exact tagged version, not just "current."

## Step 2: stop the bleeding — pull the bad release

1. On GitHub, go to the release marked "Latest" for this bad version.
2. Unpublish it (mark as draft) or delete it entirely. This is the critical step: `tauri-plugin-updater`'s endpoint is `.../releases/latest/download/latest.json`, which GitHub resolves to whichever release is currently flagged "latest" — unpublishing/deleting the bad one makes that resolve back to the previous good release automatically. No code change needed for this step.
3. Confirm by fetching `https://github.com/AuraVoice/Aura-Desktop/releases/latest/download/latest.json` directly (e.g. in a browser or `curl`) and checking the version number in the response now matches the last good release, not the bad one.

## Step 3: fix and fast-follow

1. Fix the regression on `main`.
2. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (all three must stay in sync and nothing currently enforces this automatically; the tray's version label bakes in Cargo.toml's value via `env!`, and the Sentry release tag reads package.json's).
3. Tag and push (`git tag vX.Y.Z && git push origin vX.Y.Z`) to trigger `release.yml`.
4. Fill out `RELEASE_NOTES_TEMPLATE.md` for the new release, explicitly noting in "Known issues" or a short note that the previous version was pulled and why.

## Step 4: reach testers already on the bad build

There's no in-app messaging channel yet beyond the update mechanism itself (the in-app banner idea — piggybacking a `message` field on `latest.json` — is a P1 item, not built in this pass). Until that exists:

- The only lever is testers checking for updates themselves or the update check firing on their next launch, now safely gated (this pass's fix) so it won't install mid-call and will show a "restart to apply" notice instead of relaunching unannounced.
- If you have any other way to reach testers directly (email, Discord, whatever the beta program actually uses), use it — this repo has no built-in mechanism for that today.

## Step 5: after the fact

- Log the incident in `lessons-learnt.txt` per this repo's own convention: problem, issue, root cause, fix, date.
- If the regression came from the updater/CI pipeline itself rather than app code, treat that as equally serious — it's the same failure class this runbook exists for.
