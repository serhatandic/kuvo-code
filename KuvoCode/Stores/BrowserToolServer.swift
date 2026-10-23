import Foundation
import Network

/// The panel's browser, offered to the agent as MCP tools (Streamable HTTP, JSON
/// responses) on 127.0.0.1. The engine is told about it at launch, with a token that
/// changes every time, so any model it runs can browse in the panel.
@MainActor
final class BrowserToolServer {
    private let agent: BrowserAgent
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]
    private let token = UUID().uuidString + UUID().uuidString
    private(set) var url: URL?
    /// The session a caller works for, when it isn't one you see: an engine run in a session with
    /// the coding agents (Auto's, say) is that session's.
    var owner: ((String) async -> String?)?
    /// Whether a name is a terminal that's open (see `terminalVariables`).
    var isTerminal: ((String) -> Bool)?
    /// A terminal's agent used the tools: the panel's notice about setting them up can go.
    var onTerminalCall: ((String) -> Void)?
    /// A terminal's agent shows you a file or folder: its panel opens it.
    var showForTerminal: ((URL, Bool, String) -> Void)?

    init(agent: BrowserAgent) {
        self.agent = agent
    }

    /// Where the coding agents reach it (the bridge gives it to each with its session's header).
    var agentsServer: OutsideAgents.ToolServer? {
        url.map { OutsideAgents.ToolServer(url: $0.absoluteString, token: token, timeout: BrowserTools.executionTimeout) }
    }

    /// What every terminal in the app has in its environment, for an agent running there to
    /// reach these tools through `kuvo-mcp.sh` (an MCP server over stdio, which it adds to its
    /// own settings).
    var terminalVariables: [String: String] {
        guard let url, let script = Bundle.main.url(forResource: "kuvo-mcp", withExtension: "sh") else { return [:] }
        return ["KUVO_MCP_URL": url.absoluteString, "KUVO_MCP_TOKEN": token, "KUVO_MCP_SCRIPT": script.path]
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

    /// Starts listening on a free loopback port and returns the address.
    func start() async throws -> URL {
        if let url { return url }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { state in
                MainActor.assumeIsolated {
                    guard !resumed else { return }
                    switch state {
                    case .ready:
                        resumed = true
                        continuation.resume(returning: listener.port?.rawValue ?? 0)
                    case .failed(let error):
                        resumed = true
                        continuation.resume(throwing: error)
                    default:
                        break
                    }
                }
            }
            listener.start(queue: .main)
        }
        let url = URL(string: "http://127.0.0.1:\(port)/mcp")!
        self.url = url
        return url
    }

    private func accept(_ connection: NWConnection) {
        let http = HTTPConnection(connection: connection) { [weak self] request in
            await self?.respond(to: request) ?? .init(status: 503)
        } closed: { [weak self] id in
            self?.connections[id] = nil
        }
        connections[ObjectIdentifier(http)] = http
        http.start()
    }

    // MARK: HTTP

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        guard request.path.hasPrefix("/mcp") else { return .init(status: 404) }
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer "),
              String(authorization.dropFirst(7)) == token else { return .init(status: 401) }
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
        // An agent in one of the app's terminals, which has no session of the engine's: the terminal's name.
        let terminal = request.headers["x-kuvo-terminal"]
        if let batch = body as? [[String: Any]] {
            var replies: [[String: Any]] = []
            for message in batch { if let reply = await handle(message, from: client, session: session, terminal: terminal) { replies.append(reply) } }
            return replies.isEmpty ? .init(status: 202) : .json(replies)
        }
        guard let message = body as? [String: Any] else { return .init(status: 400) }
        guard let reply = await handle(message, from: client, session: session, terminal: terminal) else { return .init(status: 202) }
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
    private func handle(_ message: [String: Any], from client: String?, session: String? = nil, terminal: String? = nil) async -> [String: Any]? {
        guard let method = message["method"] as? String else { return nil }
        let params = message["params"] as? [String: Any] ?? [:]
        guard let id = message["id"] else {
            if method == "notifications/cancelled", let request = params["requestId"] { calls[Self.key(request, client: client)]?.cancel() }
            return nil
        }
        func reply(_ result: [String: Any]) -> [String: Any] { ["jsonrpc": "2.0", "id": id, "result": result] }
        switch method {
        case "initialize":
            if let terminal { onTerminalCall?(terminal) }
            let requested = params["protocolVersion"] as? String
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
            return reply([
                "protocolVersion": requested.flatMap { supported.contains($0) ? $0 : nil } ?? "2025-06-18",
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "kuvo-browser", "title": "Kuvo Code browser", "version": AppInfo.version],
                "instructions": terminal != nil ? BrowserTools.terminalInstructions : BrowserTools.instructions(machine: false),
            ])
        case "ping":
            return reply([:])
        case "tools/list":
            return reply(["tools": terminal != nil ? BrowserTools.terminalDefinitions : BrowserTools.definitions])
        case "tools/call":
            let name = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            if let terminal {
                guard isTerminal?(terminal) == true else {
                    return reply(["content": [["type": "text", "text": "Kuvo Code doesn't know this terminal any more: it was closed. Run the agent in one of its terminals."]], "isError": true])
                }
                guard BrowserTools.terminalTools.contains(name) else {
                    return reply(["content": [["type": "text", "text": "\(name) needs a conversation in Kuvo Code; from a terminal, use the browser tools and show_in_panel."]], "isError": true])
                }
                if name == BrowserTools.showInPanel { return reply(BrowserTools.showInPanelFromTerminal(arguments, terminal: terminal, show: showForTerminal)) }
            }
            // The engine names the session calling, so an ask goes to the right conversation; the
            // agents bridge, in a header.
            var caller = terminal ?? (params["_meta"] as? [String: Any])?["ai.opencode/sessionID"] as? String ?? session
            if terminal == nil, let named = caller, let owner, let own = await owner(named) { caller = own }
            // Not the browser's: no page to serve it.
            if name == BrowserTools.showInPanel { return reply(BrowserTools.showInPanelCall(arguments, caller: caller)) }
            if name == BrowserTools.showFile { return reply(BrowserTools.showFileCall(arguments)) }
            if name == BrowserTools.showWidget { return reply(BrowserTools.showWidgetCall(arguments)) }
            let key = Self.key(id, client: client)
            let call: Task<CallResult, Never>
            if BrowserTools.mailTools.contains(name) || BrowserTools.wakeTools.contains(name) {
                // Stopped as the others are: one waiting for an answer stops waiting.
                call = Task {
                    let result = BrowserTools.wakeTools.contains(name) ? await BrowserTools.wake(name, arguments, caller) : await BrowserTools.mail(name, arguments, caller)
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
        tool("browser_navigate", "Open a web address (or search for words) in the browser panel the user sees. Returns the page as numbered elements.",
             ["url": ["type": "string", "description": "An address like example.com, or words to search for."]], required: ["url"]),
        tool("browser_snapshot", "Read the current page: title, address, scroll position, and its interactive elements numbered like [3], with visible text."),
        tool("browser_click", "Click the element with this number from the latest snapshot.",
             ["index": ["type": "integer", "description": "The element's number, like 3 for [3]."], "accept_dialog": ["type": "boolean", "description": "Accept a confirmation or prompt the page shows on the way (they're declined otherwise)."]], required: ["index"]),
        tool("browser_type", "Type text into the input with this number. Replaces what's there unless clear is false.",
             ["index": ["type": "integer"], "text": ["type": "string"],
              "submit": ["type": "boolean", "description": "Press Enter afterwards (submits search boxes and forms)."],
              "clear": ["type": "boolean", "description": "Clear the field first. Defaults to true."]], required: ["index", "text"]),
        tool("browser_select", "Choose an option, by its text or value, in the drop-down list with this number.",
             ["index": ["type": "integer"], "option": ["type": "string"]], required: ["index", "option"]),
        tool("browser_scroll", "Scroll the page up or down by screens.",
             ["direction": ["type": "string", "enum": ["up", "down"]], "pages": ["type": "number", "description": "How many screens. Defaults to 1."]], required: ["direction"]),
        tool("browser_press", "Press a key on the focused element: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight or Backspace. For typing text, use browser_type.",
             ["key": ["type": "string"], "accept_dialog": ["type": "boolean", "description": "Accept a confirmation or prompt the page shows on the way (they're declined otherwise)."]], required: ["key"]),
        tool("browser_back", "Go back a page."),
        tool("browser_forward", "Go forward a page."),
        tool("browser_text", "Read all the text on the current page at once: an article, docs, a list or a table, without scrolling through it."),
        tool("browser_screenshot", "See the visible part of the page as an image (for models that take images). With show, the user sees it too, in this conversation: use it whenever they ask to see the page or for a screenshot.",
             ["show": ["type": "boolean", "description": "Show it to the user in the conversation, not only to you."]]),
        tool("browser_save_pdf", "Save the current page as a PDF file, in pages as printing it would, with its colors. To make a document someone can share (a report, a summary, an invoice), write it as an HTML file, open it with browser_navigate (file:///…), then save it here.",
             ["path": ["type": "string", "description": "Where to save it: a full path ending in .pdf."]], required: ["path"]),
        tool("browser_wait", "Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).",
             ["seconds": ["type": "number"], "text": ["type": "string", "description": "Text to wait for, like a result's title or \"Saved\"."]]),
        tool("browser_hover", "Move the pointer over the element with this number, for menus and tips that open on hover.",
             ["index": ["type": "integer"]], required: ["index"]),
        tool("browser_new_tab", "Open a new browser tab in the panel, optionally at an address.",
             ["url": ["type": "string"]]),
        tool("browser_upload", "Attach files to the page's file input with this number (or the upload button it belongs to), as choosing them in the file picker would. Give the files' full paths.",
             ["index": ["type": "integer"], "files": ["type": "array", "items": ["type": "string"], "description": "Full paths of the files to attach."]], required: ["index", "files"]),
        tool("browser_tabs", "List the browser's tabs (numbered like [1], with the one in use marked), switch to one to work in it, or close one.",
             ["action": ["type": "string", "enum": ["list", "switch", "close"], "description": "Defaults to list."],
              "tab": ["type": "integer", "description": "The tab's number from the list, to switch to or close."]]),
        tool("browser_sign_in", "Sign in on the page with the user's own username and password: they type them in Kuvo Code (or pick a saved one), and they go straight into the fields you name. You never see them. Use this for every sign-in, and never ask for a password in the chat. Whenever a page you open asks to sign in, call it right away, even if the user didn't mention signing in: its card is how you ask them, and they can say Not Now there. Don't ask in the chat whether to sign in. Name the fields the page has now (on a sign-in that asks for the username and the password on pages of their own, call it on each; the user answers once). Then submit the form yourself.",
             ["username": ["type": "integer", "description": "The number of the username or email field, if the page has one."],
              "password": ["type": "integer", "description": "The number of the password field, if the page has one."]]),
        tool("browser_ask_code", "Ask the user for a one-time code (from a text message, an email or an authenticator app), which goes straight into the field with this number. You never see it. Then submit it if the page doesn't on its own.",
             ["index": ["type": "integer"], "prompt": ["type": "string", "description": "What to tell the user, like \"Enter the 6-digit code texted to your phone\"."]], required: ["index"]),
        tool("browser_ask_user", "Ask the user to do something on the page themselves: a CAPTCHA, approving the sign-in on their phone, or anything else you can't do. Waits until they say it's done (up to 15 minutes), then reads the page again.",
             ["instruction": ["type": "string", "description": "What they should do, in a sentence."]], required: ["instruction"]),
        tool(showInPanel, "Show the user a file or folder in Kuvo Code's side panel, beside this conversation: a folder opens in the Files tab, open down to it; a file in a tab of its own (code, Markdown, pictures and PDFs show as they are). Use it whenever the user asks to see, open or find something, and to point them to what you made or found. Give its full path.",
             ["path": ["type": "string", "description": "The file's or folder's full path."]], required: ["path"]),
        tool(showFile, "Put a file in this conversation, for the user to see where they read your replies: a picture shows in it, large, and any other file (a PDF, a document, a spreadsheet) as a card they open. Use it to show what you made or found when seeing it helps, and always when the user is on their phone (their message ends with a <from-phone> block), where file paths and the side panel don't reach them. Give its full path.",
             ["path": ["type": "string", "description": "The file's full path."],
              "caption": ["type": "string", "description": "A line about it, shown under it."]], required: ["path"]),
        tool(showWidget, "Show the user something visual or interactive right in this conversation, drawn live where this call is: a chart or graph, a diagram or flow, a mockup, a table to sort, a small app, calculator or game, a timeline, a visual explanation, or choices for them to click. Use it whenever seeing or playing with something says it better than words, and be creative. Write the HTML: a fragment, or a whole page, with its CSS and JavaScript inline; libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com (Chart.js, D3, Mermaid, Three.js, Leaflet with its map tiles); pictures from anywhere, but it can't fetch data or send anything, so put the data in the page. Follow light and dark with CSS (it starts transparent with color-scheme light dark, text in CanvasText, and --kuvo-accent as the accent). It's as tall as its content, up to about 760 points, then it scrolls. To hear back, call kuvo.send(text) from a click in it: that sends text to you as the user's message (a choice they made, values they set).",
             ["html": ["type": "string", "description": "The HTML to show."],
              "title": ["type": "string", "description": "A short name for it, shown above it. Write it first, before the HTML: it shows while you write the rest."]], required: ["html"]),
        tool("list_agents", "List the other agents you can write to with send_message, or whose conversation you can read with read_conversation: the user's bots (named helpers with a job of their own) and their other recent sessions, on their Mac and their machines, each with its name, where it runs and its address."),
        tool("read_conversation", "Read another agent's conversation (a bot's or another session's, from list_agents, or one the user names with &): what the user and others wrote to it, its replies, and a line for each step it took, oldest first. Use it to learn what it did, decided or found, to pick up where it left off, or to follow it, without interrupting it. A long one gives its start and its latest part; with query, the parts that mention it.",
             ["of": ["type": "string", "description": "Its name or address, from list_agents or the user's message."],
              "query": ["type": "string", "description": "A word or phrase to find in it: only the parts that mention it come back."]], required: ["of"]),
        tool("send_message", "Write to another agent (a bot or another session, from list_agents): it reaches that conversation as a message from you, and its agent takes it up, with its own tools and what it knows. Use it to hand off work, ask for help or information, coordinate, or report back. With wait, you get its answer back here (up to ten minutes); without, it can answer you with send_message later. A message from another agent reaches you the same way, saying who it's from.",
             ["to": ["type": "string", "description": "Its name or address, from list_agents."],
              "text": ["type": "string", "description": "What to say: all it needs to know, as it hasn't seen this conversation."],
              "wait": ["type": "boolean", "description": "Wait for its answer and get it back here."]], required: ["to", "text"]),
        tool("schedule_wake_up", "Come back to this conversation later, even while the user is away: at `when`, it gets your note as a message starting with \"[Wake-up]\", and you carry on from it. Use it to look again at something later (a build in 20 minutes, a reply tomorrow), or with every, again and again until it's canceled. Never say you can't come back later or run on a timer: schedule a wake-up instead.",
             ["when": ["type": "string", "description": "+20m, +2h, +1d, or a time like 2026-10-21T09:00 on the user's clock; at least a minute from now."],
              "note": ["type": "string", "description": "What to do then: all you'll need, as a note to yourself."],
              "every": ["type": "string", "description": "To have it come back until it's canceled: 30m, 2h, 1d, 1w (at least 5m), or weekdays. Days, weeks and weekdays keep its time of day. When it's due now too, also do the first round now."]], required: ["when", "note"]),
        tool("watch_for_change", "Wait for something to change without checking yourself (CI finishing, a deploy, a status page, a price, a file): every so often its check, a shell command, runs without you, and this conversation wakes with your note and the new output only when what the check prints changes (not the first time). Make it print just what you watch, like gh run list --limit 1 --json status,conclusion -q '.[0] | .status + \" \" + .conclusion' or curl -s <url> | grep -o '<the part that matters>', so a clock or an ad on the page doesn't count as a change. It runs in this conversation's folder for at most a minute; only what it prints counts, and printing nothing counts too. A run is skipped when a curl, wget or gh in it fails, or when it prints nothing and exits 2 or more. To watch whether a site is up, print its status code: curl -s -o /dev/null -w '%{http_code}' <url>.",
             ["every": ["type": "string", "description": "How often: 5m or more, 2h, 1d."],
              "check": ["type": "string", "description": "The shell command that prints what you watch."],
              "note": ["type": "string", "description": "What to do when it changes."]], required: ["every", "check", "note"]),
        tool("list_wake_ups", "List this conversation's wake-ups and watches, with their ids, to check what's scheduled before adding one (never keep two for the same thing)."),
        tool("cancel_wake_up", "Cancel one of this conversation's wake-ups or watches, by its id from list_wake_ups (or the one schedule_wake_up or watch_for_change gave). To change a schedule, cancel it and schedule the new one.",
             ["id": ["type": "string", "description": "Its id."]], required: ["id"]),
        tool("start_session", "Start a new session: another agent with a conversation of its own, to work on something alongside you (a separate task, a second opinion, one part of a bigger job). It works in this conversation's folder unless you name another, on your model, and gets the task as a message from you, so it knows who to report to. It shows beside this conversation for the user to follow, and you get its address to write to it with send_message; it can write back to you the same way. With wait, you get its first answer back here.",
             ["task": ["type": "string", "description": "What it's to do: all it needs to know, as it hasn't seen this conversation."],
              "title": ["type": "string", "description": "A short name for it, like \"Write the tests\"."],
              "folder": ["type": "string", "description": "The folder it works in, as a full path: this conversation's by default."],
              "beside": ["type": "boolean", "description": "Show it beside this conversation (the default). False opens it in a tab instead."],
              "wait": ["type": "boolean", "description": "Wait for its first answer and get it back here (up to ten minutes)."]], required: ["task"]),
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

    /// The tool that shows something the agent made, live in the conversation; the transcript
    /// draws it from the call (see `WidgetCard`), for a session here or on a machine alike.
    nonisolated static let showWidget = "show_widget"

    /// The tools agents write to each other with (see `AgentMail`).
    nonisolated static let mailTools: Set<String> = ["list_agents", "send_message", "read_conversation", "start_session"]
    /// Carries out their calls from this Mac's conversations.
    /// The added integrations' sites, which the browser sends the agent away from, to their tools.
    static var integrationSites: () -> [Integrations.Site] = { [] }
    /// When a conversation was sent away from an integration's site, by conversation and site:
    /// asked again a while after, the browser goes there.
    private static var sentAway: [String: Date] = [:]

    /// Whether a conversation may read files outside its folder without asking (Approve All, not a
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

    private struct PathProblem: Error { let message: String }

    /// The full path a show_in_panel call names, and whether it's a folder; or what's wrong with it.
    private static func checkedPath(_ arguments: [String: Any], caller: String?) -> Result<(path: String, isFolder: Bool), PathProblem> {
        guard let raw = arguments["path"] as? String, !raw.isEmpty else { return .failure(PathProblem(message: "Missing path.")) }
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
        guard full == given else { return .failure(PathProblem(message: "Give the full path: \(full)")) }
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: full, isDirectory: &isFolder) else { return .failure(PathProblem(message: "There's nothing at \(full).")) }
        return .success((full, isFolder.boolValue))
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

    private static func text(_ value: String, error: Bool = false) -> [String: Any] { ["content": [["type": "text", "text": value]], "isError": error] }

    /// Checks the path, here, and says whether the user sees it now. The window shows it once the
    /// call succeeds (see `Workspace.onShowInPanel`).
    static func showInPanelCall(_ arguments: [String: Any], caller: String?) -> [String: Any] {
        switch checkedPath(arguments, caller: caller) {
        case .failure(let problem): return text(problem.message, error: true)
        case .success(let found): return text(shown(found.path, isFolder: found.isFolder, inView: caller.map(isInView)))
        }
    }

    /// An agent in a terminal shows a file or folder, in that terminal's panel: now if you're looking
    /// at it, else when you come back to it.
    static func showInPanelFromTerminal(_ arguments: [String: Any], terminal: String, show: ((URL, Bool, String) -> Void)?) -> [String: Any] {
        switch checkedPath(arguments, caller: nil) {
        case .failure(let problem): return text(problem.message, error: true)
        case .success(let found):
            show?(URL(filePath: found.path, directoryHint: found.isFolder ? .isDirectory : .notDirectory), found.isFolder, terminal)
            let what = "the \(found.isFolder ? "folder" : "file") \(found.path)"
            return text(isInView(terminal)
                ? "Shown: \(what) is open in Kuvo Code's side panel, beside this terminal."
                : "Kept for later: \(what) opens in Kuvo Code's side panel when the user comes back to this terminal. They're looking at something else right now, so don't say it's open.")
        }
    }

    /// What an agent in a terminal can use: the panel's browser and show_in_panel. The rest needs a
    /// conversation of Kuvo Code's (a widget is drawn in one, messages and wake-ups belong to one).
    static let terminalTools: Set<String> = Set(definitions.compactMap { $0["name"] as? String }.filter { $0.hasPrefix("browser_") }).union([showInPanel])

    static let terminalDefinitions: [[String: Any]] = definitions.filter { terminalTools.contains($0["name"] as? String ?? "") }

    static let terminalInstructions = "You're running in a terminal inside Kuvo Code, the Mac app. These tools use its side panel, which the user sees beside you. The browser_ tools drive its browser: start with browser_navigate, read pages with browser_snapshot, and act on elements by their number. To sign in, use browser_sign_in; for a one-time code, browser_ask_code; for anything only the user can do (a CAPTCHA, approving on their phone), browser_ask_user: they answer in a card in Kuvo Code, so never ask for a password or a code in the terminal. To show the user a file or folder (one they ask to see or open, or what you made), use show_in_panel with its full path: it opens in the side panel."
    /// How long the engine lets a tool run: longer than the agent waits for the user.
    static let executionTimeout = 960_000

    /// What the engine tells the model about the tools.
    /// Where Kuvo Code's own docs are, for when you ask the agent how to do something in the app.
    /// Every session has these tools, so it hears it wherever it works.
    nonisolated static let docs = "You're working inside Kuvo Code, the Mac app the user talks to you in: sessions in projects, a side panel with changes, files, terminals and a browser, bots, group chats and remote machines. When the user asks how to do something in Kuvo Code itself (where a setting is, what a button does, how bots, wake-ups or machines work, a shortcut), read its documentation with webfetch rather than guessing: start at https://www.kuvo.run/code/docs/, whose pages include sessions, changes, panel, browsing, machines, bots, integrations, customize, settings, usage, shortcuts, privacy and troubleshooting (each at https://www.kuvo.run/code/docs/<page>/). Answer from what it says, briefly, and say where in the app to find it. When the user names a service (Notion, Linear, GitHub, Slack, their mail or calendar…) and they connected it as an integration, you have tools for it: regular tools in your list, named after it (notion_notion-search, linear_list_issues…), which you call directly, not through execute (they aren't in its catalog). Use those. They reach the user's account directly, signed in as them, so never open that service's website instead, and don't tell the user you'll use the browser for it. If Code Mode says a namespace such as notion is no longer available, that's only Code Mode: the service's regular tools are still there, so call them. If such a tool fails or says it needs signing in, say so and ask the user to sign in under Settings › Integrations. Use the browser for services you have no tools for (their chats or social accounts, say), or when the user asks for a website itself: the user is signed in to sites there, or can sign in when you ask. To show the user a file or folder (one they ask to see or open, or what you made), use show_in_panel: it opens in Kuvo Code's side panel, beside this conversation. To put a file in the conversation itself (a picture you made, a chart, a PDF), use show_file. When the user's message ends with a <from-phone> block, they're on their iPhone: file paths and the side panel don't reach them there, so show files with show_file, and keep replies short. To show something visual or interactive (a chart, a diagram, a mockup, a small app or game, choices to click), use show_widget: it draws your HTML live in the conversation, so reach for it whenever a picture or something to play with helps more than words. You're one of the user's agents: their bots and other sessions, on their Mac and machines, can be reached with list_agents and send_message, to hand off work, ask what they know, or report back; a message from one of them says who it's from. read_conversation reads one's conversation, to see what it did or decided without interrupting it. When the user names one with & (like &Mira), their message ends with who that is and its address: read its conversation when they ask about its work, and write to it when they want something from it. When the user asks for another session (a separate or parallel one, one they can follow and talk to), start it with start_session, which opens it beside this conversation; a subagent is only for work you hand off and get back yourself, out of view. You can come back to this conversation later, even while the user is away: schedule_wake_up has it wake you with your note at a time you choose (check a build in 20 minutes, look again tomorrow), or again and again with every, and watch_for_change wakes you only when something you watch changes (CI finishing, a deploy, a page), so don't keep checking or sleep in a command. Never say you can't come back later or run on a timer. list_wake_ups shows what's set, and cancel_wake_up cancels one. For work that's to go on for good (every morning, every week), suggest a bot for it (the + beside Bots in the sidebar), or hand it to a bot whose job it fits with send_message. Don't look for another way to schedule anything."

    nonisolated static func instructions(machine: Bool) -> String {
        let place = machine
            ? "Use these tools to browse in the browser on this machine, which the user can watch in Kuvo Code's panel. localhost is this machine, so you can open servers you run here."
            : "Use these tools to browse in the browser panel the user sees."
        return docs + "\n\n" + place + " Start with browser_navigate, read pages with browser_snapshot, and act on elements by their number. To sign in, use browser_sign_in; for a one-time code, browser_ask_code; for anything only the user can do (a CAPTCHA, approving on their phone), browser_ask_user. These ask the user in a card in Kuvo Code, where they can also say no. So whenever a page you open asks to sign in, call browser_sign_in right away, even if the user didn't mention signing in, rather than asking in the chat whether to; and never ask for a password or a code in the chat. For a \"Continue with Google\" (or Apple) sign-in, click it and sign in on the page it opens the same way; if that page won't let you, use browser_ask_user."
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
            return text(await agent.navigate(url))
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
            return text(await agent.savePDF(to: path))
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
            return text(await agent.newTab(string("url")))
        case "browser_upload":
            guard let index = int("index"), let files = arguments["files"] as? [String], !files.isEmpty else { return text("Missing index or files.", error: true) }
            // Attached, a file goes to the site: one outside the conversation's folder only as a
            // command could read it, after asking.
            if let outside = files.first(where: { fileNote(for: $0, caller: caller) != nil }) {
                return text("Not attached: \(outside) is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and attach it from there.", error: true)
            }
            return text(await agent.upload(index, files: files))
        case "browser_tabs":
            return text(await agent.tabs(string("action") ?? "list", tab: int("tab")))
        case "browser_sign_in":
            return text(await agent.signIn(username: int("username"), password: int("password"), for: caller))
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

// MARK: - A minimal HTTP/1.1 server connection

struct HTTPRequest {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data
}

struct HTTPResponse {
    var status: Int
    var headers: [String: String] = [:]
    var body = Data()

    static func json(_ object: Any) -> HTTPResponse {
        // Sorted, so the tools' list reads the same at every launch, and a conversation picked up
        // after one keeps the provider's prompt cache.
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
    }
}

/// One client connection: reads requests (keep-alive), answers them one at a time. It keeps
/// reading meanwhile, so a client that goes away stops what it asked for.
@MainActor
private final class HTTPConnection {
    private let connection: NWConnection
    private let handler: (HTTPRequest) async -> HTTPResponse
    private let closed: (ObjectIdentifier) -> Void
    private var buffer = Data()
    /// The request being answered.
    private var answering: Task<Void, Never>?
    private var closing = false

    init(connection: NWConnection, handler: @escaping (HTTPRequest) async -> HTTPResponse, closed: @escaping (ObjectIdentifier) -> Void) {
        self.connection = connection
        self.handler = handler
        self.closed = closed
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch state {
                case .failed, .cancelled:
                    self.closing = true
                    self.answering?.cancel()
                    self.closed(ObjectIdentifier(self))
                default: break
                }
            }
        }
        connection.start(queue: .main)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, !self.closing else { return }
                if let data { self.buffer.append(data) }
                if self.answering == nil { self.process() }
                if complete || error != nil {
                    // Gone: what it asked stops.
                    self.connection.cancel()
                } else if !self.closing {
                    self.receive()
                }
            }
        }
    }

    /// The most a request's headers and body may take: far more than a tool call needs.
    static let maxHead = 64 * 1024
    static let maxBody = 16 * 1024 * 1024

    /// Starts answering a complete request in the buffer, if there is one.
    private func process() {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            // Headers that never end aren't a request.
            if buffer.count > Self.maxHead { refuse() }
            return
        }
        guard headerEnd.lowerBound - buffer.startIndex <= Self.maxHead else { return refuse() }
        let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else {
            closing = true
            return connection.cancel()
        }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        // A length that isn't one, below zero or too big is turned away before it's read.
        guard let length = Int(headers["content-length"] ?? "0"), (0...Self.maxBody).contains(length) else { return refuse() }
        let bodyStart = headerEnd.upperBound
        guard buffer.count - bodyStart >= length else { return }
        let body = buffer.subdata(in: bodyStart..<(bodyStart + length))
        buffer.removeSubrange(..<(bodyStart + length))
        let request = HTTPRequest(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body)
        answering = Task {
            let response = await handler(request)
            send(response)
        }
    }

    /// A request it won't read: says so, and closes the connection.
    private func refuse() {
        closing = true
        buffer = Data()
        let head = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.connection.cancel() }
        })
    }

    private func send(_ response: HTTPResponse) {
        let reason: String = switch response.status {
        case 200: "OK"
        case 202: "Accepted"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 404: "Not Found"
        case 405: "Method Not Allowed"
        default: "Error"
        }
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "keep-alive"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        guard !closing else { return }
        connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.closing else { return }
                self.answering = nil
                // The next request on this connection, if one came in meanwhile.
                self.process()
            }
        })
    }
}
