# Repository Guidelines

## Subjective Product Feedback

When the user gives direct feedback about sound, visuals, wording, animation, or
other subjective product qualities, treat the user's judgment as authoritative.

Make the smallest requested change and stop. Do not perform research studies,
benchmark alternatives, analyze waveforms/spectrums, compare multiple candidates,
or attempt to predict whether the user will like the result unless explicitly
asked.

If the user asks to find an asset online, do one targeted search, choose one
clearly usable result matching their description, integrate it, and leave
subjective acceptance testing to the user. Do not inspect or evaluate the asset's
subjective quality. Preserve everything the user said was already correct.

## Required Repository Instructions

Before any repository task, read and follow `CLAUDE.md` in full. It defines architecture, workflows, cross-repository contracts, and working rules. If guidance conflicts, the stricter Agent Git Restrictions below prevail.

Never load, invoke, query, update, or otherwise use Graphify or `graphify-out/` for any task in this repository. This prohibition applies even when a Graphify skill is available or would otherwise be automatically selected. Inspect source files directly with normal repository tools instead.

## Project Structure & Module Organization

Aura Desktop pairs a React/TypeScript UI in `src/` with a Tauri/Rust shell in `src-tauri/src/`. Dashboard code lives in `src/dashboard/`, companion overlay code in `src/overlay/`, dictation HUD code in `src/dictation/`, shared utilities in `src/lib/`, state in `src/state/`, theme code in `src/theme/`, and assets in `src/assets/`. Tauri permissions and packaging live in `src-tauri/capabilities/` and `src-tauri/tauri.conf.json`.

## Change Discipline

Keep edits surgical. Change only the lines needed for the requested behavior. Do not reflow signatures, imports, comments, whitespace, or nearby code. Do not run `cargo fmt`, `rustfmt`, Prettier, format-document, or broad autofix tools. For `MEETING_RECORDING_V2_ARCHITECTURE.md`, do not run `git diff` or any git-diff variant; inspect the exact edited lines directly instead.

## Testing Guidelines

The repo has existing Vitest and Rust test files, but the required routine checks are `npx tsc --noEmit` and `cargo check`; for dependency changes also run `npx audit-ci --config ./audit-ci.jsonc` and `cargo audit`. Exercise affected behavior in `npm run tauri dev`. Before tagged releases, complete `SMOKE_TEST.md`.

**TEST FREEZE. YOU MUST NOT write any new test file, test function, test case, or fixture.** In force until Varun bumps the version or asks for tests in the current message. Nothing else lifts it: not a rule that "needs" a test, not a bug you just fixed, not a coverage gap you noticed. Never offer to add tests while it is in force.

**YOU MUST NOT write a test in order to find, reproduce, or diagnose an error.** This is the specific waste the freeze exists to stop: writing a test, compiling it, running it, and iterating on the test itself burns far more time than asking the real object directly. To verify something, in this order:

1. `cd backend && python -c "import src.main; print('OK')"` for import and wiring.
2. A throwaway `python -c` that inspects the real value (`print` the live registry, the built prompt, the serialized schema). This is inspection, not a test, and is always allowed. Never save it to a file.
3. Run the EXISTING suite. It is comprehensive; if a change is wrong it almost always already breaks something.

Repairing an EXISTING test IS allowed and expected: a stale fake, a drifted import, or an assertion that no longer matches shipped behaviour is a broken verification path, not new test surface. Fixing a fake's signature, re-pointing an assertion at a renamed mechanism, or adding a helper an existing test needs to keep working is repair. A new case, file, or fixture is not.

## Releasing

Releases are cut by tag and built by `.github/workflows/release.yml`, which signs every artifact with Azure Artifact Signing and publishes a GitHub Release with the updater `.sig` files. See the Releasing section of `CLAUDE.md` for the full step flow and the signing contract. The parts that break releases:

- Bump the version in **all three** of `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. A mismatch fails the run in about twenty seconds.
- `workflow_dispatch` is a three minute preflight over credentials and tooling, no build. Add `-f full_build=true` to rehearse bundling too.
- The Azure credential is a GitHub OIDC client assertion alive for exactly **five minutes**, not a refresh token. Never insert a slow step between `Sign in to Azure` and `Smoke test the signing command`, never remove `Update-AzureSigningLogin` from `scripts/sign-windows-artifact.ps1`, and always carry `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` in the `env:` of any step that can trigger a signature.
- signtool reports credential expiry as a generic `SignerSign() failed` (`0x80004005`), the same code a wrong region endpoint gives. Read the inner exception, not the exit code.

## Agent Git Restrictions

Codex must never stage, commit, or push changes, nor publish them to GitHub or any other platform unless asked to. 
Its role is limited to planning, modifying local code, and guiding the user. 

## Security & Configuration

Never expose secrets, signing keys, credentials, logs, or local `.env` files. New endpoints or Tauri APIs may require CSP updates in `src-tauri/tauri.conf.json` and permissions in `src-tauri/capabilities/default.json`; the current webview HTTP allowlist is scoped to `juno-backend`, PostHog, and `api.openai.com`.

