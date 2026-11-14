// The tools `kuvo-browser.js mcp` gives agents, as models see them: each one's name, what it's for
// and its input schema. The browser's own (`browser_…`), and Kuvo Code's own, which the box carries
// out (`letters/own-tools.ts`: writing to other agents, sessions, wake-ups, goals…). The vault's,
// the sandbox's and the Work Queue's come from the box itself as they're listed.
// This Mac's panel still lists a copy of its own (BrowserTools.definitions, in the app's
// BrowserToolServer.swift) until its agents browse in its box's browser (#693): change both, as
// KuvoCodeTests/BrowserToolsOnBoxTests.swift holds them to each other.

/** A JSON value, as a tool's input schema holds them. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: { [name: string]: Json }; required?: string[] };
}

/** A tool: `required` only where it names something. */
function tool(name: string, description: string, properties: { [name: string]: Json } = {}, required: string[] = []): Tool {
  return { name, description, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

export const TOOLS: Tool[] = [
  tool("browser_navigate", "Open an address, or search for words, in the browser panel the user sees. Returns the page as numbered elements.",
    { url: { type: "string", description: "An address like example.com, or words to search for." } }, ["url"]),
  tool("browser_snapshot", "Read the current page: title, address, scroll position, and its interactive elements numbered like [3], with visible text."),
  tool("browser_click", "Click the element with this number from the latest snapshot.",
    {
      accept_dialog: { type: "boolean", description: "Accept a confirmation or prompt it opens (declined otherwise)." },
      index: { type: "integer" },
    }, ["index"]),
  tool("browser_type", "Type text into the input with this number, replacing what's there unless clear is false.",
    {
      clear: { type: "boolean" },
      index: { type: "integer" },
      submit: { type: "boolean", description: "Press Enter afterwards." },
      text: { type: "string" },
    }, ["index", "text"]),
  tool("browser_select", "Choose an option, by its text or value, in the drop-down with this number.",
    { index: { type: "integer" }, option: { type: "string" } }, ["index", "option"]),
  tool("browser_scroll", "Scroll the page up or down by screens (1 by default).",
    { direction: { type: "string", enum: ["up", "down"] }, pages: { type: "number" } }, ["direction"]),
  tool("browser_press", "Press a key on the focused element: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight or Backspace. Type text with browser_type.",
    {
      accept_dialog: { type: "boolean", description: "Accept a confirmation or prompt it opens (declined otherwise)." },
      key: { type: "string" },
    }, ["key"]),
  tool("browser_back", "Go back a page."),
  tool("browser_forward", "Go forward a page."),
  tool("browser_text", "Read all of the page's text at once (an article, docs, a list or a table), without scrolling."),
  tool("browser_screenshot", "See the visible part of the page as an image (for models that take images). With show, the user sees it too, in this conversation: use it whenever they ask to see the page or for a screenshot.",
    { show: { type: "boolean" } }),
  tool("browser_save_pdf", "Save the page as a PDF, in pages as printing would, with its colors. To make a document to share (a report, an invoice), write it as an HTML file, open it with browser_navigate (file:///…), then save it here.",
    { path: { type: "string", description: "A full path ending in .pdf." } }, ["path"]),
  tool("browser_wait", "Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).",
    { seconds: { type: "number" }, text: { type: "string" } }),
  tool("browser_hover", "Move the pointer over the element with this number, for menus and tips that open on hover.",
    { index: { type: "integer" } }, ["index"]),
  tool("browser_new_tab", "Open a new browser tab in the panel, optionally at an address.",
    { url: { type: "string" } }),
  tool("browser_upload", "Attach files to the file input with this number (or its upload button), as choosing them in the file picker would.",
    {
      files: { type: "array", description: "Their full paths.", items: { type: "string" } },
      index: { type: "integer" },
    }, ["index", "files"]),
  tool("browser_tabs", "List the browser's tabs (numbered, the one in use marked), switch to one to work in it, or close one.",
    {
      action: { type: "string", description: "list by default.", enum: ["list", "switch", "close"] },
      tab: { type: "integer", description: "Its number, to switch to or close." },
    }),
  tool("browser_sign_in", "Sign in with the user's own username and password: from their vault where this conversation may use one of its sign-ins on this site (it fills on its own), or else they type or pick one in Kuvo Code. They go straight into the fields you name; you never see them. Use it for every sign-in. Whenever a page you open asks to sign in, call it right away, even if the user didn't mention signing in: its card asks them, and they can say Not Now there, so never ask in the chat whether to sign in, nor for a password. Name the fields the page has now (where the username and the password are on pages of their own, call it on each; the user answers once). Then submit the form yourself.",
    {
      item: {
        type: "string",
        description: "A sign-in from vault_items, by name, when more than one could do. It's filled only on its own site.",
      },
      password: { type: "integer", description: "The password field's number, if the page has one." },
      username: { type: "integer", description: "The username or email field's number, if the page has one." },
    }),
  tool("browser_fill", "Fill one field from the user's vault: a sign-in's username or password, or a key's or a note's field, by the item's name from vault_items. It's filled only on the item's own sites, and you never see it.",
    {
      field: {
        type: "string",
        description: "Which of its fields, when it has more than one (vault_items lists them).",
      },
      index: { type: "integer", description: "The field's number." },
      item: { type: "string" },
      why: { type: "string", description: "Why you need it, in one sentence the user reads." },
    }, ["index", "item"]),
  tool("browser_ask_code", "Ask the user for a one-time code (from a text message, an email or an authenticator app), which goes straight into the field with this number; you never see it. Then submit it if the page doesn't on its own.",
    {
      index: { type: "integer" },
      prompt: {
        type: "string",
        description: "What to tell the user, like \"Enter the 6-digit code texted to your phone\".",
      },
    }, ["index"]),
  tool("browser_ask_user", "Ask the user to do something on the page themselves: a CAPTCHA, approving the sign-in on their phone, anything you can't do. Waits until they say it's done (up to 15 minutes), then reads the page again. Not for a question or a choice: ask those with your question tool, or in your reply.",
    { instruction: { type: "string", description: "What they should do, in a sentence." } }, ["instruction"]),
  tool("show_in_panel", "Show the user a file or folder in Kuvo Code's side panel, beside this conversation: a folder in the Files tab, a file in a tab of its own (code, Markdown, pictures and PDFs show as they are). Use it whenever the user asks to see, open or find something, and to point them to what you made or found.",
    { path: { type: "string", description: "Its full path." } }, ["path"]),
  tool("show_file", "Put a file in this conversation, where the user reads your replies: a picture shows large, any other file (a PDF, a document, a spreadsheet) as a card they open. Use it to show what you made or found when seeing it helps, and always when the user is on their phone (their message ends with a <from-phone> block), where file paths and the side panel don't reach them.",
    {
      caption: { type: "string", description: "A line shown under it." },
      path: { type: "string", description: "Its full path." },
    }, ["path"]),
  tool("mark_final", "Mark a file you made as final once it's ready for the user (a report, a document, a picture): it's kept at the top of what you made, where they find it with every version.",
    {
      note: { type: "string", description: "A few words on it, like who it's for." },
      path: { type: "string", description: "Its full path." },
    }, ["path"]),
  tool("show_widget", "Show the user something to look at or play with, live in this conversation where this call is. Make one only when it does a job words can't: a chart of numbers you measured, options to see side by side with a choice to click, a value to tune with an instant preview, or a table to sort or filter. Not for a plain choice between named options (ask with your question tool, if you have one), a diagram (write a ```mermaid code block in your reply; a widget only when it needs something to click), what a sentence or a short list says, code (use a code block), or decoration. Keep it to one view with a control or two, built from the data you actually have (never invented numbers); don't repeat it in your reply, but add a line on what to do with it. It can't be opened larger: design it for the reply's width, and narrow enough for a phone (360 points). It's as tall as its content, up to about 760 points (less on a phone), then it scrolls. It has no frame: don't put the whole of it in a card or box of its own. Write the HTML (a fragment or a whole page) with its CSS and JavaScript inline; libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com (Chart.js, D3, Mermaid, Three.js, Leaflet with its map tiles); pictures from anywhere. It can't fetch data or send anything, so put the data in the page. It starts in Kuvo Code's look, light and dark: transparent, with buttons (class primary for the main one), fields, tables and headings styled, the classes kuvo-card, kuvo-chip and kuvo-row, and colors by name: var(--kuvo-accent), var(--kuvo-1) to var(--kuvo-6) for a chart's series, var(--kuvo-good) and var(--kuvo-bad), var(--kuvo-secondary) for quieter text, var(--kuvo-line) and var(--kuvo-fill). Use those rather than a palette of your own, and make anything you style yourself work in light and dark (prefers-color-scheme). Anything your script draws (Chart.js, D3, a canvas) takes its colors from those variables, read with getComputedStyle(document.documentElement).getPropertyValue('--kuvo-1') (and --kuvo-text, --kuvo-secondary, --kuvo-line for labels and grid), and draws again when matchMedia('(prefers-color-scheme: dark)') changes; otherwise it's loaded again in the new look, losing what the user did in it. To hear back, call kuvo.send(text) from a click in it: the text comes to you as the user's message, ending with a <from-widget> block that names the widget by its title, so give each a title of its own.",
    {
      html: { type: "string" },
      title: {
        type: "string",
        description: "A short name for it, shown while you make it, if it can't show, and on what the user sends from it. Write it before the HTML.",
      },
    }, ["html"]),
  tool("list_agents", "List the agents you can write to with send_message, or read with read_conversation: the user's bots and their other recent sessions, on their Mac and their machines, each with its name, where it runs and its address."),
  tool("read_conversation", "Read another agent's conversation (from list_agents, or one the user names with &): what was written to it, its replies, and a line for each step it took, oldest first. Use it to learn what it did, decided or found, to pick up where it left off, or to follow it, without interrupting it. A long one gives its start and its latest part; with query, the parts that mention it.",
    {
      of: { type: "string", description: "Its name or address." },
      query: { type: "string", description: "A word or phrase to find in it." },
    }, ["of"]),
  tool("send_message", "Write to another agent (from list_agents), to hand off work, ask for help or information, coordinate, or report back: it reaches that conversation as a message from you, and its agent takes it up. With wait, its answer comes back here (up to ten minutes); without, it can answer with send_message later. A message from another agent reaches you the same way, saying who it's from.",
    {
      text: {
        type: "string",
        description: "What to say: all it needs to know, as it hasn't seen this conversation.",
      },
      to: { type: "string", description: "Its name or address." },
      wait: { type: "boolean" },
    }, ["to", "text"]),
  tool("schedule_wake_up", "Come back to this conversation later, even while the user is away: at `when`, it gets your note as a message starting with \"[Wake-up]\", and you carry on from it. With every, it comes back again and again until it's canceled. Never say you can't come back later or run on a timer: schedule a wake-up instead.",
    {
      every: {
        type: "string",
        description: "30m, 2h, 1d, 1w (at least 5m), or weekdays. Days, weeks and weekdays keep its time of day. When it's due now too, also do the first round now.",
      },
      note: {
        type: "string",
        description: "What to do then, as a note to yourself, starting with what to do. It comes to this conversation, in its folder, so leave those out.",
      },
      summary: {
        type: "string",
        description: "One short line the user sees for it, like \"Check whether CI passed\".",
      },
      when: {
        type: "string",
        description: "+20m, +2h, +1d, or a time like 2026-10-21T09:00 on the user's clock; at least a minute from now.",
      },
    }, ["when", "note"]),
  tool("watch_for_change", "Wait for something to change without checking yourself (CI finishing, a deploy, a status page, a price, a file): every so often its check, a shell command, runs in this conversation's folder for at most a minute, and this conversation wakes with your note and the new output only when what it prints changes (not the first time). Make it print just what you watch, like gh run list --limit 1 --json status,conclusion -q '.[0] | .status + \" \" + .conclusion' or curl -s <url> | grep -o '<the part that matters>', so a clock or an ad on the page doesn't count as a change. Only what it prints counts, and printing nothing counts too. A run is skipped when a curl, wget or gh in it fails, or when it prints nothing and exits 2 or more. To watch whether a site is up, print its status code: curl -s -o /dev/null -w '%{http_code}' <url>.",
    {
      check: { type: "string" },
      every: { type: "string", description: "How often: 5m or more, 2h, 1d." },
      note: { type: "string", description: "What to do when it changes." },
      summary: {
        type: "string",
        description: "One short line the user sees for it, like \"Check whether CI passed\".",
      },
    }, ["every", "check", "note"]),
  tool("list_wake_ups", "List this conversation's wake-ups and watches, with their ids. Check it before adding one: never keep two for the same thing."),
  tool("cancel_wake_up", "Cancel one of this conversation's wake-ups or watches by its id from list_wake_ups (or the one schedule_wake_up or watch_for_change gave). To change one, cancel it and set the new one.",
    { id: { type: "string" } }, ["id"]),
  tool("set_job", "Keep your job, as one of the user's bots. Call it whenever the user gives you a job or changes it, before anything else, with the whole job as it is now: it replaces the one you had. Only a bot keeps a job.",
    {
      clear: { type: "boolean", description: "true to clear the job." },
      details: {
        type: "string",
        description: "Only what the user asked for, as close to their words as you can: what to do, watch or make, when, and any rule or limit they gave. Never how you'll work, who does the work, or a rule or limit they didn't give.",
      },
      job: { type: "string", description: "Alternative to summary." },
      summary: {
        type: "string",
        description: "What you do, in a few words, like \"Keeps the build green\" (shown under your name).",
      },
    }),
  tool("start_session", "Start a new session: another agent with a conversation of its own, working alongside you (a separate task, a second opinion, one part of a bigger job). It gets the task as a message from you, so it knows who to report to, and the user finds it under this conversation in their sidebar, to follow and talk to. You get its address to write to it with send_message; it can write back the same way. A bot is woken when its sessions finish or ask (wake), so it never checks on them. With computer, it starts on another of the user's computers, as if you lived there.",
    {
      approval: {
        type: "string",
        description: "askFirst asks before it edits or runs commands, acceptEdits edits on its own and asks before commands, auto works on its own inside the sandbox, fullAccess asks nothing. Yours by default, and never more than yours.",
        enum: ["askFirst", "acceptEdits", "auto", "fullAccess"],
      },
      chat: { type: "boolean", description: "Start it as a chat, in no project." },
      computer: {
        type: "string",
        description: "Another of the user's computers, by its name in list_agents: this one by default. Its project from list_projects there.",
      },
      effort: { type: "string", description: "One of the efforts list_models gives for the model." },
      folder: {
        type: "string",
        description: "A full path: this conversation's folder by default. With project: a folder in it or one of its worktrees, else it's refused.",
      },
      mode: {
        type: "string",
        description: "plan: it plans first and changes nothing until it's told to go on. build by default.",
        enum: ["build", "plan"],
      },
      model: { type: "string", description: "provider/model from list_models: yours by default." },
      project: { type: "string", description: "One of the user's projects, by name or folder." },
      review: {
        type: "boolean",
        description: "A bot's session is told to review its work with reviewer subagents before its report: false for a task that needs no review, told only to report. true by default.",
      },
      step: {
        type: "integer",
        description: "For your goal: the step it works on, by number, so that step's track follows it.",
      },
      task: {
        type: "string",
        description: "What it's to do: all it needs to know, as it hasn't seen this conversation.",
      },
      title: { type: "string", description: "A short name, like \"Write the tests\"." },
      wait: { type: "boolean", description: "Wait for its first answer (up to ten minutes)." },
      wake: {
        type: "string",
        description: "What you're woken with: when it finishes, when it asks, both (a bot's default), or none (a session's default).",
        enum: ["finished", "asks", "both", "none"],
      },
      worktree: {
        type: "boolean",
        description: "In a worktree of its project, on a branch of its own, out of other sessions' way.",
      },
    }, ["task"]),
  tool("list_sessions", "List the sessions you started (and the ones they started), latest first: whether each is working, asking for something (what, with the ask's id), finished, failed or stopped; its model, its tokens in context now and in total, and the first lines of its last reply."),
  tool("stop_session", "Stop a session you started, by its address from list_sessions; with archive, also put it away once its work is reported. Only your own: for another, ask the user.",
    { archive: { type: "boolean" }, session: { type: "string" } }, ["session"]),
  tool("compact_session", "Summarize the conversation of a session you started, to free up its context, as the user's /compact does: now, or when its turn ends. Nothing is lost from what the user sees. Only your own: for another, ask the user. Some coding agents can't be asked, and it says so.",
    { session: { type: "string" } }, ["session"]),
  tool("answer_ask", "Answer what one of your sessions asks: a permission (allow or deny), or a question (in words). You may allow what your own conversation could do without asking, in its mode and with its rules, but never in a session that is in Ask First: the user answers all of those. What it would have to ask about comes to the user, as answer_ask tells you: tell them in a line, and they answer it on the session. You can always deny, saying why. The user sees your answer and reason on the session.",
    {
      answer: { type: "string", description: "For a question." },
      ask: { type: "string", description: "The ask's id, from the [Session asks] message or list_sessions." },
      decision: { type: "string", description: "For a permission.", enum: ["allow", "deny"] },
      reason: { type: "string", description: "Why, in a line the user sees." },
      session: { type: "string", description: "The session's address." },
    }, ["session", "ask", "reason"]),
  tool("list_models", "List the models sessions can start on here or on another computer (computer), the ones the user has an account for, as provider/model, with their efforts.",
    { computer: { type: "string" } }),
  tool("make_project", "Make a new project: a folder named after it, in the folder the user picked for projects (or one they named for it), with a new git repository (or a clone), added to Kuvo Code's sidebar. Make every new project with it, never with mkdir or git init. The user is asked first (once for a bot, if they say Always; not for a project in the goal they started); if they haven't answered in ten minutes it stays asked, and you're told when they answer. Then start sessions in it with start_session.",
    {
      clone: { type: "string", description: "A repository to clone into it instead: an https or ssh address." },
      folder: { type: "string", description: "Only where the user named one: its full path (~/Desktop/tidepool)." },
      git: { type: "boolean", description: "false for a plain folder, without git." },
      name: { type: "string", description: "The project's name, like Tidepool." },
    }, ["name"]),
  tool("list_projects", "List the user's projects here or on another computer (computer): each one's folder, whether it's a git repository, and who made it, and where new projects go.",
    { computer: { type: "string" } }),
  tool("plan_limits", "Read the user's plan limits on this computer: for each account of each coding agent (Claude Code, Codex…), how much of each window (5-hour, weekly, a model's own) is used, when it resets, and as of when. Use it to pace long work, or to pick an account with room before starting sessions. It changes nothing."),
  tool("use_limit_reset", "Use one of an account's rate-limit resets (Codex's reset credits, Claude's reset grants) to refill its limits now, when work can't wait for the limit to start over. Only for an account plan_limits lists with resets. The user approves each use on a card in this conversation (unless they chose Always Allow for that account); if they haven't answered in ten minutes it stays asked, and you're told when they answer. It answers with the account's limits after.",
    {
      account: {
        type: "string",
        description: "The account, as plan_limits names it (its account id, or its name like Codex).",
      },
    }, ["account"]),
  tool("propose_goal", "For a bot, when the user's message is a goal of many steps (hours, days or weeks of work), or was sent with /goal: plan it, check what it needs, and put its plan to them on one card. Never for a small or quick request. The user starts it from the card, or says not now; you're told [Goal started] when they start it, and never start before. Proposing again replaces the card.",
    {
      checks: {
        type: "array",
        description: "What you checked the goal needs: tools, keys, sign-ins, services, and what only the user can do (pay on their own account, sign in, make an account, hand over a key). Never a check to approve your work or to make a choice your research can settle: Start approves the plan.",
        items: {
          type: "object",
          properties: {
            button: { type: "string", description: "The button's word for that page, like Add or Open Stripe." },
            detail: { type: "string", description: "A few words more, like what it's for." },
            ok: { type: "boolean", description: "true when it's ready; leave it out for what the user must do." },
            site: { type: "string", description: "The service's site, when there's no url." },
            text: {
              type: "string",
              description: "What's checked, like \"Stripe key works\", or what the user must do, like \"Add a Cloudflare API token\".",
            },
            url: { type: "string", description: "An https page where the user does it." },
          },
          required: ["text"],
        },
      },
      digest: {
        type: "string",
        description: "How often the user hears how it goes: by the plan's size unless they said.",
        enum: ["day", "week", "none"],
      },
      ends: {
        type: "string",
        description: "An end the user named, as a date and time (2026-11-30T18:00); leave it out otherwise.",
      },
      goal: { type: "string", description: "The goal, in the user's words." },
      projects: {
        type: "array",
        description: "New projects the plan makes, by name, or by the folder the user named for one, as a full path: made with make_project, without asking, once the goal starts.",
        items: { type: "string" },
      },
      spend: {
        type: "array",
        description: "What you'd spend yourself, each with a cap. Nothing else may be spent. What the user pays for themselves (a membership they join, a fee on their own account) is a check for them instead, its price in detail.",
        items: {
          type: "object",
          properties: {
            cap: { type: "number" },
            currency: { type: "string", description: "USD by default." },
            per: {
              type: "string",
              description: "goal (the whole goal) by default.",
              enum: ["day", "week", "month", "goal"],
            },
            what: { type: "string" },
          },
          required: ["what", "cap"],
        },
      },
      steps: {
        type: "array",
        description: "The plan's steps, in order, each one session's whole task with a short name of a few words, never a sentence. Steps that don't wait for each other run side by side.",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                after: {
                  type: "array",
                  description: "The steps it waits for, by number; leave it out for one that can start now.",
                  items: { type: "integer" },
                },
                app: {
                  type: "string",
                  description: "The app on the computer it's done in, by the app's own name, like Xcode or Figma; leave it out for work in the browser or the terminal.",
                },
                detail: {
                  type: "string",
                  description: "What's in it, about 30 characters at most, like \"SDK, paywall, test config\": never a sentence.",
                },
                site: {
                  type: "string",
                  description: "The site it's done at in the browser, like appstoreconnect.apple.com for submitting an app; leave it out for work on the computer (code, Xcode, a build), and never give a maker's site for its products.",
                },
                text: {
                  type: "string",
                  description: "Its short name, a few words on one line, like \"Photo scan engine\" or \"Submit for review\": never a sentence or a list of what's in it.",
                },
              },
              required: ["text"],
            },
          ],
        },
      },
      title: {
        type: "string",
        description: "The goal's name in two to four words, like \"Landing page\": never a sentence.",
      },
    }, ["goal", "steps"]),
  tool("goal_progress", "During your goal: mark its steps as they start, move and end, add steps as the plan changes, keep what only the user can fix or decide (or what's outside the plan) as waiting, keep a call you made yourself (decided), report what you spent, and say what you're still watching. It tells you whether the user is here.",
    {
      add: {
        type: "array",
        description: "New steps, as the plan changes, like propose_goal's: a short name of a few words, never a sentence; detail about 30 characters at most; site only for work in the browser, app only for work in an app on the computer.",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                after: { type: "array", items: { type: "integer" } },
                app: { type: "string" },
                detail: { type: "string" },
                site: { type: "string" },
                text: { type: "string" },
              },
              required: ["text"],
            },
          ],
        },
      },
      decided: {
        type: "object",
        description: "A call you made yourself, kept for the user to see; they may change it later.",
        properties: {
          choice: { type: "string", description: "What you chose, in a few words." },
          options: {
            type: "array",
            description: "The choices there were, yours among them: the user may pick another of these.",
            items: { type: "string" },
          },
          text: { type: "string", description: "The call, as a question, like \"Which hosting?\"." },
          why: { type: "string", description: "Why, in a few words, like \"free tier covers it\"." },
        },
        required: ["text", "choice"],
      },
      spent: {
        type: "array",
        description: "What you spent, by the plan's spend line.",
        items: {
          type: "object",
          properties: { amount: { type: "number" }, what: { type: "string" } },
          required: ["what", "amount"],
        },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            app: {
              type: ["string", "null"],
              description: "The app on the computer it's done in, by its own name, where that changed; null takes it away.",
            },
            note: {
              type: "string",
              description: "A few words the user sees: what you counted (\"3 of 8 pages\"), or like \"looks again at 2:40\".",
            },
            progress: {
              type: "number",
              description: "From 0 to 1, only where you can count it, with what you counted in note (3 of 8 pages is 0.375).",
            },
            state: { type: "string", enum: ["todo", "doing", "done", "waiting", "paused", "skipped"] },
            step: { type: "integer", description: "The step's number, from 1." },
            until: {
              type: "string",
              description: "For a step that can only start at a time (a weekly run on Monday): that time, like 2026-11-02T09:00. Set a wake-up for it too; you aren't told to carry on before then. null takes it away.",
            },
          },
          required: ["step"],
        },
      },
      waiting: {
        type: "object",
        properties: {
          app: { type: "string", description: "The app on the computer it's done in, by its own name." },
          detail: { type: "string" },
          kind: {
            type: "string",
            description: "you: only the user can fix it; judgment: a call only they can make; outside: not in the plan.",
            enum: ["you", "judgment", "outside"],
          },
          site: { type: "string", description: "The service's site, when there's no url." },
          step: { type: "integer", description: "The step it holds up: settled once you go on with that step." },
          text: { type: "string", description: "What it is, like \"Finish Stripe's identity check\"." },
          url: { type: "string", description: "An https page where the user does it." },
        },
        required: ["kind", "text"],
      },
      watching: {
        type: "array",
        description: "All you're still watching, as it is now, like \"DNS for driftwood.coffee\".",
        items: { type: "string" },
      },
    }),
  tool("may_spend", "During your goal: whether a purchase fits the plan's cap for it, in its period now. Ask before every purchase.",
    { amount: { type: "number" }, what: { type: "string", description: "The plan's spend line it's for." } }, ["what", "amount"]),
  tool("finish_goal", "End your goal with the report: what needs the user first, then what got done and where, what it spent, and what you're still watching.",
    {
      report: { type: "string", description: "A few lines." },
      watching: { type: "array", items: { type: "string" } },
    }, ["report"]),
  tool("notify_user", "Send the user a notification, on their phone and their Mac, when you need them and they may not be looking: a decision only they can make, something blocked until they act, or news they asked to be told. A reply notifies them only when it answers something they asked; when you work on your own (a wake-up, a watch, another agent's message, a goal), nothing reaches them unless you use this. Not for progress or routine results: those go in your reply. A few an hour at most; the same text isn't sent twice.",
    {
      text: {
        type: "string",
        description: "One sentence, leading with what you need from the user or the news, like \"I need your Stripe key to finish the payments step.\"",
      },
    }, ["text"]),
];
