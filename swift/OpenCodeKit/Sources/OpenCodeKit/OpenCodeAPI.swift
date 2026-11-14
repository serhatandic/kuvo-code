import Foundation

/// The opencode v2 HTTP API, the parts the app uses.
///
/// Calls that take a `directory` are scoped to that project folder (sent as the
/// `x-opencode-directory` header). Session calls are scoped by the session itself.
public struct OpenCodeAPI: Sendable {
    public let client: HTTPClient
    /// For an engine on another machine: how the app writes that machine's folders
    /// (`ssh://host`), taken off before a folder goes to the engine, which knows only its paths.
    public let folderPrefix: String?

    public init(endpoint: ServerEndpoint, session: URLSession = .shared, folderPrefix: String? = nil) {
        client = HTTPClient(endpoint: endpoint, session: session)
        self.folderPrefix = folderPrefix
    }

    /// A folder as the engine knows it.
    public func enginePath(_ folder: String) -> String {
        guard let folderPrefix, folder.hasPrefix(folderPrefix) else { return folder }
        return String(folder.dropFirst(folderPrefix.count))
    }

    /// A folder the engine named, as the app writes it.
    public func appFolder(_ path: String) -> String {
        guard let folderPrefix, !path.hasPrefix(folderPrefix) else { return path }
        return folderPrefix + path
    }

    public var events: EventStream { EventStream(client: client) }

    // MARK: Server

    public func info() async throws -> ServerInfo {
        try await get("api/info")
    }

    // MARK: Catalog

    public func integrations(directory: String? = nil) async throws -> [Integration] {
        try await get("api/integration", directory: directory, as: LocatedEnvelope<[Integration]>.self).data
    }

    public func integration(_ id: String, directory: String? = nil) async throws -> Integration {
        try await get("api/integration/\(id.pathEscaped)", directory: directory, as: LocatedEnvelope<Integration>.self).data
    }

    public func providers(directory: String? = nil) async throws -> [Provider] {
        try await get("api/provider", directory: directory, as: LocatedEnvelope<[Provider]>.self).data
    }

    public func models(directory: String? = nil) async throws -> [Model] {
        try await get("api/model", directory: directory, as: LocatedEnvelope<[Model]>.self).data
    }

    public func defaultModel(directory: String? = nil) async throws -> Model? {
        try await get("api/model/default", directory: directory, as: LocatedEnvelope<Model?>.self).data
    }

    public func agents(directory: String? = nil) async throws -> [Agent] {
        try await get("api/agent", directory: directory, as: LocatedEnvelope<[Agent]>.self).data
    }

    public func commands(directory: String? = nil) async throws -> [Command] {
        try await get("api/command", directory: directory, as: LocatedEnvelope<[Command]>.self).data
    }

    // MARK: Settings

    /// Shells the engine can run commands in.
    public func shells() async throws -> [ShellOption] {
        try await get("api/config/shell")
    }

    public func mcpServers(directory: String? = nil) async throws -> [MCPServer] {
        try await get("api/mcp", directory: directory, as: LocatedEnvelope<[MCPServer]>.self).data
    }

    /// Connects `name` again, in `directory`'s instance (each folder the engine has open runs its
    /// own servers), or the engine's own folder's.
    public func connectMCP(_ name: String, directory: String? = nil) async throws {
        try await send("POST", "api/experimental/mcp/\(name.pathEscaped)/connect", directory: directory)
    }

    public func disconnectMCP(_ name: String) async throws {
        try await send("POST", "api/experimental/mcp/\(name.pathEscaped)/disconnect")
    }

    public func skills(directory: String? = nil) async throws -> [Skill] {
        try await get("api/skill", directory: directory, as: LocatedEnvelope<[Skill]>.self).data
    }

    public func webSearchProviders(directory: String? = nil) async throws -> [WebSearchProvider] {
        try await get("api/websearch/provider", directory: directory, as: LocatedEnvelope<[WebSearchProvider]>.self).data
    }

    /// One project's approvals saved with Always: `projectID`'s, or by default the engine's own
    /// folder's (the folders outside any project's).
    public func savedPermissions(projectID: String? = nil) async throws -> [SavedPermission] {
        try await get("api/permission/saved", query: ["projectID": projectID], as: DataEnvelope<[SavedPermission]>.self).data
    }

    public func removeSavedPermission(_ id: String) async throws {
        try await send("DELETE", "api/permission/saved/\(id.pathEscaped)")
    }

    public func plugins(directory: String? = nil) async throws -> [PluginInfo] {
        try await get("api/plugin", directory: directory, as: LocatedEnvelope<[PluginInfo]>.self).data
    }

    /// The project's version control state: today, its current git branch.
    /// One answer from the session's model, with the session's context, leaving its history
    /// as it was.
    public func generate(_ prompt: String, session: String) async throws -> String {
        struct Body: Encodable { var prompt: String }
        struct Response: Decodable { var data: Text; struct Text: Decodable { var text: String } }
        return try await send("POST", "api/session/\(session.pathEscaped)/generate", body: Body(prompt: prompt), as: Response.self).data.text
    }

    /// One answer from a model (the default one without `model`), outside any session.
    /// OpenCode's free models don't answer these.
    public func generate(_ prompt: String, model: ModelRef? = nil) async throws -> String {
        struct Body: Encodable { var prompt: String; var model: ModelRef? }
        struct Response: Decodable { var data: Text; struct Text: Decodable { var text: String } }
        return try await send("POST", "api/experimental/generate", body: Body(prompt: prompt, model: model), as: Response.self).data.text
    }

    public func vcs(directory: String) async throws -> VCSInfo {
        try await get("api/vcs", directory: directory, as: LocatedEnvelope<VCSInfo>.self).data
    }

    // MARK: Projects and worktrees

    /// What the engine makes of a folder: its project, and that project's main checkout.
    public func location(directory: String) async throws -> LocationInfo {
        var info: LocationInfo = try await get("api/location", directory: directory)
        info.directory = appFolder(info.directory)
        info.project.directory = appFolder(info.project.directory)
        info.project.canonical = appFolder(info.project.canonical)
        return info
    }

    public func projects() async throws -> [ProjectInfo] {
        try await get("api/project")
    }

    /// Sets the command the engine runs in each new worktree of the project (nil or empty for none).
    public func setSetupCommand(project id: String, _ command: String?) async throws {
        struct Body: Encodable { var commands: ProjectInfo.Commands }
        try await send("PATCH", "api/project/\(id.pathEscaped)", body: Body(commands: ProjectInfo.Commands(start: command ?? "")))
    }

    /// A new git worktree of the project, at its main checkout's last commit (with no branch
    /// checked out), in the engine's data folder. The project's setup command runs in it first.
    /// Returns its folder.
    public func createWorktree(project id: String, name: String? = nil) async throws -> String {
        struct Body: Encodable { var projectID: String; var name: String? }
        struct Info: Decodable { var directory: String }
        return appFolder(try await send("POST", "api/worktree", body: Body(projectID: id, name: name), as: Info.self).directory)
    }

    /// Removes a worktree the engine made. Without `force`, git refuses one with changes that
    /// aren't committed.
    public func removeWorktree(project id: String, directory: String, force: Bool) async throws {
        struct Body: Encodable { var projectID: String; var directory: String; var force: Bool }
        try await send("DELETE", "api/worktree", body: Body(projectID: id, directory: enginePath(directory), force: force))
    }

    // MARK: Connecting providers

    public func connectKey(integration: String, key: String, answer: FormAnswer? = nil, directory: String? = nil) async throws {
        struct Body: Encodable { var key: String; var answer: FormAnswer? }
        try await send("POST", "api/integration/\(integration.pathEscaped)/connect/key", directory: directory, body: Body(key: key, answer: answer))
    }

    public func connectExternal(integration: String, method: String, answer: FormAnswer? = nil, directory: String? = nil) async throws {
        struct Body: Encodable { var methodID: String; var answer: FormAnswer? }
        try await send("POST", "api/integration/\(integration.pathEscaped)/connect/external", directory: directory, body: Body(methodID: method, answer: answer))
    }

    public func startOAuth(integration: String, method: String, answer: FormAnswer? = nil, directory: String? = nil) async throws -> OAuthAttempt {
        struct Body: Encodable { var methodID: String; var answer: FormAnswer? }
        return try await send("POST", "api/integration/\(integration.pathEscaped)/connect/oauth", directory: directory,
                              body: Body(methodID: method, answer: answer), as: LocatedEnvelope<OAuthAttempt>.self).data
    }

    public func oauthStatus(integration: String, attempt: String, directory: String? = nil) async throws -> OAuthStatus {
        try await get("api/integration/\(integration.pathEscaped)/connect/oauth/\(attempt.pathEscaped)", directory: directory, as: LocatedEnvelope<OAuthStatus>.self).data
    }

    /// For `mode == .code` sign-ins only: hands the pasted code to the engine.
    public func completeOAuth(integration: String, attempt: String, code: String, directory: String? = nil) async throws {
        struct Body: Encodable { var code: String }
        try await send("POST", "api/integration/\(integration.pathEscaped)/connect/oauth/\(attempt.pathEscaped)/complete", directory: directory, body: Body(code: code))
    }

    public func cancelOAuth(integration: String, attempt: String, directory: String? = nil) async throws {
        try await send("DELETE", "api/integration/\(integration.pathEscaped)/connect/oauth/\(attempt.pathEscaped)", directory: directory)
    }

    /// Where the engine's settings come from, each with its settings as the engine reads them
    /// (an older opencode's turned into its own form).
    public func configSources(directory: String? = nil) async throws -> JSONValue {
        try await get("api/config", directory: directory)
    }

    public func credentials() async throws -> [Credential] {
        try await get("api/credential", as: DataEnvelope<[Credential]>.self).data
    }

    /// Stored sign-ins with their secrets, for asking providers about usage.
    /// Keep the result in memory only.
    public func credentialSecrets() async throws -> [CredentialSecret] {
        try await get("api/credential", as: DataEnvelope<[CredentialSecret]>.self).data
    }

    /// Stored sign-ins whole (an OAuth one's refresh token too), to hand one to another engine
    /// (a machine's) as it is. Keep the result in memory only.
    public func credentialEntries() async throws -> [CredentialEntry] {
        try await get("api/credential", as: DataEnvelope<[CredentialEntry]>.self).data
    }

    /// Stores a sign-in made elsewhere (another engine's), for `integration`: with `activate`, as
    /// its active one.
    public func storeCredential(_ entry: CredentialEntry, for integration: String, activate: Bool = true) async throws {
        struct Body: Encodable {
            var integrationID: String
            var label: String
            var value: JSONValue
            var activate: Bool
        }
        try await send("POST", "api/credential", body: Body(integrationID: integration, label: entry.label, value: entry.value, activate: activate))
    }

    /// Stores a sign-in for `integration`, as its active one, in the engine's own form (a key,
    /// or an OAuth sign-in with its method): one brought over from an older opencode.
    public func storeCredential(value: JSONValue, label: String, for integration: String) async throws {
        struct Body: Encodable {
            var integrationID: String
            var label: String
            var value: JSONValue
            var activate = true
        }
        try await send("POST", "api/credential", body: Body(integrationID: integration, label: label, value: value))
    }

    public func activateCredential(_ id: String) async throws {
        try await send("POST", "api/credential/\(id.pathEscaped)/activate")
    }

    public func removeCredential(_ id: String) async throws {
        try await send("DELETE", "api/credential/\(id.pathEscaped)")
    }

    // MARK: Sessions

    /// A page of sessions, newest first; the next one after `cursor` (a page's `cursor.next`,
    /// which carries the filters along).
    public func sessions(directory: String? = nil, roots: Bool = true, limit: Int = 100, after cursor: String? = nil) async throws -> Page<Session> {
        var query: [String: String?] = ["limit": String(limit)]
        if let cursor {
            query["cursor"] = cursor
        } else {
            query["order"] = "desc"
            if roots { query["parentID"] = "null" }
            if let directory { query["directory"] = enginePath(directory) }
        }
        var page: Page<Session> = try await get("api/session", query: query)
        page.data = page.data.map(appSession)
        return page
    }

    /// The sessions a session's agent started (its subagents'), newest first.
    public func children(of session: String, limit: Int = 50) async throws -> [Session] {
        let page: Page<Session> = try await get("api/session", query: ["limit": String(limit), "order": "desc", "parentID": session])
        return page.data.map(appSession)
    }

    /// Every session a session's agent started, newest first, page after page.
    public func allChildren(of session: String) async throws -> [Session] {
        let size = 100
        var page: Page<Session> = try await get("api/session", query: ["limit": String(size), "order": "desc", "parentID": session])
        var all = page.data
        var seen = Set(all.map(\.id))
        while page.data.count == size, let next = page.cursor?.next {
            page = try await get("api/session", query: ["limit": String(size), "cursor": next])
            let new = page.data.filter { seen.insert($0.id).inserted }
            guard !new.isEmpty else { break }
            all += new
        }
        return all.map(appSession)
    }

    /// Every session (the root ones, unless `roots` is false), newest first, page after page.
    public func allSessions(directory: String? = nil, roots: Bool = true) async throws -> [Session] {
        let size = 100
        var page = try await sessions(directory: directory, roots: roots, limit: size)
        var all = page.data
        var seen = Set(all.map(\.id))
        // The last page is the short one; its cursor still points on.
        while page.data.count == size, let next = page.cursor?.next {
            page = try await sessions(limit: size, after: next)
            let new = page.data.filter { seen.insert($0.id).inserted }
            guard !new.isEmpty else { break }
            all += new
        }
        return all
    }

    public func session(_ id: String) async throws -> Session {
        appSession(try await get("api/session/\(id.pathEscaped)", as: DataEnvelope<Session>.self).data)
    }

    /// A session as the app keeps it: its folder written the app's way.
    func appSession(_ session: Session) -> Session {
        guard folderPrefix != nil else { return session }
        var session = session
        session.location.directory = appFolder(session.location.directory)
        return session
    }

    /// Sessions that are running right now.
    public func activeSessions() async throws -> Set<String> {
        let active = try await get("api/session/active", as: DataEnvelope<[String: JSONValue]>.self).data
        return Set(active.keys)
    }

    public func createSession(directory: String, title: String? = nil, agent: String? = nil, model: ModelRef? = nil, permissions: [PermissionRule]? = nil, metadata: JSONValue? = nil) async throws -> Session {
        struct Body: Encodable { var title: String?; var agent: String?; var model: ModelRef?; var location: Location; var permissions: [PermissionRule]?; var metadata: JSONValue? }
        let body = Body(title: title, agent: agent, model: model, location: Location(directory: enginePath(directory)), permissions: permissions, metadata: metadata)
        return appSession(try await send("POST", "api/session", body: body, as: DataEnvelope<Session>.self).data)
    }

    /// A new session with a conversation from elsewhere (the agents bridge takes one from the
    /// engine): its messages as they were, carried on here.
    public func importSession(directory: String, title: String?, agent: String?, model: ModelRef, permissions: [PermissionRule]?, messages: [Message], waiting: [WaitingPrompt] = []) async throws -> Session {
        struct Body: Encodable { var title: String?; var agent: String?; var model: ModelRef; var location: Location; var permissions: [PermissionRule]?; var messages: [Message]; var waiting: [WaitingPrompt] }
        let body = Body(title: title, agent: agent, model: model, location: Location(directory: enginePath(directory)), permissions: permissions, messages: messages, waiting: waiting)
        return appSession(try await send("POST", "api/session/import", body: body, as: DataEnvelope<Session>.self).data)
    }

    /// A conversation whole, as the engine keeps it (its session, with its metadata and
    /// permissions, and every message), for another engine to carry on with
    /// (`importSession(exported:directory:)`): a bot or chat moving to another computer. Kept as
    /// the engine wrote it, so nothing is lost on the way.
    public func exportSession(_ id: String) async throws -> JSONValue {
        try await get("api/experimental/session/\(id.pathEscaped)/export", as: DataEnvelope<JSONValue>.self).data
    }

    /// A conversation another engine exported (`exportSession`), carried on here at `directory`
    /// under the same ID. An engine that has one with that ID already refuses it (409).
    public func importSession(exported: JSONValue, directory: String) async throws -> Session {
        struct Body: Encodable { var info: JSONValue; var messages: JSONValue; var location: Location }
        guard let info = exported["info"], let messages = exported["messages"] else { throw URLError(.cannotParseResponse) }
        let body = Body(info: info, messages: messages, location: Location(directory: enginePath(directory)))
        return appSession(try await send("POST", "api/experimental/session/import", body: body, as: DataEnvelope<Session>.self).data)
    }

    public func renameSession(_ id: String, title: String) async throws {
        struct Body: Encodable { var title: String }
        try await send("PATCH", "api/session/\(id.pathEscaped)", body: Body(title: title))
    }

    /// Moves the session to another folder (and that folder's project): right away when it's
    /// idle, otherwise at the agent's next step. The folder must exist.
    public func moveSession(_ id: String, to directory: String) async throws {
        struct Body: Encodable { var directory: String }
        try await send("POST", "api/session/\(id.pathEscaped)/move", body: Body(directory: enginePath(directory)))
    }

    /// Replaces the session's own permission rules (the agent's still apply underneath).
    public func setPermissions(session id: String, rules: [PermissionRule]) async throws {
        struct Body: Encodable { var permissions: [PermissionRule] }
        try await send("PATCH", "api/session/\(id.pathEscaped)", body: Body(permissions: rules))
    }

    /// Attaches (or replaces) an instruction for the session's agent under `key` (lowercase
    /// letters, digits, `.`, `_` and `-`). The agent hears about the change at its next step.
    public func setInstruction(session id: String, key: String, text: String) async throws {
        struct Body: Encodable { var value: String }
        try await send("PUT", "api/experimental/session/\(id.pathEscaped)/instructions/entries/\(key.pathEscaped)", body: Body(value: text))
    }

    public func removeInstruction(session id: String, key: String) async throws {
        try await send("DELETE", "api/experimental/session/\(id.pathEscaped)/instructions/entries/\(key.pathEscaped)")
    }

    /// A new session with this one's conversation up to (not including) `before`.
    public func forkSession(_ id: String, before: String) async throws -> Session {
        struct Body: Encodable { var before: String }
        return appSession(try await send("POST", "api/session/\(id.pathEscaped)/fork", body: Body(before: before), as: DataEnvelope<Session>.self).data)
    }

    /// Replaces the session's metadata (a JSON object; keep what other clients put there).
    public func setMetadata(session id: String, _ metadata: JSONValue) async throws {
        struct Body: Encodable { var metadata: JSONValue }
        try await send("PATCH", "api/session/\(id.pathEscaped)", body: Body(metadata: metadata))
    }

    public func deleteSession(_ id: String) async throws {
        try await send("DELETE", "api/session/\(id.pathEscaped)")
    }

    /// Marks the session read up to its last run.
    public func markViewed(_ id: String, idle: Milliseconds) async throws {
        struct Body: Encodable { var idle: Milliseconds }
        try await send("POST", "api/session/\(id.pathEscaped)/view", body: Body(idle: idle))
    }

    /// The newest messages, oldest first.
    public func messages(session: String, limit: Int = 100, before cursor: String? = nil) async throws -> Page<Message> {
        var query: [String: String?] = ["limit": String(limit)]
        if let cursor { query["cursor"] = cursor } else { query["order"] = "desc" }
        var page: Page<Message> = try await get("api/session/\(session.pathEscaped)/message", query: query)
        page.data.reverse()
        return page
    }

    /// The oldest messages, oldest first: how the conversation began.
    public func firstMessages(session: String, limit: Int = 100) async throws -> Page<Message> {
        try await get("api/session/\(session.pathEscaped)/message", query: ["limit": String(limit), "order": "asc"])
    }

    public func inbox(session: String) async throws -> [InboxItem] {
        try await get("api/session/\(session.pathEscaped)/inbox", as: DataEnvelope<[InboxItem]>.self).data
    }

    /// The shell commands running in `directory`'s location: agents', those left running in the
    /// background among them.
    public func shells(directory: String? = nil) async throws -> [ShellJob] {
        try await get("api/shell", directory: directory, as: LocatedEnvelope<[ShellJob]>.self).data
    }

    /// One shell command, with its process once it has started and its exit once it has ended.
    public func shell(_ id: String, directory: String? = nil) async throws -> ShellJob {
        try await get("api/shell/\(id.pathEscaped)", directory: directory, as: LocatedEnvelope<ShellJob>.self).data
    }

    /// A shell command's output from byte `cursor` on (the start without), `limit` bytes at most.
    public func shellOutput(_ id: String, from cursor: Int? = nil, limit: Int? = nil, directory: String? = nil) async throws -> ShellOutput {
        try await get("api/shell/\(id.pathEscaped)/output", query: ["cursor": cursor.map(String.init), "limit": limit.map(String.init)],
                      directory: directory, as: LocatedEnvelope<ShellOutput>.self).data
    }

    /// Stops a shell command and drops the output it kept.
    public func removeShell(_ id: String, directory: String? = nil) async throws {
        try await send("DELETE", "api/shell/\(id.pathEscaped)", directory: directory)
    }

    public func diff(session: String) async throws -> [FileDiff] {
        try await get("api/session/\(session.pathEscaped)/diff", as: DataEnvelope<[FileDiff]>.self).data
    }

    // MARK: Running

    /// A message you sent that waits its turn, carried into an imported session (still waiting).
    public struct WaitingPrompt: Encodable, Sendable {
        public var id: String
        public var text: String
        public var files: [PromptFile]

        public init(id: String, text: String, files: [PromptFile]) {
            self.id = id
            self.text = text
            self.files = files
        }
    }

    public struct PromptFile: Encodable, Sendable {
        public var uri: String
        public var name: String?

        public init(uri: String, name: String? = nil) {
            self.uri = uri
            self.name = name
        }
    }

    /// Sends a message. Returns as soon as it's queued; the reply arrives as events.
    public func prompt(session: String, id: String, text: String, files: [PromptFile] = [], delivery: InboxItem.Delivery = .steer) async throws {
        struct Body: Encodable { var id: String; var text: String; var files: [PromptFile]?; var delivery: InboxItem.Delivery }
        let body = Body(id: id, text: text, files: files.isEmpty ? nil : files, delivery: delivery)
        var request = try request("POST", "api/session/\(session.pathEscaped)/prompt", query: [:], directory: nil, body: body)
        // Taken once by its id however often it comes, so a phone's link sends it again if it
        // drops before the answer comes (KuvoLink's `LinkRequest.repeatableHeader`).
        request.setValue(id, forHTTPHeaderField: Self.repeatableHeader)
        _ = try await client.send(request, as: Empty.self)
    }

    /// The header that says a request is safe to send again (KuvoLink's `LinkRequest.repeatableHeader`).
    public static let repeatableHeader = "Idempotency-Key"

    /// Words from the app rather than from you, which the engine keeps apart from your messages, as
    /// it does its own notes to the model; the agent then takes a turn on them.
    public func addSynthetic(session: String, text: String, description: String? = nil) async throws {
        struct Body: Encodable { var text: String; var description: String? }
        try await send("POST", "api/session/\(session.pathEscaped)/synthetic", body: Body(text: text, description: description), as: Empty.self)
    }

    /// Runs a slash command, with what follows its name, and files, as a message would carry them.
    public func runCommand(session: String, name: String, arguments: String, files: [PromptFile] = [], delivery: InboxItem.Delivery? = nil) async throws {
        struct Body: Encodable { var name: String; var text: String; var files: [PromptFile]?; var delivery: InboxItem.Delivery? }
        let body = Body(name: name, text: arguments, files: files.isEmpty ? nil : files, delivery: delivery)
        try await send("POST", "api/session/\(session.pathEscaped)/command", body: body)
    }

    public func selectAgent(session: String, agent: String) async throws {
        struct Body: Encodable { var agent: String }
        try await send("POST", "api/session/\(session.pathEscaped)/agent", body: Body(agent: agent))
    }

    public func selectModel(session: String, model: ModelRef) async throws {
        struct Body: Encodable { var model: ModelRef }
        try await send("POST", "api/session/\(session.pathEscaped)/model", body: Body(model: model))
    }

    /// Stops the current run. With `resume`, the agent goes straight on with the input waiting
    /// to steer it, so that input goes in now instead of at the next step. Whether there was a run
    /// to stop.
    @discardableResult
    public func interrupt(session: String, resume: Bool = false) async throws -> Bool {
        struct Response: Decodable { var interrupted: Bool }
        return try await send("POST", "api/session/\(session.pathEscaped)/interrupt", query: ["resume": resume ? "true" : nil], as: Response.self).interrupted
    }

    /// Removes waiting input before the agent gets it. Input already delivered is left alone.
    /// Summarizes the conversation so far to free up the context window: right away when
    /// idle, otherwise at the agent's next step.
    public func compact(session: String) async throws {
        struct Body: Encodable {}
        try await send("POST", "api/session/\(session.pathEscaped)/compact", body: Body(), as: JSONValue.self)
    }

    /// Waits for the session's run to wind down after an interrupt.
    public func wait(session: String) async throws {
        try await send("POST", "api/experimental/session/\(session.pathEscaped)/wait")
    }

    /// Takes the conversation back to before `messageID`, and the files the agent changed
    /// since. Until the next message (which makes it final), `clearRevert` brings it all back.
    public func stageRevert(session: String, messageID: String) async throws -> Session.Revert {
        struct Body: Encodable { var messageID: String }
        return try await send("POST", "api/session/\(session.pathEscaped)/revert/stage", body: Body(messageID: messageID), as: DataEnvelope<Session.Revert>.self).data
    }

    public func clearRevert(session: String) async throws {
        try await send("DELETE", "api/session/\(session.pathEscaped)/revert")
    }

    public func cancelInbox(session: String, item: String) async throws {
        try await send("DELETE", "api/session/\(session.pathEscaped)/inbox/\(item.pathEscaped)")
    }

    /// Moves waiting input between the next step (`steer`, which also wakes an idle session)
    /// and after the run (`queue`).
    public func setDelivery(session: String, item: String, delivery: InboxItem.Delivery) async throws {
        struct Body: Encodable { var delivery: InboxItem.Delivery }
        try await send("PATCH", "api/session/\(session.pathEscaped)/inbox/\(item.pathEscaped)", body: Body(delivery: delivery))
    }

    /// Runs one command in the session's folder, as you, without waking the agent: it gets the
    /// command and its output with the next message.
    /// It shows up through the session's events (`session.shell.started`, `…ended`).
    public func runShell(session: String, command: String) async throws {
        struct Body: Encodable { var command: String }
        try await send("POST", "api/session/\(session.pathEscaped)/shell", body: Body(command: command))
    }

    // MARK: Permissions and questions

    public func permissions(session: String) async throws -> [PermissionRequest] {
        try await get("api/session/\(session.pathEscaped)/permission", as: DataEnvelope<[PermissionRequest]>.self).data
    }

    public func reply(session: String, permission: String, decision: PermissionRequest.Decision, message: String? = nil) async throws {
        struct Body: Encodable { var decision: PermissionRequest.Decision; var message: String? }
        try await send("POST", "api/session/\(session.pathEscaped)/permission/\(permission.pathEscaped)/reply", body: Body(decision: decision, message: message))
    }

    /// A session's forms; `directory` with ``FormRequest/anySession`` for what MCP servers ask
    /// in that project folder.
    public func forms(session: String, directory: String? = nil) async throws -> [FormRequest] {
        try await get("api/session/\(session.pathEscaped)/form", directory: directory, as: DataEnvelope<[FormRequest]>.self).data
    }

    public func reply(session: String, form: String, answer: FormAnswer, directory: String? = nil) async throws {
        struct Body: Encodable { var answer: FormAnswer }
        try await send("POST", "api/session/\(session.pathEscaped)/form/\(form.pathEscaped)/reply", directory: directory, body: Body(answer: answer))
    }

    /// Declines a question. With a message, the agent reads it as feedback.
    public func dismiss(session: String, form: String, message: String? = nil, directory: String? = nil) async throws {
        try await send("DELETE", "api/session/\(session.pathEscaped)/form/\(form.pathEscaped)", query: ["message": message], directory: directory)
    }

    // MARK: Plumbing

    private func get<Response: Decodable>(_ path: String, query: [String: String?] = [:], directory: String? = nil, as type: Response.Type = Response.self) async throws -> Response {
        try await client.send(request("GET", path, query: query, directory: directory, body: Empty?.none), as: type)
    }

    @discardableResult
    private func send<Response: Decodable>(_ method: String, _ path: String, query: [String: String?] = [:], directory: String? = nil, body: (some Encodable)? = Empty?.none, as type: Response.Type = Empty.self) async throws -> Response {
        try await client.send(request(method, path, query: query, directory: directory, body: body), as: type)
    }

    private func request(_ method: String, _ path: String, query: [String: String?], directory: String?, body: (some Encodable)?) throws -> URLRequest {
        var request = try client.request(method, path, query: query, body: body)
        if let directory {
            request.setValue(enginePath(directory).addingPercentEncoding(withAllowedCharacters: .uriComponentAllowed), forHTTPHeaderField: "x-opencode-directory")
        }
        return request
    }
}

extension CharacterSet {
    /// What JavaScript's `encodeURIComponent` leaves alone.
    static let uriComponentAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
}

extension String {
    var pathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .uriComponentAllowed) ?? self
    }
}
