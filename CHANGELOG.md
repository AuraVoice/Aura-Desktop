# Changelog

Every user-visible change to Aura Desktop, newest first, one section per tagged
release. Lines land under **Unreleased** as the work is committed; bumping the
version renames that heading to the release and its date. The release workflow
refuses a tag whose version has no section here, and copies the section into the
GitHub release body, so this file is the release notes.

Headings are `## [X.Y.Z] - YYYY-MM-DD`. Group lines under **Added**, **Changed**
and **Fixed**; drop a group that is empty. Write for the person using the app,
not for the person who wrote the code: what they can do now, or what stopped
going wrong. Internal-only work (CI, refactors, docs) stays out.

Sections before 0.15.33 were reconstructed from commit history when this file
was started and read like commit subjects rather than release notes.

## [Unreleased]

### Added
- Swarm managers now get a persona name alongside their job title, so the rail, roster and every message read "Snapshot Sam · Langfuse Snapshots" instead of a bare job label.
- Type "@" in #group to pick a manager or the Supervisor from a list; the mention steers the message to them and is highlighted in that manager's colour, both while you type it and in the thread afterwards.
- Asking a busy manager how it is getting on gets a status reply from its live session instead of a refusal.

### Changed
- The "Routing details" expander with its confidence percentage is gone from #group; a routed message shows only who took it and why.

### Fixed
- A #group message now leaves the box the moment you send it and shows faintly as "Sending" until it lands; before, your words sat in the composer until the router answered.
- A message routed to a manager that is still working no longer bounces with an error: it waits in line and starts on its own when the current task ends, in #group and in a DM.

## [0.16.2] - 2026-10-03

### Added
- Working managers in Swarm now show a small 3D version of their own mark turning beside a line that says what they are reading right now, with a quieter line in the manager's own voice underneath. Team rounds animate while the Supervisor writes the answer, a working manager's dot in the rail pulses on the same beat, and channels show placeholder rows while they load instead of flashing an empty screen.

### Changed
- The Swarm message box is 4px shorter with rounded 24px corners, a matching rounded send button, and a softer border and focus outline.
- Swarm has a connected chat layout, distinct manager colors, compact activity cards, and a refined composer. Reading older messages keeps your place, with a Jump to latest button when you want to catch up.
- Swarm managers now use their name's initial instead of generated icons, including while working. The Supervisor keeps its icon.
- Swarm fills the available width with only a tiny gap at the left and right edges.
- A Swarm manager can now read the accounts it asked for as soon as they are connected, instead of starting with every account switched off on its Team card. GitHub managers can list your repositories, browse a repo's files and read one file, not just open pull requests. A manager asks you at most one question per task; after that it carries on with a stated assumption instead of asking for things it can look up itself.

### Fixed
- Answering a Swarm setup question now goes straight into shaping the manager instead of restarting classification or asking again for missing details.
- Holding Ctrl+Win to dictate now works while an Aura window is in front, such as the dashboard's Swarm composer. Windows stops passing key presses to Aura's keyboard listener whenever one of its own windows has focus, so the chord did nothing there; Aura now also reads those keys directly while it is in front.
- Dictating into a dashboard field now shows the dictation pill while you hold the chord, and the words land in that field even when the chat card is open under the notch. The hold used to run with no feedback, and an open chat swallowed the text.
- Pressing Ctrl+Alt+G on a fresh call no longer turns Guide Mode off again by itself while Buddy is still starting up. If Buddy does not take the handoff in time, the call stays up and you can ask Buddy to turn Guide Mode on.
- A call no longer drops with "Buddy hit a snag" on a slow turn that Buddy was about to answer anyway. The message now appears only when every retry has failed.
- The "Buddy couldn't start" notice and the "Record this meeting?" prompt are now the size of their own text and buttons. With the chat open under the notch they used to stretch to the chat's full height, leaving one line of text in a tall empty block.

## [0.16.1] - 2026-10-02

### Changed
- Guide Mode is now one mode. Press Ctrl+Alt+G (Control+Option+G on a Mac) or ask Buddy to watch with you: Buddy watches your screen and listens quietly, speaks only when you are wrong, ask, or get stuck, checks official docs before correcting you, and walks you through a task step by step with the pointer when you ask. The separate "coach me" command is gone; starting Guide Mode does all of it.
- Starting Guide Mode no longer opens with a greeting. Buddy's first word comes only when there is a reason for one.

### Fixed
- The Guide Mode dot in the notch now lights up as soon as Buddy is watching, not only once a walkthrough has started.

## [0.16.0] - 2026-10-02

### Added
- When Aura decides a #group request is not Swarm work, she now says what to do instead: what the built-in feature does for that request and how to start it, with a button that opens it, and a **Hire that instead** button when an ongoing version would fit, which resends your message and its files as a hire. Files attached to a declined request are called out as unused instead of silently dropped.
- A **Swarm** tab on the Agents page, laid out like a chat app: describe ongoing work in #group and Aura hires a manager for it, gives that manager a team, and brings in a Supervisor once you have two. Your team now lives in your account, not on this computer.
- Swarm managers do real work. Message one in its DM (or let #group route to it) and it plans, searches the web, reads pages and the accounts you granted it, then posts a report where every finding cites its source. You can watch each step as it happens and press Stop at any time; a stopped or budget-limited run still reports what it found.
- Per-manager **Can read** switches for Gmail, Google Calendar, Classroom, GitHub, X bookmarks and Notion, all off until you turn one on. Managers only ever read: anything they write for you to send is shown as a draft and never sent.
- **Routines**: give a manager a schedule (say, weekdays at 8:00) and its report is waiting in its DM, with a notification, even if your laptop was closed. Suggested schedules wait for you to turn them on.
- A manager can hand a question off to a full Aura Research run, and a separate checker can mark a report **Verified** when every goal is backed by its sources.
- Ask **#group** something that spans your work and up to three managers work on it at once; the Supervisor then posts one combined answer in #group, with a link to each manager's full report and one notification instead of several.
- A Swarm draft meant for **X**, **LinkedIn** or **your calendar** now has a **Review** button: edit it, see exactly what will be posted or booked, and press **Approve** to do it once. Calendar holds go on your own calendar with no invitees, and Aura refuses to post publicly from a run that read your private accounts.
- Attach a **PDF, Word (.docx) or text file** to any Swarm message. Aura reads it on your computer and sends only its text, and the manager the message goes to can then read it, find things in it and quote it in its report. **Pin** a file in a manager's DM and it reads that file on every run, routines included. Unpinned files are cleared after 30 days.
- Paste a screenshot into any Swarm message (Ctrl+V on Windows, ⌘V on a Mac), drop an image onto the message box, or attach one with the paperclip. Aura reads it once and keeps only a description and the text in it, so the manager can quote what the picture shows. The image itself is never stored.
- Ask a manager for a document (a tailored resume, a cover letter, a plan, a fixed-up version of a file you attached) and its report carries it ready to edit, with **Save as Word**, **Save as PDF** and **Save as Text**. Files land in Downloads, in an Aura Documents folder, and never overwrite anything, including the file you attached.
- A one-time button brings a Swarm sandbox team from an earlier build into your account.

### Changed
- Insights' time filter is now a dropdown with 7 days, 30 days, 90 days and All time.
- Page titles and the top bar are gone, so every page starts at the top. Your profile now sits beside the sidebar button, notifications sit beside the window buttons, and light or dark mode is in Settings > System > Appearance.
- The Swarm tab now shows who you're talking to and their role, lists every manager with its title, shows when a Supervisor will join, and has a **New manager** button. It now matches the rest of the app's theme, with one accent colour instead of a colour per manager. The Reset button, which wiped your whole Swarm in two clicks, is gone.
- Swarm's send buttons now use the same paper plane icon as the chat window.
- Dark mode is now matte black: a pure black window with flat near-black panels, without the glossy gradients, highlights, shine sweeps and drop shadows.
- Opening Agents from the sidebar now folds the sidebar away, giving Swarm the full width. The Swarm tab also says less: shorter starter cards, labels and hints, at the same text size. The Managers status box now only appears while managers are working or something needs attention.

### Fixed
- **Manage billing** no longer shows for a plan that wasn't bought through checkout, which has nothing to manage. A short note explains why instead. When billing does fail to open, it now says why rather than asking you to try again.
- A Swarm report now says why it stopped short (an account not connected, nothing new found, budget used up) instead of just "Partial report", and a run that only hit its own safety rules no longer counts as partial.
- Interview company research that runs out of room now says the dossier came out too long, instead of claiming the research service was not responding.
- Signing into a different account no longer deletes your dictation history. Each account's dictations and recordings stay on this computer, visible only to that account, until they reach the 90-day limit.
- A Swarm DM now stops you at 2,000 characters, the most a manager's brief can hold, instead of letting you type up to 4,000 and then refusing the send.
- Approving a Swarm draft now tells you the same thing the approval card does: X's monthly posting limit is no longer called today's, and "X is limiting requests, try again in a few minutes" is no longer hidden behind "X refused it".
- A Swarm request that times out after a few seconds no longer claims it waited two minutes.
- The Swarm tab no longer piles up requests for team rounds that already finished, and typing in its composer no longer redraws every message.

## [0.15.33] - 2026-09-26

### Added
- One **Agents** item in the dashboard sidebar with Computer and Research tabs, replacing the separate Research and Browser Agent entries.
- **Replay the welcome tour** under Settings > System runs the shortcut tour and live demo again.
- A **Jump to newest** pill in the chat when you have scrolled up to read.
- A half-typed chat message now survives closing the chat; it is back when you reopen it.
- Text can be selected across several replies in the chat and copied as plain text.
- A "Microphone changed, still recording" status pill when Meeting Notes swaps or reopens its device mid-capture.
- Chat, voice calls and dictation say **You're offline** up front instead of a generic connection error.

### Changed
- Sending a chat message no longer jumps you to the bottom if you were reading older messages.
- Older chat messages load when you scroll to the top, without the view jumping.
- Notifications are held while you are on a call, recording a meeting or in an interview session, and shown when it ends.
- The daily catch-up card rests for five days after being dismissed three days in a row.
- Connectors are rechecked quietly whenever the dashboard regains focus; a revoked token shows a reconnect banner.
- Long chats re-render only the rows that changed, so typing in the composer stays smooth.

### Fixed
- Dictation stopping silently after Windows dropped the keyboard hook; the app now notices and reinstalls it.
- Audio capture, the keyboard hook and a dictation hold in flight are all recovered after the machine sleeps and wakes.
- A near-silent dictation tap no longer types a made-up word, and recognizer tags such as `<transcript>` are stripped.
- A microphone unplugged in the middle of a dictation hold is reopened once instead of failing the hold.
- Provider citation codes such as `citeturn0search1` no longer appear inside chat replies.
- The update banner no longer appears over a live call.

## [0.15.32] - 2026-09-25
- Send the composer's effort level with every chat turn.
- Chat card polish for dark mode.
- Bring the desktop chat composer in line with mobile.

## [0.15.31] - 2026-09-24
- Let Screen Sight off pause a watch session's frames without ending it.
- Keep one call one meeting across hand-offs, and stop calling a second window a focus change.
- Stop dictation commands from stacking on top of polish.
- Background Browser Agent: Aura's own Chromium driven one step at a time.
- Meeting detection: treat an app holding the mic as a call.

## [0.15.30] - 2026-09-22
- GitHub connector: read-only, show which repositories Aura can read.

## [0.15.29] - 2026-09-22
- Interview Companion: give the typed and Screen composer its own chat thread.

## [0.15.28] - 2026-09-22
- Voice commands: move the TypeSafe key off the client and behind the backend.

## [0.15.27] - 2026-09-21
- Voice commands: find Store apps, and stop claiming a launch that did not happen.
- Voice commands: a short dictation hold can act instead of type.

## [0.15.26] - 2026-09-21
- See a call that is running in a background tab.
- Let the candidate ask about the screen, and show code as code.

## [0.15.25] - 2026-09-18
- Stop the resume bleeding into answers it has no business in, and start the companion on its own.

## [0.15.24] - 2026-09-18
- Let the interviewer be in the room instead of on this machine.

## [0.15.23] - 2026-09-18
- Make Interview Companion work when nobody ever speaks.

## [0.15.22] - 2026-09-18
- Stop a speaker relabel from cutting an interviewer's question in half.

## [0.15.21] - 2026-09-18
- Stop Interview Companion losing an interview to a rejected diarize handshake.
- Only badge the activity row whose turn is still in flight.

## [0.15.20] - 2026-09-16
- Let the answer model pick the register per question, keep the brief on disk, debrief interviews.
- End the dictation hold when the HUD's Copy button is pressed.

## [0.15.19] - 2026-09-15
- Read the field back after dictation and upload when idle.

## [0.15.18] - 2026-09-15
- Stop long pages painting blank while they scroll.
- Make dark mode matte black instead of green.

## [0.15.17] - 2026-09-15
- Add GitHub, LinkedIn, X and Google Classroom connectors with click-only approval cards.
- Stop the update dialog hanging forever on Restarting.

## [0.15.16] - 2026-09-14
- Add light and dark appearance across every window.
- Add the interview prep room and make brief and research failures explain themselves.
- Opt dictation and interview audio out of Deepgram model training.
- Make dictation sharing upload, and make withdrawal reach every copy.
- Make circle to ask work end to end on the frontend.

## [0.15.15] - 2026-09-12
- Add the native half of the circle-to-ask region gesture.
- Give the voice recovery card connecting, error and mic variants.
- Show meeting insights and transcript side by side.

## [0.15.14] - 2026-09-11
- Improve Buddy voice startup recovery.
- Redesign the meeting prompt and stop notification replays on sign-in.

## [0.15.13] - 2026-09-11
- Rebuild of 0.15.12 with no code change.

## [0.15.12] - 2026-09-11
- Let Interview Companion start even when call detection misses.

## [0.15.11] - 2026-09-10
- Make Interview Companion's Brief widget switchable, not a dead end.
- Smooth Interview Companion answer streaming and recenter the scroll button.
- Coalesce the toast flood when draining a large notification backlog.
- Drop the update dialog glyph and restyle the disconnect confirm to match it.

## [0.15.10] - 2026-09-09
- Make the Screen Sight shortcut actually stop per-turn screen capture.

## [0.15.9] - 2026-09-08
- Slow the Help sidebar roll to four seconds per word.
- Re-mint the dictation credential on demand instead of failing the first hold after sleep.

## [0.15.8] - 2026-09-08
- Add beta analytics and observability across every window.
- Route dictation into the chat composer and stop dev/installed toggle fights.

## [0.15.7] - 2026-09-07
- Ask for Screen Recording when Screen Sight is first armed.
- Point Join Discord at the server invite from the website.
- Roll the sidebar Help entry between Get help and Join Discord.
- Fold Conversations, Drafts and Saved into one History page.

## [0.15.6] - 2026-09-07
- Keep launch at login pointed at the installed app.
- Keep the chat open when dictating into its composer.
- Track end-to-end turn latency in chat sessions.

## [0.15.5] - 2026-09-07
- Move the update prompt into a centered dialog.
- Run Interview Companion on macOS.
- Open the tray menu on a plain click.

## [0.15.4] - 2026-09-07
- Stop dictation feeling slow at both ends of a hold.
- Clean up the research detail view.

## [0.15.3] - 2026-09-07
- Migrate pre-share dictation history databases and give playback a solid stop icon.
- Center connector and paywall dialogs, fix their glass styling, left-align the top bar title.

## [0.15.2] - 2026-09-07
- Redo the research brief detail view.
- Show a glass dialog when a free plan blocks deep research.
- Keep the backend's refusal code when a research request fails.
- Clean up the Research composer and library rows.

## [0.15.1] - 2026-09-06
- Play dictation clips on macOS by handing the webview a WAV.
- Get the dictation row menu out from behind the rows.
- Stop one abandoned OAuth tab freezing the whole connectors page.
- Say what Notion actually shares before the picker confuses someone.
- Fit all three interview tabs on one line and measure the pill.

## Earlier releases

Tags from v0.1.x to v0.15.0 predate this file. `git log vA..vB` between two tags
lists what each one shipped.
