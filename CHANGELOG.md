# Changelog

What changed in each release, for people using Kuvo Code. Add changes people would notice under
Unreleased, in plain words about what they'll see, as part of the change itself. Before a
release, Unreleased is renamed to the version; the release notes come from that section.

## Unreleased

- Swiping between computers works in Settings' sidebar too, and Settings › General sets which way a swipe turns them.
- Coding agents on your machines are the machine's own: Kuvo Code uses the Claude Code, Codex and Grok installed there, as its terminal finds them, rather than copies of its own. Install one from Accounts, on your Mac or a machine, and it runs its maker's installer; Update updates one on a machine too. Machines that had Kuvo Code's copies need Install once (your sign-ins stay).
- Update All, at the top of Coding Agents in Accounts, updates every coding agent that's out of date, on your Mac and your machines.
- Group chats answer sooner: a message you write while the lead works out who does what comes first, and bots stay quick in a long chat, as what they looked up along the way no longer weighs on every turn. A bot new to a chat reads all of it, not only the latest messages.
- In a group chat, name a bot that isn't in it with &, and it answers that once, as a guest.
- In a group chat, the line under a bot at work shows what it's thinking as it thinks, and bots name each other with & so the names show as the bots.
- Click a bot's face or name in a group chat to open its conversation, and the title at the top of a group chat or a bot's conversation to edit it.
- A message you steer into a session says At its next step until the agent takes it.
- A new app icon: Kuvo Code's five bots together, each in its own color with a small pair of eyes, on cream in light mode and on black in dark mode.
- A remote machine's engine runs on its own, with its sessions, bots and group chats: quitting Kuvo Code or clicking Disconnect leaves it running, it no longer stops after a day without Kuvo Code, and it starts again by itself if it crashes.
- Stop Engine in Settings › Machines stops a machine's engine until you click Start Engine, through restarts of the machine too.
- Open at login, in Settings › General: Kuvo Code opens in the background when you log in, without its window, so your bots and sessions on this Mac keep working from then on. Its engine also starts with the app now, whether or not the window is open.
- Each computer has its own settings: with machines, Settings' sidebar has a page for each, and a machine's Accounts, Custom Auto, Agents, Permissions, Commands, Skills, Integrations, MCP Servers, Engine and Worktrees are its own, in tabs named for it. Your Mac no longer copies its settings, keys and sign-ins to machines; a new machine starts with a copy, once.
- Also Apply to…: after you change a setting on one computer, a bar at the bottom of the page makes the same change on another computer, or every one, keys included.
- With machines, the sidebar has a page for each computer, with its bots, chats and projects: swipe with two fingers between them, or click a computer's icon at the top of the page, beside its name. It follows the tab you're on, and search covers every computer.
- A machine's sessions, bots and group chats go by that machine's own permissions, not this Mac's.
- The personalities you write for bots are on all your computers: one you make, change or delete on one reaches the others as Kuvo Code connects to them.
- Agents on your machines write to agents on your other machines, and wait for their answers, with your Mac off too: your computers reach each other through Kuvo Code's relay.
- A machine another Mac set up with a newer Kuvo Code is used as it is, rather than taken back to older versions.
- A Mac with an older Kuvo Code can still use a machine a newer one set up: the machine keeps its own tools, keeps running by itself, and goes back to its own settings once nothing runs there.
- Each machine keeps Kuvo Code up to date by itself: at night, while nothing runs there, a few days after a release, going back to what it had if the new version doesn't start. Turn it off, or update now, on the machine's Engine page in Settings.

## 0.7.2

- Edit Bot shows the model a bot really talks on: when the one picked for it belongs to an account you've signed out of, its conversation's model, rather than "Choose a Model".
- With Claude Code in Build, a plan it makes on its own for a big task no longer leaves it stuck planning: it carries on building once its plan is done.
- With Claude Code in Plan mode under Ask First, it writes its plan again; asking first about its plan file had it refused.
- A bot in a group chat talks on the model its own conversation is on when the one picked for it belongs to an account you've signed out of (Edit Bot shows no model for it then), rather than saying it needs a sign-in for a model you aren't using.
- Ask the agent for a screenshot of the page it's browsing and it shows in the conversation, not only inside its browser step.
- With Cursor, a subagent still at work when you press Stop shows as stopped in its session, rather than finished, and how full the context is no longer counts Cursor's thinking twice.
- With Codex, a file it creates or deletes shows its lines in the conversation and on its permission card, rather than +0 and the file's bare text, and a turn's token count includes every step, not only those just before its words.
- With Grok and Antigravity, what a session has cost counts each turn once, rather than adding up the agent's running total every time it reports it, and pressing Stop while it waits on a permission shows that step as stopped, not declined.

## 0.7.1

- A message to a conversation or a bot whose model you're no longer signed in to says so right away, naming the account to sign in to, and stays in the composer, rather than going unanswered without a word. In a group chat, that bot says so and the others carry on, on your Mac or on a machine.
- When a model's provider turns a message down because it isn't signed in, a bot in a group chat or a conversation says which account to sign in to again, and where, rather than the provider's own words, like "Missing required Authorization header".
- A bot's reply that names another agent with &, like &Finance, shows its face and colored name, as your own messages do, in conversations and in the cards for messages between agents.
- An agent can put a file in the conversation for you to see, like a chart it made or a PDF it found: a picture shows large, and any other file as a card that opens it in the side panel.
- In a composer, Backspace right after an agent you named with &, like &Finance, removes the whole name at once.
- A loader beside text, like a message card's "Waiting for its answer", sits in line with the words rather than below them.

## 0.7.0

- A sign-in whose page turned it down, or that the service couldn't finish, says so in words, rather than with the code the page sent back (like `access_denied`).
- **Get beta updates** in Settings › General: turn it on to get new versions to try before they're released, through the same updates. Turned off, you keep the beta you have until the next release.
- A project can use a terminal instead of the chat: in Edit Project, **Terminal Instead of Chat** takes a command (`omp`, `claude`, `codex`, `opencode`, `pi`…, with any flags: `claude --continue`), with the common ones a click away, and each new session in that project opens a terminal tab in the main area running it. **New Terminal Tab** (⌃⇧`, or ⌘K) opens a plain shell there for any project. The project's terminals are listed under it in the sidebar, and its menu has **New Conversation** to start a conversation anyway. Closing a tab, or the window, ends the shell; terminal tabs aren't kept when the app quits.
- A change to Settings › Permissions' rules made outside that page, like in the engine's settings file, applies to conversations that are already open, not only to new ones.
- In a group chat, the bot that's talking shows what it's doing under its name, like the file it's reading or the line it's thinking, so a long turn doesn't look stuck.
- A conversation no longer goes blank when a long reply comes in; it used to show nothing until you scrolled.
- The list that opens over the composer as you type /, @ or & no longer shows a dark block behind it.
- Bots in a group chat answer small talk and quick questions straight away, and look things up (files, the web, other conversations) only when what's asked needs it.
- An agent you name with & reads that conversation or writes to it only when what you ask needs it; a name that just comes up in your message stays a mention.
- In a group chat you name a bot with &, as you name agents everywhere else; @ is only for files. Replying to a bot or clicking its face writes &Name.
- A Markdown file's rendered view in Files draws Mermaid diagrams from `mermaid` code blocks, like flowcharts, Gantt charts and sequence diagrams, in light or dark, offline. A button shows a diagram's code, and one Mermaid can't read shows as code with what's wrong.
- The context ring of a Cursor session counts the last request Cursor reports, rather than all of a reply's requests added up.
- The first launch after an update that changes how your things are kept backs up your lists and settings first, then brings them up to date, while the window says Updating. Each bot's name, look and job are now also kept in its own folder, on this Mac or its machine.
- A remote machine that restarts starts Kuvo Code's engine again by itself, as your Mac last started it, with its bots' wake-ups and your integrations' keys, so it carries on without your Mac. It keeps those keys between starts (only you can read them), and a line in your crontab there does the starting; removing the machine takes it out.
- Move to Computer, in a bot's or a chat's right-click menu, moves it to this Mac or another of your machines, like one you just set up, with its conversation, memory, files and wake-ups; it carries on there. What you send it while it moves waits in the composer. What it leaves behind goes to the trash where it was, with a copy of its conversation. Bots that work in a project or with a coding agent stay where they are.
- A group chat whose bots all live on the same machine can move there with Move to Computer, and keeps talking, holding its meetings and handing out work there while your Mac is off. A chat whose bots live on different computers stays on your Mac.

## 0.6.6

- Undo in a Claude Code, Codex or other coding agent's session works right after its turn ends or after Kuvo Code opens again; for a moment it said "Stop the agent first" while nothing was working.
- Text on the window's cards (conversations, the side panel, Settings) is crisp in light mode: it was drawn see-through over the window's glass, which turned black a washed-out gray. The sidebar keeps the glass look.
- Buttons and menus in Settings are readable again: 0.6.5 drew them pale behind white labels. Text areas in Settings (commit instructions, an agent's instructions) are the group itself, without a box inside it.
- Settings › Accounts uses the same quiet gray groups as the other pages, rather than a yellowish one.

## 0.6.5

- Settings › Permissions says what Default comes to, like "Default (Allow)" or "Default (Ask First)", and an agent's own permissions show what Settings › Permissions has for it.
- Settings reads more easily: brighter descriptions, the first sentence of each skill (all of it on hover) and a search field for skills, one-line fields you can see, a site count on Website Data, "Add Another" for a second account, "Added" beside integrations that need nothing, and MCP Servers sends you to Integrations for servers kept there. The sidebar scrolls to the page that's open.
- Settings fits a narrow window: a row's control goes under its title rather than squeezing it, and no page pushes the sidebar out of the window.
- The space around the cards moves the window, at the top, sides and bottom, and a double-click there does what a title bar's does. Settings' sidebar can be resized, like the sessions' sidebar, and keeps the same width.
- The tab bar is off when you start: the window's cards reach the top, and you switch sessions in the sidebar or with ⌘K. Turn it on in View › Show Tab Bar or Settings › General. Without it, Settings shows one page at a time.
- Settings has a cleaner look: a wider column, even spacing between sections, quieter groups with separators, text fields you can see, and shorter descriptions (the details are in tooltips). Its sidebar is grouped as Application, Models & Providers, Agents & Tools, Projects, Side Panel, and Privacy & Data.
- Settings › Storage counts the coding agents Kuvo Code installed, under a kind of their own, and your bots' and chats' folders: its total left them out, often the biggest part.
- A session on a machine keeps its Claude Code, Codex or Custom Auto model while the machine's coding agents start, after it connects or reconnects, rather than a new one starting on another model or an open one saying to choose one. Settings › Custom Auto no longer says an agent's models aren't signed in while the agents start.
- Set Up Custom Auto in a machine's session opens that machine's lists, not this Mac's.
- A bot whose memory writes its job in the heading ("## Job: Keeps CI green") shows that job under its name and knows it; with nothing written under such a heading, it asked you for its job again.
- A group chat open in the window while you're in another app no longer marks itself read, which took away the notifications of what was said; it waits for you, as a session does.
- A session you switch to a coding agent's model keeps its side panel: its pages, terminals and files go with it to the new session, and its agent goes on in the page it was using, rather than staying behind the archived one.
- With two sessions side by side, Add to Message and Add Screenshot to Message from the panel go to the session you're working in, the one beside once you've clicked into it, rather than the other; the panel stays that session's.
- A group chat's panel browser doesn't offer Add Screenshot to Message, which did nothing there: a group chat's messages are words only.
- The number on the Dock counts a session once while its subagents ask you something, rather than once for each subagent.
- While the coding agents start, the composer's chip shows the session's Claude Code, Codex or Custom Auto model as it is, rather than the engine's default as if that were the one in use.
- A file's path typed in the panel browser's address field ("/Users/you/site/index.html", "~/report.html") opens the file; it went to a web address made of the path.
- Setting up the coding agents no longer leaves a few hundred megabytes of downloads behind on your Mac (on first launch, a build of Claude's that isn't used); what an earlier version kept goes the next time Kuvo Code starts.
- Settings › Commands lists Claude Code's commands kept in folders of ~/.claude/commands too (/frontend:component there comes over as frontend-component); only those at its top showed.
- Selecting in a conversation works as one selection again: it stays when you let go, whichever way you drag, looks the same in every reply and step it takes in, and Add to Chat and Copy show over it, for a double-clicked word or a triple-clicked paragraph too.
- In a session that asks before reading files outside its folder, the agent's browser no longer attaches such a file to a website's upload without asking first, on this Mac and on machines; it said so for opening one, but uploads went through.
- The context ring of a Claude Code session counts against the window Claude Code gives the model on your plan, 1M tokens for Opus 5.5, rather than 200K for every model it didn't call 1M, which showed a long session full ("218K / 200K") with most of its room left.
- The context ring of a Grok or Antigravity session counts against the window the agent says its model has, once it has answered, rather than 256K for every Grok model and 1M for every Antigravity one.
- The context ring of a model whose provider takes less than its whole window in one request (OpenAI's GPT-5 models take 272K of 400K, and most of GitHub Copilot's take less too) counts against what it takes: the conversation was summarized while the ring still showed room left.

## 0.6.4

- A message you'd sent for the agent's next step that was still waiting when Kuvo Code quit shows under Paused when you open the session again, first in line, and Resume sends it. It showed as sending for ever, and Resume went past it to the queue.
- When Grok looks through its tools for one, the step reads "Looked for a tool" with what it looked for, rather than its words run together as a tool's name.
- Clearing the panel browser's history no longer leaves the icon of a site you'd just visited behind, kept if it was still loading as you cleared.
- A machine you reach at two addresses, like its name on your local network and over Tailscale, is one machine. Adding it again at its other address, or having added both before, makes the second one of the first's addresses, rather than a second machine that set everything up again, listed every session twice, and on removal would have signed out and stopped what the first still used. Kuvo Code uses whichever address answers. Right-click it in Settings › Machines to stop using an address, or, when one of the two can't be reached to tell, to say they're the same computer.
- Signing in on a machine's browser (to connect an integration, or when an agent asks) no longer freezes when a site asks for a passkey: the site, or a frame of another site in its page like a sign-in button, hears there's none here and offers its other ways, such as "Try another way". Chrome's passkey prompt, which the live view couldn't show, held the page still. The panel's browser on your Mac refuses passkeys the same way, however a site asks.
- Modes, permission rules and other settings you change reach your connected machines too, not only the next time they connect: a machine's engine starts over with them once nothing is running there. A mode you added showed up only on this Mac.
- Custom Auto's lists are each place's own: this Mac and each machine have their own, made from the models each has, picked at the top of Settings › Custom Auto. A machine's lists were a copy of this Mac's, with models it might not have, and changing them there changed this Mac's.
- Undoing a message that waited in the queue, then sending, keeps the agent's reply from before it for good; in 0.6.3 it still went a moment later, as the engine confirmed the undo.
- Searching the sidebar for words like "read" or "asked" no longer lists nearly every session: Kuvo Code's own wording for the agent's steps ("Read …", "Asked you a question") isn't searched, only what a step worked on, like its file or command.
- Removing a machine closes the tabs of its bots, which stayed open waiting for it.
- A session shows working when Kuvo Code opens while a subagent of one of its subagents is still at work, not only one of its own.
- Starting a bot from a shared one whose job and details are on the same line keeps the details in its first message; only the job's own sentence is left out, as it's said first.
- A session archived with Kuvo Code 0.6.2 or earlier gets its wake-ups back when you bring it back; they stayed paused, as if you'd paused them.
- Redo after typing between two undos keeps what you typed and nothing else: the message the first undo put in the composer, which Redo brings back to the conversation, no longer stays there to be sent twice.
- Sessions and bots on Cursor have Kuvo Code's own tools (send_message, the panel's browser, show_in_panel), and a message Grok sends another session shows what it said and to whom. 0.6.3 said so, but its copy of the coding agents' bridge was built before these fixes.

## 0.6.3

- Switching an MCP server between running on this Mac and on the web no longer writes a half-typed environment variable or header into the other kind.
- An MCP server's command keeps a backslash inside double quotes, as a shell does ("a\.b" stays a\.b).
- Signing in on a machine that can't be reached says so, rather than that something on your Mac is using the sign-in's port.
- A machine whose engine another Mac of yours started is used with that Mac's accounts, as it says; this Mac's keys no longer go into it (where they'd stay after you removed the machine).
- Removing a connected machine signs its coding agents out there too, as it said it would; their sign-ins stayed when the machine was connected.
- Connecting to a machine after an update of Kuvo Code no longer stops a session still working there to update its engine; the update waits until nothing runs.
- A new password typed in a sign-in card for a saved account is saved in its place; agents allowed to sign in on their own kept using the old one. Allowing them with a password filled in from Passwords asks for Touch ID, as it should.
- Turning notifications on in System Settings after saying no works without restarting Kuvo Code.
- A message Grok sends another session shows what it said and to whom, and opens; it showed only "To another agent" and couldn't be opened. Grok's use of Kuvo Code's other tools (the panel, its browser) shows what it asked for too.
- A summary of the conversation that failed says so ("Couldn't summarize the conversation"); it read "Summarized the conversation to save space", and could turn an earlier summary into a failed one.
- A project folder that a git repository around it ignores (such as one under a dotfiles repository at your home folder) lists its files in the panel and for @ mentions; the list was empty.
- Opening a bot whose machine isn't connected shows that it's waiting for the machine, with Connect Now, under the bot's name. A bot on a machine whose sessions hadn't been listed on this Mac yet showed the welcome screen.
- Sessions and bots running on Cursor have Kuvo Code's own tools, as the other coding agents do: they can answer another session with send_message, use the panel's browser and show things in the panel. A bot on Cursor asked by another session went looking for send_message in your files.
- Archiving a session the engine couldn't archive just then leaves it where it was, with its wake-ups running; it looked archived, came back on its own later, and its wake-ups stayed held.
- A session moved to a coding agent's model takes its wake-ups and watches along; they stayed with the old session in Archived, held there.
- A wake-up an agent sets after its session was archived waits until you bring the session back, as the ones it had already do.
- Redo after undoing twice keeps what you typed in the composer between the two undos; it used to put the composer back as it was before the first undo, and what you'd typed was lost.
- In the Changes tab, files whose names have quotes, a backslash or a tab in them, or a folder named like "Plan b", are listed by their real paths, and Discard and Stage work on them. Some were listed under another file's name, and Discard could act on that file instead.
- Discarding a deleted file whose folder has since been replaced by a file of the same name moves that file to the Trash. It used to be deleted for good.
- Unstage works in a repository with no commits yet; it said git couldn't restore the file.
- In the Changes tab of a folder that isn't a git repository, or of a project on a machine, a file the agent edited more than once no longer shows lines like "--- a/notes.md" among its changes, and its counts match what it shows.
- When merging a worktree back would conflict, the files are named as they are; a name with accented letters or quotes showed as escaped codes ("caf\303\251.txt").
- Searching the sidebar for words like "you" or "agent" no longer lists every session under In Conversations; it finds only conversations where they were said.
- Switching to another session in the same folder with the Changes tab open shows that session's changes under This Session (and outside git); within a few seconds it went back to showing the first session's. A comment half written on a line stays with the session it was written in.
- Undoing a message that waited in the queue, then sending, no longer takes away the agent's reply from before it (until the conversation was read again); only the message and what came after it go.
- The Now button on a session's wake-up sends it once: clicked again while it was on its way, the agent got it twice.
- Wake-ups you paused stay paused when you archive the session and bring it back; bringing it back resumed them.
- A bot imported from a .kuvobot file says its job once in its first message; the job's line was there twice.
- A session whose subagent was still working when Kuvo Code opened (or a machine reconnected), one sent off in the background, shows as working in the sidebar, its tab and its bot; it showed as done.
- A bot on a machine that runs with a coding agent (or Custom Auto) gets its wake-ups and watches while your Mac is off; they were sent to the engine, which doesn't have its conversation, and never arrived.
## 0.6.2

- A worktree's branch named after a title in another language keeps its letters ("Giriş düzeltmesi" is giris-duzeltmesi, not giri-dzeltmesi).
- A model or mode changed elsewhere (a bot's editor, your phone, another Mac) shows in a conversation you have open, and picking the one before works again.
- Try Again sends a message's files again when they were sent inline (to a machine, or from your phone); they used to be dropped.
- A session deleted while it worked no longer counts as working, which kept the Mac awake, and its notifications go with it.
- A message for a coding agent on a machine that couldn't go as the machine connected (its agents still starting) goes within a minute, rather than at the machine's next connection.
- Editing a bot while a personality it used was changed or removed no longer undoes your edit.
- A bot's job keeps all of its section in its memory, its own sub-headings and code included; it used to stop at the first line starting with #. A job written in Edit Bot by an older version is no longer lost when the bot's memory has an empty Job heading.
- In a group chat, a bot's message that only starts with "Pass" ("Pass rate is 98% on main.") is no longer taken as passing its turn and left out.
- Closing the window with a machine's conversation in view no longer leaves two start tabs in its panel.
- A message with comments on the changes that didn't go, or was on its way when Kuvo Code quit, comes back to its composer with its comments.
- Notifications hide AWS access key IDs (AKIA…) too, and no longer hide names that only start like a key (npm_config_…), which also took their answer buttons away.

## 0.6.1

- Requests to a model whose sign-in ran out and couldn't be renewed (shown only as "Request failed: 400") now say so, with Sign In Again, and Accounts and the sidebar mark that account.
- Sign-ins that renew themselves with a new token each time (an older ChatGPT sign-in, GitLab Duo) are no longer copied to your machines, where two copies ended the sign-in everywhere; each machine signs in to its plans on its own, in Accounts with the machine picked. Copies made before are taken off the machines. API keys and GitHub Copilot still go to all of them.

## 0.6.0

- With Find open, Esc closes it first; press Esc again to stop the agent.
- Get Skills lists each skill of a repository once, not again for copies it keeps for other tools.
- With a coding agent, a message you send again after undoing one no longer vanishes from the conversation.
- Find marks every place it finds, also while a reply is being written, and the conversation's first message no longer sits under its bar.
- Esc stops the agent even when the composer doesn't have the keyboard.
- Coding agents keep to Settings › Permissions' "Work outside the project": with Ask First they ask before reading or changing files outside it, and Don't Allow there holds for them. Answering Always to Codex, Grok or Antigravity is kept by Kuvo Code for the conversation, so your rules still hold for what comes after. If Antigravity can't be set to ask first, its turn stops instead of going on without asking.
- Sign-in pages that ask for a passkey no longer get stuck in the browser, on your Mac or a machine: passkeys can't be used there yet, so the site offers its other ways, like your password.
- The usage item in the menu bar is compact (Bars) by default; a style you picked stays.
- The green button now makes the window fill the screen, keeping its look, instead of going full screen, where the title bar showed as a gray band. Tabs in the title bar no longer flicker while you make the window narrower.
- Find in a conversation goes straight to each place, in the middle of the view, instead of jumping back and forth.
- Expanding a big search's output with context lines no longer freezes the window for a few seconds.
- The coding agents (Claude Code, Codex, Cursor, Grok, Antigravity) can use the skills in Settings › Skills, including ones you add there or from other folders and catalogs, except the ones you switch off. On a machine, they get that machine's skills.
- In dark mode, the sidebar stays dark and easy to read when a bright window is behind Kuvo Code.
- Settings › Skills no longer shows the folder each skill is in; hover over one to see it.
- Settings › Accounts splits Coding Agents from Plans. A menu next to Coding Agents picks This Mac or one of your machines, to see that machine's agents and sign in to each there (each machine signs in on its own); plans and API keys stay as they are, since your machines get them too. A conversation on a machine that needs a sign-in says which machine, with Sign In on it. Signing in on a machine says it's installing the agent there first.
- With Ask First, Grok and Antigravity ask before using Kuvo Code's tools that should ask, and before anything else they ask about that Kuvo Code can't tell the kind of.
- In Ask First, an agent's watch asks you first with its check written out, also in older sessions and with the coding agents; a wake-up a coding agent's session set on a machine is no longer lost.
- When no model in a Custom Auto list can run, the conversation says why: which agents aren't signed in (on your Mac or on the machine), with a button to sign in, or which limits hold and when each resets, in your time zone.
- The coding agents work on your machines too: Claude Code, Codex, Cursor, Grok, Antigravity and Custom Auto can run sessions, chats, bots and group chat seats in a machine's projects. Sign in to each on the machine in Settings › Accounts, with the machine picked next to Coding Agents; the sign-in finishes in your Mac's browser, and your Custom Auto lists come along.
- Custom Auto goes on with the next model when one stops with an error, not only at a usage limit, and skips an account whose sign-in ended until you sign in again. Antigravity's "usage limit reached" answer counts as its limit, with the reset time it gives.
- An account at its usage limit or whose sign-in ended is marked in Settings › Accounts and on the accounts row at the bottom of the sidebar.
- Antigravity renews its own sign-in when its access runs out partway through a task and carries on, instead of asking you to sign in again.
- Wake-ups are set with Kuvo Code's own tools now, for sessions and bots alike: in Ask First, a command that only looked like a wake-up can no longer write a file without asking; a subagent's wake-up wakes the conversation that started it; one for a conversation that's gone is put away rather than tried for ever; and an agent's tab stays while its conversation works or waits for you.
- A browser tab an agent opened that you never looked at closes itself an hour after an agent last used it, on your Mac and on a machine, so sessions and bots browsing out of sight don't pile up pages that stay loaded; one you looked at stays. Settings › Panel can turn this off.
- The usage item in the menu bar shows the plans of the coding agents you're signed in to (Claude Code, Codex, Grok, Cursor, Antigravity), instead of asking you to connect an account.
- A long message in the composer, like a big paste, scrolls with the trackpad or mouse wheel.
- Changes shows a huge or minified new file as too big to show instead of slowing the panel down, and This Session lists every edit an agent made on a machine after writing a file.
- A subagent's messages to other agents, and sessions it starts, go as its conversation's, with its approval: Ask First holds for them too. Waiting for an agent's answer stops when you stop the session, and the answer is what it said to the message.
- A bot's open tab stays open when its conversation moves to a coding agent, and models from your coding agents no longer show as unavailable for a moment after launch.
- Dragging a selection past the top or bottom of a conversation selects as it scrolls, instead of jumping to the first or last message.
- In group chats, a bot named in another bot's reply keeps its color.
- Sessions and chats can wake themselves up, as bots do: ask the agent to check back in 20 minutes or to tell you when a build finishes, and it comes back in the same conversation, even while you're away (on a machine, with your Mac off). A bar over the composer shows when, with Now and Cancel.
- Removing an integration also takes back the keys bots had of their own for it.
- Notifications keep their buttons for commit hashes in image tags, release names and checksums, and hide keys written as ENV['…'] =, := or =>, and names like SECRET_KEY_BASE.
- Settings › MCP Servers no longer lists integrations, which have their own page; Permissions keeps a pattern you typed when you change its rule's kind or effect.
- A worktree's branch prefix with a stray space or character no longer stops worktree sessions from starting.
- Mentions stand out in your messages everywhere: files you name with @ (a click opens them in the panel) and bots or sessions you name with &, in sent, sending and waiting messages, and in bots' messages in group chats. A bot you name shows with its face and a session with a conversation mark, in place of the &, already as you type it, and the pointer turns to a hand over them.
- Type & in any message, a group chat's too, to name one of your bots or sessions, like &Mira: the agent knows which one you mean, and the name shows in bold (a bot's in its color) and opens that conversation. Agents can now read each other's conversations, not only write to each other.
- Settings › Permissions › Always Allowed lists approvals you saved in sessions on your machines too, and removes them there.
- Notifications hide a hex value after any name that isn't a hash's (AESKey, SECRETKEY, SIGNATURE…), and show commit hashes, checksums and cache keys.
- A permission card for a huge new file shows its first 400 lines with Show All, instead of holding the window up.
- A new skill can't overwrite one already there, a Claude Code command named like one of the engine's comes over with -claude, and New Agent and New Command say when the settings file can't be changed rather than losing what you write.
- Canceling Add a Machine while it connects no longer adds the machine (and copies your accounts to it) a moment later.
- Notifications hide keys given with flags like --apiKey or --db_password again.
- A permission card shows each file's changes in full, and deleting a bot can't close an editor you opened meanwhile.
- A permission card shows everything Allow allows: every file's changes and the whole command, scrolling when long.
- A bot's conversation found by searching has the bot's menu, so it can't be deleted or archived away from its bot by mistake.
- Notifications hide a hex key after any key's name again (except a cache key's), and show flags like --password-stdin or --secret-id with their buttons.
- The bar of background commands shows the latest of a progress line that redraws itself, instead of "Nothing printed yet."
- Auto is now **Custom Auto**, with as many lists of models as you like (one for bugfixes, one for features), each picked by name in the model picker, which shows a list's models in full and lets you edit the one under the pointer. A session on it shows which model is at work, and the context gauge shows that model's window. A reply you stopped has Copy and Reply under it too.
- When this Mac's engine stops for good, its sessions' pending questions and background commands go too; messages agents send at once count toward their limit together.
- Notifications hide keys given with flags like --private-key or --client-secret, and Authorization: Token token="…".
- Moving Kuvo Code to Applications keeps the copy there until the new one is in place, and Settings' preview tab stays the same tab after a relaunch.
- Bots on this Mac can use any model, the coding agents' and Auto included; picking one for an existing bot carries its conversation over, as for a session. Blocks catch more commands hidden in a command line, and ask about a line they can't read through. Undo puts back a file the agent moved or copied, and keeps files your ignore rules left out.
- Notifications hide a hex key after a key's or secret's name however it's written (quoted, in YAML or JSON), and show checksums and cache keys.
- When this Mac's engine stops for good, its sessions no longer show as working or keep the Mac awake.
- Cursor sessions work when they don't approve everything, instead of failing with "sandboxing is not supported in this environment". You can pick thinking effort for every Cursor and Grok model that has it. When your settings (a mode, the session's agent, Permissions) don't allow a tool, Grok and Antigravity carry on without it instead of stopping the turn.
- Kuvo Code no longer crashes when it shows a conversation in which drawing a widget failed; the failed step shows instead.
- Notifications hide a hex key after a name again (like ENCRYPTION_KEY=…), and show short --key values, like sort --key 2,3.
- Colored search output highlights patterns with | or ) in them, and skips searches that could slow the conversation down.
- Chrome DevTools from the MCP catalog runs a fixed version (a newer one you set stays), only on this Mac, with a browser profile of its own that goes when it closes, no update checks and no usage statistics sent to Google, so it leaves nothing in your home folder; files it saves land in the project.
- Waiting for another agent's answer finds it also on a machine whose clock differs from your Mac's.
- Blocks in Settings › Permissions catch more of what a command line hides from them in sessions with coding agents (`sudo -n`, `/bin/rm`, `"rm"`, `eval`, `xargs`, `find -exec` and others). When a coding agent carries on by itself twice in a row, both show, and a message you sent meanwhile still goes.
- A widget or Show in Panel from Antigravity works as it happens, not only after the conversation is opened again.
- Coding agents: Antigravity's subagents no longer show up again with each turn, and an image it makes is never mixed up with one you attached. Codex's agents in the background keep working after the turn, and what they ask stays yours to answer. Stop reaches a subagent that works in the background. A widget or panel tool an agent calls first thing works. Sessions on Antigravity, Cursor or Grok get a real title, written by another coding agent you're signed in to. Undo keeps a file you already had when ignore rules outside the session's folder changed.
- A session with a coding agent that can't write titles (Antigravity) gets one from your default model, instead of the start of your first message, when that model can write one.
- A session an agent starts on its own asks first when the agent's session does, and its answer is found reliably also on a machine whose clock differs.
- Discard leaves a submodule's folder alone again; Merge and Pull Request count the new files the Changes panel lists; and This Session shows a file the agent wrote and then edited once.
- Notifications hide a number after a password or Authorization again, show commit hashes in commands, and stay quick on very long text.
- Bring Over copies files opencode's settings name into Kuvo Code's own folder (so they keep working, also on machines), brings API keys and skills even when opencode's settings can't be read, and brings a server named like one of your integrations under a name of its own.
- The New Project popup keeps what you typed when a shortcut or a notification would open something else, and a file Kuvo Code sets aside because it couldn't read it no longer replaces one set aside before.
- Shift-Return or Option-Return in your answer to a quote starts a new line instead of sending, and an image an agent made shows large also with Each Step and in group chats.
- Antigravity's file reads show as done once they're done (with what was read), instead of "Reading…" until its turn ends. Undo never takes back edits you made while Kuvo Code was closed, and a coding agent carrying on by itself while you undo no longer makes the undo final.
- A command's output in the conversation is colored as a terminal shows it: a search's files, line numbers and what it found, a diff's added and removed lines, and errors and warnings.
- Discarding in Changes moves a folder that took a file's place (a repository cloned there, or new files) to the Trash before the file comes back, instead of git deleting it for good; and a changed file too big to show says so instead of looking unchanged.
- Merge and Pull Request no longer ask you to commit files git is set to hide; removing a worktree still counts them.
- Notifications hide more kinds of keys (DigitalOcean, Supabase, Pulumi, Groq, xAI, Hugging Face and others, and a token in an address), and show migration file names, temporary folders, `docker -u` and `mysql -P` in full.
- Bring Over keeps opencode's `{env:…}` and `{file:…}` references as written instead of empty values or a file's contents, says when it can't read opencode's settings, and brings an MCP server that shares a name with one of Kuvo Code's integrations under a name of its own.
- @ mentions and the file filter list the right paths in a project outside git that's in a linked folder, like `/tmp` or a cloud drive.
- New Project and Edit Project open in a popup over the window again, instead of taking the place of the conversation.
- Dragging or clicking around in a widget no longer shows Add to Chat and Copy as if you'd selected text; selecting a widget's text still does.
- Discarding a new file in Changes that was staged and then edited again no longer leaves it to be committed; discarding a moved file puts the old one back also in Unstaged; a file that became a link comes back as it was; and the dialog says when a folder with its own repository goes to the Trash.
- Removing a worktree asks first when it has new files, also when git is set to hide them.
- Notifications show paths and names like `web3Provider` in full again, and one that hides something as dots has no answer buttons.
- Review comments stay for your next message when Kuvo Code writes one for you (Build after Plan, Ask the Agent to Fix It), and branching from a message brings its comments along.
- Review comments you haven't sent stay with the session when you close its tab or quit, and go when it's deleted.
- In Changes, Stage, Unstage and Discard act on just that file, even when its name looks like a pattern (`app/[slug]/page.tsx`); discarding a new file only noted with `git add -N` moves it to the Trash instead of emptying it.
- A bot on a machine saves a long memory too, and a command a machine can't decode fails rather than reporting success.
- Notifications hide more kinds of keys (Stripe, webhook secrets, Slack hooks) and no longer hide long branch, package or test names.
- In split view, the panel stays the session's beside while the expanded panel covers it.
- Machines whose login shell is fish (or another that isn't like sh) work: a backslash in a file name, a bot's memory or a wake-up note no longer breaks the commands Kuvo Code runs there.
- Answering from a notification (Allow, Reply, a question's choices) needs your Mac unlocked; a notification that can't show everything a request covers has no Allow button; and what looks like a password, token or key in a notification shows as dots.
- Removing a provider you set up in Accounts also removes its key, here and on your machines.
- In split view, Run, New Terminal, Open Quickly and Edit Project go to the session you're working in, as Stop does.
- Editing a queued message no longer loses it when the engine is slow to answer; Undo twice, then Redo, leaves the composer as it was; messages that couldn't be sent come back in the order you wrote them; and a model the engine won't switch to doesn't stay picked.
- A message you send just as you press Stop waits in the queue rather than starting the agent again, and one sent for the next step of a run that then fails waits there too, where you see it.
- A conversation on a machine you read while it was away stays read when the machine is back, and a session deleted from another Mac or your phone closes its tabs in the panel.
- In a group chat, a bot's report on its part is what it did for that part, all of it, even when another agent wrote to it meanwhile.
- In a group chat: a message you send while the lead hands out the work keeps the parts from starting on their own, and Stop stops the lead too; a part's report is only what the bot did for it; a part whose message you took back ends rather than working forever; @Sam no longer calls Samantha; a meeting missed while Kuvo Code was closed isn't followed by the next minutes later, and one due at launch waits a moment for bots on machines; and a bot taken out of a chat forgets it.
- Anonymous usage no longer includes a short hash tied to your Codex or Claude account when the menu bar follows one: only which tool.
- On a machine, only you can open Kuvo Code's folder (`~/.kuvo-code`): where home folders are open to others there, other users could read your conversations, bots' memory and settings in it.
- A message from an agent on a machine names its sender only when that agent is on the machine, and messages from a machine are limited as one sender's: one past the limit goes a while later rather than being lost.
- A file saved to your Mac from a machine's browser is marked as downloaded, so macOS checks it before it opens, as it does any download.
- On a machine, the engine's password no longer appears on a command line while a bot's wake-up is sent (another user there could read it), nor in the environment of a watch's check.
- A page the agent saves as a PDF leaves out what you filled in (a password, a code), as its screenshots do, in the browser on your Mac and on a machine.
- Saved passwords are offered and filled in only over https, where they were saved: a sign-in page over plain http (which can be read on the way) gets no saved password, from you or the agent, on your Mac or in a machine's browser.
- A widget in the conversation sends a message as you only when you click in it, and opens a web address in your browser only from your click: a widget's script could do either on its own.
- Under Ask First, and in a group chat, the agent's browser opens files in the conversation's folder (and temporary ones) only: a file elsewhere on your Mac or the machine, which a command would have asked about, isn't opened without your say, nor read when a link, a redirect or going back leads there (on a machine, a page's pictures and frames from elsewhere don't load either). A tab you opened on such a file stays as it is, and the agent goes on in a new tab.
- On a machine, an agent no longer switches to or closes a browser tab another conversation's agent is using, as on your Mac.
- A page in the panel that isn't on screen (a bot's, say) can no longer open the file picker over the app, where you couldn't tell which page asked.
- On a machine, a page you took over stays yours while your Mac sleeps, its connection drops for a moment or you look at another conversation: the agent doesn't go on in it until you hand it back, or you remove the machine or quit. Another Mac's hand-back no longer ends yours.
- A machine's browser saves a download with a long name in Japanese, Chinese or another such script under its name, and clears downloads after a week while it keeps running too.
- On a machine, a link the agent clicks that opens a new window (a sign-in window, say) is where it goes on, as on your Mac, rather than back on the page that opened it.
- After your Mac wakes, a machine's browser view comes back right away, rather than once its old connection times out.
- Letting agents sign in to a site on their own is for the account you allowed it with, and ends when you delete that password: one saved later isn't used without asking.
- The browser offers to save a password on https pages only, where it fills them in, in the toolbar and in the agent's sign-in card; on http://localhost it offered to save one it could never fill.
- A bot can no longer schedule a wake-up that repeats more than a year apart: one far longer made Kuvo Code quit as it opened, again each time, after sending it.
- A repeating wake-up isn't queued again while the last one still waits (the bot busy, or waiting on you), so a bot doesn't come back to a pile of them.
- Weekday wake-ups and meetings are Monday to Friday wherever you are; in a few places they followed the local weekend.
- A wake-up time written with its time zone (06:00Z, 09:00+03:00) is that moment on your Mac too, not that hour in your own time zone.
- On a machine, a bot's watches no longer hold up its wake-ups, a wake-up isn't sent twice when the engine starts over, wake-ups reach the engine on a machine set up with a web proxy, its times are right on a machine without time zone files, and a repeat like 08m is refused rather than stopping that wake-up for good.
- Removing a machine that can't be reached signs out of your accounts there, stops its engine and deletes integrations' sign-ins the next time it can be, as do deleting one of its bots and removing an integration: before, its bots kept waking on your accounts.
- Removing a machine while it's still connecting stops the connection there and then, rather than letting it finish and copy your accounts over; and a machine whose engine another Mac started is left running for that Mac.
- Outlook's sign-in now carries between your Mac and machines (its key went missing, so a copied one couldn't be opened), and integrations' servers run apart from your project, without its .env, npm or Bun settings, and without the engine's password.
- In Settings › Permissions, a rule you were typing in no longer takes the place of a choice you made above it before leaving the field.
- **Wake Up Now** says so when a one-off wake-up couldn't be taken off the schedule (it would come at its time too), and on a machine it doesn't send a shortened note when the whole one can't be read.
- Picking another model while the agent has just asked you something no longer stops it and loses the question.
- While the agent thinks or writes at length, the line under the conversation keeps saying it's working, rather than "Waiting for the model to answer" after 20 seconds; and on a machine whose clock differs from your Mac's, its times are right.
- The coding agents you use in Kuvo Code, and the commands they run, no longer see the password of Kuvo Code's agents bridge in their environment, where a command that printed it showed it to the model.
- If saving your Auto list fails, Settings › Auto shows the list Auto still uses, rather than the one that didn't save.
- On a machine whose clock is behind your Mac's, a reply being written no longer says "Waiting for the model to answer" the whole time it streams in.
- Picking another model just as the agent finishes no longer starts it working again on a task that was done: the run is handed to the new model only if it was still going.
- A conversation no longer opens with "Something went wrong: cancelled" over the composer: when Kuvo Code started its engine over while reading a conversation (or a request was called off for another reason), that showed as an error.
- After **Build It** leaves Plan mode, the conversation no longer shows "Plan mode: it explores and plans" under the "Build mode" line.
- The bar over the composer for commands left running in the background no longer flashes for every command the agent runs, nor adds and drops quick ones from its list while a long one runs: a command shows there once it has run for a couple of seconds.
- Bring the coding agent you already pay for: Claude Code, Codex, Cursor, Grok and Antigravity, signed in as you, under **Subscriptions** at the top of Settings › Accounts. Pick one of their models for a new session, and that agent does the work, on this Mac, with its replies, edits, permissions and questions in the conversation like any session's.
- Keep up with subagents while they work: a bar over the composer lists the ones at work, with the step each is on, **Open** and **Stop**. **Open** (on its row in the conversation too) shows a subagent in a tab of the side panel, with everything it does as it does it and a composer of its own: tell it something while it works, give it another model, or stop it.
- Making an agent in Settings › Agents is one page now: name it (it keeps the name as you write it), describe it, give it instructions and choose what it may do, then **Create Agent**. **What It May Do** has a plain choice for each kind of action, like Don't Allow for editing files, and **Add Rule** adds as many rules as you like; a rule without a pattern, or one for all commands, says so instead of vanishing.
- Buttons and other controls no longer show the text pointer, in the conversation, the side panel or Settings: conversations kept out of sight still set it over what you pointed at. Controls without a border show the pointing hand.
- More than one account with a coding agent (work and personal, say): **Add Account** under it in Accounts. Each signs in on its own and shows in the model picker as its own.
- **Subscriptions** in Accounts has the coding agents and the plans you sign in to (GitHub Copilot, GitLab Duo, Poe, OpenCode) together: what you're signed in to with your accounts side by side, the rest as tiles to click.
- The model picker goes by provider: a rail down its side with your starred models, Auto, each coding agent account and each provider, a search across all of them, ⌘1–⌘9 for the rows in view, and older models folded under the newest of each kind. Star a model to keep it at the top.
- **Auto**: your own order of models, from any agent or provider, each with its effort, in Settings › Auto. A session on Auto works on the first one in your list; when one reaches its usage limit partway, the next goes on with what was done. A limit on a whole account skips all of its models, a limit on one model only that model, until it resets; then Auto goes back to it, and the session says so.
- Your commands from Settings › Commands, and those written as files in a project's `.opencode/command` folder, work in sessions with a coding agent, with `$ARGUMENTS`, `$1`, `$2`… filled in as on the engine.
- Claude Code and Codex take a message you send while they work at their next step, and a text file you attach for a coding agent goes in the message, as with the engine's models.
- A subagent's permission card or question no longer disappears from its conversation when the conversation is read again, or when the subagent was already at work as Kuvo Code started.
- Undo From Here and Redo work in sessions with a coding agent too: the conversation and the files go back, as with the engine's models.
- A subagent Claude Code sends off to work in the background goes on after its turn, in its own session, where its work shows as it happens, and it can ask you for permission there.
- What the coding agents do shows in full: pictures their tools bring back, the work of Cursor's and Grok's subagents, Cursor's command output as it runs, Codex's and Claude Code's warnings, hooks, retries and summaries, forms their tools ask you to fill in, and turns Grok starts on its own. Anything an agent sends that Kuvo Code doesn't know yet still shows its words.
- Images Antigravity and Codex make show in the conversation, Antigravity's widgets draw there as other agents' do, and pictures Codex's tools bring back (a page's screenshot) show with their step.
- Commands Claude Code leaves running in the background show in the bar over the composer, with their output and **Stop**; when one ends and Claude Code carries on by itself, the conversation shows it, as with the engine's models.
- Sessions with Claude Code or Codex are titled by their model (or the one you picked for titles in Settings › Agents), and **Suggest a Message** and **Create Pull Request** have the session's model write, as in other sessions. With Cursor, Grok or Antigravity, your default model writes them.
- Run a command yourself with ! in a session with a coding agent; the agent gets it and its output with your next message.
- Claude Code, Codex, Grok and Antigravity can use the side panel's browser, show you files in the panel and message your other agents, as the engine's models do.
- An agent of yours from Settings › Agents works in sessions with a coding agent too, and Codex's to-do list and This Session's changes show there as in any session.
- In sessions with a coding agent, Settings › Permissions' Blocks hold as they do on the engine, and reading a .env file asks first.
- Subagents of Claude Code, Codex and Antigravity show in the bar over the composer, and **Open** shows what each does in the side panel, as the engine's do; you steer or stop them in the conversation that started them. Codex's and Antigravity's keep going after the agent's turn when it doesn't wait for them.
- A session on an engine model can move to a coding agent or Auto: pick one of their models, and the conversation carries on in a session of theirs, in the same tab and with the messages you'd queued, and the old one is archived.
- A session with a coding agent can move to another model, another agent's or a provider's: the new one gets the conversation so far and carries on.
- The refresh button in Accounts checks your coding agents again, and so does coming back to the app: one you installed or signed in to in Terminal shows without restarting.
- An agent whose own program is out of date (an old Claude Code lists old Claude models) says so in Accounts, with an **Update** button that updates it the way you installed it: Homebrew, npm or the agent's own updater. Its new models show once it's done, without restarting, and sessions use the new version from their next message. The model picker points there too.
- Antigravity's **Sign In** shows its download, then opens Google's page when it's ready, rather than seeming to do nothing.
- A ChatGPT or SuperGrok plan signs in once, through Codex or Grok under Subscriptions; Accounts no longer offers a second way to the same plan. One you connected before keeps working.
- Markdown files in the side panel open at once, even long ones: they're drawn the way replies are. A link to another of the project's files opens it in the panel.
- A conversation that comes into view (a bot's, opening it from the sidebar, switching tabs, hiding or showing the sidebar) shows its messages straight away, rather than only once you scroll.
- Replies being written, code especially, cost less to draw with each few words.
- Window › Fill, Center and Move & Resize work again, and so do their keys: since 0.5.20 they were greyed out.
- Find marks its matches in replies already on screen, and the marks go when Find closes. A group chat's faces in replies update too.
- A reply being written comes in smoothly: its words are drawn as each frame of the screen begins, so they no longer cost a dropped frame now and then (about one frame in five before, one in thirty-five now).
- Selecting text in a conversation goes on from row to row, as on a web page: drag from a reply up or down through your messages, steps and code blocks, and past the top or bottom it scrolls along. Copy and Add to Chat take all of it, in order, and ⌘A selects the whole conversation. Add to Chat no longer goes through your clipboard.

## 0.5.22

- Commands the agent runs no longer get the settings Kuvo Code gives the engine, which hold the key to its browser tools: a command that printed its environment showed it, there for the model to read.
- The first message in a project after Kuvo Code starts has the browser's and your integrations' tools: it could go out just before they were connected, and the agent said it had no browser.
- Tabs no longer run off the window when there are more than fit: they keep their names, and the row scrolls, with the tab you're on brought into view. Their ends fade where more tabs are out of sight.
- A Settings page you open comes in a preview tab, its name in italics, as in VS Code: the next page you open replaces it, unless you've clicked or typed in it, and then it gets a tab of its own. ⌘-click still opens one right away.
- The engine's download on first launch tries again by itself, from where it stopped, when the connection drops or stalls; and when the server or a proxy turns it away, it says so, with what it answered, rather than with an error code.
- The sidebar's rows no longer show under the window's buttons and the sidebar button when you scroll it with the tab bar hidden: the list ends below them, fading out at its top and bottom while there's more to scroll to. Settings' sidebar too.
- The side panel makes room as it slides in and out, as the sidebar does: the conversation narrows and widens along with it, rather than waiting under the panel and then jumping to its new width.
- Conversations lay out their messages themselves now, rather than through SwiftUI's lazy list, which guessed the whole conversation's height again at every width. Opening and closing the side panel no longer flashes a blank conversation or makes the text flicker as it settles, sliding is smoother, and scrolling through long conversations and group chats is lighter.

## 0.5.21

- Opening or closing the sidebar or the side panel no longer leaves the conversation blank for a moment, or for a few seconds.
- The sidebar and the side panel slide in and out ahead of the conversation, rather than the conversation jumping to make room first: it moves along with the sidebar, and makes room for the panel once it has slid in. Sliding the panel is smoother too.
- Commands the agent runs find your own tools' sign-ins and settings, as in your terminal: `gh` said you weren't logged in, and others that keep theirs in `~/.config` or `~/.local/share` didn't find them. On your machines too, and in bots' watches there.

## 0.5.20

- A reply no longer shows its lines on top of each other, or with gaps, after you open or close the sidebar or the side panel. Its text could stay laid out for a width it wasn't shown at.
- With anonymous usage on, the app also sends an empty note every couple of minutes while it's open and has sent nothing else, so it's known how many people have it open at a time. It carries nothing new about you.
- Showing the sidebar again slides it straight in: it stays ready while hidden, bots included, rather than being drawn again first, which made the start of the slide stutter.

- Scrolling the sidebar, and everything else that moves in the window, takes less work: macOS no longer works out where the window can be dragged from each time something moves, only while the pointer is on the title bar. Scrolling the sidebar took about half the work in tests.
- Picking another model while the agent works hands the run to it right away: the step under way stops and the new model carries on, or says why it can't (one that isn't available shows its error with Try Again). Before, the switch waited for the next step, so a step that had stalled kept the session working with nothing happening. And a reply that stops arriving partway now says it's waiting for the model to answer.
- The usage item's first screen, with no account connected yet, no longer warns about macOS permission dialogs for providers you'd pick: there are none to pick.
- A bot that works in one of your projects goes back to the branch your project was on once it has made a fix on a branch of its own. It left your checkout on its branch.
- Wake Up Now, in Edit Bot, sends a wake-up once and turns into Woken Up, so a second click doesn't have the bot do its job again. For a bot on a machine that can't be reached, it says so rather than doing nothing.

## 0.5.19

- Long conversations scroll more smoothly and use less memory: replies are drawn with macOS's own text system, looking as they did. In tests, reading through a long conversation had a quarter as many late frames, and resizing the window with one open stalled for half as long. Right-clicking selected words in a reply also offers Look Up and Translate, and copying a table gives a line for each row.
- A checklist in a reply ("- [ ] Gather ingredients", "- [x] Done") shows checkboxes, ticked or not, rather than bullets followed by brackets.
- Save to Mac, for a file a machine's browser downloaded, puts it in your Downloads folder once it has all arrived. A half-copied file showed there under its name meanwhile, and stayed if Kuvo Code quit.
- A bot's job, as it shows under its name and goes into Export, is no longer taken from a section like "Job log" or "Job history" in its memory.
- Bring Over, when everything from opencode is here already but a sign-in, says so with which to sign in to again, rather than opening an empty list to bring over.

## 0.5.18

- A machine's SSH connection closes when Kuvo Code does, even if it crashes or is forced to quit, and so does one it gives up on while connecting. They could stay open in the background for days.
- On a machine, your settings, with any keys or tokens you gave a server in Settings › MCP Servers, reach its engine in a file only you can read that goes when it stops, not in its environment, where the agent's commands could print them. A project's own opencode.json there now wins over them, as on your Mac.

## 0.5.17

- Codex in the usage item, and its limits next to a session and in Usage Remaining, are the ChatGPT account you connected in Kuvo Code. They came from the Codex app's sign-in on your Mac: without one, Codex said you weren't signed in, and with one on another account, they were that account's. And with SuperGrok connected, Kuvo Code no longer renews the Grok CLI's sign-in, which could sign it out.
- Opening a shared bot can't give it a hidden job through its name (a name with line breaks wrote one into its memory), a file that isn't a bot is refused at once rather than read without end, and closing it without making the bot leaves none of its personality behind. A bot that can't be made, say when its machine drops, leaves no folder or conversation behind.
- The Files tab lists names as the Finder does, file3 before file29, as on your phone.
- A server you add in Settings › MCP Servers can't take an integration's name: it showed as that integration, and removing the integration removed it. And removing a server, agent or command right after typing in it no longer brings it back half made.
- ⌘K and the Dock menu list chats too. Run and Edit Project don't take a chat or a bot's own folder for a project, and New Project on a folder that's one already keeps its name, run command and folders.
- A worktree session that can't be made leaves no worktree behind, and in a repository using Git LFS, Kuvo Code opened from the Finder makes worktrees again (each failed, leaving up to 20 branches). When one of several attempts can't be made, the others go too, rather than staying behind empty.
- Reopening a conversation that was cut off when Kuvo Code quit says it was interrupted, and that a message carries it on, rather than ending on a failed step. A step you stopped or that was cut off counts as stopped, not failed.

## 0.5.16

- Cards above the composer stay while the agent waits, even if reading them again fails (over a slow link), and a form you'd half filled keeps its answers when you come back from another conversation. Clearing "Something else…" in a question leaves no answer behind, and a sign-in or code card no longer takes the keyboard while you're typing a message.
- A permission notification names every command it covers, not just the first, since Allow approves them all. And notifications go when what they ask is answered elsewhere (on your phone, say), is no longer asked, or a browser's ask ends.
- What a subagent asks you (a permission, a question, a sign-in or a code in the browser) shows in the conversation it works for, which waits on you with the orange hand. It showed nowhere, and the subagent waited until it gave up.
- Files with accents, Turkish letters, CJK or emoji in their names show and open in Open Quickly, ⌘K and @-mentions. They came out as escape codes. A file open in the panel shows the agent's changes as they're made, line numbers stay right in files with Windows line endings, a Markdown file's own pictures show in its preview, and its preview loads nothing from the web.
- A worktree with changes isn't removed when git can't tell (a machine's connection dropping). And Bring Over in Settings › General no longer replaces accounts you've connected when it can't read them, no longer puts opencode's permission rules ahead of yours, and leaves no copy of opencode's settings behind when it fails.
- The usage item in the menu bar only refreshes accounts connected in Kuvo Code. It could also refresh, and renew the logins of, tools you hadn't connected (Claude Code, the Codex CLI), which could sign them out. And limits next to a session or in the sidebar no longer show an old reading, or one whose window has reset, as current.
- A GitHub repository that is a single skill (its SKILL.md at the top) shows that skill to add. It said the repository had none.
- Integrations: Change Key keeps how you set an integration up (turned off, Code Mode, your headers), a settings file Kuvo Code can't change says so on the page rather than failing quietly, Remove always signs you out, keys keep working when Kuvo Code runs for days, and a sign-in the engine lost stops waiting.
- Adding a machine as `ssh://host:port` or by an IPv6 address is refused with how to do it (a Host in `~/.ssh/config`). The app then read your Mac's files at the machine's paths. And a dropped connection no longer starts two reconnect attempts at once, or replaces what went wrong with "the connection was lost".
- Going back to one of the last few sessions you had open shows it at once, scrolled where you left it. Switching to a long conversation took up to a quarter of a second, and it opened at the end.
- Resizing the window with a long conversation open is smoother: it took twice the work, as the conversation was laid out again to keep its end in view at every step, and the sidebar was made again each time too.

## 0.5.15

- In Ask First, the agent asks before saving a PDF or uploading one of your files to a site. Bots in a group chat can't start sessions, save PDFs or upload your files, as they already couldn't change files or run commands.
- Closing an integration's sign-in page in Settings while the site shows a message no longer quits Kuvo Code.
- Your password goes only into a page of the site the sign-in card names. A page leaving for another site could take a sign-in meant for that site, and the toolbar's Fill Password could fill the last site's login on a page that never finished loading.
- In a group chat, a message you send as a bot finishes its turn reaches that bot: it gets another turn. Before, it could miss it, and the others passed it by.
- A review comment stays with the line you wrote it on when the agent edits the file meanwhile. It could be saved on, or later shown at, another line in that place.
- ⌘Return in a new session's composer sends the message. It did nothing.
- A worktree isn't removed while any session works in it, even one you haven't opened, a subagent or a command left running there. And a merge stopped by a hook or commit signing is taken back, rather than leaving your checkout in the middle of it.
- Colored lines in the Changes panel never show another line's text after the agent edits the file.
- The Changes panel shows files with Windows line endings line by line, and no longer folds the next changed file into them. It also reads changes right when your git settings change diff prefixes (diff.mnemonicPrefix, diff.noprefix), shows conflicted files during a merge, stages a renamed file, names a huge or minified file rather than drawing it, and Suggest a Message describes only what the commit takes.
- Wake Up Now on a bot on a machine sends its whole note. It sent the shortened one from the list, on one line. And a watch whose check won't stop at its minute is killed, so the wake-ups after it still come.
- A group chat that finished on its last allowed turn no longer offers Keep Going, and Keep Going shows once the wrap-up is done, when it works.
- After you undo a message in a group chat, the bots are told to set aside what was taken back. The note never reached them, so they went on as if it still stood.
- Typing Japanese, Chinese or Korean, Return picks the input method's candidate, and Escape and the arrow keys stay with it, rather than sending the message, stopping the agent or going back through messages. Group chats, review comments and Find too.
- Stop keeps what you sent for the agent's next step ahead of the messages you queued, so Resume sends it first, and Redo after an undo takes back the quotes the undone message brought to the composer.
- A message sent again with Try Again that can't go (the engine restarting, a machine dropping) comes back to the composer. It was gone from the conversation, and a "Sending" bubble stayed for good.
- Cancelling a message while it shows "Sending" stops it. It came back moments later and the agent ran it anyway.
- An engine waiting on a macOS prompt, like one asking for access to your Desktop folder, is no longer started over after a minute. That took the prompt away and asked again.

## 0.5.14

- Models show once the engine has finished starting, even when that takes longer than a minute, like when a macOS folder prompt is answered late. The composer could stay on "Choose a Model".
- The live view of a machine's browser no longer misses a change that left the picture the same size, like a box ticked or a letter typed.
- A machine's browser no longer restarts for an update in the middle of an agent's task there, between its steps. It waits until no agent has used it for ten minutes.
- Closing Kuvo Code's window and opening it again no longer leaves empty Terminal and New Tab tabs in each conversation's panel, and deleting the conversation in view no longer leaves a browser tab running behind it.
- Closing a terminal tab ends its shell and whatever runs in it, like a dev server holding its port. They kept running until Kuvo Code quit.
- Web search works in every session: agents search with Exa, which needs no key. The default picked a service at random for each session, and one of them (Firecrawl) answers every search with nothing without a key, so about one session in five couldn't search. Settings › Engine still lets you choose another service, or any.
- A conversation shows at once when you open Kuvo Code, and when you open one you haven't yet since: its latest messages, as last seen, show while the engine reads them (which took a second or more at launch, with a blank card meanwhile). The sidebar's sessions show at once too.
- Going from one session to another is quicker. The composer stays where it is and keeps the keyboard, showing each session's draft, rather than being made again for every session; the slowest switches took about half as long in tests.
- The accent color you pick in Settings › Appearance also colors the tab bar's badges, the agent's pointer in the browser and `@User` in group chats. They kept macOS's own accent. VoiceOver names each accent swatch.
- Scrolling and clicking in a machine's browser keep up with you. Its live view comes at your screen's size while the page moves, and sharp once it stops; making every picture sharp kept the browser on the server so busy that a scroll took most of a second to show.
- A session waiting for your answer shows the orange hand in the sidebar and tab bar even if you haven't opened it, like a bot's work in a session of its own. It showed as still working.
- Settings › Engine no longer says every web search service needs an API key: most search without one. Its "Any service" choice was called "Any connected service", though it uses services you haven't connected too.
- Kuvo Code no longer stops responding for a second as it starts, while it checks that its engine is genuine.
- Opened from the disk image, Kuvo Code offers to move itself to your Applications folder and opens from there. From the disk image it can't update itself, so updates were quietly skipped.
- Scrolling through a long conversation is smoother: replies take about a third less work to draw as they come into view, and code blocks show colored at once instead of plain for a moment first.
- Scrolling up while earlier messages come in no longer jumps the conversation by a few lines now and then.
- A long reply streams in more smoothly: new words redraw only the reply being written, not the whole conversation.

## 0.5.13

- A conversation on a machine picks up again by itself after the network drops out in a way that leaves the connection silent, like Wi-Fi changing. It could stop showing new replies until something else reconnected it.
- Models show by themselves once the engine has finished starting. If it was slow to start, the composer said "Choose a Model" until something else made Kuvo Code look again, and an engine that never finished starting is now started over once.
- Setting up the browser on a machine tries again when the connection drops partway through. It used to wait for the next launch, or for you to open the machine's browser.
- A choice in a question card, or in a form, no longer repeats itself when its description only says its label again ("Red" under Red).
- With VoiceOver, the side panel's tabs can be picked and closed. They read as text and an icon, with nothing to press.
- Pages left open in a machine's browser from before Kuvo Code last quit show in every session on that machine, until an agent works in one or you pick it, which makes it that session's. They went to whichever session was in view.
- A machine's browser moves to a newer build Kuvo Code brings (a newer Chrome, new fonts) once nothing is using it, keeping its open pages. One started before the update arrived kept the old build for as long as the machine's engine ran.
- The browser on a machine shows Chinese, Japanese and Korean, and Hebrew, Thai, Hindi, Tamil and other scripts, instead of empty boxes. It brings a font that covers them (adding about 3 MB to what a machine downloads once).

## 0.5.12

- The line that sums up an agent's steps names an MCP server's tools by the server ("used GitHub", "used context7 2 times") rather than their raw names, and says "used a skill" and "started a session".
- VoiceOver names the **Pause Wake-Ups** switch in Edit Bot, each bot's button under a group chat's composer ("Ask Reader"), and each field in a form an MCP server or a sign-in asks you to fill. They read as an unnamed switch, buttons and text fields.
- Each session has its own side panel, and so does each bot and group chat: its files, terminals and browser tabs stay with it, and switching conversations shows the other's. The panel was shared, so one agent's pages and terminals showed in every conversation.

## 0.5.11

- Find in a conversation goes to each place it found again. In 0.5.9 it could stay where it was, or stop short in a long conversation.
- A conversation opens showing its end at once. It could show nothing until you scrolled, or a moment of an earlier part first.
- While nothing comes back from the model for a while, the line at the end of the conversation says "Waiting for the model to answer…" with how long, instead of "Working…". A provider that never answers could look for many minutes as if the agent were busy doing something.

## 0.5.10

- A reply's preview in the sidebar, and in notifications, keeps what it quotes as written: a path or a `snake_case` name lost its underscores, and "C#" or "a > b" lost their marks. Only Markdown's own marks are taken off.
- After a model error, Try Again stays when you pick another model or mode for the retry; the "Switched to…" line hid it, so there was no way forward.
- A session in a worktree, and a bot's conversation, no longer show "Instructions updated: api/kuvo.worktree" or the like for what Kuvo Code tells the agent itself.
- In the Changes tab, a binary file says "Binary" in its header, and a new file too big to show says "Too big to show". Both showed nothing at all, as if the file were empty. VoiceOver can fold and unfold each file, which read as a "Forward" heading before.
- Hovering over **Always Allow** on a permission card that covers everything of its kind says so ("changes to any file in this project", "any command") rather than showing "*".
- A session whose model isn't available anymore, like a free model that went away or one from an account you signed out of, says **Choose a Model** in the composer, and the picker opens on the list. It showed the default model as if it were in use, while every message failed with "Model unavailable". After you pick another, **Try Again** under the error is still there and sends your message with it: switching the model used to hide it.
- The agent can click, type and choose in the panel's browser on your Mac again. Since 0.5.6 every click or keystroke failed with "There's no element on the page now", though it could still read pages.
- When a page doesn't open, like a local server that isn't running, the agent hears why ("Could not connect to the server") rather than finding an empty tab.
- VoiceOver names the icon buttons by what they do: the sidebar's + buttons (New Bot or Group Chat, New Chat, New Project), Collapse All, Open in Editor, the Changes branch menu and Move to Project, and each Add in MCP Servers and Skills says what it adds. Menus no longer have a separate "Go Down" button for their arrow. A file waiting in the composer reads as its name and kind, with a Remove action: its remove button shows only on hover, so VoiceOver couldn't reach it.
- A command the agent leaves running in the background shows in a bar over the composer, with how long it has run, what it has printed and Stop, and the session shows as working until it ends. It used to look as if nothing was happening. The bar can be folded to one line, which still shows that something runs. When a command ends, the conversation says so, and whether it finished, failed or was stopped, before the agent carries on.
- A message waiting for the agent's next step has Send Now right in its row, which stops the agent's current step and gives it the message. It was only in the ⋯ menu.
- Searching the sidebar: a session you delete leaves the results under In Conversations at once (clicking it opened nothing), and a search typed while Kuvo Code is still starting finds what was said in conversations once they're in.
- Undo From Here in a folder that isn't a git repository says that the agent's file changes stay as they are: only the conversation goes back there. It said the files went back too.
- Removing a session's worktree never throws away work you weren't warned about: after a merge, or when changes appeared after Kuvo Code asked, the worktree stays and says why, and none is removed while an agent works in it.

## 0.5.9

- Scrolling up through a long conversation no longer jumps. As replies above come into view, or earlier messages load, what you're reading stays where it is, and earlier messages come in before you reach the top.
- Replies draw in one go, and faster: a long reply no longer shows up empty for a moment and then at its size. The first code block in a conversation no longer holds up the app for a quarter of a second while code coloring starts, and a code block keeps showing the latest code while it's being written.
- A session on a remote machine no longer keeps showing "Connecting to…" over and over while nothing runs there. With an integration added, the machine's engine looked out of date every time it was checked, and was started over every few seconds.
- Giving a bot a key of its own, or taking it away, changes only that key's entry in its folder's `.opencode/opencode.json`. It used to replace that file, and taking the last key away deleted the whole `.opencode` folder, with any skills or commands in it. A bot on a machine no longer loses its folder's settings each time the machine connects.
- In a folder that isn't a git repository, the Changes tab lists the files the agent changed in the session, as it says it does: it stayed empty. A file edited several times shows as one change.
- A session archived with its worktree removed stays with its project: Settings › Archived Sessions listed it under the worktree's folder name, and restoring it made a project of a folder that was gone.
- When the agent asks to run a command, the card shows the command line as it will run, pipes and `&&` included. A command like `npm test | tail -5` showed as two separate lines.
- Settings › Permissions lists the approvals you saved with Always Allow in every project, to remove them. It said "None yet" for any made in a project.
- Conversations keep going while a save panel or an error message is open. Exporting a session as Markdown, or an error after removing a worktree or moving a chat, used to stop every conversation, bot and wake-up from updating until you closed it. With VoiceOver, the composer's mode and model buttons open their menus.
- Signing out of an account or integration here signs your remote machines out too, even when that fails the first time: it's tried again until it works, rather than leaving the machine signed in.
- A sign-in renewed on a remote machine is no longer replaced by an older copy when the connection drops while Kuvo Code checks it.
- When a remote machine connects again, it tells you what its agents asked while it was away, like a bot's permission request from a wake-up while your Mac slept. Before, nothing said so until you opened that conversation.
- Messages agents send each other are no longer lost when a machine drops: one waiting for a machine stays queued until it's delivered, and one a machine's agent leaves for an agent elsewhere stays there until it gets through.
- Answering a permission request from its notification says so when the answer didn't go through, as answering a question already did.
- Changing a bot's name, model or personality while its machine is away reaches the bot once the machine is back. Its group chats catch up too, and a chat you deleted meanwhile is taken out of its folder. In a group chat, a go-ahead whose work couldn't be handed out now says so.
- Deleting a bot moves its folder, with its memory and the files it made, to the Trash (on a machine, to Kuvo Code's trash folder there). It used to be deleted for good.
- Removing an OpenRouter or Z.ai key in the usage panel no longer deletes that key's file in `~/.config`, which other tools use. A key there shows as yours, like one from your environment.
- A remote machine's engine is no longer started over when this Mac's engine and the machine's list GitHub Copilot's models differently.

## 0.5.8

- While a reply is still being written, a code block that starts on a list item's line, like `- ```sh`, or in a quote stays a code block, and the words after it show as words.
- Every account works on your remote machines, API keys and sign-ins like ChatGPT's or GitHub Copilot's alike: each is copied to the machine's engine and kept in step with your Mac, so a provider you connect, switch to or sign out of here does the same there right away, without the machine's engine starting over, and one that wasn't connected at the time catches up when it connects. A ChatGPT sign-in used to stay on your Mac. A sign-in renewed on one side no longer leaves its old copy behind on the other.
- A remote machine's browser keeps its temporary files in Kuvo Code's own folder there, never in the machine's /tmp, and clears away what a browser that was stopped hard left in /tmp before.
- A link whose address or title goes on to the next line, with dollar signs in its address, opens that address; math used to change it.
- A bot can have keys of its own: in Edit Bot, under Keys, give it a GitHub token or another integration's key that only it uses, in place of your shared one from Settings › Integrations. No other bot or session gets it, on your Mac or on a machine. On remote machines, integrations' keys are no longer in the engine's environment, where an agent's commands could print them: they're in files only you can read, gone once the engine stops.
- An integration that takes a key, like GitHub with a personal access token, connects on your Mac as soon as you save the key. It used to say "Couldn't connect on this Mac" until Kuvo Code's engine restarted, which waited until no session on your Mac was working.
- In replies and Markdown previews, a list item with a code block, quote or table in it keeps its number or bullet beside its own first line. It sat beside the block, so the item's first words read as the end of the item before.
- Math in replies and Markdown previews no longer takes words that aren't its own. A numbered list with each formula opened after its label, like "1. Energy: $$", keeps every item; a code block that starts on a list item's line stays code; a quote under a list item keeps its quote marks out of the formula; and "$$" for prices or the shell's PID stays as written.
- A link whose address has dollar signs, like `?$filter=…&$top=2`, opens that address; math used to change it while the link's words looked right.
- An idle machine's engine is no longer started over each time Kuvo Code launches for no reason, and one whose settings changed (an integration's key) starts over with them once nothing runs there, however long its work takes, even if it was connecting at the time.
- Watches see something appear or go away again: a check like `curl -s … | grep -o '…'` that finds nothing counts, so a bot hears when an item comes back in stock or a status page stops saying all is well. A run where curl, wget or gh fails, as when the network is down, never counts, through `| jq`, `| sed` or `| head` too. A check that writes warnings no longer wakes its bot once after the update, and Check Now runs a check the way its watch does and says when a run wouldn't count.
- Opening a picture or file from a conversation saves it in Kuvo Code's own Attachments folder, as the kind of file it says it is and marked as downloaded. Anything that could run, like an app, a script or an installer, is shown in Finder instead of opened.
- Starting a rename on another session while one is open no longer closes the new one at once. In Settings › Skills, a repository that finishes loading after you opened another no longer replaces it.
- A new session's first message is kept until it has really gone to the agent, so quitting while the session's tools start no longer loses it.
- After a remote machine reconnects, a subagent that finished meanwhile no longer shows as working for good, nor does its session, tab or bot. A subagent sent off in the background that failed shows Failed.
- In split view, a session beside that the window has no room to show no longer takes ⌘. and the other menus, isn't marked read, and isn't counted as in view. A tab you pick in the panel goes to the half you last worked in, and a tab a conversation's own subagent used is free for it again after a minute and a half.
- A settings file with Windows line endings keeps its layout too when Kuvo Code adds the web search default; its closing brace was pulled up onto the last line.
- Each subagent an agent hands work to has a row of its own in the conversation: its task and agent, the step it's on while it works and what it used once done; click it to see each step it takes. Several started at once show one under another, instead of folding into the steps as "handed off 4 tasks" or a "Delegated a task" that told you nothing.

## 0.5.7

- When the engine stops while starting, the failure screen shows the engine's own error message again, not just an exit code.
- On a remote machine, a project's own web search setting in its opencode.json wins over your Mac's choice, as it does on your Mac.
- Adding the web search default no longer rewrites your engine settings file: it adds one line and keeps your layout. A settings file that's a link (to your dotfiles, say) stays a link when Settings change it.
- A watch on something that keeps changing, like a price or a counter, wakes its bot again, once each time it runs, with the latest output; it never did, and was checked every two minutes. A check that fails without printing anything, or is stopped, counts as not having run, so a longer outage no longer wakes the bot twice, and a check's error messages don't count as what it shows.
- A weekly wake-up or group meeting keeps its day of the week after a time-zone change, and saving a group chat no longer moves its meeting's time after the clocks changed.
- Deleting a bot on a machine that's in several group chats no longer leaves a chat transcript in its folder there.

## 0.5.6

- Subagents an agent sends off to work in the background show while they work: under its steps, each with a spinner and opening to what it's doing, even after its turn has ended. The session's row and tab show it working meanwhile, and a bot's row says how many tasks it's working on. They used to vanish into "handed off 7 tasks".
- In the sidebar, a bot's next wake-up, its watches and its pause stand apart from what it said, each with its sign: the wake-up and watches in your accent color, a pause in grey. "Needs you" is in orange.
- **Help › Contact Us…** writes to us at info@kuvo.run, from the menu bar or the menu at the bottom of the sidebar.
- A message of yours that starts like a note from another agent but names no one ("[Message from · ses_1]") no longer crashes Kuvo Code.
- Math in replies keeps the text around it whole: lists, quotes, tables and code keep their shape next to formulas, and the shell's `$$` and prices no longer turn into math. A formula that can't be drawn shows as written instead of leaving a gap, and more draw, like `\boxed`, `\dots` and `align`. A reply with certain symbol characters no longer shows a formula twice or quits Kuvo Code.
- Find marks the right words in a reply with math in it.
- Split view: the half you type in gets the menus and keys, like Stop, Find and the modes, not only the half you clicked. When the window is short of room, only the split you opened last stays ahead of the side panel.
- A file a subagent or a group chat's bot shows you opens where you see that conversation. A conversation you aren't looking at no longer takes over the tab you're in, and a tab waiting on a sign-in or a code isn't taken by another.
- Renaming ends, keeping what you typed, when its row folds away or you leave its tab, instead of coming back later and taking the keyboard. A new branch is made only when you press Return. Bots and group chats are renamed in their editors, so their tabs no longer offer Rename….
- In Settings, something opened over an editor, like a sign-in, goes back to that editor, and searching opens its result in another tab, so what you typed in an editor stays.
- New Project keeps its worktree setup command after you add a machine and come back.
- A new session's first message comes back in its composer if Kuvo Code quits or crashes while the session is being made.
- Web pages the agent browses can't read or change the numbered elements it acts on, on this Mac or a machine. Stopping the agent while it waits in the browser stops it at once; it used to keep your Mac busy until the wait ran out.
- Long replies with many links listed at the end stream smoothly, and a link defined twice goes to its first address, as Markdown has it.
- A code block whose first line starts with tabs or has emoji no longer runs under its language and Copy.

## 0.5.5

- Two sessions side by side: right-click a tab or a session in the sidebar and choose Open Beside. The two show as one tab, and come back together when you return to it from another; drag the gap to resize, swap them, close the one beside (⇧⌘T brings it back beside), or choose Close Split View to give each a tab of its own. Stop, Find, the modes and the keys on its cards go to the half you clicked into, and the one beside counts as seen while it shows.
- Two sessions side by side show as one tab in two halves, the tab's own half raised. Settings › General can show them as one tab with both names, or as the two tabs joined, as before.
- An agent can start a session of its own for part of the work, in the same project or another folder: it opens beside the conversation that started it (or in a tab of its own, if asked), and the two can write to each other. Ask for a separate session, or let the agent decide.
- Math in replies is drawn as formulas: `$…$` and `\(…\)` in a line, `$$…$$` and `\[…\]` centered on their own. It used to show as raw LaTeX, and a line of `=` under it turned the line above into a heading. Prices like $5 and code stay as they are.
- Editors open in place instead of in pop-up windows. In Settings, an agent, command, MCP server, skill, key, sign-in or provider opens in the page, under a way back to it (Esc goes back too); New Project and Edit Project open in the window's main card, as a bot does; and Add a Machine opens inside what asked for it.
- Renaming a session happens where its title is: in its row in the sidebar, or in its card's header from its tab or the command palette. A new branch is named right where the branch shows in the title bar.
- A widget the agent makes opens larger over its conversation, as the side panel does over the window, instead of in a separate sheet; Esc brings the conversation back. While it's being made, it shows its name as soon as the agent has written it, or words that change, instead of "Making something… Zero KB".
- Fields show everything written in them: an agent's or command's description, a skill's "Use it when", a project's run and setup commands, a group chat's name and purpose, and your answers grow as you type rather than cutting off.
- A file dropped anywhere on the message box is attached, its text included. Dropped on the text, it used to go in as the file's path.
- Each conversation's agent keeps to a browser tab of its own. Two sessions browsing at once used to move each other's pages, and one's click could land on the other's page.
- The menu bar's usage panel shows Grok's weekly limit for a SuperGrok account you signed in to in Kuvo Code; it used to need the Grok CLI signed in too. That account comes first: an old or other Grok CLI login on your Mac no longer stands in for it.
- Following the agent's thinking while it streams no longer leaves the conversation blank once the thinking is done and folds into its summary: it stays at the end. Code blocks are lighter to draw, and keep their size while Find marks them.
- Kuvo Code no longer quits when a program on your Mac sends its browser tools a malformed request.
- Showing a folder in the panel works when the agent gives its path with a slash at the end.
- Saving a page as a PDF over an existing file keeps the old file if the save fails. It used to be deleted first.
- An alert a page shows between the agent's steps no longer leaves the agent stuck until you dismiss it. While the agent waits for you to sign in or do something on the page, the page's own questions show for you to answer instead of being turned down.
- A password or code you give the agent goes in only if the page is still on the same site with the same fields. If it changed while you answered, nothing is filled in, and a password only ever goes into a password field. A sign-in card also goes away when the agent stops.
- When the agent clicks or types by number, it acts on the element it read, also inside frames and shadow roots. It used to hit the wrong element in a frame, couldn't use elements in shadow roots, and could land on another element after the page added rows or banners above it. If the element is gone or changed, it reads the page again.
- Repeating wake-ups and group meetings keep their time of day. A daily 2:30 no longer moves an hour for good after clocks go forward, one isn't skipped after clocks go back, and after a time-zone change they come at the same time there.
- Canceling a wake-up or watch, or pausing a bot, on a machine that isn't connected says so and keeps it listed. It used to look done while the machine still ran it.
- A watch no longer wakes its bot when its check fails for a moment, like right after your Mac wakes before Wi-Fi is back. A change counts once a second check a couple of minutes later sees it too, and a check that times out doesn't count.
- Group chats: parts that wait on each other say so instead of waiting forever. A part that takes many steps is reported when it's done, and a report or a "couldn't do its part" note no longer shows twice.
- A paused bot with a wake-up that came due, or a wake-up that keeps failing, no longer keeps Kuvo Code busy twice a second. One that fails is tried again in a minute, then less often.
- Saving in Edit Bot no longer undoes a job the bot learned while the editor was open.
- Deleting a bot on a machine that isn't connected says so and keeps the bot, instead of taking it off the list while it kept waking up and working on the machine.
- A bot can no longer delete folders outside its own by canceling a wake-up with a path like `../`: `kuvo-wake` takes only a wake-up's ID or its letters.
- An attached symlink is read as the file or folder it points to, instead of going to the agent as a path. A big image still over 20 MB after conversion goes as a path the agent can open; it used to be sent anyway and dropped.
- What you write in a new session's message box while the session is being set up goes on to the new session. It used to be lost, and the message was sent as it was before your edit.
- A `/command` or `!command` that fails, or can't run because its machine isn't connected, goes back to the message box with its files instead of disappearing. Files attached to a `!command` stay for your next message.
- In a session on a machine, two attached files with the same name no longer overwrite each other there. After Edit, Undo or Branch, the composer gets back your own files, not the machine's copies or files that couldn't be copied.
- A file sent to the agent as a path, like a .zip, a video or anything over 20 MB, shows once on your message and in the queue, and comes back once after Edit, Undo or ↑. It used to show twice.
- Writing `<review-comments>` or `<attached-files>` in a message, or quoting a reply that does, no longer cuts words from your message, from ↑ history, or from what comes back after Edit or Undo. A comment with a line like `[file.swift:10]` stays one comment.
- Anonymous usage sends a model's name only if it's in the public catalog. Models you set up yourself (deployments, ARNs, fine-tunes, local models) go out as "custom".
- Turning web search off or picking a service, in the settings file or a project's own settings, is no longer overridden. The free web search is written into the settings file once, where Settings › Engine › Web Search shows it and you can change or remove it.
- Remote machines that stopped trying to reconnect while your Mac slept try again when it wakes.
- The engine stops when Kuvo Code quits, even if something you left running from a panel terminal is still going.
- After the engine restarts, a later crash is noticed and it starts again by itself. A restart could briefly show "couldn't start" and leave a crashed engine looking ready.
- Links written as `[text][1]`, with their addresses listed at the end of a long reply, work all the way through. They showed as plain brackets in every part of the reply but the last.
- Opening a conversation while the agent is working shows all of it. It could show empty or out of date, or leave out the words being written or a step, until it was opened again.
- After the connection to the engine or a machine comes back, a conversation shows each message, step and turn's end once. The last ones could show twice until you switched away and back.
- Updating the browser on a machine no longer deletes the copy that's running when the home folder there is reached through a link. Two Macs on different versions of Kuvo Code no longer send the browser to a machine they share in turns, and a half-built browser download left on your Mac when Kuvo Code quit is cleaned up.
- On a machine, while an agent waits for you to sign in, give a code or do a step, other sessions and bots there keep browsing; they used to wait with it, up to 15 minutes. A stopped agent's card closes and its leftover steps no longer run later, and if the page changed while you answered, nothing is filled in.
- On a machine, an agent's browsing answers pop-up dialogs only in the page it's working in. It could answer, or even accept, one in a page you were using or had taken over while another agent browsed.
- Every session is listed, however many you have. Only the newest 100 were, so older ones, pinned ones among them, and a quiet bot's conversation could go missing after a relaunch.
- A session the engine didn't name is named after your first message, without the note on attached files or the header of a message from another agent. After a long first run it stayed "New Session", then took a later message's words.
- After you disconnect an account, new sessions and bots start on a model you can still use, rather than on that account's and failing. Settings' model choices show such a model by name instead of a blank.
- A model whose name has a slash in it, like OpenRouter's, stays chosen for new sessions and bots; they used to start on the default model instead.
- Agents no longer list sessions you archived among the ones they can write to.
- New Session (⌘N) in a bot's conversation starts in your latest project. It used to make an empty project called "workspace", whose session was listed nowhere; one made that way is gone from Projects.
- A file or folder an agent shows you while you're in another conversation opens in the side panel when you come back to that one. It used to be lost, while the agent was told it was open; now it's told whether you've seen it. The step names what it showed, and clicking it shows it again.
- A new bot no longer shows for a moment as a project called "workspace" in the sidebar while it's set up.
- Creating a bot on a machine that's still connecting waits for it, showing what's under way beside the buttons, then makes the bot. It used to do nothing. If the machine can't be reached, it says so above the buttons.
- Dropping a quote you were replying to no longer quits Kuvo Code. With the cursor in its answer, the app crashed.
- While the agent thinks between steps, its thinking shows under the steps as it happens. It could be folded in with the finished steps, as if the agent had stopped.
- With the side panel at its widest, it stays inside the window. Beside the bot editor it could run off the window's right edge; the editor's colors and faces now wrap onto another line when there's little room.
- When the window hasn't room for the sidebar, the panel and a session beside, the one you opened last stays and the others make way; a session beside that you come back to makes way first. Showing the panel beside a split view used to do nothing, and its button needed a second press.
- When an agent on one of your machines starts browsing, the panel opens once its page is there to show. It used to open straight away on Changes, with nothing of the agent's in it.
- Anonymous usage, while it's on, also says where a first run stops, how an update goes, how long a model takes to start answering, and what kind of trouble a failed run, sign-in, crash or hang was, so those can be fixed. As before, never your code, prompts, files or accounts, and it's off with Settings › Privacy.

## 0.5.4

- Long thinking and long replies stream and scroll smoothly. Opening the agent's thinking while it streamed, or scrolling through a long reply, could freeze the window for seconds at a time and keep your Mac busy after the reply was done. A code block is now colored once the agent has finished writing it, instead of flickering between plain and colored as it grows.
- The agent can search the web again: every search failed, because the engine had no search service chosen. It now uses a free one, and moves to another when one is busy.
- On a machine, the browser is now Chrome itself, run without a window, instead of Chrome's stripped-down headless version, which sites like Google and X took for a bot and turned sign-ins away from. It downloads again once, the first time you use the browser there.
- If the engine stops while you work, Kuvo Code starts it again in a moment and your conversations carry on, instead of a screen saying it couldn't start. Only if it keeps stopping does that screen come back, now saying it stopped.
- Files you attach stay on your message once it's sent. They used to vanish from it until you reopened the session.
- The agent knows where the files you attach are on your Mac, so it can work with them. It used to get only what's in them, go looking for them, and sometimes say they weren't on disk.
- The agent and your bots can save a page as a PDF, so "make me a one-page summary as a PDF" gives you a real document, in pages and with its colors, on this Mac or a machine.
- A new bot writes first. When its name says what it's for, like Social Media Manager, it says what it takes its job to be and asks what it needs to start; otherwise it asks what you'd like it to do.
- Text reads lighter and cleaner, most of all light text in dark mode: Kuvo Code draws it as chat apps on the web do, without macOS thickening it.
- The agent reads a long page or list in one step instead of scrolling through it a screen at a time: a job across ten pages took under a minute instead of five.
- The model picker opens on one side of its button and stays there. It used to open above, then jump below when it grew, as you turned to the model list or More models.
- The model picker offers only models you can use: those of accounts you connected, and the free ones. Without an account it used to list paid and GitHub Copilot models too, which failed with "missing required Authorization header".
- Double-clicking an empty part of the title bar, or a card's header, zooms the window, or does what you chose in System Settings › Desktop & Dock. The tabs and project name there used to take the click.
- Undo brings back the files the agent changed in a project opened through a link, like a Dropbox folder: it used to take back only the conversation. Projects you open from now on get this; one opened before keeps working as it did.
- In a machine's browser, a window a page opens, like Continue with Google's sign-in, shows where you are, in Settings' sign-in tab and in the side panel, and closing it brings back the page that opened it. It used to open out of sight, so the button seemed to do nothing.
- Signing in to a site on a machine no longer stays at "Opening…" when the browser was only just set up there.
- A session the model doesn't name (some free models leave it out) is named after the start of your first message, instead of staying "New Session" beside others like it.
- A session started in Plan mode says so at the top ("Plan mode: it explores and plans, without changing files"), instead of showing the engine's note to the model, "<system-reminder>…".
- A bot's turn that only kept its memory up to date says "Updated its memory" and opens it, instead of "Edited 1 file" with Show All Changes leading to an empty list. Show All Changes shows only when the files are ones the Changes panel lists.
- A bot asked to change its model points you to Edit Bot, which lists the models you can use, instead of suggesting ones you have no account for.
- A code block whose first line is long starts below its language and Copy, instead of running in under them where its end was hidden.
- With VoiceOver, the composer's round button reads Send or Stop (it read "Up"); each line of the changes offers Comment on This Line, and each of your messages Copy, New Session From Here and Undo From Here, which otherwise show only under the pointer.
- With VoiceOver, the tabs in the title bar are buttons read by their own names, with Close Tab as an action; in Settings they all read "Back to Sessions" and couldn't be switched.

## 0.5.3

- MCP servers you add give the agent their tools directly, so every model finds them; smaller ones often missed tools behind Code Mode. Servers you already added switch over too, unless you turned Code Mode on. For a server with many tools, turn Code Mode on in its settings to keep each message small.

## 0.5.2

- **Bots get their job from their conversation**: Edit Bot has no job fields any more. A new bot asks "What's my purpose?", and what you tell it becomes its job, kept in its memory and changed as you tell it more; the sidebar shows it in a few words under its name. Starting from a ready-made or shared bot types its job in the conversation for you to send. Your bots' jobs move into their memory.
- Figma connects through Figma's own server: you sign in with your Figma account instead of pasting a token, and the agent gets Figma's own tools. If you'd added Figma, sign in to it once under Settings › Integrations; its token is removed.
- Integrations' servers (Outlook, Apple Calendar, Figma and the others) take about half the memory they did and start faster: each runs on its own, without npx waiting beside it.
- Kuvo Code uses much less memory after launch: it used to wake every bot's folder in the engine, each with its own copy of every integration's server, for an hour. With Outlook connected and a few bots, that was more than a gigabyte.
- When an integration or an MCP server needs something from you mid-task (which account or list, say), it asks in a card above the composer of the conversation waiting on it, and in a notification. It used to wait where you couldn't see it, and the agent stayed stuck until you stopped it.
- Apple Reminders and Calendar can add and change things again: their server asked for a confirmation before each change that Kuvo Code had no place to show, so the change never happened.
- Kuvo Code runs opencode 2.0.32, with the latest list of models, and Gemini replies that come back garbled are tried again instead of ending the turn.
- Settings › General brings over your opencode setup, when you have one: its API keys, model, MCP servers, agents, commands, plugins and skills. It shows what's new before anything changes and replaces nothing here; sign-ins (like ChatGPT's) are named for you to sign in to again, since sharing one between two apps can sign both out.
- The engine starting again (after you add an integration's key, say) no longer leaves it stopped: the one before, exiting a moment late, was taken for the new one.
- New bots can start from Lens, a code reviewer: it reviews a project's changes before they ship (pull requests too, when gh is signed in) and reports what it found, file by file. It takes the place of Bargain, which watched prices.
- A sign-in you give an agent is forgotten after a few minutes, as it's meant to be; it used to stay in memory until Kuvo Code quit. Settings › Keyboard Shortcuts lists New Chat and zooming a machine's page too.
- Keys you give integrations are no longer in the engine's environment, where the agent's own commands (env, say) could print them and send them to the model. This Mac's engine reads them from files only you can read, which go when Kuvo Code quits.
- **Group chats hand out the work**: after the discussion, the lead lists who does what, and each bot does its part in its own conversation, with all its tools, then reports back to the chat. It starts at once if you'd already said to go ahead, or when you click Start the Work; a part that needs another done first waits for it, and a part waiting on you shows Needs You. In the chat itself, bots only talk and look things up.
- Messages agents send each other, and a group chat's work handed to a bot, fold to one line in the conversation; click to open or fold one. Long ones start folded.
- Approve All runs what Settings › Permissions sets to Ask First without asking, as its name says; it used to ask anyway. Don't Allow in Settings now holds in every session: one set to Ask First used to ask about it instead.
- With Outlook and Microsoft 365 connected, every message used to carry all 196 of its tools, about 280,000 tokens, so sessions were slow and costly and small models ran out of room. Now the agent looks up the tool it needs, and each message is about 30 times smaller. Integrations you added earlier get this, and any newer version of their server, on their own.
- In a narrow window, each Settings page's title stays lined up with the settings under it.
- A draft waiting in the composer opens with the cursor after it, instead of all selected, when the window takes a moment to come forward.

## 0.5.1

- Messages waiting for the agent sit in a card tucked behind the composer, with a picture's thumbnail when one is attached. Steer gives a queued message to the agent at its next step without waiting for the run to end, the trash removes it, and ⋯ has Send Now and Edit; double-click a message to edit it.
- Pictures and files you attach in a session on a machine reach its agent: they used to fail with "Unable to read attachment". What the model can read goes with the message; anything else is copied to the machine for the agent to open.

## 0.5.0

- Settings has tabs, like your sessions: each page you open gets a tab of its own beside the others (⌘-click opens one more, even when it's open), and so does a site you sign in to for the agent; ⌃Tab, ⌘1 to ⌘9 and ⌘W work there too, and your tabs are there the next time. Pages line up under their titles.
- Signing in to X, LinkedIn or Reddit for the agent happens right in Settings › Integrations, which shows whether you're signed in on this Mac and on each machine, live as you sign in.
- X opens on your machines: a page opened there at an address used to stay blank on sites that turn headless browsers away.
- Settings › Integrations shows how each one is doing on this Mac and on each machine ("Connected on this Mac and my-server"), with one button when something needs you and the rest in a ⋯ menu. **Sign In…** for a service the agent uses on its site opens it right in Settings, for this Mac or one of your machines, instead of a panel tab that didn't show.
- Settings › Integrations shows Sign In… for Gmail and Google Calendar until you've signed in (they used to say Connected), and says when Outlook hasn't been signed in yet.
- A key you save for an integration reaches the engine and your machines' engines on its own, once whatever's working there is done; there's no Restart Engine button to remember.
- **Integrations work the way you'd expect**: once you connect one, the agent uses its tools directly, on this Mac and on your machines, instead of opening the service's website. Integrations you added before are switched over when Kuvo Code starts.
- Find (⌘F) marks each place your words are, right in the text (replies, code, tables and your messages), the one you're on in orange, with a bar in the corner that counts the results.
- A widget takes shape as the agent writes it, then comes alive when it's done.
- What an agent writes to another shows in its conversation, as "To Scout" with the message, and the answer when it waited for one.
- ⌘F finds in group chats too, as in sessions.
- **Agents write to each other**: any session or bot, on this Mac or a machine, can see who else there is and send one a message, then wait for its answer or carry on. A message from another agent shows who it's from, with Open to go to its conversation. Two agents can't keep writing back and forth unattended.
- **Agents make things you can see and play with**, right in the conversation: charts, diagrams, mockups, small apps and games, or choices to click, drawn live where they made them, in sessions and group chats. What you click in one can answer the agent for you.
- The usage panel does less work: it reads only what's new in Claude and Codex logs, and finds their accounts without holding up launch.
- Kuvo Code runs opencode 2.0.31, with fixes for MCP servers, configured instructions, long conversations and models' reasoning settings.
- **Chats**: conversations of no project, for a question or an idea. Start one with **+** next to Chats or ⌥⌘N; when it turns into work, **Move to Project** carries it, conversation and all, into one of your projects.
- Sidebar sections fold: click Bots, Chats, Projects or Recents to tuck it away.
- With the tab bar hidden, the side panel's button stays at the top right of the window, so the panel is easy to find.
- **Bots**: teammates with a name, a look of their own and one job. Make one with **+** next to Bots in the sidebar: pick its color, shape and face, say what it does, and have it live on this Mac or on one of your machines, in a folder of its own or one of your projects. A bot keeps one conversation, remembers what it learns in a memory file, and can schedule its own wake-ups to carry on later; on a machine, it wakes up and works while your Mac is off. Its steps show when it schedules a wake-up, and each wake-up shows in its conversation.
- **Bots come alive**: a bot's avatar shows what it's up to. It bounces with sparks circling it while it works, hops and glows when it needs you, cheers when it has news, and sleeps with z's floating up until its next wake-up. Idle, it breathes, blinks, looks around and fidgets now and then, and it notices when you point at it. The sidebar counts down to its next wake-up and shows when it's waking up.
- **Group chats for bots**: with two bots or more, start one from **+** next to Bots. Write to the group and its bots talk it through, one at a time, answering each other; the lead goes first and sums up at the end, `@name` asks someone directly, and a bot with nothing to add stays quiet. Write while they talk and the one talking reads it at once; long discussions pause until you say Keep Going. Afterwards, each bot remembers the chat, so you can ask it about one in its own conversation.
- In group chats, `@mentions` stand out: the bot's name in its own color, and in its messages, its face in place of the @. A group chat can also say what it's for, and its bots keep that in mind.
- In group chats, your messages have the time, Copy and **Undo From Here** under the pointer, as in a session; bots' messages have Copy. Undo takes the chat back to before your message and puts it in the composer, and the bots set aside what was taken back.
- In group chats, what a bot did on its turn shows above its message, like "Searched the web 3 times, fetched 2 pages", and opens to each step. When a bot names you ("`@User`"), it stands out in your accent color.
- **Each bot has a model**, picked when you make it or in Edit Bot. Group chats use it; in a bot's own conversation you can still pick another.
- **Personalities for bots**: pick how a bot talks, like Straight Shooter, Skeptic or Mentor, or write your own. It shows in its own conversation and in group chats.
- **Pictures open in the window**: click one you sent to look closer, right away, instead of waiting for Preview. Pinch or double-click to zoom, the arrow keys go to the message's other pictures, and Copy (⌘C) puts it on the clipboard.
- **Kuvo Code's own loader**: the prompt mark draws itself in quiet dashes wherever something's loading or working, and the starting screen shows Kuvo Code's icon.
- A bot moves in one place at a time: where it's working in the conversation in view, otherwise in the sidebar.
- Showing or hiding the side panel or the sidebar no longer makes the conversation flicker and jump: it takes its new width at once while the panel slides.
- Sending a message after an undo no longer makes the conversation flicker: the undone part goes and your message appears in one step. A message that starts the agent no longer flashes in the waiting list above the composer.
- Claude models through GitHub Copilot work again: they failed with "thinking.adaptive.block_binding: Extra inputs are not permitted", on this Mac and on machines.
- The side panel no longer shows a blank tab, its bar stuck in the middle, after the window is closed and opened again. Its terminals and pages also keep running while the engine restarts.
- **A browser on your machines**: agents on a remote machine browse with a browser that runs there, so they keep going while your Mac is off, and `localhost` is the machine. In a session on the machine, the side panel's browser tabs are its pages, live: new tabs open there, pages the agent opens show up as tabs, and you can watch or click and type in them yourself, as sharp as your screen, with scrolling that moves at once. Kuvo Code brings Chromium with everything it needs into `~/.kuvo-code` on the machine, so nothing is installed on the system.
- **Using a machine's browser**: right-click a page for a menu to open or copy a link, zoom with ⌘+ and ⌘− or a pinch (zoomed out, a page lays out as wide as on a desktop), and the pointer turns into a hand over links and a text cursor over fields. What a page downloads stays on the machine; **Save to Mac** copies it into your Downloads folder. It asks sites for your Mac's languages. Agents browsing at the same time, like two bots waking at once, each keep to a page of their own, the panel follows only the agent of the conversation you're in, and the badge over a page names the bot browsing it. Pages only agents used close after half a day left alone. Open pages come back when the browser starts again, after an update or a rest.
- A machine's browser stays smoother over a slow connection: a page that moves, like scrolling or an animation, shows up to about twice the frames per second from a far-away server.
- **A new model picker**, as in Codex: it opens on the model's effort, a slider; click the level and the model above it for the model list, and picking one turns back to its effort, without closing in between. More models lists them all, typing searches them, and the session takes your choice once, when the picker closes. The note in the conversation names the effort too.
- A bot's conversation has just its name at the top; its avatar shows where it lives.
- Two Macs on one machine no longer take turns restarting its engine: the second uses the one that's running.
- The panel's browser handles files: a page's upload button opens the file picker, and downloads go to your Downloads folder, with a bar that shows their progress and **Show in Finder**.
- The panel's browser shows a page's alerts, confirmations and questions in a bar over it. Before, they were skipped, and a confirmation always answered no.
- A step that brings back a picture, like the agent's screenshot of a page, shows it when you open the step; click it to look closer.
- **See where the agent acts**: when it browses, a pointer glides to what it clicks, pulses as it clicks, and rings the field it types into, in your Mac's browser and in a machine's. In the conversation, each browser step has an icon for what it does.
- Agents can list, switch and close browser tabs, attach files to a page's upload, find what they download, accept a page's confirmation when it should go ahead, hover over menus, and wait for a text to show on a page.
- A bot that wakes up, or a conversation's first message in a folder just opened, waits a moment for its tools, so the agent has its browser from the first step.
- In Edit Bot, **Wake Up Now** sends a waiting wake-up right away, to see the bot's job run, and **Pause Wake-Ups** holds them all until you turn it off; the sidebar says Paused meanwhile.
- A bot on this Mac browses in tabs of its own, so one waking up never takes over the page you're on. Its tabs show in the side panel next to yours while you're in its conversation, or a group chat it's in.
- **Wake-ups that repeat**: a bot schedules a recurring job once, like every morning at 9, every 2 hours or on weekdays, and it keeps coming back at the same time of day, across daylight saving changes too, until it's canceled. Before, a bot rescheduled itself after every run, and a run that failed ended the job. Edit Bot shows how often each one repeats.
- In Edit Bot, **Add Wake-Up…** schedules one yourself: pick when, how often it repeats and what the bot does then, without asking it in its conversation.
- **Watches for bots**: to keep an eye on something (a status page, a build, a price), a bot can set a watch: Kuvo Code runs a quick check for it on a schedule, without its model, and wakes it only when what the check shows changes, with what it shows now. Cheaper than waking up every hour just to look. Edit Bot lists them, with Check Now to see what a check shows, the sidebar says Watching, and the bot keeps a lookout, glancing one way and the other.
- **Share a bot**: Edit Bot's **Export…** saves a file with its look, job, instructions and personality (not its memory or wake-ups); opening one (or **File › Import Bot…**) starts a new bot from it, as a template does.
- Ask the agent how to do something in Kuvo Code: it knows where the docs are, and reads the page that covers it rather than guessing.
- **Reply to a message, or part of one**: the reply arrow under an answer (or under a bot's message in a group chat) puts what you selected in it, or all of it, in a Replying To card over the composer; your message goes with the quote above it. In a group chat it names the bot too.
- **Reply from a notification**: when a session or a bot finishes while you're in another app, its notification's **Reply** sends your answer straight to the conversation, like a chat app, without switching to Kuvo Code.
- A bot on a machine that finished while your Mac was asleep or offline tells you once the Mac is back, in a notification like any other, rather than not at all.
- When an agent or a bot asks you a question while you're in another app, the notification shows the question itself, with its choices as buttons (and a field to answer in your own words), so you can answer without switching.
- A bot with news you haven't read shows the start of what it said under its name in the sidebar, as a chat list does.
- **Take Over**: while an agent browses, the badge over the page has Take Over, in your Mac's browser and a machine's. The page is yours until you click Hand Back; the agent's browser steps wait meanwhile, then it's told you were there and sees the page as you left it. The panel's browser on your Mac now shows that badge too, naming the bot that's browsing.
- **Group chats that meet on their own**: in a group chat's editor, turn on Meets on a Schedule, pick a time, how often (every day, on weekdays, every week) and what to go over. At that time the topic goes to the chat and the bots talk it through; while you're away, a notification brings the lead's sum-up, and Reply answers in the chat.
- While an agent or a bot works on this Mac, the Mac doesn't go to sleep on its own, so a long task isn't cut off when you step away; the display can still sleep. Turn it off in Settings › General.
- A bot on a machine whose clock is in another time zone than yours wakes up at the times you mean, in your time zone, its repeats and weekends too.
- When a session or a bot finishes while you're in another app, the notification shows the start of its reply, not just "Finished", and a bot's carries its name.
- **Start a bot from a ready-made one**: New Bot offers bots to begin with, like a morning news digest, a page watcher, a price tracker, a researcher, a build keeper and a morning standup, each with a job, instructions and a look to change as you like. A new bot's conversation offers **Start Its Job**, which sets it going: it asks for what it needs and schedules its next run.
- For a site you choose, agents can sign in on their own with its saved password: tick **Let agents sign in here on their own** in the sign-in card. It still goes straight into the page, you get a notification, and **Settings › Passwords** lists those sites to turn off.
- **Agents can sign in for you**: when a page wants a sign-in, the agent asks in its conversation, like a permission request. Type your username and password there (or pick a saved one) and they go straight into the page, in your Mac's browser or a machine's; the agent and the model never see them, and they're blanked out of what the agent reads and its screenshots. It asks the same way for a two-step code, and for a step only you can do, like approving the sign-in on your phone. The conversation shows the hand in the sidebar until you answer.
- After your Mac wakes, a machine that lost its connection while it slept connects again by itself.
- A machine whose connection stopped working without closing (its engine restarted behind it, say) is noticed within seconds and connected again by itself, and it keeps trying for half an hour. Meanwhile a bar over the composer says so, with **Connect Now**, and sending waits, rather than failing with an error.
- **Integrations**: let the agent and your bots work with your mail, calendars, chats, socials and code tools, in **Settings › Integrations**. Each connects the best way it has: its maker's own server where you sign in once (Fastmail, GitLab, Linear, Notion, Jira, Calendly), with a token or app of yours (GitHub, Slack, Gmail, Google Calendar, Asana, Zoom), through an open-source server with a key you bring (Outlook, Apple Calendar and Reminders, CalDAV calendars, Todoist, Figma), or on its site in the panel's browser (Discord, Telegram, WhatsApp, X, LinkedIn, Reddit, Bluesky, Mastodon). Keys stay in your Keychain.
- Outlook's sign-in reaches your machines too: sign in with its code once, on this Mac or a machine, and both have it.
- Integrations you sign in to, like Notion or Linear, work on your machines too: the sign-in is copied to each machine's engine and kept in step, so a bot there uses Notion's own tools instead of opening its website. Ask about a connected service and the agent reaches for its tools first. **Remove** now signs you out properly, here and on your machines.
- Bots, the loader and the shimmer on "Working…" move without costing you battery: their motion is now played by the system's animation engine on the GPU, so Kuvo Code at rest with bots in the sidebar uses next to no CPU, where it used about a third of a core, and a session at work no longer pays for its spinners and shimmers (three took a tenth of a core, even with the window hidden).
- Your bots, group chats and personalities are safe from a file that won't read: it's set aside next to itself as `.unreadable.json` instead of being written over with an empty list.
- A machine's browser has the same toolbar as this Mac's: its More menu now zooms and opens Browser Settings too.
- Copy Path copies the whole path everywhere; in Changes, Copy Relative Path gives it from the project, and a step that touched a file can copy its path too.
- Escape closes a custom provider's settings, as it does an agent's, a command's or an MCP server's.
- Shift-Return starts a new line where the cursor is, not at the end of what you've written, in sessions and group chats.
- Group chats quote as sessions do: each part you reply to goes over the composer with a line for your answer, and one message can answer several. Opening a group chat with a draft puts the cursor after it, instead of selecting it.
- Group chats scroll as sessions do, with the button back to the newest message when you scroll up; and sending in a session takes you back to the end, as in a group chat.
- Long conversations can be read from the start: scrolling to the top reads the messages before, 200 at a time, and keeps your place. Before, only the latest 200 showed. Find offers **Search Earlier**, to look through all of it.
- Long conversations stay smooth while the agent writes: only the reply being written is drawn again, not every message before it.
- A conversation no longer opens blank until you show or hide the side panel: when its rows turned out shorter than first guessed, it could stay scrolled past its end.
- Answering many quotes at once no longer fills the window: past a few, they scroll above the message field, with the one you're answering in view, and **Remove All** clears them.
- **Accounts** opens in Settings, from the sidebar's menu or ⇧⌘K, instead of a sheet of its own.
- Signing in to an integration ends on a sheet that fits what it says, with the service's own name and what you can do now.
- New bots to start from: **Compass** plans your day from your calendar and mail, **Courier** keeps up with your inbox and drafts replies, and **Echo** keeps up with your mentions on social sites. They use your integrations, or the browser without them, and never send anything without asking.
- On your machines, the engine and what it runs keep their temporary files in `~/.kuvo-code` rather than `/tmp`, and on this Mac in Kuvo Code's own temporary folder.
- Long conversations scroll more smoothly: the transcript isn't worked out again as you scroll, and short messages skip the measuring and masking only long ones need. A whole history opening at once no longer fades in row by row.
- Kuvo Code uses much less power at rest: bots' animations pause while its window can't be seen, and a resting bot moves with fewer frames.
- The agent's steps between its replies are summed up in a line, like "Ran 6 commands, read 3 files", that opens to each; the step under way still shows while it works. Settings › Appearance › Agent's steps shows each step again, or only how many there were.
- Replying to several parts at once: select text in the conversation and choose **Add to Chat** (or **Copy**) in the menu over it, as many times as you like. Each part goes over the composer with a line for your answer, and your message shows each quote with its answer. The reply arrow under a reply quotes all of it.
- Ask the agent to show you a file or folder, and it opens it in the side panel: a folder in Files, open down to it, a file in a tab of its own. It works on your machines too.
- Expanding the side panel is one smooth motion: the panel widens over the conversation, rather than the two fading through each other, and collapsing it brings the conversation back just as it was.
- When something in a session doesn't work (a message that didn't go, an undo), it says so in a bar over the composer, rather than an alert you have to click away.
- The agent's questions have a new card: one question at a time (‹ 1 of 3 ›), its choices numbered (press a number to pick one, and a choice goes on to the next question), a line to write your own answer, **Skip**, and **×** to dismiss them all. A long one scrolls inside the card, so the window no longer stretches and the composer stays in view.
- A remote machine's sessions stay in the sidebar, and keep their conversations on screen, while the machine reconnects or connects at launch, so you can read them meanwhile. The bar over the composer says whether it's connecting, reconnecting or couldn't, and things that need the machine, like Undo, wait for it.

## 0.4.0

- **A new Settings**, in the main window in place of your sessions: ⌘, opens it, and the back arrow or Esc returns to where you were. Its pages are in groups in a sidebar, with a search field, each in a card under its title. New pages: Appearance, Notifications, Keyboard Shortcuts, Privacy, Storage, Git, Worktrees, Archived Sessions, Browser and Passwords.
- **Appearance**: pick an accent color (macOS's own, one of its colors, or any color), a frosted or solid window, and the conversation's text size and typeface, with a live preview.
- **Storage** shows what Kuvo Code keeps on your Mac, by kind, and cleans up sessions you haven't used in a while, logs, and the engine download kept for machines.
- **Passwords in the panel's browser**: it offers to save a password when you sign in to a site, in your login keychain, and fills it in when you click the key in its toolbar. It never fills one in on its own, and the agent never sees them. Settings › Passwords shows, copies or deletes them.
- **Archived Sessions** brings archived sessions back or deletes them. **Worktrees** lists sessions' worktrees with their size. **Git** sets what sessions' branches start with, and instructions for the commit messages and pull requests Kuvo Code writes. **Browser** lists the sites that keep data in the panel's browser, to remove one at a time.
- Code and text files can open in the editor you choose, in Settings › General. Notifications can go without a sound, and the Dock count has its own switch.
- **Run a command yourself**: start a message with `!`, like `!npm test`, to run it in the session's folder (on the server, for a project on a remote machine). The composer switches to a shell look while you type it, and the command shows in the conversation with its output, which the agent sees with your next message.
- The welcome screen shows Kuvo Code's own icon.
- **The row at the bottom of the sidebar opens a menu**: your accounts, how much your plans have left and when they reset, your machines and how they're connected, Settings, and Help, with the docs, what's new and a way to report an issue. The Help menu has the same links.
- **Remote machines**: open projects on a Linux server you reach with SSH, like a home server or a VPS, next to your Mac's. Add one in Settings › Machines, or under Location in New Project. Kuvo Code installs its engine there and runs the project's sessions on it; Changes, Files, the terminal and Run work on the machine too. A task carries on while your Mac sleeps or is off, and its work is there when you come back. Your API keys and GitHub Copilot sign-in go along, held in memory, and if the connection drops, Kuvo Code reconnects by itself.

## 0.3.0

- **A livelier look.** Cards have lit edges instead of gray outlines, the window's glass picks up your desktop's color, and your messages, the selected session and the send button are tinted with your accent color. Code sits in one recessed block, and the agent's steps open inline. Dark mode is deeper and cooler, with brighter code colors; in light mode the window's frame is a bright warm ivory whatever your wallpaper.
- Messages fade out under the conversation's header instead of being cut off, and run on under the composer.
- **A quieter composer**: no outline, smaller corners, and its buttons stay in the background until you point at them.
- **Hide the tab bar**, the whole row at the top, with View › Hide Tab Bar (⌥⌘T) or in Settings › General: the cards reach the top of the window, with the sidebar button next to the window's own. Switch sessions from the sidebar or ⌘K.
- **Open With**: the file viewer's Open button has a menu beside it, and the Changes tab's ⋯ menu an Open With submenu, listing the apps that open the file with their icons, the default first, and Other… for any app.
- The side panel's new tab page fits a narrow panel: its tools stack in one column instead of breaking their names.
- **Many tabs in the side panel** stay readable: each keeps its name, and past what fits the row scrolls sideways, fading at the edge with more and keeping the chosen tab in view.
- **New Project and Edit Project** read as one form: the folders are rows of a field like the name, with adding one as its last row, and Run and Worktree Setup are fields of their own.
- The sidebar sits on the window's glass instead of a card of its own, its rows lined up under the window's buttons, and the tabs start where the conversation does.
- **Files a reply names look like files**: an icon and the name in link color, instead of code.
- **Settings**: long tabs open at the top, Accounts fits each provider's name, and clearer labels in Engine and Panel. New agents, commands and servers are named in their sheet, which says why a name can't be used, and Cancel leaves nothing behind. Escape closes every editor, keys and tokens show as dots until you click them, signing in has one set of buttons, and a rejected API key keeps what you typed.
- Fixed: Add Rule in Settings › Permissions set Edit Files to Allow.
- Fixed: switching an MCP server between this Mac and the web could lose its command, and a new web server stayed off.
- Fixed: on a Mac set to Turkey's region, percentages read "%21"; they read "21%" now.
- Fixed: switching sessions from Recents briefly highlighted the other session under its project.
- Fixed: the tabs started far from the project's name, and the branch's hover fill covered the name.
- **You can tell what's clickable.** Buttons, icons, menus and rows light up under the pointer: the icons under messages and replies, Copy on code blocks, the branch name (now with a menu chevron), the Changes tab's menus and file headers, the agent's steps, pick lists, attachments, tabs and more.
- **Code blocks have line numbers.** Copying, whether with Copy or by selecting part of the code, leaves them out.
- **The usage panel follows the accounts you connected in Kuvo Code**: GitHub Copilot, ChatGPT (Codex), OpenCode, OpenRouter and Z.ai. Connecting one turns it on; tools signed in elsewhere on your Mac, like Claude Code, no longer show up. One with no usage to read stays out of the panel, and Customize says why.
- **Clicking a provider's bar in the usage panel** opens its limits, spend and trend in the same style as the bars, instead of the old card.
- **Review** button in the Changes tab: the agent reviews what the tab shows, with /review.
- **Add Screenshot to Message** in the panel's browser attaches what's on the page to your message.
- Click a picture in the conversation to look closer in Quick Look.
- **Bring your Claude Code agents and commands.** Settings › Agents imports the agents in ~/.claude/agents as subagents, with their descriptions and instructions, and Settings › Commands imports the slash commands in ~/.claude/commands.
- **Attempts.** Under Worktree in a new session's composer, pick 2, 3 or 4 sessions to try the same task, each in a worktree of its own, then compare them and keep the best.
- **Search what was said.** The sidebar's search also looks in conversations, and shows the words around each match; clicking one opens the session with Find on it.
- **Switch branches from the title bar.** Click the branch under the project's name for the repository's branches, latest first, or New Branch….
- **Write your own skills** in Settings › Skills: New Skill… takes a name, when the agent should use it, and its instructions. Edit… changes it later.
- **Answer permission requests from the notification.** When the agent asks while you're in another app, the notification has Allow, Always Allow and Deny buttons.
- **Popular MCP servers in one click.** Settings › MCP lists well-known servers, like Linear, Sentry, Notion, Atlassian, Stripe, Supabase, Neon, Context7 and Hugging Face, each from the company behind it. Add one, and sign in if it needs an account.
- **Create Pull Request** from the Changes tab on any branch other than the main one: it pushes the branch and opens the pull request page on GitHub or GitLab, with a title and description the session's model wrote from the branch's changes.
- **This Session** in the Changes tab shows only what the session's agent changed, apart from your own edits and other sessions'.
- Fixed: outside a git repository, the Changes tab listed the agent's edits without their lines.
- **Command palette (⌘K).** Find a session in any project, a file in this one, or something to do, from New Terminal to any Settings tab, with its shortcut. Before you type, it lists your latest sessions.
- **Run your app with one click.** Give a project a run command, like npm run dev, in Edit Project; the play button in the title bar, or ⌘R, runs it in a terminal in the panel, in the session's folder or worktree. Run again to start it over.
- **Worktrees.** Pick Worktree in a new session's composer and the agent works in its own copy of the project, on a branch of its own named after the session, so several sessions can work at once without touching each other's files or yours. The Changes tab shows everything the branch changed, and its branch menu merges the work into your branch or pushes it and opens a pull request. Archiving the session offers to remove the worktree. A setup command in Edit Project runs in each new worktree, to install dependencies or copy files like .env.
- **Since main** in the Changes tab shows everything a branch changed since it left the main branch, committed or not.
- **Open a folder from outside the app.** Drop it on the Dock icon, choose Open With › Kuvo Code in the Finder, or run `open -a "Kuvo Code" <folder>`, and it opens as a project with a new session. Right-click the Dock icon for your latest sessions and New Session.
- **The engine is opencode 2.0.29.** A reply that runs past the model's length limit now carries on by itself, and the transcript says so in a line.
- **Anonymous usage.** Kuvo Code now shares which features get used and how often, with the app and macOS versions, so work goes where it matters. Never your code, prompts, files or accounts. A note at first launch says so, and you can turn it off there or in Settings › General.

## 0.2.0

- **Set up the agent in Settings.** New Agents, Permissions, MCP, Skills and Commands tabs, and more under Engine, cover what opencode's settings file does: your own agents and their instructions, what the agent may do without asking, MCP servers with their status, slash commands, web search, summaries and more. Changes apply right away.
- **Add your own providers** in Accounts: a company proxy, a self-hosted server or any service with an OpenAI- or Anthropic-compatible API, with its models.
- **Add skills from popular collections on GitHub** in Settings › Skills: see what a skill's files are, add it, and turn any skill on or off.
- **A project can have several folders.** New Project (⇧⌘N, or + next to Projects) names a project and adds its folders; sessions run in the primary one, and the agent can work in the others too and knows them by name. Right-click a project for **Edit Project…** to rename it or add and remove folders.
- The **Files** panel lists all of a project's folders, and its filter looks in all of them. The **Changes** panel has a folder menu to show each folder's changes, and comments there name the folder.
- **Type / for commands:** /init sets up an AGENTS.md that tells the agent about your project, and /review reviews your changes. The conversation shows the command, not the long prompt behind it.
- **Type @ in the composer to mention a file** from any of the project's folders, picked from a list that starts with the files you changed last and narrows as you type.
- **⌘Return queues a message** until the agent is done. Queued messages go one after another, as many as you like, and a message sent with Return while the agent works still reaches it first, at its next step.
- **Messages waiting for the agent are listed above the composer.** Send one now (the agent stops its current step and takes it), put it back in the composer to edit (or press ↑ in an empty composer), or remove it.
- Stop pauses the queue, and so does a failed run, instead of sending the rest into the same error. **Resume** picks it up again.
- **Undo from any of your messages:** hover over it and click Undo From Here to take back the conversation and the agent's file changes since, with the message back in the composer to edit. Redo brings it all back until you send.
- **New Session From Here**, under one of your messages, starts a new session with the conversation up to it, to try another way while keeping this one.
- **Try Again** under a failed run sends your last message again, in place of the failed attempt.
- **Build It** under an answer in Plan mode switches to Build and has the agent carry the plan out.
- **Summarize Now** in the context ring's popover shrinks a long conversation to a summary, to make room before the context window fills up.
- **Files a reply names open with a click**, in the side panel.
- **Open Quickly (⇧⌘O)** finds a file in the project by name and opens it in the side panel.
- **Add to Message**, when you right-click a selection in a file or a terminal in the side panel, puts those lines (as `@src/app.ts:4-6`) or that output in your message.
- When the agent runs code that calls its tools (Code Mode), the step reads "Ran code" and opens to show the code and what it returned.
- **See what a subagent is doing.** When the agent hands part of the task to a subagent, its step opens to show what it was asked and each step it takes, live, then what it found and the tokens and cost it used.
- **Under each reply, "Edited 3 files"** lists what that turn changed, with lines added and removed, each a click from the panel.
- **Commit from the Changes panel**, and push afterwards if you like: Commit… takes what's staged, or all the changes shown, and the session's model can suggest the message.
- **Stage, unstage or discard a file's changes** from its menu in the Changes panel. Discarding asks first, and a new file goes to the Trash.
- **Notifications:** when a session finishes or needs your answer while you're in another app, you get a notification that opens it, and the Dock icon counts the sessions waiting for you. Settings › General turns them off.
- **Pin sessions** you keep coming back to: they stay at the top of the sidebar.
- **Search sessions** from the top of the sidebar, by title or project.
- **Archive sessions** you're done with: they leave the sidebar's lists, and searching still finds them.
- Right-click a session's tab to rename it.
- **Copy or export a conversation as Markdown** from the session's menu in the sidebar, to share it in an issue or a chat.
- **⌘W closes the session tab**, and ⇧⌘T reopens the last one you closed, where it was. ⇧⌘W closes the window.
- A long message, like a pasted log, shows its first lines in the conversation until you click **Show More**.
- **⌘F finds words in the conversation**, highlighting each message they're in.
- **↑ and ↓ in an empty composer go through the messages you sent**, as in a shell.
- What you type in the composer stays there when you switch to another session, and when you quit the app.
- Copy buttons under each reply and, when you hover, under each of your messages.
- Code blocks show their language and have their own **Copy** button.
- Hovering over one of your messages shows when you sent it.
- Right-click a project and choose **Open In** to open it in your editor, terminal or git app.
- Right-click a step that read or changed a file to open the file in the panel or show it in the Finder.
- ⌘1 to ⌘8 show that session tab, and ⌘9 the last one, as in browsers.
- Escape in the composer stops the agent, as ⌘. does.
- While the agent works, the end of the conversation shows how long it's been at it.
- Scrolled up in a conversation, a button takes you back to the newest message.
- A step you stopped, with Stop or Send Now, shows as stopped instead of as a red error.
- The panel no longer shows scroll bars, which took a strip off its content on Macs set to always show them.
- A long conversation sometimes opened part of the way up instead of at its newest message.

## 0.1.2

- **Signing in with Google, Apple and others works in the panel's browser.** Sign-in windows open in their own tab and close themselves when you're done, back on the site you were signing in to.
- **Click the context ring at the top of a conversation** to see what it measures: how full the model's context window is, what the session has cost, and your plan's limits when the usage item follows that account.
- **The terminal sits right on the panel**, in the panel's own color, with no darker box around it and no scroll bar track.
- Links that open a new window always open in a new tab, as in other browsers, so that setting is gone.
- Searching Accounts for a provider that isn't there says so, with a button to clear the search, instead of showing an empty box.
- Closing the panel's last tab leaves a new tab in its place, instead of an empty panel.
- The panel button at the top right of the window is a plain icon, like the sessions button at the top left, and it's the one place to show and hide the panel.
- A narrow panel with a file open no longer spills over the conversation; the file list next to the file gets narrower instead.
- Files and changed lines in the Changes panel are plain rows, not rounded boxes with notches at the edge.
- The line beside a file's line numbers no longer runs up through the file's header.
- The spinner on a working session's tab no longer flies in from the corner of the window.

## 0.1.1

- **Deleting a session asks first**, since it can't be undone.
- **API keys you paste into the usage panel are kept in your Keychain**, not in a file. Keys saved by 0.1.0 move there on their own.

## 0.1.0

Kuvo Code's first public release: a native Mac harness for coding agents that works with any model, on the opencode engine.

### Highlights

- **Any model.** Sign in with a subscription you already have, add an API key, or start with free models that need no account. Pick the model and effort for each message.
- **Built for the Mac.** SwiftUI and Liquid Glass on macOS 26. Sessions sit under their project in the sidebar, transcripts update live, and edits and commands open to show what they did.
- **Review changes like a pull request.** The Changes tab shows the project's uncommitted changes from git, with unchanged lines folded and pictures shown before and after. Comment on any line, and your comments go to the agent with your next message.
- **Files, terminals and a browser.** The side panel holds them as tabs: the project's files with code highlighted and Markdown rendered, your shell in the project folder, and a web browser. A new tab offers the tools and the sites you visit most, and Settings › Panel sets it up the way you like.
- **Browsing for the agent, with any model.** The agent can open pages in the panel's browser, read them, click, type and scroll, and you see every step.
- **Attach anything.** Drop, paste or pick files of any kind. Pictures show up in the transcript.
- **Plans and spend in the menu bar.** One bar per provider shows the limit closest to running out; click it for pace, reset times and spend for today and the last 30 days. Covers Claude, Codex, Copilot, Cursor, OpenCode, OpenRouter, Z.ai and more.
- **Build and Plan modes.** Plan mode talks a change through before making it. With **Ask First**, the agent asks before it edits files or runs commands.
- **Updates itself.** Kuvo Code checks for signed updates once a day and shows what's new before it installs one. **Kuvo Code › Check for Updates…** checks right away.
- **Kept apart from your own opencode.** The engine is the official opencode, unmodified, with its sessions, accounts and settings in Kuvo Code's own folder.
