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

### Changed

- Home is now a launchpad instead of a welcome banner. Start a voice call, open chat, dictate, or jump to Meetings, Research and Swarm from one row of tiles, each showing its shortcut. A Needs you list shows posts waiting for your OK (approve them right there) and this week's meeting action items. Up next lists your calendar with a Join button when a call is about to start, and Jump back in opens your latest conversation, draft, saved item and meeting directly. The weekly stats are now one line at the bottom that opens Insights.
- Links from Home now open the exact conversation, draft or meeting instead of just the page it lives on.
- Home and the sidebar are calmer. Nothing moves unless you point at it: the Beta tags no longer flash, Get help no longer flips to Join Discord, and menu items no longer jump on hover. Text uses fewer sizes, every list on Home has the same simple row layout, and the shortcut for each action shows when you hover its tile.
- The Daily briefing setting is gone, since Home now shows that information. "Calendar in briefing" is now "Calendar on Home".

## [0.17.1] - 2026-10-09

### Fixed

- Selecting text in the chat card now copies it right away, no Ctrl+C needed. Ctrl+C works there too now. Before, the selection showed up but the copy went to whatever app you were in before.
- Tagging a manager with @ in the Swarm message box no longer turns the rest of your message into a doubled, smeared blur, and the cursor stays where you are typing.
- Swarm no longer stutters after you paste an image into a message, and the message box grows once instead of twice while the image loads.
- Pressing Stop on a #group round no longer briefly flips back to running.
- An @name in a Swarm message is only highlighted when that manager will actually get the message, so "foo@Sam" or a fifth name no longer looks addressed.
- Attaching more than 5 files to a Swarm message now tells you so, instead of quietly leaving the extras out.
- Long Swarm channels stay fast: only the messages near what you are reading are drawn, so months of history no longer slow the page down.
- While a manager is working, Swarm no longer refetches and redraws the whole conversation every few seconds when nothing has changed.

### Changed

- A Swarm manager's memory now shows how old each item is the same way the rest of the dashboard does ("3h ago", "2d ago", then the date).

## [0.17.0] - 2026-10-08

### Changed

- The live Interview Companion has moved out of Aura into its own app, SideKick. The tray item, its card and card keys, the "Start Interview Companion on its own" and "Keep interview audio" settings, and the Sessions tab on the Interview page are gone. Your prepared interviews, company dossiers, prep rooms and Interview Mode with Buddy are unchanged.
- Ctrl+Alt+S is always Screen Sight again; it no longer turns into a screen send while an interview card is open.

## [0.16.9] - 2026-10-08

### Added

- Swarm managers can ask you a question when the next move is your call, right on their report, and you answer with one tap. A manager can also ask before it starts, when what you asked for could mean two different jobs.

### Changed

- The dashboard opens much larger by default, 1600 by 840 instead of 1000 by 700, so the Agents tabs and long Swarm reports have room without resizing. On a smaller screen it shrinks to fit, so it never opens under the taskbar.
- Swarm managers now follow the conversation in their channel. "Try again" retries what you last asked for, "only these two" narrows it, and "what's wrong?" gets a straight answer about the last run instead of starting a new search.
- Swarm managers read much deeper: up to 20 steps per task, the parts of a page or file that match what they are looking for instead of only its first lines, and a code search that finds a feature in your repository by what it does. Web research now always finishes before a manager opens your accounts, so it no longer loses web search halfway through.
- Swarm managers no longer start separate Research runs; they do that reading themselves and put it in their own report.
- The Swarm tab has a cleaner design. While a manager works you now see each step land as it happens (what it searched or read, how long it took, how many sources it added), with what it is doing right now at the bottom, and the steps fold into one line like "Searched 6 sources and read 2 pages in 1.2 min" when it finishes. Cards are frosted glass over a soft colour field, in light and dark. Reports lead with the answer, show each source's site next to the claim it backs, and put drafts that need your approval in their own card. Public posts are marked so they never look like a private calendar hold. Manager messages show bold text, lists and links properly.
- The Team panel opens again from the Team button in the Swarm header, and a status pill there shows how many managers are working or waiting on you. Managers waiting on an answer are marked "Needs you" in the channel list.

### Fixed

- A Swarm report that did its job no longer says "It kept finding the same things, so it stopped" because one part repeated a step, and a manager no longer says it "could not read" something just because it asked for the same thing twice.
- When a Swarm run fails because of a problem on Aura's side (a model provider out of credit or rejecting a request), the report now says so instead of "The model it uses was unavailable", and it no longer tells you to try again when that would not help.

## [0.16.8] - 2026-10-07

### Added
- While the Interview Companion card is open, Ctrl+Alt with an arrow key (Control+Option on a Mac) moves it a step in that direction, and holding the keys glides it, so you can clear a video tile or your code without reaching for the mouse. The keys go back to your other apps as soon as the card closes.
- More Interview Companion keys, all with Ctrl+Alt held (Control+Option on a Mac) while the card is open: H queues a screenshot so a problem taller than one screen goes out as one question with your next send, Enter is Answer now, B hides or shows the card, and Shift+Up/Down scrolls a long answer, held or tapped. A gear beside Stop lists every key and says if another app has taken one.
- Formulas and derivations in a typed answer are now typeset as math. Prices, code and ordinary text are left alone.

### Changed
- The Interview Companion's Screen switch now starts on, so every question you send carries a fresh look at your screen. While the card is on screen, Ctrl+Alt+S (Control+Option+S on a Mac) works like the Send button, even if you moved Screen Sight to another shortcut: it sends what you typed together with your screen, or just the screen if the box is empty, in which case Aura now solves what it shows instead of describing it back to you. With the card closed it is Screen Sight as before. A screen send now reads the monitor the card is on, not the one your mouse happens to be on.

- Clicking a button on the notch or one of its cards no longer leaves Aura holding the keyboard. On Windows the app you were working in gets its focus back as soon as the click is handled, so your caret and typing carry on where they were. Text fields, open menus and the Interview Companion card keep focus as before, and the setup screen is unchanged. macOS already behaved this way.

- Swarm managers no longer stop at a small per-session limit when reading repo files, issues, emails or attached documents, and a file already read this session is served from memory instead of fetched again. A step served that way says "already read this session". A manager can start up to three Research runs per brief instead of one, and a limit that is hit now names what ran out.

## [0.16.7] - 2026-10-07

### Added
- Swarm managers remember. Each finished run leaves what it learned, which sites it could not read, what you asked for and what it already told you, kept encrypted on this computer and handed to the manager on its next run so it stops repeating itself. Every manager's card has a Memory section where you can read it, forget a row, export it as a file or bring a file back in. A routine that fires while your laptop is closed uses the last memory the app sent.
- Bolt can sit in a corner of your screen. Turn on "Sit on the desktop" in Settings > Companion and he waits there, listens while you dictate, cheers when the words land, and holds up Aura's messages over his head. Drag him to any corner, or pick one on the same page. Click him to hide him for an hour or until tomorrow.

### Changed
- Swarm reads like a chat. A manager's report is plain prose in its message, with findings as bullets and their sources inline, drafts quoted, and the buttons you can act on (Review, Grant, Open) as small links. Its plan and every step fold into one line under the message, "Searched 6 sources, read 2 pages, 1.2 min", that you can open. A question is just a message; reply below to answer it.

### Fixed
- A run that stopped early no longer shows raw page text as its report, and every reason it stopped now has a plain sentence instead of a code like "(unavailable)".

## [0.16.6] - 2026-10-06

### Added
- Buddy has a face. Bolt, a little robot, now appears in chat while Aura is thinking, and in Swarm while Aura decides who owns a message.
- Settings has a new Companion tab where you can pick Buddy's avatar or turn it off and keep the plain dots.
- Swarm managers can watch the web for you. Tell #group something like "every time this project ships a release, check it against my repo and open issues for bugs we share", answer one question, and the manager watches that page, starts work when it changes, and reports what is interesting with options. Each watch shows on the manager's card with when it last looked and what it saw, and a page that keeps failing pauses itself and says why.
- Swarm managers can open GitHub issues in your repository. Each one waits for your review in the report, or, if you switch on "Act without asking" for that repository on the manager's card, it is opened right after the report, up to a daily limit you set.

### Changed
- Swarm reads like a team chat now. Managers and the Supervisor talk to you in first person, like teammates in Slack, instead of narrating how each message was routed. A new manager joins #group and introduces itself, it asks its own setup questions, and replies drop the "Answered" and "New manager" badges.
- Swarm avatars are redesigned. Your messages show your Google photo, each manager's initial sits on a solid tile in its own colour, and the Supervisor has a new hub icon in its own graphite colour, so it no longer looks like Aura.
- Swarm is calm at rest. Only a manager that is actually working shows a pulsing ring, and a paused manager's dot is now a hollow ring, so you can tell it apart without relying on colour.
- Your Swarm messages now sit on the right in a bubble, and the agents' replies keep the full width on the left, so you can see what you asked and what came back at a glance. Agent names read in plain ink with their role beside them, and days are marked with a small label.
- The selected tab on the Agents and History pages is now a white pill instead of a green one, and the notification count is dark instead of green.
- Swarm's jump-to-latest button is now a round arrow with no label.
- The Swarm channel list can fold down to a strip of icons with the small arrow beside "Swarm", giving the conversation more room. It remembers your choice, and hovering an icon names it. The list also lost its green tint and now matches the rest of the page.
- The Swarm channel list no longer carries a "Swarm" heading and logo above the channels. The fold arrow now sits at the bottom of the list, the rule under the channel header is gone, #group no longer repeats who answers it beside its name, and the Team button is gone from the channel header.
- The point-of-contact box at the top of the Swarm channel list (the Supervisor, or whoever answers the front door) is gone. The #group channel and the Team panel already say who answers.
- The Swarm composer now shows who will answer before you send. Manager rows in the rail say "Working" while they are on a task, and the Team panel shows each manager's connectors and routines, a Working chip, and separate Supervisor and Managers sections.

### Fixed
- Swarm no longer pushes the Computer, Research and Swarm tabs half off the top of a smaller window; it now fits the space it has.
- The GitHub pill above the Swarm composer now opens the repository picker in #group as well as in a manager's DM. A repository picked there applies to every active manager that can read GitHub.
- The Swarm composer no longer leaves an empty band below itself; the box now sits a few pixels above the bottom edge, and the privacy note appears only when a file or image is attached.
- The Swarm message list shows a slim scrollbar instead of the Windows one with arrow buttons.
- Swarm is no longer tinted green. Controls, highlights and report cards are neutral, and colour is kept for what each manager is and for anything that needs your attention.
- A Swarm manager's direct message header now uses the same name as the rail.
- Working cards in Swarm no longer show every manager in blue.

## [0.16.5] - 2026-10-05

0.16.4 was built but never published, so its changes ship here too.

### Added
- Saved interview sessions can now be reflected on from the Interview page, including one whose reflection failed or was never asked for after the card closed.
- Interview Mode now asks whether you have the job description, your resume, or notes, and opens one card where you can paste text or drop PDF and Word files. The practice questions are built from all of it, including questions about the projects on your resume.

### Fixed
- Opening Interview Companion while you are already in the call no longer starts it instantly. It now waits ten seconds so you can attach a brief or resume, and pauses while the Brief menu is open or a resume is being read. Start still works straight away.
- An interviewer who talks for several minutes without a break no longer stops the live answers or makes Reflect fail every time.
- When Reflect cannot work for this transcript, it says so instead of asking you to try again.
- Voice calls made in a conversation you already had going now save to your history. Before, a second call in the same thread was silently dropped.
- Interview Mode setup no longer quits when you ask it to hurry up, and no longer promises a first question before it has asked its setup questions.
- Closing the interview card lets setup carry on right away instead of leaving Buddy silent, and a send that fails can be retried from the same card.
- Interview Companion sessions are no longer erased when you sign out or switch accounts.
- Interview preparations, browser agent task history and your recent chat are no longer erased when you sign out or switch accounts either.

## [0.16.3] - 2026-10-03

### Added
- Swarm managers now get a persona name alongside their job title, so the rail, roster and every message read "Snapshot Sam · Langfuse Snapshots" instead of a bare job label.
- Type "@" in #group to pick a manager or the Supervisor from a list; the mention steers the message to them and is highlighted in indigo, both while you type it and in the thread afterwards.
- Asking a busy manager how it is getting on gets a status reply from its live session instead of a refusal.

### Changed
- The "Routing details" expander with its confidence percentage is gone from #group; a routed message shows only who took it and why.
- The selected channel in the Swarm rail now has the same rounded corners as the message box instead of a near-square outline.

### Fixed
- A #group message now leaves the box the moment you send it and shows faintly as "Sending" until it lands; before, your words sat in the composer until the router answered.
- A message routed to a manager that is still working no longer bounces with an error: it waits in line and starts on its own when the current task ends, in #group and in a DM.
- Replying to a manager that asked you a question, in #group or in its channel, now answers it and the manager carries on; before, the reply waited in line behind the very question it answered. A manager that was parked for a while no longer times out the moment you answer.
- A manager no longer stops to ask you for a documentation link, a repository or a file it can look up itself; it searches instead.

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
