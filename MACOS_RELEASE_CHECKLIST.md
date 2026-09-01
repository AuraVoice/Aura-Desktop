# macOS release checklist

What has to exist outside this repo before a tag produces a Mac build, in the order the
release workflow needs it. `release.yml` fails fast with the secret's name when one is
missing, but read this first so the failure is never a surprise.

## 1. Secrets in the `production` GitHub environment

Repo > Settings > Environments > `production` > Environment secrets. All five are read by
the `macos` job only; the Windows job and its Azure secrets are unchanged.

| Secret | What goes in it | Where it comes from |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` | Keychain Access > My Certificates > right-click "Developer ID Application: …" > Export, choose `.p12`, set a password. Then `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password typed during that export | you |
| `APPLE_API_KEY` | the 10-character Key ID | App Store Connect > Users and Access > Integrations > **Team Keys** > Generate API Key, role **Developer** |
| `APPLE_API_ISSUER` | the Issuer ID (UUID) shown above the key list | same page |
| `APPLE_API_KEY_P8` | the full text of the downloaded `AuthKey_XXXX.p8`, including the BEGIN/END lines | same page; the file downloads exactly once |

Rules that are easy to get wrong:

- The certificate must be **Developer ID Application**, created by the Account Holder at
  developer.apple.com > Certificates. An "Apple Development" or "Mac Developer" certificate
  imports and signs fine and is refused by Gatekeeper on every user's Mac. The smoke test
  checks for the exact string.
- The API key must be a **Team** key. Individual keys cannot talk to the notary service and
  fail with 401. Developer role is enough.
- Export the `.p12` from the Mac that holds the private key. A certificate downloaded from
  the portal alone has no private key and cannot sign.
- `KEYCHAIN_PASSWORD` is not a secret; the job generates it. `APPLE_ID` and `APPLE_PASSWORD`
  are not used and should not be added.
- The `production` environment also holds the Windows and updater secrets
  (`AZURE_*`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); the macOS
  job reuses the updater pair.

## 2. Run order

1. `gh workflow run release.yml` (plain). Three minutes: both credential smoke tests, no
   build. A red `Smoke test Apple signing and notarization credentials` step names the
   secret or the certificate problem in its last lines.
2. `gh workflow run release.yml -f full_build=true`. About 25 minutes on the Mac leg:
   builds, signs, notarizes, staples, then runs every `codesign`/`spctl`/`stapler`/`lipo`
   check. Nothing is published. Download nothing from it; the artifacts stay on the runner.
   If notarization is rejected, the `tauri-action` or dry-run step log contains
   notarytool's JSON with the reason.
3. Bump the four version files (see CLAUDE.md "To ship"), commit, push, tag. The `publish`
   job flips the draft only after both platforms verified and `latest.json` carries all
   three platform keys.
4. Hand the `.dmg` link from the release to beta users directly. Aura-Web keeps serving the
   `.msi` until its download page learns to pick the `.dmg`.
5. Cut a patch release later so the beta installs prove the self-update path.

## 3. Before public launch (company certificate)

- Replace `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` with the organization
  membership's Developer ID Application export; the API key must be regenerated under the
  organization team too.
- The Team ID changes. Every beta install re-prompts for Microphone, Accessibility, Input
  Monitoring and Screen Recording, and once for the keychain master key ("Always Allow"),
  on its first launch after that update. Put that in the release notes.
- Same release: test `entitlements.plist` with `allow-dyld-environment-variables` and
  `allow-unsigned-executable-memory` removed (dry run, then launch on a clean Mac).
- Point Aura-Web's download page at the `.dmg` for macOS visitors and update
  `../Aura/ECOSYSTEM.md` section 6.
