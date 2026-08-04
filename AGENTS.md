# Repository Guidelines

## Required Repository Instructions

Before any repository task, read and follow `CLAUDE.md` in full. It defines architecture, workflows, cross-repository contracts, and working rules. If guidance conflicts, the stricter Agent Git Restrictions below prevail.

Never load, invoke, query, update, or otherwise use Graphify or `graphify-out/` for any task in this repository. This prohibition applies even when a Graphify skill is available or would otherwise be automatically selected. Inspect source files directly with normal repository tools instead.

## Project Structure & Module Organization

Aura Desktop pairs a React/TypeScript UI in `src/` with a Tauri/Rust shell in `src-tauri/src/`. Components and CSS live in `src/overlay/`, utilities in `src/lib/`, state in `src/state/`, and assets in `src/assets/`. Tauri permissions and packaging live in `src-tauri/capabilities/` and `src-tauri/tauri.conf.json`. 

## Change Discipline

Keep edits surgical. Change only the lines needed for the requested behavior. Do not reflow signatures, imports, comments, whitespace, or nearby code. Do not run `cargo fmt`, `rustfmt`, Prettier, format-document, or broad autofix tools. For `MEETING_RECORDING_V2_ARCHITECTURE.md`, do not run `git diff` or any git-diff variant; inspect the exact edited lines directly instead.

## Testing Guidelines

There is no automated unit or end-to-end suite. Before submitting, run `npx tsc --noEmit` and `cargo check`; for dependency changes also run `npm audit --audit-level=high` and `cargo audit`. Exercise affected behavior in `npm run tauri dev`. Before tagged releases, complete `SMOKE_TEST.md`.

**TEST FREEZE. YOU MUST NOT write any new test file, test function, test case, or fixture.** In force until Varun bumps the version or asks for tests in the current message. Nothing else lifts it: not a rule that "needs" a test, not a bug you just fixed, not a coverage gap you noticed. Never offer to add tests while it is in force.

**YOU MUST NOT write a test in order to find, reproduce, or diagnose an error.** This is the specific waste the freeze exists to stop: writing a test, compiling it, running it, and iterating on the test itself burns far more time than asking the real object directly. To verify something, in this order:

1. `cd backend && python -c "import src.main; print('OK')"` for import and wiring.
2. A throwaway `python -c` that inspects the real value (`print` the live registry, the built prompt, the serialized schema). This is inspection, not a test, and is always allowed. Never save it to a file.
3. Run the EXISTING suite. It is comprehensive; if a change is wrong it almost always already breaks something.

Repairing an EXISTING test IS allowed and expected: a stale fake, a drifted import, or an assertion that no longer matches shipped behaviour is a broken verification path, not new test surface. Fixing a fake's signature, re-pointing an assertion at a renamed mechanism, or adding a helper an existing test needs to keep working is repair. A new case, file, or fixture is not.

## Agent Git Restrictions

Codex must never stage, commit, or push changes, nor publish them to GitHub or any other platform unless asked to. 
Its role is limited to planning, modifying local code, and guiding the user. 

## Security & Configuration

Never expose secrets, signing keys, credentials, logs, or local `.env` files. New endpoints or Tauri APIs may require CSP updates in `src-tauri/tauri.conf.json` and permissions in `src-tauri/capabilities/default.json`.

