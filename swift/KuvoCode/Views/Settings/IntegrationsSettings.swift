import ClientDesign
import OpenCodeKit
import SwiftUI

/// Integrations: your mail and calendar, chats, socials, code and work tools, for the agent and
/// your bots, on each computer (each has its own, with its own keys and sign-ins). Each the best
/// way it has: its maker's own server (connect, and sign in once), a key you bring, or the site in
/// the panel's browser. What the page lists, and how each is doing, is what the computer's box
/// says (`kuvo/integrations`, this Mac's as a machine's); adding and removing go through it too.
struct IntegrationsSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    /// What the box listed last; nil until it's read (`Shown` has what it said before, at once).
    @State private var listed: Integrations.Listed?
    /// Why it couldn't be read just now.
    @State private var failure: String?
    /// Goes up with each read and each change's answer: an older read coming back later is dropped.
    @State private var reads = 0
    /// The engine's servers, as it says how each is doing: when they change, the box is asked again.
    @State private var live: [MCPServer] = []
    /// Those being added, removed or connected again: a spinner in their place.
    @State private var busy: Set<String> = []
    /// The keys being read again, from the note over the page.
    @State private var readingKeys = false
    /// Those just turned on, until the box has the change: starting, not Off.
    @State private var turningOn: Set<String> = []
    @State private var signingIn: IntegrationRef?
    @State private var addingKey: Integrations.Entry?
    @State private var removing: Integrations.Entry?
    /// What didn't happen, and why.
    @State private var trouble: (title: String, why: String)?
    @State private var demoAdded = false

    private var config: EngineConfig { app.config(for: box) }
    private var api: OpenCodeAPI? { app.api(for: box) }
    private var name: String { app.name(of: box) }
    /// What's shown: what the box said, or before this page was opened again, what it said then.
    private var shown: Integrations.Listed? { listed ?? Shown.last[box.id] }

    /// Its box is up: this Mac's running, a machine's engine reached.
    private var boxUp: Bool {
        guard let machine = box.machine else { return app.box.endpoint != nil }
        return app.machines.engine(machine)?.isReady == true
    }

    /// What, changing, means it's worth asking the box again.
    private struct Changes: Equatable {
        var live: [MCPServer]
        var settings: [String: JSONValue]
        var boxUp: Bool
        /// This Mac's browser's cookies changed (a site signed in to or out of).
        var cookies: Int
    }

    var body: some View {
        Group {
            if let shown {
                list(shown)
            } else if let failure {
                unread(failure)
            } else {
                reading
            }
        }
        .modifier(LiveMCPServers(servers: $live, api: { app.api(for: box) }, change: config.settings))
        .task(id: Changes(live: live, settings: config.settings, boxUp: boxUp, cookies: box.machine == nil ? SiteSignIns.shared.macChanges : 0)) { await read() }
        .task(id: box) {
            // Where a machine's browser is signed in, as its cookies say, read from here: its box
            // can't tell yet. (This Mac's box says where this Mac's is.)
            guard let machine = box.machine else { return }
            while !Task.isCancelled {
                await SiteSignIns.shared.refresh(machine, app: app)
                try? await Task.sleep(for: .seconds(4))
            }
        }
        .confirmationDialog("Remove \(removing?.title ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { entry in
            Button("Remove", role: .destructive) { remove(entry) }
        } message: { _ in
            Text("The agent and your bots stop using it, and your sign-in or key goes with it.")
        }
        .alert(trouble?.title ?? "", isPresented: Binding(get: { trouble != nil }, set: { if !$0 { trouble = nil } })) {
            Button("OK") { trouble = nil }
        } message: {
            Text(trouble?.why ?? "")
        }
        #if DEBUG
        .onAppear {
            // KUVO_DEMO_SIGN_IN_SITE=<id>: signing in to that service on its site, in the sheet.
            if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_SIGN_IN_SITE"], let service = Integrations.service(id) {
                app.settingsTabs.open(service, on: box)
            }
            // KUVO_DEMO_CONNECTED=<id>: its sign-in, on its last step.
            if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_CONNECTED"], let service = Integrations.service(id) {
                signingIn = IntegrationRef(id: "mcp_demo", service: service)
            }
        }
        #endif
        .settingsDetail(item: $signingIn, title: { _ in nil }) { ref in
            ConnectDetail(integrationID: ref.id, name: ref.service?.title, symbol: ref.service?.symbol, note: ref.service == nil ? "The agent can use it now." : "", highlights: highlights(ref.service?.title)) {
                signingIn = nil
                Task {
                    if let api { for entry in shown?.integrations ?? [] where entry.signIn == ref.id { await app.reconnect(entry.id, api: api, machine: box.machine) } }
                    await read()
                }
            }
        }
        .settingsDetail(item: $addingKey, title: { "Connect \($0.title)" }) { entry in
            KeyEntry(entry: entry) { saved in
                addingKey = nil
                guard let saved else { return }
                // Its box connects its server again everywhere once the engine has read the key.
                take(saved)
            }
        }
    }

    private func list(_ listed: Integrations.Listed) -> some View {
        let entries = listed.integrations
        return ScrollingSettingsForm {
            // Integrations live in the settings file: one that can't be changed changes nothing here.
            ConfigProblem()
            if let failure {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(name)’s integrations can’t be read now")
                            Text("\(failure) Below is how they were when last read.").foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                    Button("Try Again") { Task { await tryAgain() } }
                }
            } else if let note = listed.keysNote(on: name) {
                // Once, for the page: the rows only dim what needs keys.
                Section {
                    Label {
                        Text(note)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                    if readingKeys {
                        Spinner(size: 14)
                            .frame(height: 22)
                            .accessibilityLabel("Reading the keys again")
                    } else {
                        Button("Try Again") { readKeysAgain() }
                            .help("Read the integrations’ keys on \(name) again")
                    }
                }
            }
            ForEach(Self.kinds(of: entries)) { kind in
                Section(kind.id) {
                    ForEach(kind.entries) { entry in
                        // As last read while its box can't be reached: dimmed, and nothing to do.
                        row(entry)
                            .opacity(failure == nil ? 1 : 0.5)
                            .disabled(failure != nil)
                    }
                }
            }
        }
    }

    /// Being read for the first time.
    private var reading: some View {
        VStack(spacing: 14) {
            Spinner()
            Text("Reading \(name)’s integrations…")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 60)
    }

    /// Never read: why, and Try Again.
    private func unread(_ why: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: box.machine == nil ? "laptopcomputer" : "server.rack")
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text("\(name)’s integrations can’t be read")
                .font(.system(size: 15, weight: .semibold))
            Text(why)
                .settingsText()
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Try Again") { Task { await tryAgain() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 60)
    }

    /// A kind, by its title, and its integrations.
    private struct Kind: Identifiable {
        let id: String
        var entries: [Integrations.Entry]
    }

    /// Each kind, in the order the box lists them. KUVO_DEMO_INTEGRATION_KINDS=<kinds>: only those,
    /// for screenshots.
    private static func kinds(of entries: [Integrations.Entry]) -> [Kind] {
        var kinds: [Kind] = []
        for entry in entries {
            if let at = kinds.firstIndex(where: { $0.id == entry.kind }) { kinds[at].entries.append(entry) } else { kinds.append(Kind(id: entry.kind, entries: [entry])) }
        }
        #if DEBUG
        if let only = ProcessInfo.processInfo.environment["KUVO_DEMO_INTEGRATION_KINDS"] {
            return kinds.filter { kind in only.split(separator: ",").contains { kind.id.lowercased().hasPrefix($0.lowercased()) } }
        }
        #endif
        return kinds
    }

    private func row(_ entry: Integrations.Entry) -> some View {
        let places = entry.added ? self.places(entry) : siteSignIns(entry)
        return SettingsRowLayout {
            HStack(alignment: .center, spacing: 12) {
                BrandMarkView(entry.id, size: 17, fallback: entry.symbol)
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    // The tag flows on after the name, so a narrow row wraps the two as one line.
                    Text("\(entry.title)  \(Text(entry.how).font(.subheadline).foregroundStyle(.secondary))")
                    Text(entry.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    if !places.isEmpty {
                        PlacesLine(places: places, waitsForCodeHelp: "Ask the agent to use \(entry.title): the first time, it gives you a code to enter on Microsoft's page.")
                            .padding(.top, 2)
                    }
                }
            }
            .settingsText()
            HStack {
                if busy.contains(entry.id) {
                    Spinner(size: 14)
                        .frame(height: 22)
                        .accessibilityLabel("Working on \(entry.title)")
                } else if let adding = entry.adding {
                    switch adding {
                    case .onSite:
                        let service = Integrations.service(entry.id)
                        Button(siteSignedIn(entry) == true ? "Open…" : "Sign In…") {
                            if let service { withAnimation(.ui) { app.settingsTabs.open(service, on: box) } }
                        }
                        .disabled(service == nil)
                        .help("Sign in to \(entry.title) in the browser the agent and your bots use on \(box.machine == nil ? "this Mac" : name)")
                    case .app: Button("Add App…") { addingKey = entry }
                    case .key: Button("Add Key…") { addingKey = entry }
                    case .connect: Button("Connect") { add(entry) }
                    case .keysUnreadable:
                        // Waits for its keys to be read (the page says so, once).
                        Button(entry.isApp ? "Add App…" : "Add Key…") {}
                            .disabled(true)
                            .help("Its keys can’t be read on \(name) right now")
                    }
                } else {
                    let health = health(of: entry)
                    let isOff = health == .disabled
                    // What needs you, first.
                    if health == .needsSignIn, let signIn = entry.signIn {
                        // Again when the sign-in it had ended: the one way to sign in, said so.
                        Button(entry.signInEnded == true ? "Sign In Again…" : "Sign In…") { signingIn = IntegrationRef(id: signIn, service: Integrations.service(entry.id)) }
                    } else if health == .failed {
                        Button("Try Again") { reconnect(entry) }
                    } else if isOff {
                        // Turned off in MCP Servers: on again, as its switch there does.
                        Button("Turn On") { turnOn(entry) }
                            .help("The agent and your bots can use \(entry.title) again")
                            .accessibilityLabel("Turn on \(entry.title)")
                    } else {
                        // Nothing needs you: say it's set up, beside its menu.
                        Label("Added", systemImage: "checkmark")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Menu {
                        // Nothing to sign in to or connect while it's off, and not twice: while
                        // it needs one, its button signs in.
                        if !isOff, health != .needsSignIn, let signIn = entry.signIn {
                            Button("Sign In Again…") { signingIn = IntegrationRef(id: signIn, service: Integrations.service(entry.id)) }
                        }
                        if entry.takesKeys {
                            // Not while its keys can't be read there: they'd only be turned away.
                            Button(entry.isApp ? "Change App…" : "Change Key…") { addingKey = entry }
                                .disabled(entry.keysUnknown)
                                .accessibilityHint(entry.keysUnknown ? "Its keys can’t be read on \(name) right now." : "")
                        }
                        if !isOff { Button("Reconnect") { reconnect(entry) } }
                        Divider()
                        // Its keys go with it, and can't be taken away while they can't be read.
                        Button("Remove…", role: .destructive) { removing = entry }
                            .disabled(entry.keysUnknown)
                            .accessibilityHint(entry.keysUnknown ? "Its keys can’t be read on \(name) right now." : "")
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("More")
                    .accessibilityLabel("More for \(entry.title)")
                }
            }
        }
    }

    /// How it's doing, as its box says; one just turned on is starting until the box has it. Nil
    /// while its engine can't say.
    private func health(of entry: Integrations.Entry) -> Integrations.Entry.Health? {
        guard let said = entry.health else { return shown?.engineDown == true ? nil : .starting }
        return turningOn.contains(entry.id) && said == .disabled ? .starting : said
    }

    /// How it's doing on this computer.
    private func places(_ entry: Integrations.Entry) -> [Place] {
        [Place(name: name, machine: box.machine, state: health(of: entry).map { Place.state($0, signInEnded: entry.signInEnded == true) } ?? .engineDown)]
    }

    /// Whether a service the agent uses on its site is signed in on this computer: as this Mac's
    /// box says, or as a machine's browser's cookies, read from here, last said.
    private func siteSignedIn(_ entry: Integrations.Entry) -> Bool? {
        box.machine == nil ? entry.siteSignedIn : SiteSignIns.shared.isSignedIn(entry.id, on: box.machine)
    }

    private func siteSignIns(_ entry: Integrations.Entry) -> [Place] {
        guard entry.isBrowser, let signedIn = siteSignedIn(entry) else { return [] }
        return [Place(name: name, machine: box.machine, state: signedIn ? .signedIn : .signedOut)]
    }

    /// What signing in to it gives you, for the sheet's last step.
    private func highlights(_ title: String?) -> [ConnectView.Highlight] {
        guard let title else { return [] }
        return [ConnectView.Highlight(symbol: "text.bubble", title: "Just ask", detail: "The agent and your bots use \(title)'s own tools when you mention it, not its website.")]
    }

    // MARK: Through its box

    /// What the box lists now; `again`, as Try Again reads it (this Mac's host interface started
    /// first, when it isn't answering).
    private func read(again: Bool = false) async {
        reads += 1
        let read = reads
        do {
            let found = try await again ? app.integrationsAgain(on: box) : app.integrations(on: box)
            guard read == reads else { return }
            listed = found
            Shown.last[box.id] = found
            failure = nil
            #if DEBUG
            // KUVO_DEMO_ADD_INTEGRATION=<ids>: those added, as Connect does (comma-separated).
            if !demoAdded, let ids = ProcessInfo.processInfo.environment["KUVO_DEMO_ADD_INTEGRATION"] {
                demoAdded = true
                for id in ids.split(separator: ",").map(String.init) {
                    if let entry = found.integrations.first(where: { $0.id == id }), !entry.added { add(entry) }
                }
            }
            #endif
        } catch {
            guard read == reads else { return }
            failure = error.localizedDescription
        }
    }

    /// One as the box answered a change with it, in its place (a read under way is dropped).
    private func take(_ entry: Integrations.Entry) {
        reads += 1
        guard var now = shown else { return }
        if let at = now.integrations.firstIndex(where: { $0.id == entry.id }) { now.integrations[at] = entry }
        listed = now
        Shown.last[box.id] = now
    }

    /// This Mac's box started again when it stopped for good; then read again.
    private func tryAgain() async {
        if box.machine == nil, app.box.endpoint == nil, app.box.canStartAgain { await app.box.startAgain() }
        await read(again: true)
    }

    /// The keys read again, as the whole page is: a spinner in Try Again's place meanwhile, and
    /// said plainly when they still can't be (the page says so itself when it couldn't be read).
    private func readKeysAgain() {
        readingKeys = true
        Task {
            await tryAgain()
            readingKeys = false
            if failure == nil, shown?.keysNote(on: name) != nil {
                trouble = ("The keys still can’t be read", box.machine == nil
                    ? "Kuvo Code still can’t reach your Keychain for them. Try again in a moment, and if it keeps happening, quit and reopen Kuvo Code."
                    : "\(name) still can’t reach them. Try again in a moment.")
            }
        }
    }

    private func add(_ entry: Integrations.Entry) {
        busy.insert(entry.id)
        Task {
            do {
                take(try await app.addIntegration(entry, on: box))
            } catch {
                trouble = ("\(entry.title) wasn’t added", error.localizedDescription)
            }
            busy.remove(entry.id)
        }
    }

    /// Out of the engine's settings, with its keys, its sign-in and what its server kept.
    private func remove(_ entry: Integrations.Entry) {
        busy.insert(entry.id)
        Task {
            if let why = await app.removeIntegration(entry.id, on: box) { trouble = ("\(entry.title) wasn’t removed", why) }
            await read()
            busy.remove(entry.id)
        }
    }

    /// Connects it again on this computer.
    private func reconnect(_ entry: Integrations.Entry) {
        busy.insert(entry.id)
        Task {
            if let api { await app.reconnect(entry.id, api: api, machine: box.machine) }
            await read()
            busy.remove(entry.id)
        }
    }

    /// On again, as its switch in MCP Servers turns it on: starting at once, as its box will say
    /// once it has the change.
    private func turnOn(_ entry: Integrations.Entry) {
        turningOn.insert(entry.id)
        Integrations.turnOn(entry.id, in: config)
        Task {
            if let why = await config.settled() { trouble = ("\(entry.title) wasn’t turned on", why) }
            await read()
            turningOn.remove(entry.id)
        }
    }
}

/// What each computer's box listed last, for the page as it opens again.
@MainActor
private enum Shown {
    static var last: [String: Integrations.Listed] = [:]
}

/// Where an integration runs, and how it's doing there.
private struct Place: Identifiable {
    let name: String
    /// nil for this Mac.
    let machine: String?
    let state: State
    /// Alone in its line, it still says where ("Signed in on this Mac").
    var namesPlace = false
    var id: String { machine ?? "" }

    /// Worst last.
    enum State: Int, Comparable {
        case connected, signedIn, off, starting, engineDown, signedOut, waitsForCode, needsSignIn, signInEnded, failed

        static func < (a: State, b: State) -> Bool { a.rawValue < b.rawValue }

        var title: String {
            switch self {
            case .connected: "Connected"
            case .signedIn: "Signed in"
            case .signedOut: "Not signed in"
            case .off: "Off"
            case .starting: "Starting"
            case .engineDown: "Engine not running"
            case .waitsForCode: "Not signed in yet"
            case .needsSignIn: "Needs sign-in"
            case .signInEnded: "Sign-in ended"
            case .failed: "Couldn’t connect"
            }
        }

        var color: Color {
            switch self {
            case .connected, .signedIn: .green
            case .off, .starting, .engineDown, .signedOut: .secondary
            case .waitsForCode, .needsSignIn, .signInEnded: .orange
            case .failed: .red
            }
        }
    }

    /// As its box says it's doing (`signInEnded`: the sign-in it had ended).
    static func state(_ health: Integrations.Entry.Health, signInEnded: Bool = false) -> State {
        switch health {
        case .connected: .connected
        case .starting: .starting
        case .waitsForCode: .waitsForCode
        case .needsSignIn: signInEnded ? .signInEnded : .needsSignIn
        case .failed: .failed
        case .disabled: .off
        }
    }
}

/// An integration's state in a line: a dot in the color of the worst, and each state with where
/// ("Connected on this Mac · Needs sign-in on my-server"); with no machines, just the state.
private struct PlacesLine: View {
    let places: [Place]
    let waitsForCodeHelp: String

    private var text: String {
        guard places.count > 1 else {
            guard let place = places.first else { return "" }
            return place.state.title + (place.namesPlace ? " on " + place.name : "")
        }
        let states = Set(places.map(\.state)).sorted()
        if states.count == 1, let state = states.first, [.connected, .signedIn].contains(state) { return state.title + " on " + Self.list(places.map(\.name)) }
        return states.reversed().map { state in
            state.title + " on " + Self.list(places.filter { $0.state == state }.map(\.name))
        }.joined(separator: " · ")
    }

    static func list(_ names: [String]) -> String {
        names.count <= 1 ? names.joined() : names.dropLast().joined(separator: ", ") + " and " + names.last!
    }

    var body: some View {
        let worst = places.map(\.state).max() ?? .connected
        HStack(spacing: 6) {
            Circle()
                .fill(worst.color)
                .frame(width: 7, height: 7)
            Text(text)
                .lineLimit(1)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .help(places.contains { $0.state == .waitsForCode } ? waitsForCodeHelp : "")
    }
}


/// The keys an integration needs, typed or pasted, for this computer: kept where its box keeps
/// keys (this Mac's Keychain, or a machine's own keys' folder): in the page's place. `done` has it
/// as the box lists it once they're saved and it's added, or nil for Cancel.
private struct KeyEntry: View {
    let entry: Integrations.Entry
    let done: (Integrations.Entry?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var values: [String: String] = [:]
    @State private var failed: String?
    @State private var isSaving = false

    private var keys: [Integrations.Entry.Key] { entry.keys ?? [] }

    /// What the keys are for, under the fields.
    private var explanation: String {
        switch entry.way {
        case "app":
            "\(entry.title)'s own server signs in only through an app registered with it. Make one in its developer console, with this redirect URL, then paste its ID and secret: \(entry.redirect ?? Integrations.redirect). They stay \(kept); then you sign in."
        case "token":
            "It goes to \(entry.title)'s own server with your token, which stays \(kept)\(box.machine == nil ? " and reaches the engine only while it runs" : "")."
        case "package":
            "It runs \(entry.by ?? "its server"), an open-source MCP server, with your key. The key stays \(kept)\(box.machine == nil ? " and reaches the engine only while it runs" : "")."
        default:
            ""
        }
    }

    /// Where the keys are kept: in your Keychain, or in a folder only you can read on the machine.
    private var kept: String {
        box.machine == nil ? "in your Keychain" : "on \(app.name(of: box)), in a folder only you can read"
    }

    private var isComplete: Bool {
        keys.allSatisfy { !(values[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        SettingsDetailPage {
            Section {
                ForEach(keys, id: \.name) { key in
                    SettingsTextRow(title: key.label) {
                        SecureField(key.label, text: Binding(get: { values[key.name] ?? "" }, set: { values[key.name] = $0 }), prompt: Text(key.prompt))
                    }
                }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if let failed {
                        Text(failed)
                            .foregroundStyle(.red)
                    }
                    Text(explanation)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if let help = entry.help, let url = URL(string: help) {
                        Link("Where to get one", destination: url)
                    }
                }
            }
        } footer: {
            EditorFooter(primary: "Save", canDoPrimary: isComplete && !isSaving, onPrimary: save, onCancel: { done(nil) })
        }
        .task {
            // Those it keeps, to change (never over what you've typed meanwhile).
            guard entry.added || entry.keysSaved == true else { return }
            for (name, value) in await app.integrationKeys(entry, on: box) where (values[name] ?? "").isEmpty { values[name] = value }
        }
    }

    private func save() {
        isSaving = true
        failed = nil
        Task {
            do {
                done(try await app.addIntegration(entry, keys: values, on: box))
            } catch let refusal as BoxRefusal {
                failed = refusal.message
            } catch {
                failed = "Couldn’t save it on \(app.name(of: box)): \(error.localizedDescription)"
            }
            isSaving = false
        }
    }
}
