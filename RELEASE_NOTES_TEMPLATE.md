# Release notes template

Copy this into the GitHub release body (the release `tauri-action` creates has no body content beyond the auto-generated title, so this has to be added manually before or after the tag is pushed).

```markdown
## What's new
-

## Fixed
-

## Known issues
-

## Rollback instructions
If this build causes a regression, see ROLLBACK_RUNBOOK.md. Short version: delete/unpublish this release so the updater's `latest.json` falls back to the previous one, then fast-follow with a patched version.
```

Keep every section even if empty ("None this release") rather than omitting it — a beta tester scanning for "is this already known" should see the same shape every time.
