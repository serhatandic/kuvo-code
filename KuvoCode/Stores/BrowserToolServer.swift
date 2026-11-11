import Foundation
import Network

/// The panel's browser, offered to the agent as MCP tools (Streamable HTTP, JSON
/// responses) on 127.0.0.1. The engine is told about it at launch, with a token that
/// changes every time, so any model it runs can browse in the panel.
@MainActor
final class BrowserToolServer {
    private let agent: BrowserAgent
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
    private let token = UUID().uuidString + UUID().uuidString
    private(set) var url: URL?
    /// The session a caller works for, when it isn't one you see: an engine run in a session with
    /// the coding agents (Auto's, say) is that session's.
    var owner: ((String) async -> String?)?

    init(agent: BrowserAgent) {
        self.agent = agent
    }

    /// Where the coding agents reach it (the bridge gives it to each with its session's header).
    var agentsServer: OutsideAgents.ToolServer? {
        url.map { OutsideAgents.ToolServer(url: $0.absoluteString, token: token, timeout: BrowserTools.executionTimeout) }
    }

    /// The engine's config entry for this server, as `OPENCODE_CONFIG_CONTENT` takes it.
    var engineConfig: [String: Any]? {
        url.map { engineConfig(at: $0) }
    }

    private func engineConfig(at url: URL) -> [String: Any] {
        ["mcp": ["servers": ["kuvo-browser": [
            "type": "remote",
            "url": url.absoluteString,
            "headers": ["Authorization": "Bearer \(token)"],
            "oauth": false,
            // Plain tools, so every model calls them directly.
            "codemode": false,
            // A tool that asks you (to sign in, for a code) waits for you.
            "timeout": ["execution": BrowserTools.executionTimeout],
        ] as [String: Any]]]]
    }

    /// Starts listening on a free loopback port and returns the address. One that can't listen
    /// now (waiting for a network that may never come) fails rather than holding the engine's
    /// start: it starts without the browser.
    func start() async throws -> URL {
        if let url { return url }
        let port = try await server.start()
        let url = URL(string: "http://127.0.0.1:\(port)/mcp")!
        self.url = url
        return url
    }

    // MARK: HTTP

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        guard request.path.hasPrefix("/mcp") else { return .init(status: 404) }
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer "),
              samePassword(String(authorization.dropFirst(7)), token) else { return .init(status: 401) }
        switch request.method {
        case "POST": break
        case "DELETE": return .init(status: 200)
        default: return .init(status: 405, headers: ["Allow": "POST, DELETE"])
        }
        guard let body = try? JSONSerialization.jsonObject(with: request.body) else {
            return .json(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "Parse error"]])
        }
        let client = request.headers["mcp-session-id"]
        // A coding agent's: its session, as the bridge named it.
        let session = request.headers["x-kuvo-session"]
        if let batch = body as? [[String: Any]] {
            var replies: [[String: Any]] = []
            for message in batch { if let reply = await handle(message, from: client, session: session) { replies.append(reply) } }
            return replies.isEmpty ? .init(status: 202) : .json(replies)
        }
        guard let message = body as? [String: Any] else { return .init(status: 400) }
        guard let reply = await handle(message, from: client, session: session) else { return .init(status: 202) }
        var response = HTTPResponse.json(reply)
        if message["method"] as? String == "initialize" { response.headers["Mcp-Session-Id"] = UUID().uuidString }
        return response
    }

    // MARK: JSON-RPC

    /// Tool calls under way, by client and request: one the client cancels stops (an ask it
    /// waits on closes).
    private var calls: [String: Task<CallResult, Never>] = [:]

    /// What a tool call gives back, from the task that makes it.
    private struct CallResult: @unchecked Sendable { let value: [String: Any] }

    private static func key(_ id: Any, client: String?) -> String { (client ?? "") + "|" + String(describing: id) }

    /// The reply to one message, or nil for a notification.
    private func handle(_ message: [String: Any], from client: String?, session: String? = nil) async -> [String: Any]? {
        guard let method = message["method"] as? String else { return nil }
        let params = message["params"] as? [String: Any] ?? [:]
        guard let id = message["id"] else {
            if method == "notifications/cancelled", let request = params["requestId"] { calls[Self.key(request, client: client)]?.cancel() }
            return nil
        }
        func reply(_ result: [String: Any]) -> [String: Any] { ["jsonrpc": "2.0", "id": id, "result": result] }
        switch method {
        case "initialize":
            let requested = params["protocolVersion"] as? String
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
            return reply([
                "protocolVersion": requested.flatMap { supported.contains($0) ? $0 : nil } ?? "2025-06-18",
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "kuvo-browser", "title": "Kuvo Code browser", "version": AppInfo.version],
                "instructions": BrowserTools.instructions(machine: false, vault: !(await BrowserTools.vaultDefinitions()).isEmpty) + (await BrowserTools.workQueueDefinitions()).instructions,
            ])
        case "ping":
            return reply([:])
        case "tools/list":
            // With the vault's and the sandbox's, in this Mac's box's own words.
            return reply(["tools": BrowserTools.definitions(vault: await BrowserTools.vaultDefinitions()) + (await BrowserTools.sandboxDefinitions()) + (await BrowserTools.workQueueDefinitions()).tools])
        case "tools/call":
            let name = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            // The engine names the session calling, so an ask goes to the right conversation; the
            // agents bridge, in a header.
            var caller = (params["_meta"] as? [String: Any])?["ai.opencode/sessionID"] as? String ?? session
            if let named = caller, let owner, let own = await owner(named) { caller = own }
            // Not the browser's: no page to serve it.
            if name == BrowserTools.showInPanel { return reply(BrowserTools.showInPanelCall(arguments, caller: caller)) }
            if name == BrowserTools.showFile { return reply(BrowserTools.showFileCall(arguments)) }
            if name == BrowserTools.markFinal { return reply(BrowserTools.markFinalCall(arguments)) }
            if name == BrowserTools.showWidget { return reply(BrowserTools.showWidgetCall(arguments)) }
            let key = Self.key(id, client: client)
            let call: Task<CallResult, Never>
            if BrowserTools.mailTools.contains(name) || BrowserTools.wakeTools.contains(name) || name == BrowserTools.setJob || BrowserTools.isVault(name) || BrowserTools.isSandbox(name) || BrowserTools.isWorkQueue(name) {
                // Stopped as the others are: one waiting for an answer stops waiting.
                call = Task {
                    let result = BrowserTools.isVault(name) ? await BrowserTools.vault(name, arguments, caller)
                        : BrowserTools.isSandbox(name) ? await BrowserTools.sandbox(name, arguments, caller)
                        : BrowserTools.isWorkQueue(name) ? await BrowserTools.workQueue(name, arguments, caller)
                        : name == BrowserTools.setJob ? await BrowserTools.job(arguments, caller)
                        : BrowserTools.wakeTools.contains(name) ? await BrowserTools.wake(name, arguments, caller) : await BrowserTools.mail(name, arguments, caller)
                    return CallResult(value: ["content": [["type": "text", "text": result.text]], "isError": result.isError])
                }
            } else {
                let agent = agent.serving(caller)
                call = Task { CallResult(value: await BrowserTools.call(name, arguments: arguments, agent: agent, caller: caller)) }
            }
            calls[key] = call
            defer { if calls[key] == call { calls[key] = nil } }
            // The connection closing stops it too.
            return reply(await withTaskCancellationHandler { await call.value } onCancel: { call.cancel() }.value)
        default:
            return ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Unknown method \(method)"]]
        }
    }
}

// MARK: - Tools

/// The browser tools: names, descriptions and input schemas for the model, and what each does.
@MainActor
enum BrowserTools {
    static let definitions: [[String: Any]] = [
        tool("browser_navigate", "Open an address, or search for words, in the browser panel the user sees. Returns the page as numbered elements.",
             ["url": ["type": "string", "description": "An address like example.com, or words to search for."]], required: ["url"]),
        tool("browser_snapshot", "Read the current page: title, address, scroll position, and its interactive elements numbered like [3], with visible text."),
        tool("browser_click", "Click the element with this number from the latest snapshot.",
             ["index": ["type": "integer"], "accept_dialog": ["type": "boolean", "description": "Accept a confirmation or prompt it opens (declined otherwise)."]], required: ["index"]),
        tool("browser_type", "Type text into the input with this number, replacing what's there unless clear is false.",
             ["index": ["type": "integer"], "text": ["type": "string"],
              "submit": ["type": "boolean", "description": "Press Enter afterwards."],
              "clear": ["type": "boolean"]], required: ["index", "text"]),
        tool("browser_select", "Choose an option, by its text or value, in the drop-down with this number.",
             ["index": ["type": "integer"], "option": ["type": "string"]], required: ["index", "option"]),
        tool("browser_scroll", "Scroll the page up or down by screens (1 by default).",
             ["direction": ["type": "string", "enum": ["up", "down"]], "pages": ["type": "number"]], required: ["direction"]),
        tool("browser_press", "Press a key on the focused element: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight or Backspace. Type text with browser_type.",
             ["key": ["type": "string"], "accept_dialog": ["type": "boolean", "description": "Accept a confirmation or prompt it opens (declined otherwise)."]], required: ["key"]),
        tool("browser_back", "Go back a page."),
        tool("browser_forward", "Go forward a page."),
        tool("browser_text", "Read all of the page's text at once (an article, docs, a list or a table), without scrolling."),
        tool("browser_screenshot", "See the visible part of the page as an image (for models that take images). With show, the user sees it too, in this conversation: use it whenever they ask to see the page or for a screenshot.",
             ["show": ["type": "boolean"]]),
        tool("browser_save_pdf", "Save the page as a PDF, in pages as printing would, with its colors. To make a document to share (a report, an invoice), write it as an HTML file, open it with browser_navigate (file:///…), then save it here.",
             ["path": ["type": "string", "description": "A full path ending in .pdf."]], required: ["path"]),
        tool("browser_wait", "Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).",
             ["seconds": ["type": "number"], "text": ["type": "string"]]),
        tool("browser_hover", "Move the pointer over the element with this number, for menus and tips that open on hover.",
             ["index": ["type": "integer"]], required: ["index"]),
        tool("browser_new_tab", "Open a new browser tab in the panel, optionally at an address.",
             ["url": ["type": "string"]]),
        tool("browser_upload", "Attach files to the file input with this number (or its upload button), as choosing them in the file picker would.",
             ["index": ["type": "integer"], "files": ["type": "array", "items": ["type": "string"], "description": "Their full paths."]], required: ["index", "files"]),
        tool("browser_tabs", "List the browser's tabs (numbered, the one in use marked), switch to one to work in it, or close one.",
             ["action": ["type": "string", "enum": ["list", "switch", "close"], "description": "list by default."],
              "tab": ["type": "integer", "description": "Its number, to switch to or close."]]),
        tool("browser_sign_in", "Sign in with the user's own username and password: from their vault where this conversation may use one of its sign-ins on this site (it fills on its own), or else they type or pick one in Kuvo Code. They go straight into the fields you name; you never see them. Use it for every sign-in. Whenever a page you open asks to sign in, call it right away, even if the user didn't mention signing in: its card asks them, and they can say Not Now there, so never ask in the chat whether to sign in, nor for a password. Name the fields the page has now (where the username and the password are on pages of their own, call it on each; the user answers once). Then submit the form yourself.",
             ["username": ["type": "integer", "description": "The username or email field's number, if the page has one."],
              "password": ["type": "integer", "description": "The password field's number, if the page has one."],
              "item": ["type": "string", "description": "A sign-in from vault_items, by name, when more than one could do. It's filled only on its own site."]]),
        tool("browser_fill", "Fill one field from the user's vault: a sign-in's username or password, or a key's or a note's field, by the item's name from vault_items. It's filled only on the item's own sites, and you never see it.",
             ["index": ["type": "integer", "description": "The field's number."],
              "item": ["type": "string"],
              "field": ["type": "string", "description": "Which of its fields, when it has more than one (vault_items lists them)."],
              "why": ["type": "string", "description": "Why you need it, in one sentence the user reads."]], required: ["index", "item"]),
        tool("browser_ask_code", "Ask the user for a one-time code (from a text message, an email or an authenticator app), which goes straight into the field with this number; you never see it. Then submit it if the page doesn't on its own.",
             ["index": ["type": "integer"], "prompt": ["type": "string", "description": "What to tell the user, like \"Enter the 6-digit code texted to your phone\"."]], required: ["index"]),
        tool("browser_ask_user", "Ask the user to do something on the page themselves: a CAPTCHA, approving the sign-in on their phone, anything you can't do. Waits until they say it's done (up to 15 minutes), then reads the page again. Not for a question or a choice: ask those with your question tool, or in your reply.",
             ["instruction": ["type": "string", "description": "What they should do, in a sentence."]], required: ["instruction"]),
        tool(showInPanel, "Show the user a file or folder in Kuvo Code's side panel, beside this conversation: a folder in the Files tab, a file in a tab of its own (code, Markdown, pictures and PDFs show as they are). Use it whenever the user asks to see, open or find something, and to point them to what you made or found.",
             ["path": ["type": "string", "description": "Its full path."]], required: ["path"]),
        tool(showFile, "Put a file in this conversation, where the user reads your replies: a picture shows large, any other file (a PDF, a document, a spreadsheet) as a card they open. Use it to show what you made or found when seeing it helps, and always when the user is on their phone (their message ends with a <from-phone> block), where file paths and the side panel don't reach them.",
             ["path": ["type": "string", "description": "Its full path."],
              "caption": ["type": "string", "description": "A line shown under it."]], required: ["path"]),
        tool(markFinal, "Mark a file you made as final once it's ready for the user (a report, a document, a picture): it's kept at the top of what you made, where they find it with every version.",
             ["path": ["type": "string", "description": "Its full path."],
              "note": ["type": "string", "description": "A few words on it, like who it's for."]], required: ["path"]),
        tool(showWidget, "Show the user something to look at or play with, live in this conversation where this call is. Make one only when it does a job words can't: a chart of numbers you measured, options to see side by side with a choice to click, a value to tune with an instant preview, or a table to sort or filter. Not for a plain choice between named options (ask with your question tool, if you have one), a diagram (write a ```mermaid code block in your reply; a widget only when it needs something to click), what a sentence or a short list says, code (use a code block), or decoration. Keep it to one view with a control or two, built from the data you actually have (never invented numbers); don't repeat it in your reply, but add a line on what to do with it. It can't be opened larger: design it for the reply's width, and narrow enough for a phone (360 points). It's as tall as its content, up to about 760 points (less on a phone), then it scrolls. It has no frame: don't put the whole of it in a card or box of its own. Write the HTML (a fragment or a whole page) with its CSS and JavaScript inline; libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com (Chart.js, D3, Mermaid, Three.js, Leaflet with its map tiles); pictures from anywhere. It can't fetch data or send anything, so put the data in the page. It starts in Kuvo Code's look, light and dark: transparent, with buttons (class primary for the main one), fields, tables and headings styled, the classes kuvo-card, kuvo-chip and kuvo-row, and colors by name: var(--kuvo-accent), var(--kuvo-1) to var(--kuvo-6) for a chart's series, var(--kuvo-good) and var(--kuvo-bad), var(--kuvo-secondary) for quieter text, var(--kuvo-line) and var(--kuvo-fill). Use those rather than a palette of your own, and make anything you style yourself work in light and dark (prefers-color-scheme). Anything your script draws (Chart.js, D3, a canvas) takes its colors from those variables, read with getComputedStyle(document.documentElement).getPropertyValue('--kuvo-1') (and --kuvo-text, --kuvo-secondary, --kuvo-line for labels and grid), and draws again when matchMedia('(prefers-color-scheme: dark)') changes; otherwise it's loaded again in the new look, losing what the user did in it. To hear back, call kuvo.send(text) from a click in it: the text comes to you as the user's message, ending with a <from-widget> block that names the widget by its title, so give each a title of its own.",
             ["html": ["type": "string"],
              "title": ["type": "string", "description": "A short name for it, shown while you make it, if it can't show, and on what the user sends from it. Write it before the HTML."]], required: ["html"]),
        tool("list_agents", "List the agents you can write to with send_message, or read with read_conversation: the user's bots and their other recent sessions, on their Mac and their machines, each with its name, where it runs and its address."),
        tool("read_conversation", "Read another agent's conversation (from list_agents, or one the user names with &): what was written to it, its replies, and a line for each step it took, oldest first. Use it to learn what it did, decided or found, to pick up where it left off, or to follow it, without interrupting it. A long one gives its start and its latest part; with query, the parts that mention it.",
             ["of": ["type": "string", "description": "Its name or address."],
              "query": ["type": "string", "description": "A word or phrase to find in it."]], required: ["of"]),
        tool("send_message", "Write to another agent (from list_agents), to hand off work, ask for help or information, coordinate, or report back: it reaches that conversation as a message from you, and its agent takes it up. With wait, its answer comes back here (up to ten minutes); without, it can answer with send_message later. A message from another agent reaches you the same way, saying who it's from.",
             ["to": ["type": "string", "description": "Its name or address."],
              "text": ["type": "string", "description": "What to say: all it needs to know, as it hasn't seen this conversation."],
              "wait": ["type": "boolean"]], required: ["to", "text"]),
        tool("schedule_wake_up", "Come back to this conversation later, even while the user is away: at `when`, it gets your note as a message starting with \"[Wake-up]\", and you carry on from it. With every, it comes back again and again until it's canceled. Never say you can't come back later or run on a timer: schedule a wake-up instead.",
             ["when": ["type": "string", "description": "+20m, +2h, +1d, or a time like 2026-10-21T09:00 on the user's clock; at least a minute from now."],
              "note": ["type": "string", "description": "What to do then, as a note to yourself, starting with what to do. It comes to this conversation, in its folder, so leave those out."],
              "every": ["type": "string", "description": "30m, 2h, 1d, 1w (at least 5m), or weekdays. Days, weeks and weekdays keep its time of day. When it's due now too, also do the first round now."],
              "summary": ["type": "string", "description": "One short line the user sees for it, like \"Check whether CI passed\"."]], required: ["when", "note"]),
        tool("watch_for_change", "Wait for something to change without checking yourself (CI finishing, a deploy, a status page, a price, a file): every so often its check, a shell command, runs in this conversation's folder for at most a minute, and this conversation wakes with your note and the new output only when what it prints changes (not the first time). Make it print just what you watch, like gh run list --limit 1 --json status,conclusion -q '.[0] | .status + \" \" + .conclusion' or curl -s <url> | grep -o '<the part that matters>', so a clock or an ad on the page doesn't count as a change. Only what it prints counts, and printing nothing counts too. A run is skipped when a curl, wget or gh in it fails, or when it prints nothing and exits 2 or more. To watch whether a site is up, print its status code: curl -s -o /dev/null -w '%{http_code}' <url>.",
             ["every": ["type": "string", "description": "How often: 5m or more, 2h, 1d."],
              "check": ["type": "string"],
              "note": ["type": "string", "description": "What to do when it changes."],
              "summary": ["type": "string", "description": "One short line the user sees for it, like \"Check whether CI passed\"."]], required: ["every", "check", "note"]),
        tool("list_wake_ups", "List this conversation's wake-ups and watches, with their ids. Check it before adding one: never keep two for the same thing."),
        tool("cancel_wake_up", "Cancel one of this conversation's wake-ups or watches by its id from list_wake_ups (or the one schedule_wake_up or watch_for_change gave). To change one, cancel it and set the new one.",
             ["id": ["type": "string"]], required: ["id"]),
        tool(setJob, "Keep your job, as one of the user's bots. Call it whenever the user gives you a job or changes it, before anything else, with the whole job as it is now: it replaces the one you had. Only a bot keeps a job.",
             ["summary": ["type": "string", "description": "What you do, in a few words, like \"Keeps the build green\" (shown under your name)."],
              "details": ["type": "string", "description": "Only what the user asked for, as close to their words as you can: what to do, watch or make, when, and any rule or limit they gave. Never how you'll work, who does the work, or a rule or limit they didn't give."],
              "job": ["type": "string", "description": "Alternative to summary."],
              "clear": ["type": "boolean", "description": "true to clear the job."]]),
        tool("start_session", "Start a new session: another agent with a conversation of its own, working alongside you (a separate task, a second opinion, one part of a bigger job). It gets the task as a message from you, so it knows who to report to, and the user finds it under this conversation in their sidebar, to follow and talk to. You get its address to write to it with send_message; it can write back the same way. A bot is woken when its sessions finish or ask (wake), so it never checks on them. With computer, it starts on another of the user's computers, as if you lived there.",
             ["task": ["type": "string", "description": "What it's to do: all it needs to know, as it hasn't seen this conversation."],
              "title": ["type": "string", "description": "A short name, like \"Write the tests\"."],
              "project": ["type": "string", "description": "One of the user's projects, by name or folder."],
              "chat": ["type": "boolean", "description": "Start it as a chat, in no project."],
              "folder": ["type": "string", "description": "A full path: this conversation's folder by default. With project: a folder in it or one of its worktrees, else it's refused."],
              "worktree": ["type": "boolean", "description": "In a worktree of its project, on a branch of its own, out of other sessions' way."],
              "model": ["type": "string", "description": "provider/model from list_models: yours by default."],
              "effort": ["type": "string", "description": "One of the efforts list_models gives for the model."],
              "mode": ["type": "string", "enum": ["build", "plan"], "description": "plan: it plans first and changes nothing until it's told to go on. build by default."],
              "approval": ["type": "string", "enum": ["askFirst", "acceptEdits", "auto", "fullAccess"], "description": "askFirst asks before it edits or runs commands, acceptEdits edits on its own and asks before commands, auto works on its own inside the sandbox, fullAccess asks nothing. Yours by default, and never more than yours."],
              "wake": ["type": "string", "enum": ["finished", "asks", "both", "none"], "description": "What you're woken with: when it finishes, when it asks, both (a bot's default), or none (a session's default)."],
              "wait": ["type": "boolean", "description": "Wait for its first answer (up to ten minutes)."],
              "review": ["type": "boolean", "description": "A bot's session is told to review its work with reviewer subagents before its report: false for a task that needs no review, told only to report. true by default."],
              "step": ["type": "integer", "description": "For your goal: the step it works on, by number, so that step's track follows it."],
              "computer": ["type": "string", "description": "Another of the user's computers, by its name in list_agents: this one by default. Its project from list_projects there."]], required: ["task"]),
        tool("list_sessions", "List the sessions you started (and the ones they started), latest first: whether each is working, asking for something (what, with the ask's id), finished, failed or stopped; its model, its tokens in context now and in total, and the first lines of its last reply."),
        tool("stop_session", "Stop a session you started, by its address from list_sessions; with archive, also put it away once its work is reported. Only your own: for another, ask the user.",
             ["session": ["type": "string"],
              "archive": ["type": "boolean"]], required: ["session"]),
        tool("compact_session", "Summarize the conversation of a session you started, to free up its context, as the user's /compact does: now, or when its turn ends. Nothing is lost from what the user sees. Only your own: for another, ask the user. Some coding agents can't be asked, and it says so.",
             ["session": ["type": "string"]], required: ["session"]),
        tool("answer_ask", "Answer what one of your sessions asks: a permission (allow or deny), or a question (in words). You may allow what your own conversation could do without asking, in its mode and with its rules, but never in a session that is in Ask First: the user answers all of those. What it would have to ask about comes to the user, as answer_ask tells you: tell them in a line, and they answer it on the session. You can always deny, saying why. The user sees your answer and reason on the session.",
             ["session": ["type": "string", "description": "The session's address."],
              "ask": ["type": "string", "description": "The ask's id, from the [Session asks] message or list_sessions."],
              "decision": ["type": "string", "enum": ["allow", "deny"], "description": "For a permission."],
              "answer": ["type": "string", "description": "For a question."],
              "reason": ["type": "string", "description": "Why, in a line the user sees."]], required: ["session", "ask", "reason"]),
        tool("list_models", "List the models sessions can start on here or on another computer (computer), the ones the user has an account for, as provider/model, with their efforts.",
             ["computer": ["type": "string"]]),
        tool("make_project", "Make a new project: a folder named after it, in the folder the user picked for projects (or one they named for it), with a new git repository (or a clone), added to Kuvo Code's sidebar. Make every new project with it, never with mkdir or git init. The user is asked first (once for a bot, if they say Always; not for a project in the goal they started); if they haven't answered in ten minutes it stays asked, and you're told when they answer. Then start sessions in it with start_session.",
             ["name": ["type": "string", "description": "The project's name, like Tidepool."],
              "folder": ["type": "string", "description": "Only where the user named one: its full path (~/Desktop/tidepool)."],
              "git": ["type": "boolean", "description": "false for a plain folder, without git."],
              "clone": ["type": "string", "description": "A repository to clone into it instead: an https or ssh address."]], required: ["name"]),
        tool("list_projects", "List the user's projects here or on another computer (computer): each one's folder, whether it's a git repository, and who made it, and where new projects go.",
             ["computer": ["type": "string"]]),
        tool("plan_limits", "Read the user's plan limits on this computer: for each account of each coding agent (Claude Code, Codex…), how much of each window (5-hour, weekly, a model's own) is used, when it resets, and as of when. Use it to pace long work, or to pick an account with room before starting sessions. It changes nothing."),
        tool("propose_goal", "For a bot, when the user's message is a goal of many steps (hours, days or weeks of work), or was sent with /goal: plan it, check what it needs, and put its plan to them on one card. Never for a small or quick request. The user starts it from the card, or says not now; you're told [Goal started] when they start it, and never start before. Proposing again replaces the card.",
             ["goal": ["type": "string", "description": "The goal, in the user's words."],
              "steps": ["type": "array", "items": ["anyOf": [["type": "string"], ["type": "object", "properties": ["text": ["type": "string", "description": "Its short name, a few words on one line, like \"Photo scan engine\" or \"Submit for review\": never a sentence or a list of what's in it."], "detail": ["type": "string", "description": "What's in it, about 30 characters at most, like \"SDK, paywall, test config\": never a sentence."], "after": ["type": "array", "items": ["type": "integer"], "description": "The steps it waits for, by number; leave it out for one that can start now."], "site": ["type": "string", "description": "The site it's done at in the browser, like appstoreconnect.apple.com for submitting an app; leave it out for work on the computer (code, Xcode, a build), and never give a maker's site for its products."], "app": ["type": "string", "description": "The app on the computer it's done in, by the app's own name, like Xcode or Figma; leave it out for work in the browser or the terminal."]], "required": ["text"]]]], "description": "The plan's steps, in order, each one session's whole task with a short name of a few words, never a sentence. Steps that don't wait for each other run side by side."],
              "title": ["type": "string", "description": "The goal's name in two to four words, like \"Landing page\": never a sentence."],
              "checks": ["type": "array", "items": ["type": "object", "properties": [
                  "text": ["type": "string", "description": "What's checked, like \"Stripe key works\", or what the user must do, like \"Add a Cloudflare API token\"."],
                  "ok": ["type": "boolean", "description": "true when it's ready; leave it out for what the user must do."],
                  "detail": ["type": "string", "description": "A few words more, like what it's for."],
                  "url": ["type": "string", "description": "An https page where the user does it."],
                  "button": ["type": "string", "description": "The button's word for that page, like Add or Open Stripe."],
                  "site": ["type": "string", "description": "The service's site, when there's no url."]], "required": ["text"]],
                 "description": "What you checked the goal needs: tools, keys, sign-ins, services, and what only the user can do (pay on their own account, sign in, make an account, hand over a key). Never a check to approve your work or to make a choice your research can settle: Start approves the plan."],
              "spend": ["type": "array", "items": ["type": "object", "properties": [
                  "what": ["type": "string"], "cap": ["type": "number"], "currency": ["type": "string", "description": "USD by default."],
                  "per": ["type": "string", "enum": ["day", "week", "month", "goal"], "description": "goal (the whole goal) by default."]], "required": ["what", "cap"]],
                 "description": "What you'd spend yourself, each with a cap. Nothing else may be spent. What the user pays for themselves (a membership they join, a fee on their own account) is a check for them instead, its price in detail."],
              "projects": ["type": "array", "items": ["type": "string"], "description": "New projects the plan makes, by name, or by the folder the user named for one, as a full path: made with make_project, without asking, once the goal starts."],
              "ends": ["type": "string", "description": "An end the user named, as a date and time (2026-11-30T18:00); leave it out otherwise."],
              "digest": ["type": "string", "enum": ["day", "week", "none"], "description": "How often the user hears how it goes: by the plan's size unless they said."]], required: ["goal", "steps"]),
        tool("goal_progress", "During your goal: mark its steps as they start, move and end, add steps as the plan changes, keep what only the user can fix or decide (or what's outside the plan) as waiting, keep a call you made yourself (decided), report what you spent, and say what you're still watching. It tells you whether the user is here.",
             ["steps": ["type": "array", "items": ["type": "object", "properties": [
                  "step": ["type": "integer", "description": "The step's number, from 1."],
                  "state": ["type": "string", "enum": ["todo", "doing", "done", "waiting", "paused", "skipped"]],
                  "progress": ["type": "number", "description": "From 0 to 1, only where you can count it, with what you counted in note (3 of 8 pages is 0.375)."],
                  "note": ["type": "string", "description": "A few words the user sees: what you counted (\"3 of 8 pages\"), or like \"looks again at 2:40\"."],
                  "until": ["type": "string", "description": "For a step that can only start at a time (a weekly run on Monday): that time, like 2026-11-02T09:00. Set a wake-up for it too; you aren't told to carry on before then. null takes it away."],
                  "app": ["type": ["string", "null"], "description": "The app on the computer it's done in, by its own name, where that changed; null takes it away."]], "required": ["step"]]],
              "add": ["type": "array", "items": ["anyOf": [["type": "string"], ["type": "object", "properties": [
                  "text": ["type": "string"], "detail": ["type": "string"], "site": ["type": "string"], "app": ["type": "string"],
                  "after": ["type": "array", "items": ["type": "integer"]]], "required": ["text"]]]],
                 "description": "New steps, as the plan changes, like propose_goal's: a short name of a few words, never a sentence; detail about 30 characters at most; site only for work in the browser, app only for work in an app on the computer."],
              "waiting": ["type": "object", "properties": [
                  "kind": ["type": "string", "enum": ["you", "judgment", "outside"], "description": "you: only the user can fix it; judgment: a call only they can make; outside: not in the plan."],
                  "text": ["type": "string", "description": "What it is, like \"Finish Stripe's identity check\"."],
                  "detail": ["type": "string"],
                  "url": ["type": "string", "description": "An https page where the user does it."],
                  "site": ["type": "string", "description": "The service's site, when there's no url."],
                  "app": ["type": "string", "description": "The app on the computer it's done in, by its own name."],
                  "step": ["type": "integer", "description": "The step it holds up: settled once you go on with that step."]], "required": ["kind", "text"]],
              "decided": ["type": "object", "properties": [
                  "text": ["type": "string", "description": "The call, as a question, like \"Which hosting?\"."],
                  "choice": ["type": "string", "description": "What you chose, in a few words."],
                  "why": ["type": "string", "description": "Why, in a few words, like \"free tier covers it\"."],
                  "options": ["type": "array", "items": ["type": "string"], "description": "The choices there were, yours among them: the user may pick another of these."]], "required": ["text", "choice"],
                 "description": "A call you made yourself, kept for the user to see; they may change it later."],
              "spent": ["type": "array", "items": ["type": "object", "properties": ["what": ["type": "string"], "amount": ["type": "number"]], "required": ["what", "amount"]], "description": "What you spent, by the plan's spend line."],
              "watching": ["type": "array", "items": ["type": "string"], "description": "All you're still watching, as it is now, like \"DNS for driftwood.coffee\"."]]),
        tool("may_spend", "During your goal: whether a purchase fits the plan's cap for it, in its period now. Ask before every purchase.",
             ["what": ["type": "string", "description": "The plan's spend line it's for."], "amount": ["type": "number"]], required: ["what", "amount"]),
        tool("finish_goal", "End your goal with the report: what needs the user first, then what got done and where, what it spent, and what you're still watching.",
             ["report": ["type": "string", "description": "A few lines."],
              "watching": ["type": "array", "items": ["type": "string"]]], required: ["report"]),
        tool("notify_user", "Send the user a notification, on their phone and their Mac, when you need them and they may not be looking: a decision only they can make, something blocked until they act, or news they asked to be told. A reply notifies them only when it answers something they asked; when you work on your own (a wake-up, a watch, another agent's message, a goal), nothing reaches them unless you use this. Not for progress or routine results: those go in your reply. A few an hour at most; the same text isn't sent twice.",
             ["text": ["type": "string", "description": "One sentence, leading with what you need from the user or the news, like \"I need your Stripe key to finish the payments step.\""]], required: ["text"]),
    ]

    /// The folder a conversation works in, by its session (on this Mac).
    static var sessionFolder: (String) -> String? = { _ in nil }
    /// Whether a conversation is on screen, so show_in_panel can say whether the user sees it now.
    static var isInView: (String) -> Bool = { _ in false }

    /// The tool that shows a file or folder in the panel; the window does it when the call
    /// succeeds (see `Workspace.onShowInPanel`), for a session here or on a machine alike.
    nonisolated static let showInPanel = "show_in_panel"

    /// The tool that puts a file in the conversation: the transcript shows it from the call (see
    /// `ShownFileRow`), here and on a phone, which opens it with `kuvo/file`.
    nonisolated static let showFile = "show_file"
    /// Pins a file in the record of what was made (the box reads the call).
    nonisolated static let markFinal = "mark_final"

    /// The tool that shows something the agent made, live in the conversation; the transcript
    /// draws it from the call (see `WidgetCard`), for a session here or on a machine alike.
    nonisolated static let showWidget = "show_widget"

    /// The tools agents write to each other and run their sessions with, answered by this Mac's box
    /// (see `AgentMail`).
    nonisolated static let mailTools: Set<String> = ["list_agents", "send_message", "read_conversation", "start_session", "list_sessions", "stop_session", "compact_session", "answer_ask", "list_models", "make_project", "list_projects", "propose_goal", "goal_progress", "may_spend", "finish_goal", "notify_user", "plan_limits"]
    /// Carries out their calls from this Mac's conversations.
    /// The added integrations' sites, which the browser sends the agent away from, to their tools.
    static var integrationSites: () -> [Integrations.Site] = { [] }
    /// When a conversation was sent away from an integration's site, by conversation and site:
    /// asked again a while after, the browser goes there.
    private static var sentAway: [String: Date] = [:]

    /// Whether a conversation may read files outside its folder without asking (Auto or Full Access, not a
    /// group chat's seat), by its session. Unknown, it asks.
    static var readsAnywhere: (String) -> Bool = { _ in false }

    /// What the browser says instead of opening `address`, a file outside the conversation's
    /// folder (and the temporary folders, where an agent writes a page to open), when it asks
    /// before reading those: opened, the browser read it without asking, where a command would
    /// have asked. Links are followed to where they lead.
    static func fileNote(for address: String, caller: String?) -> String? {
        // The address the browser opens, read the way it reads it (trimmed, say).
        guard let url = BrowserSession.url(from: address), url.isFileURL else { return nil }
        if let caller, readsAnywhere(caller) { return nil }
        func real(_ path: String) -> String { URL(filePath: path).resolvingSymlinksInPath().path }
        let path = real(url.path)
        let places = [caller.flatMap(sessionFolder), NSTemporaryDirectory(), "/tmp", "/private/tmp"].compactMap { $0 }.map(real)
        if places.contains(where: { path == $0 || path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }) { return nil }
        return "Not opened: \(url.path) is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and open it there."
    }

    /// Where a file that may not be there yet would be: its nearest folder that is, with links
    /// followed, and the rest of its path.
    static func realTarget(_ path: String) -> String {
        // (Its ".." taken out first, as the file is written: one in a folder that isn't there yet
        // would otherwise never get to one that is.)
        var folder = (path as NSString).standardizingPath
        var rest: [String] = []
        while !FileManager.default.fileExists(atPath: folder), folder != "/", !folder.isEmpty {
            rest.insert((folder as NSString).lastPathComponent, at: 0)
            folder = (folder as NSString).deletingLastPathComponent
        }
        return rest.reduce(URL(filePath: folder).resolvingSymlinksInPath()) { $0.appending(path: $1) }.path(percentEncoded: false)
    }

    /// What the browser says instead of opening `address`, when it's an added integration's
    /// site: to use its tools. The first time only, so the agent can still open it when the user
    /// asked for the website itself.
    static func integrationNote(for address: String, caller: String?) -> String? {
        guard let site = Integrations.site(of: address, in: integrationSites()) else { return nil }
        let key = (caller ?? "") + "\u{0}" + site.id
        if let when = sentAway[key], when.timeIntervalSinceNow > -600 { return nil }
        sentAway[key] = .now
        return site.note
    }

    static var mail: (_ name: String, _ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _, _ in ("Not available.", true) }
    /// The vault's tools (`vault_items`, `vault_ask`, `vault_run`): this Mac's box lists them and
    /// carries them out (KuvoLink's PROTOCOL.md, "Vault").
    nonisolated static func isVault(_ name: String) -> Bool { name.hasPrefix("vault_") }
    static var vaultDefinitions: () async -> [[String: Any]] = { [] }
    static var vault: (_ name: String, _ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _, _ in ("Not available.", true) }
    /// What the vault fills on a page for a conversation (`kuvo/vault/fill`): its status and answer,
    /// or nil when this Mac's box can't be reached.
    static var vaultFill: (_ body: [String: Any]) async -> (status: Int, value: [String: Any])? = { _ in nil }
    /// The sandbox's way out (`sandbox_ask`): this Mac's box lists it while its commands run in the
    /// sandbox, and asks you, and runs the command (KuvoLink's PROTOCOL.md, "Sandbox").
    nonisolated static func isSandbox(_ name: String) -> Bool { name.hasPrefix("sandbox_") }
    static var sandboxDefinitions: () async -> [[String: Any]] = { [] }
    static var sandbox: (_ name: String, _ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _, _ in ("Not available.", true) }
    /// The Work Queue's tools (`queue_…`): this Mac's box lists them, says what agents are told of
    /// them, and carries them out (KuvoLink's PROTOCOL.md, "The Work Queue").
    nonisolated static func isWorkQueue(_ name: String) -> Bool { name.hasPrefix("queue_") }
    static var workQueueDefinitions: () async -> (tools: [[String: Any]], instructions: String) = { ([], "") }
    static var workQueue: (_ name: String, _ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _, _ in ("Not available.", true) }
    /// The tool a bot keeps its job with, in its box's record (`PATCH kuvo/bots/<id>` with `job`).
    nonisolated static let setJob = "set_job"
    /// Carries out its calls from this Mac's conversations.
    static var job: (_ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _ in ("Only a bot keeps a job, and this conversation isn't one.", true) }
    /// The tools a conversation's wake-ups are set with (see `WakeUps.call`).
    nonisolated static let wakeTools: Set<String> = ["schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up"]
    /// Carries out their calls from this Mac's conversations.
    static var wake: (_ name: String, _ arguments: [String: Any], _ caller: String?) async -> (text: String, isError: Bool) = { _, _, _ in ("Not available.", true) }

    /// Says it's shown; the conversation draws it.
    nonisolated static func showWidgetCall(_ arguments: [String: Any]) -> [String: Any] {
        guard let html = arguments["html"] as? String, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ["content": [["type": "text", "text": "Missing html."]], "isError": true]
        }
        return ["content": [["type": "text", "text": "Shown in the conversation, live. The user sees it now; what they click in it that calls kuvo.send comes to you as their message."]], "isError": false]
    }

    /// What its call says when it goes ahead: shown now, or kept until the user comes back to the
    /// conversation (`inView` nil: on a machine, which can't tell). It also tells a folder from a
    /// file (see `shownFolder`).
    nonisolated static func shown(_ path: String, isFolder: Bool, inView: Bool?) -> String {
        let what = "the \(isFolder ? "folder" : "file") \(path)"
        switch inView {
        case true?: return "Shown: \(what) is open in Kuvo Code's side panel, beside this conversation."
        case false?: return "Kept for later: \(what) opens in Kuvo Code's side panel when the user comes back to this conversation. They're in another one right now, so don't say it's open."
        case nil: return "Sent: \(what) opens in Kuvo Code's side panel beside this conversation, at once if the user is looking at it, or else when they come back to it."
        }
    }

    /// Whether a call's answer says it went ahead, and with a folder: nil for an error. Machines
    /// that haven't taken the new script yet answer "Showing the file …".
    nonisolated static func shownFolder(in said: String) -> Bool? {
        for prefix in ["Shown: ", "Kept for later: ", "Sent: ", "Showing "] where said.hasPrefix(prefix) {
            let rest = said.dropFirst(prefix.count)
            if rest.hasPrefix("the folder ") { return true }
            if rest.hasPrefix("the file ") { return false }
        }
        return nil
    }

    /// Checks the path, here, and says whether the user sees it now. The window shows it once the
    /// call succeeds (see `Workspace.onShowInPanel`).
    static func showInPanelCall(_ arguments: [String: Any], caller: String?) -> [String: Any] {
        func text(_ value: String, error: Bool = false) -> [String: Any] { ["content": [["type": "text", "text": value]], "isError": error] }
        guard let raw = arguments["path"] as? String, !raw.isEmpty else { return text("Missing path.", error: true) }
        // A relative one is in the folder the conversation works in.
        let expanded = (raw as NSString).expandingTildeInPath
        let base = caller.flatMap(sessionFolder) ?? FileManager.default.currentDirectoryPath
        // A full path is taken as given: standardizing would take /private off /private/var/…,
        // where projects in the temporary folder are, and call the agent's own path wrong.
        let clean = expanded.hasPrefix("/") && !expanded.split(separator: "/").contains { $0 == ".." || $0 == "." }
        let full = clean ? expanded : (expanded.hasPrefix("/") ? URL(filePath: expanded) : URL(filePath: base).appending(path: expanded)).standardizedFileURL.path
        // A folder's path may end in "/", which expanding drops.
        var given = raw
        while given.count > 1, given.hasSuffix("/") { given.removeLast() }
        guard full == given else { return text("Give the full path: \(full)", error: true) }
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: full, isDirectory: &isFolder) else { return text("There's nothing at \(full).", error: true) }
        return text(shown(full, isFolder: isFolder.boolValue, inView: caller.map(isInView)))
    }

    /// Checks the file is there, here: the transcript shows it from the call.
    static func showFileCall(_ arguments: [String: Any]) -> [String: Any] {
        func text(_ value: String, error: Bool = false) -> [String: Any] { ["content": [["type": "text", "text": value]], "isError": error] }
        guard let raw = arguments["path"] as? String, !raw.isEmpty else { return text("Missing path.", error: true) }
        // As given, which is what the conversation shows it from: a full path, nothing to expand.
        let full = raw
        guard full.hasPrefix("/"), !full.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else {
            return text("Give the file's full path" + (raw.hasPrefix("~") ? ": \((raw as NSString).expandingTildeInPath)" : "."), error: true)
        }
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: full, isDirectory: &isFolder) else { return text("There's nothing at \(full).", error: true) }
        guard !isFolder.boolValue else { return text("\(full) is a folder: show a file in it, or the folder with show_in_panel.", error: true) }
        return text("Shown in the conversation: the file \(full). The user sees it there, on their Mac and their phone.")
    }

    /// Checks the file is there: the box's record pins it, from the call.
    static func markFinalCall(_ arguments: [String: Any]) -> [String: Any] {
        func text(_ value: String, error: Bool = false) -> [String: Any] { ["content": [["type": "text", "text": value]], "isError": error] }
        guard let full = arguments["path"] as? String, full.hasPrefix("/"), !full.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else {
            return text("Give the file's full path.", error: true)
        }
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: full, isDirectory: &isFolder), !isFolder.boolValue else { return text("There's no file at \(full).", error: true) }
        return text("Marked final: \(full). It's kept at the top of what you made, for the user.")
    }

    /// How long the engine lets a tool run: longer than the agent waits for the user.
    static let executionTimeout = 960_000

    /// What the engine tells the model about the tools.
    /// Where Kuvo Code's own docs are, for when you ask the agent how to do something in the app.
    /// Every session has these tools, so it hears it wherever it works.
    nonisolated static let docs = "You work inside Kuvo Code, the Mac app the user talks to you in: sessions in projects, a side panel with changes, files, terminals and a browser, bots, group chats and remote machines. When the user asks how to do something in Kuvo Code itself (a setting, a button, bots, wake-ups, machines, a shortcut), read its documentation with webfetch rather than guessing, starting at https://www.kuvo.run/code/docs/ (pages at https://www.kuvo.run/code/docs/<page>/: sessions, changes, panel, browsing, machines, bots, integrations, customize, settings, usage, shortcuts, privacy, troubleshooting), and answer briefly from it, saying where in the app to find it. A service the user connected as an integration (Notion, Linear, GitHub, Slack, their mail or calendar…) has regular tools named after it (notion_notion-search, linear_list_issues…), which you call directly, not through execute (they aren't in its catalog; if Code Mode says a namespace such as notion is no longer available, the regular tools are still there). Use those: they reach the user's account directly, signed in as them, so never open that service's website instead, nor tell the user you'll use the browser for it. If one of those tools fails or says it needs signing in, say so and ask the user to sign in under Settings › Integrations. Use the browser for services you have no tools for, or when the user asks for a website itself: they're signed in to sites there, or can sign in when you ask. To show the user a file or folder (one they ask to see or open, or what you made), use show_in_panel; to put a file in the conversation itself (a picture, a chart, a PDF), show_file. When the user's message ends with a <from-phone> block, they're on their iPhone, where file paths and the side panel don't reach: show files with show_file, and keep replies short. show_widget draws your HTML live in the conversation, for when seeing or trying something (a chart of real numbers, options side by side, a value to tune) beats reading it; ask a plain choice with your question tool, and draw a diagram as a ```mermaid block in your reply. You're one of the user's agents: list_agents lists their bots and other sessions, on their Mac and machines; send_message writes to one (to hand off work, ask what it knows, or report back), and read_conversation reads one's conversation without interrupting it. A message from one says who it's from. When the user names one with & (like &Mira), their message ends with who that is and its address: read its conversation when they ask about its work, and write to it when they want something from it. When the user asks for another session (a separate or parallel one they can follow and talk to), start it with start_session; a subagent is only for work you hand off and get back yourself, out of view. For sessions you start: list_sessions, answer_ask (only what you could do yourself), stop_session, compact_session (when one's context is getting full) and list_models; make_project makes a project (the user is asked first), list_projects lists them. To come back to this conversation later, even while the user is away, use schedule_wake_up (once, or again and again with every), or watch_for_change to wake only when something you watch changes, so don't keep checking or sleep in a command; list_wake_ups and cancel_wake_up manage them. Never say you can't come back later or run on a timer. For work that's to go on for good (every morning, every week), suggest a bot (the + beside Bots in the sidebar), or hand it to a bot whose job it fits with send_message. Don't look for another way to schedule anything."

    /// What the vault's tools are for: said only where agents may use the vault (its box lists them
    /// at `kuvo/vault/tools`).
    nonisolated static let vaultInstructions = " The user's vault keeps sign-ins, keys, files and notes you may use without seeing them: vault_items lists yours, vault_ask asks for one you need, browser_fill fills a field from one, and vault_run hands values to a command (never print them)."

    nonisolated static func instructions(machine: Bool, vault: Bool) -> String {
        let place = machine
            ? "You browse in the browser on this machine, which the user can watch in Kuvo Code's panel. localhost is this machine, so you can open servers you run here."
            : "You browse in the browser panel the user sees."
        return docs + "\n\n" + place + " Start with browser_navigate, read pages with browser_snapshot, and act on elements by their number. To sign in, and whenever a page you open asks you to (even if the user didn't mention signing in), call browser_sign_in right away rather than asking in the chat whether to; for a one-time code, use browser_ask_code, and for anything only the user can do (a CAPTCHA, approving on their phone), browser_ask_user. These ask the user in a card in Kuvo Code, where they can also say no, so never ask for a password or a code in the chat. For a \"Continue with Google\" (or Apple) sign-in, click it and sign in on the page it opens the same way; if that page won't let you, use browser_ask_user." + (vault ? vaultInstructions : "")
    }

    /// The tools to list: browser_fill, and browser_sign_in's vault item, only with the vault's own
    /// (none while it isn't open to agents: then a sign-in fills only one you let agents make on
    /// their own, or asks you).
    static func definitions(vault: [[String: Any]]) -> [[String: Any]] {
        guard vault.isEmpty else { return definitions + vault }
        return definitions.compactMap { tool in
            switch tool["name"] as? String {
            case "browser_fill": return nil
            case "browser_sign_in":
                var tool = tool
                var schema = tool["inputSchema"] as? [String: Any] ?? [:]
                var properties = schema["properties"] as? [String: Any] ?? [:]
                properties["item"] = nil
                schema["properties"] = properties
                tool["inputSchema"] = schema
                return tool
            default: return tool
            }
        }
    }

    private static func tool(_ name: String, _ description: String, _ properties: [String: Any] = [:], required: [String] = []) -> [String: Any] {
        var schema: [String: Any] = ["type": "object", "properties": properties]
        if !required.isEmpty { schema["required"] = required }
        return ["name": name, "description": description, "inputSchema": schema]
    }

    static func call(_ name: String, arguments: [String: Any], agent: BrowserAgent, caller: String? = nil) async -> [String: Any] {
        // While the tool works in a page, a dialog it shows is answered at once (it would hold
        // the page, and the tool, until someone did); the agent marks the page it works in.
        agent.acceptsDialogs = (arguments["accept_dialog"] as? NSNumber)?.boolValue ?? false
        defer { agent.finished() }
        // You have the page: the step waits until you hand it back.
        if let handedBack = await agent.waitForControl() {
            return ["content": [["type": "text", "text": handedBack]], "isError": false]
        }
        // The tab in use on a file the conversation may not read (one you opened, say): the step
        // goes on in a new tab. One a step took there keeps its result back. Tabs need neither: the
        // list reads no page, and a tab on such a file can't be picked.
        let browses = name.hasPrefix("browser_") && name != "browser_tabs"
        let moved = browses && name != "browser_new_tab" ? await agent.moveOffForbiddenFile() : nil
        var result = await perform(name, arguments: arguments, agent: agent, caller: caller)
        if browses, let note = await agent.leaveForbiddenFile() {
            return ["content": [["type": "text", "text": note]], "isError": true]
        }
        // Downloads that started or finished meanwhile, ahead of the tool's own result.
        let notes = (moved ?? "") + agent.takeNotes()
        if !notes.isEmpty, var content = result["content"] as? [[String: Any]], content.first?["type"] as? String == "text" {
            content[0]["text"] = notes + (content[0]["text"] as? String ?? "")
            result["content"] = content
        }
        return result
    }

    private static func perform(_ name: String, arguments: [String: Any], agent: BrowserAgent, caller: String?) async -> [String: Any] {
        func text(_ value: String, error: Bool = false) -> [String: Any] {
            ["content": [["type": "text", "text": value]], "isError": error]
        }
        func int(_ key: String) -> Int? { (arguments[key] as? NSNumber)?.intValue ?? (arguments[key] as? String).flatMap(Int.init) }
        func string(_ key: String) -> String? { arguments[key] as? String }
        func bool(_ key: String) -> Bool? { (arguments[key] as? NSNumber)?.boolValue }

        switch name {
        case "browser_navigate":
            guard let url = string("url") else { return text("Missing url.", error: true) }
            if let note = fileNote(for: url, caller: caller) { return text(note, error: true) }
            if let note = integrationNote(for: url, caller: caller) { return text(note) }
            let said = await agent.navigate(url)
            // One that didn't open is a failed step: its line doesn't read "Opened".
            return text(said, error: BrowserAgent.notOpened(said))
        case "browser_snapshot":
            return text(await agent.snapshot())
        case "browser_click":
            guard let index = int("index") else { return text("Missing index.", error: true) }
            return text(await agent.click(index))
        case "browser_type":
            guard let index = int("index"), let value = string("text") else { return text("Missing index or text.", error: true) }
            return text(await agent.type(index, text: value, submit: bool("submit") ?? false, clear: bool("clear") ?? true))
        case "browser_select":
            guard let index = int("index"), let option = string("option") else { return text("Missing index or option.", error: true) }
            return text(await agent.select(index, option: option))
        case "browser_scroll":
            let pages = (arguments["pages"] as? NSNumber)?.doubleValue ?? 1
            return text(await agent.scroll(down: string("direction") != "up", pages: pages))
        case "browser_press":
            guard let key = string("key") else { return text("Missing key.", error: true) }
            return text(await agent.press(key))
        case "browser_back":
            return text(await agent.back())
        case "browser_forward":
            return text(await agent.forward())
        case "browser_text":
            return text(await agent.text())
        case "browser_save_pdf":
            guard let path = string("path") else { return text("Missing path.", error: true) }
            // Saved outside the conversation's folder, it would replace what's there without
            // asking, where a command would have asked.
            let expanded = ((path as NSString).expandingTildeInPath as NSString).standardizingPath
            if expanded.hasPrefix("/"), fileNote(for: URL(filePath: realTarget(expanded)).absoluteString, caller: caller) != nil {
                return text("Not saved: \(expanded) is outside this conversation's folder, and this session asks before writing files elsewhere. Save it in the folder; if the user wants it elsewhere, ask them first, then move it there (a command, which asks them).", error: true)
            }
            // Where it was checked: "new/../x.pdf" leaves no "new" folder behind.
            return text(await agent.savePDF(to: expanded.hasPrefix("/") ? expanded : path))
        case "browser_screenshot":
            guard let png = await agent.screenshot() else { return text("Couldn't capture the page.", error: true) }
            return ["content": [["type": "image", "data": png, "mimeType": "image/png"]]]
        case "browser_wait":
            if let wanted = string("text"), !wanted.isEmpty { return text(await agent.wait(for: wanted)) }
            return text(await agent.wait((arguments["seconds"] as? NSNumber)?.doubleValue ?? 2))
        case "browser_hover":
            guard let index = int("index") else { return text("Missing index.", error: true) }
            return text(await agent.hover(index))
        case "browser_new_tab":
            if let url = string("url"), let note = fileNote(for: url, caller: caller) { return text(note, error: true) }
            if let url = string("url"), let note = integrationNote(for: url, caller: caller) { return text(note) }
            let said = await agent.newTab(string("url"))
            return text(said, error: BrowserAgent.notOpened(said))
        case "browser_upload":
            guard let index = int("index"), let given = arguments["files"] as? [String], !given.isEmpty else { return text("Missing index or files.", error: true) }
            // Each file by its full path, checked and read as the same one.
            let files = given.map { ($0 as NSString).expandingTildeInPath }
            if let relative = files.first(where: { !$0.hasPrefix("/") }) { return text("Not attached: give the full path of \(relative).", error: true) }
            // Attached, a file goes to the site: one outside the conversation's folder only as a
            // command could read it, after asking.
            if let outside = files.first(where: { fileNote(for: URL(filePath: $0).absoluteString, caller: caller) != nil }) {
                return text("Not attached: \(outside) is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and attach it from there.", error: true)
            }
            return text(await agent.upload(index, files: files))
        case "browser_tabs":
            return text(await agent.tabs(string("action") ?? "list", tab: int("tab")))
        case "browser_sign_in":
            return text(await agent.signIn(username: int("username"), password: int("password"), item: string("item"), for: caller))
        case "browser_fill":
            guard let index = int("index"), let item = string("item"), !item.isEmpty else { return text("Name the field by its number and the vault item to fill it from.", error: true) }
            return text(await agent.fill(index, item: item, field: string("field"), why: string("why"), for: caller))
        case "browser_ask_code":
            guard let index = int("index") else { return text("Missing index.", error: true) }
            return text(await agent.askCode(index, prompt: string("prompt"), for: caller))
        case "browser_ask_user":
            guard let instruction = string("instruction"), !instruction.isEmpty else { return text("Missing instruction.", error: true) }
            return text(await agent.askUser(instruction, for: caller))
        default:
            return text("Unknown tool \(name).", error: true)
        }
    }
}
