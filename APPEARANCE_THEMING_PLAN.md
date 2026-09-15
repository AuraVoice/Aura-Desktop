# Aura Desktop: Light + Dark Appearance

## Context

Aura today is split-brained: the dashboard and onboarding are bright mint glass (light only), while the overlay notch, chat cards and dictation HUD are near-black glass (dark only). Nothing reads `prefers-color-scheme`, there is no theme setting, and `theme.css` stamps `color-scheme: dark` on every window, including the light dashboard. Users on a dark OS get a blinding dashboard at night; users on a light OS get dark cards hanging off the notch.

Goal: one Appearance setting (System / Light / Dark, default System) that every window follows live, with a soft crossfade on change. Light stays today's look pixel for pixel. Dark is the same brand after sunset: deep green-black with smoky frosted glass.

Decisions locked with Varun (2026-09-14):

| # | Decision |
|---|---|
| D1 | Every window themes (dashboard, onboarding, overlay cards, status pill) |
| D2 | System / Light / Dark, default System |
| D3 | Dark = deep green-black glass, mint edge light |
| D4 | Switch motion = soft crossfade (~320ms), instant under reduce motion |
| D5 | Notch pill stays black in both modes; cards growing out of it follow the theme |
| D6 | Phased, each surface ships dark as soon as it passes audit |

---

## 1. The design

### 1.1 Palette

Light values below are today's, unchanged. Dark values are new.

| Token | Light (today) | Dark | Why |
|---|---|---|---|
| `--db-bg` | `#f1f0ea` | `#0b1412` | green-black, not grey: keeps the mint identity |
| `--db-content-bg` | `#faf9f5` | `#0e1916` | one step up from bg |
| `--db-surface` | `#ffffff` | `#13201c` | solid fallback surfaces |
| `--db-hover` | `#eceae2` | `rgba(255,255,255,0.06)` | alpha so it never punches the glass |
| `--db-border` | `#e7e5dd` | `rgba(190,235,222,0.10)` | mint-tinted hairline |
| `--db-text` | `#1f2328` | `#e6efec` | about 16:1 on bg |
| `--db-text-dim` | `#6b7280` | `#9aaba6` | about 7:1 on surface |
| `--db-text-mute` | `#9aa0a6` | `#6b7c77` | captions only (about 4:1) |
| `--db-active` | `#20232a` | `#e6efec` | inverse chip flips |
| `--db-teal` | `#1ec8b0` | `#2ee0c4` | brighter so it holds contrast on black |
| `--db-teal-deep-a/b` | `#2f6f60` / `#294f47` | `#1f5a4e` / `#173f37` | hero gradient |
| `--db-shadow-*` | ink `rgba(24,29,35,..)` | `rgba(0,0,0,..)` at about 3x alpha | shadows need more weight on dark |

### 1.2 The glass recipe, tokenized

CLAUDE.md's canonical recipe becomes five tokens, so every `.db-card`, briefing card and onboarding tile flips by redefining tokens, not by editing rules.

```
                    LIGHT (today, verbatim)                         DARK (new)
--db-glass-border   rgba(255,255,255,0.82)                          rgba(190,240,225,0.12)
--db-glass-fill     135deg rgba(255,255,255,.88) -> (232,244,241,.56)   135deg rgba(30,48,43,.72) -> (14,24,21,.56)
--db-glass-inset    inset 0 1px 0 rgba(255,255,255,.94)             inset 0 1px 0 rgba(255,255,255,.06)
--db-glass-shadow   0 5px 14px rgba(63,86,78,.06)                   0 8px 24px rgba(0,0,0,.35)
--db-glass-sheen    white sweep                                     mint sweep rgba(170,255,230,.10)
--db-divider        rgba(63,86,78,.10)                              rgba(190,235,222,.08)
--db-glass-hover    rgba(255,255,255,.5)                            rgba(255,255,255,.05)
```

Dark adds one ambient layer behind `.db-content`: a very faint mint radial glow top left (`rgba(46,224,196,0.06)`), so frosted cards have something to frost. Without it, blur over flat black is invisible and the glass reads as flat grey boxes.

### 1.3 The overlay (D5)

```
 LIGHT MODE                                   DARK MODE
 ┌───────────────┐  <- notch pill, #0a0a0a    ┌───────────────┐  <- same black pill
 └───────┬───────┘     ALWAYS dark tokens     └───────┬───────┘
 ╭───────┴────────────────────╮               ╭───────┴────────────────────╮
 │ frosted white card  90%     │               │ smoky black card 85%       │
 │ ink text, deep-teal accent  │               │ white text (today's look)  │
 ╰────────────────────────────╯               ╰────────────────────────────╯
```

- `--glass-*` keeps today's dark values as the default. `:root[data-theme="light"]` redefines them for cards: fill `rgba(250,252,251,0.9)`, text `rgba(20,28,26,0.95)` / dim `0.62`, border top white `.95` to bottom `rgba(63,86,78,.14)`, field fill `rgba(63,86,78,.06)`, `text-shadow: none`, accent `#149e8b` (the bright teal fails contrast on white).
- **The notch pins itself dark.** A `.theme-pinned-dark` class on `NotchBar`'s root and on the dictation HUD re-declares the dark `--glass-*` set. Without it, light mode turns notch icons dark-on-black. The HUD counts as notch family because it takes the notch's edge during a hold.
- Card fill stays at about 90% opacity in light. A transparent Tauri window's `backdrop-filter` only blurs webview pixels, never the desktop behind it, so a 60% white card over a busy desktop would be unreadable.

### 1.4 Motion

| Moment | Behaviour |
|---|---|
| Theme change (picker, top-bar toggle, OS flip while on System) | `document.startViewTransition()` crossfade, 320ms, `var(--db-ease)`. It animates gradients and `backdrop-filter`, which CSS transitions cannot. |
| No View Transitions (older WKWebView) | Add `html.theme-switching` for 360ms, which transitions `background-color, color, border-color, box-shadow, fill, stroke`. Scoped to the switch window so hovers never inherit a sluggish transition. |
| Reduce motion (`.db-reduce-motion` or OS setting) | Instant swap, no transition. |
| Window hidden (`document.hidden`, e.g. overlay at rest) | Instant swap, no transition. |
| Top-bar toggle icon | Sun and moon crossfade with a 90° rotate and 0.6 to 1 scale, 240ms. Monitor glyph when on System. |
| Appearance picker tile select | The mint selection ring slides between tiles (same measured-indicator trick as `SlidingTabs.tsx`), then the tile's mini preview does one glass sheen pass. |
| Dark card hover | Existing sheen sweep, mint tinted, plus the border brightening from `.12` to `.22`. No neon glow. |

### 1.5 Controls

1. **Settings > General > Appearance**: three glass preview tiles (Light, Dark, and System drawn as a diagonal half-and-half). Each tile is a CSS-only miniature: sidebar strip, two cards, a teal dot. The tiles are a real `radiogroup` with arrow-key roving, following `SegmentedChoice.tsx`'s pattern.
2. **Top bar quick toggle**: one icon button next to notifications that cycles Light and Dark. Clicking it while on System sets the opposite of the current resolved theme.
3. There is no tray entry. The tray is for runtime actions.

---

## 2. How it works (data flow)

```
 user clicks "Dark" tile ─┐        OS flips to dark ─────────────┐
                          v                                      v
  saveGeneralSettings({theme:"dark"})          matchMedia('(prefers-color-scheme: dark)') change
  (plugin-store, key dashboard_general_settings)     (only acted on when theme === "system")
                          │                                      │
        store.onKeyChange fans out to EVERY window  ─────────────┤
            ┌─────────────┼───────────────┬──────────────┐       │
            v             v               v              v       v
       dashboard       main overlay    dictation     status-pill
            │             │               │              │
            └──── themeEngine.apply(resolved) ──────────┘
                    1. resolved = setting === "system" ? media : setting
                    2. skip if same as <html data-theme>
                    3. visible and motion OK ? startViewTransition : instant
                    4. <html data-theme=..>, style.colorScheme = ..
                    5. localStorage["aura.theme.resolved"] = resolved (paint cache)
                    6. invoke("set_window_theme") -> native title/menus/scrollbars
```

**Cold open with no flash** (dark OS, dashboard not yet built):

```
 open_dashboard (Rust)
   └─ reads dashboard_general_settings.theme from the store (same as show_in_taskbar())
   └─ resolves "system" via the main window's native theme()
   └─ WebviewWindowBuilder.background_color(#0b1412)   <- the window is dark before any JS runs
 main.tsx (sync, before createRoot)
   └─ themeEngine.boot(): <html data-theme> from the localStorage cache   <- first CSS paint is dark
 React mounts -> useGeneralSettings resolves -> apply() reconciles (instant, never animated at boot)
```

Without both halves, dark mode opens on a white frame: `App.css` makes `html, body, #root` transparent and `.db-app` paints only after React mounts.

---

## 3. Files

> **As built (2026-09-14), where it differs from the plan below:**
> - Dark is not tokenized in place. The working tree carried uncommitted work in `dashboard.css` and the interview sheets, and eight parallel agents could not safely edit one 8,300-line file. So every component sheet stays the untouched light base, and themes live in `src/theme/surfaces/` override sheets, imported through `src/theme/themes.css`. That makes Light pixel-identical by construction.
> - There is no `palette.css` and no `set_window_theme` command. Issue tauri#5802 (the webview's `prefers-color-scheme` follows the OS, whatever window theme is set) makes a native theme call fight the System setting, and nothing visible needed it: the titlebar is custom and scrollbars are hidden. `color-scheme` is set per document instead.
> - MeetingPrompt and VoiceRecovery are pinned dark in both themes (2026-09-11 product call), alongside the notch and dictation HUD.
> - `ThemeSync` reads the store itself rather than `useGeneralSettings`, whose initial defaults would briefly flash the OS theme.

**New**
- `src/theme/themeEngine.ts`: `boot()`, `apply(resolved, {animate})`, `resolveTheme(setting, media)`, and the media listener. One module used by all windows.
- `src/theme/palette.css`: the dark and light semantic token blocks (`:root[data-theme=...]`), the glass recipe tokens, and the light overrides for `--glass-*`.
- `src/dashboard/components/AppearancePicker.tsx` (+ its CSS in dashboard.css) and a `ThemeToggleButton` in the TopBar.

**Modified (phase 0 core)**
- `src/lib/generalSettings.ts`: add `theme: "system" | "light" | "dark"`, default `"system"`. `mergeSettings` folds it into old stores, so no migration is needed.
- `src/main.tsx`: call `themeEngine.boot()` before render, and mount a tiny `useThemeSync()` in each root, which reuses `useGeneralSettings()`.
- `src/theme/theme.css`: remove the hardcoded `color-scheme: dark` (the engine sets it per window).
- `src/dashboard/dashboard.css:4-23`: `--db-*` gain dark values under `:root[data-theme="dark"] .db-app`, plus the new glass tokens.
- `src-tauri/src/dashboard.rs:96`: add `.background_color(..)` from the stored theme. Add an async `set_window_theme` command calling `window.set_theme()`, registered in `lib.rs`.
- `src/overlay/NotchBar.tsx` and `src/dictation/DictationHud.tsx`: add the `theme-pinned-dark` class.

**Migrated per phase (the bulk):** replace a hardcoded color with a token ONLY when the value should differ by theme. Brand colors stay: traffic lights (`dashboard.css:113-121`), `StreakFlameIcon`, Gmail/Zoom/Meet glyphs, status dots. Worst offenders: `dashboard.css` (735), `InterviewHackerCard.css` (90), `InterviewPage.css` (76), `PrivacySetupStep.css` (68), `DashboardOnboarding.css` (54). Three brand glyphs in `connectorBrandIcons.tsx` (lines 72, 95, 117) become `currentColor` so the X and GitHub-style marks do not vanish on black. The Insights gauge (`dashboard.css:4546`) and share ring (`:4402`) move to tokens. `DashboardOnboarding.css:118`'s `color-scheme: light` date input switches to inherit.

---

## 4. Phases (D6: ship per surface)

| Phase | Scope | Ships when |
|---|---|---|
| **0 Engine** | Setting key, themeEngine, boot cache, Rust background + set_theme, token scaffolding. The picker stays hidden. Light is pixel-identical. | tsc + cargo check green; the app looks unchanged |
| **1 Dashboard shell** | Titlebar, sidebar, top bar, content bg, `.db-card` family, modals, popovers, segmented, toggles, UpdateDialog, TrialBanner. Unhide the Appearance picker and top-bar toggle. | Every settings dialog and Home in dark passes the audit below |
| **2 Dashboard pages** | Home, History (3 panels), Insights charts, Dictation, Interview + PrepRoom, Connectors, Research, Account, Billing, Help, MobileApp | Page by page, each merged when it passes |
| **3 Overlay cards (light)** | `--glass-*` light overrides, notch pinning, ChatSlot, DraftCard, NotificationInbox, CalendarAgenda, MeetingPrompt/Notes, Callback, ActionApproval, KebabMenu, InterviewHackerCard, StatusPill, UpdateBanner | Every card over a white web page AND a dark IDE |
| **4 Onboarding** | OnboardingFlow, PrivacySetupStep, ProfileSetupStep, HotkeyTour, SetupPanel, SignInForm, DashboardOnboarding in dark | A fresh-profile run on a dark OS |
| **5 Close-out** | CLAUDE.md "Visual language" gains the dark recipe and the pinned-notch rule. Update the product knowledge catalog entry in juno-backend if Buddy is asked about appearance. | Doc diff reviewed |

Per-phase commit, never pushed without Varun saying so.

---

## 5. Edge cases handled

- **Portaled popovers** render outside `.db-app`, so they lose the `--db-*` tokens (an existing CLAUDE.md rule). The dark tokens live on `.db-app`, so the existing "portal into `.db-app`" rule covers it. Phase 1 greps every `createPortal` target.
- **A store read failure** resolves to `"system"`, never a forced light.
- **A stale localStorage cache vs the store at boot**: reconcile instantly with no crossfade, so no flicker at launch.
- **An OS theme flip while the user picked Light or Dark explicitly**: ignored.
- **Account switch**: the theme is device-level (same store as reduceMotion), so it survives sign-out, as expected.
- **Screen Sight / capture**: overlay windows are already excluded from capture, so no impact.
- **Transparent overlay + view transition**: skipped when `document.hidden`. When visible, the snapshot includes transparent pixels, so no black box flashes.

## 6. Verification

1. `npx tsc --noEmit` (the node_modules copy) and `cd src-tauri; cargo check` in PowerShell, every phase.
2. A throwaway grep count of hardcoded hex/rgba per migrated file before and after (inspection, not a test). The remaining hits must each be an intentional brand color.
3. Varun runs `npm run tauri dev` and walks this checklist:
   - Picker: Light, Dark, System. Every open window follows within one frame, and the crossfade is smooth.
   - Windows Settings > Personalization > Colors: flip the app mode while on System. Dashboard and overlay follow live.
   - Close the dashboard, set Dark, reopen it. No white frame.
   - Light mode: the notch pill is still black with light icons, and the chat card is frosted white over both a white page and a dark IDE.
   - Reduce motion on: the switch is instant.
   - Phase 4: a fresh profile on a dark OS gets dark onboarding.
   - macOS leg (WKWebView): the fallback crossfade works and `set_theme` does not steal focus.
4. The existing suite runs unchanged (TEST FREEZE: no new tests).
