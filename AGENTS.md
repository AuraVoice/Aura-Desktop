# Repository Guidelines

## Required Repository Instructions

Before any repository task, read and follow `CLAUDE.md` in full. It defines architecture, workflows, cross-repository contracts, and working rules. If guidance conflicts, the stricter Agent Git Restrictions below prevail.

## Project Structure & Module Organization

Aura Desktop pairs a React/TypeScript UI in `src/` with a Tauri/Rust shell in `src-tauri/src/`. Components and CSS live in `src/overlay/`, utilities in `src/lib/`, state in `src/state/`, and assets in `src/assets/`. Tauri permissions and packaging live in `src-tauri/capabilities/` and `src-tauri/tauri.conf.json`. Do not commit source avatar files from ignored `Avatars/`.

## Build, Test, and Development Commands

- `npm ci`: install the locked Node dependencies.
- `npm run dev`: start only the Vite browser UI at port 1420.
- `npm run tauri dev`: run the complete native app with hot reload.
- `npm run build`: type-check and build the frontend into `dist/`.
- `npm run tauri build`: create production installer and updater artifacts.
- `npx tsc --noEmit`: run the fast frontend CI check.
- `cd src-tauri; cargo check`: compile-check Rust. Use PowerShell because Git Bash can shadow MSVC's linker.

## Coding Style & Naming Conventions

Follow TypeScript style: two-space indentation, double quotes, semicolons, trailing commas, `PascalCase` components, and `useCamelCase` hooks. Keep CSS beside its component. Use Rust defaults (`snake_case`, `rustfmt`) and run `cargo fmt --check` after Rust formatting changes. Tauri commands use `snake_case`; JavaScript arguments use `camelCase`. Avoid unrelated refactors and em dashes in copy or comments.

## Testing Guidelines

There is no automated unit or end-to-end suite. Before submitting, run `npx tsc --noEmit` and `cargo check`; for dependency changes also run `npm audit --audit-level=high` and `cargo audit`. Exercise affected behavior in `npm run tauri dev`. Before tagged releases, complete `SMOKE_TEST.md`.

## Commit & Pull Request Guidelines

History uses imperative summaries, prefixes such as `docs:` and `chore:`, and version commits like `V0.1.8 - ...`. Pull requests should include a description, linked issues, verification commands, and UI evidence. Ensure CI passes and call out security, updater, permission, or cross-repository impacts.

## Agent Git Restrictions

Codex must never stage, commit, or push changes, nor publish them to GitHub or any other platform. Its role is limited to planning, modifying local code, and guiding the user. Leave all repository publishing actions to the user.

## Security & Configuration

Never expose secrets, signing keys, credentials, logs, or local `.env` files. New endpoints or Tauri APIs may require CSP updates in `src-tauri/tauri.conf.json` and permissions in `src-tauri/capabilities/default.json`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
