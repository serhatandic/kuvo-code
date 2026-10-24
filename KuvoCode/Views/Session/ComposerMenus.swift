import AppKit
import OpenCodeKit
import SwiftUI

/// How much the agent may do without asking, for a session.
enum ToolApproval: String, CaseIterable {
    /// The engine's defaults: tools run without asking (reading secrets like .env still asks).
    case approveAll
    /// Edits, writes, shell commands and web fetches wait for an OK.
    case askFirst

    static let key = "toolApproval"

    var title: String {
        switch self {
        case .approveAll: "Approve All"
        case .askFirst: "Ask First"
        }
    }

    var detail: String {
        switch self {
        case .approveAll: "Runs tools without asking"
        case .askFirst: "Asks before editing files or running commands"
        }
    }

    /// The session rules that give this behaviour, on their own.
    var rules: [PermissionRule] {
        switch self {
        case .approveAll: []
        // A PDF the browser saves is a file written, and an upload sends one of yours to a site. A
        // watch runs its check, a command, whenever it's due. (A conversation's wake-ups, Kuvo
        // Code's tools, never ask.)
        case .askFirst: ["edit", "write", "patch", "shell", "webfetch", "external_directory", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"]
            .map { PermissionRule(action: $0, effect: .ask) }
        }
    }


    /// The session rules that give this behaviour beside Settings › Permissions' rules
    /// (`settings`). A session's rules come after those, and the last one that matches wins, so
    /// they're folded in: Approve All runs what Settings asks first about, without asking; Ask
    /// First still lets through what Settings allows (a command like "npm test *", a bot's
    /// memory), asking about the rest; and both keep what Settings doesn't allow, which nothing
    /// overrides.
    func rules(settings: [PermissionRule]) -> [PermissionRule] {
        let denied = settings.filter { $0.effect == .deny }
        switch self {
        case .approveAll:
            return settings.filter { $0.effect == .ask }.map { PermissionRule(action: $0.action, resource: $0.resource, effect: .allow) } + denied
        case .askFirst:
            // Folders outside the project ask already, unless Settings allows them all: then the
            // mode asks. Settings' own folders go by its rules as they are, so they aren't made
            // again here, where they'd be taken for the session's own (`isParticular`).
            let everywhere = settings.last { $0.action == "external_directory" && $0.resource == "*" }?.effect == .allow
            let mode = everywhere ? rules : rules.filter { $0.action != "external_directory" }
            // What Settings says of particular things (an Ask under a broader Allow too), in its order.
            return mode + settings.filter { $0.effect != .deny && $0.resource != "*" && $0.action != "external_directory" } + denied
        }
    }

    /// A rule a session has for something of its own, which neither its approval nor Settings
    /// make: a folder it may work in (the project's others, a bot's). The rest are made again
    /// from its approval and Settings as they are now, so a rule taken out of Settings goes from
    /// sessions too, and so do the `kuvo-wake` ones an earlier version allowed (wake-ups are
    /// tools now; those let a command that also wrote a file through).
    static func isParticular(_ rule: PermissionRule) -> Bool {
        rule.action == "external_directory" && rule.effect == .allow && rule.resource != "*"
    }

    /// A session's rules made again from its approval and Settings › Permissions as they are now,
    /// with its own particular ones after.
    static func refreshed(_ current: [PermissionRule], settings: [PermissionRule]) -> [PermissionRule] {
        ToolApproval(rules: current).rules(settings: settings) + current.filter(isParticular)
    }

    /// Whether a conversation with these rules asks first, but nothing has asked you about a
    /// watch's check before its tool ran: its rules are from before watches asked, or it runs with
    /// the coding agents (`agents`), whose bridge doesn't check Kuvo Code's tools against them.
    /// Then the tool mustn't start it (see `WakeUps.call`).
    static func watchWentUnasked(_ rules: [PermissionRule]?, agents: Bool) -> Bool {
        guard ToolApproval(rules: rules) == .askFirst else { return false }
        return agents || !(rules ?? []).contains { $0.action == "kuvo-browser_watch_for_change" && $0.effect == .ask }
    }

    /// What the agent hears instead: the same watch, as a command, which asks you with the check
    /// written out.
    static let watchAsCommand = "This conversation asks before running commands, and a watch runs its check by itself, so the user approves it first: start it with the shell command kuvo-wake watch <every> \"<check>\" \"<what to do when it changes>\" instead, which asks them."

    init(rules: [PermissionRule]?) {
        self = (rules ?? []).contains { $0.action == "shell" && $0.effect == .ask } ? .askFirst : .approveAll
    }
}

/// "Build ⌄": the mode (agent) and how much it may do on its own.
struct ModeChip: View {
    @Environment(Catalog.self) private var catalog
    let agent: String
    let approval: ToolApproval
    let onSelectAgent: (String) -> Void
    let onSelectApproval: (ToolApproval) -> Void

    var body: some View {
        NativeMenuButton(name: "mode", menu: makeMenu) {
            HStack(spacing: 6) {
                Image(systemName: Self.symbol(agent))
                Text(agent.capitalized)
                if approval == .askFirst {
                    Image(systemName: "hand.raised.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .foregroundStyle(agent == "plan" ? AnyShapeStyle(.orange) : AnyShapeStyle(.foreground))
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .hoverHighlight(in: Capsule(), mutesInk: true)
        }
        .help("Mode and tool permissions (⌥⌘1 Build, ⌥⌘2 Plan)")
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(.sectionHeader(title: "Mode"))
        for agent in catalog.primaryAgents {
            menu.addItem(ActionItem(agent.name.capitalized, subtitle: Self.detail(agent), image: NSImage(systemSymbolName: Self.symbol(agent.id), accessibilityDescription: nil), checked: agent.id == self.agent) {
                onSelectAgent(agent.id)
            })
        }
        menu.addItem(.separator())
        let approvals = NSMenu()
        for option in ToolApproval.allCases {
            approvals.addItem(ActionItem(option.title, subtitle: option.detail, checked: option == approval) { onSelectApproval(option) })
        }
        menu.addItem(.chained("Tool Permissions", value: approval.title, image: NSImage(systemSymbolName: "checkmark.shield", accessibilityDescription: nil), submenu: approvals))
        return menu
    }

    static func symbol(_ agent: String) -> String {
        switch agent {
        case "build": "hammer"
        case "plan": "list.bullet.clipboard"
        default: "person.crop.circle"
        }
    }

    /// Short, plain descriptions for the built-in modes; custom agents bring their own.
    static func detail(_ agent: Agent) -> String? {
        switch agent.id {
        case "build": "Makes changes and runs commands"
        case "plan": "Explores and plans, without changing files"
        default: agent.description.map { String($0.prefix(60)) }
        }
    }
}

/// "Local ⌄" or "Worktree ⌄", for a new session: whether it works in the project's folder or
/// in a git worktree of its own, on a branch of its own.
struct WorkplaceChip: View {
    let worktree: Bool
    /// How many sessions try the task, each in a worktree of its own.
    var attempts = 1
    let onSelect: (Bool) -> Void
    var onSelectAttempts: (Int) -> Void = { _ in }

    var body: some View {
        NativeMenuButton(name: "workplace", menu: makeMenu) {
            HStack(spacing: 6) {
                Image(systemName: worktree ? "arrow.triangle.branch" : "folder")
                Text(worktree ? (attempts > 1 ? "Worktree ×\(attempts)" : "Worktree") : "Local")
            }
            .font(.callout)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .hoverHighlight(in: Capsule(), mutesInk: true)
        }
        .help("Where the session works: in the project's folder, or in a worktree of its own")
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(ActionItem("Local", subtitle: "Works in the project's folder", image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil), checked: !worktree) {
            onSelect(false)
        })
        menu.addItem(ActionItem("Worktree", subtitle: "Works in a copy on a branch of its own", image: NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil), checked: worktree) {
            onSelect(true)
        })
        menu.addItem(.separator())
        let counts = NSMenu()
        for count in 1...4 {
            counts.addItem(ActionItem(count.counting("Session"), subtitle: count == 1 ? nil : "Each tries it in a worktree of its own", checked: worktree && count == attempts) {
                onSelect(true)
                onSelectAttempts(count)
            })
        }
        menu.addItem(.chained("Attempts", value: worktree ? "\(attempts)" : nil, image: NSImage(systemSymbolName: "square.stack", accessibilityDescription: nil), submenu: counts))
        return menu
    }
}

/// "GPT-6 Luna · High ⌄": the model and its effort. It opens the model picker, which stays open
/// while you choose both. Elsewhere (a bot's default model) the same picker opens from a label of
/// its own.
struct ModelChip<Label: View>: View {
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    let selection: ModelRef?
    let onSelect: (ModelRef) -> Void
    var opensBelow = false
    /// Whose models it offers: the engine's (a bot's, a machine's session), or every one with the
    /// coding agents' and Auto (a session with the agents, a new one on this Mac).
    var scope: ModelScope = .engine
    /// Auto among them (not in your Auto list's own picker).
    var offersAuto = true
    /// Drawn with the model in use and its effort.
    @ViewBuilder let label: (Model?, String?) -> Label
    @State private var isOpen = false
    @State private var startsExpanded = false
    @State private var startsOnList = false
    /// Where the card opens, and the room it has there, read as it opens.
    @State private var placement = ModelPicker.Placement()
    @State private var anchor = ScreenRoom()

    /// The model picked can't be used now: the chip asks for another rather than show the
    /// default as if it were in use.
    private var isUnavailable: Bool { catalog.isUnavailable(selection) || selection.map { !scope.allows($0.providerID) } == true }
    private var current: Model? { isUnavailable ? nil : catalog.shownModel(selection) ?? catalog.defaultModel }
    private var variant: String? { current.flatMap { model in selection?.sameModel(as: model.ref) == true ? selection?.variant : nil } }

    var body: some View {
        Button {
            if !isOpen { placement = ModelPicker.Placement(room: anchor.room, prefersBelow: opensBelow) }
            isOpen.toggle()
        } label: {
            label(current, variant)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(isUnavailable ? "\(catalog.model(selection)?.name ?? selection?.id ?? "") isn't available now: choose another model" : "Model and effort")
        .background(ScreenRoomReader(room: anchor))
        .popover(isPresented: $isOpen, arrowEdge: placement.below ? .bottom : .top) {
            ModelPicker(catalog: catalog, selection: selection, onSelect: onSelect, close: { isOpen = false }, scope: scope, offersAuto: offersAuto,
                        startsExpanded: startsExpanded, startsOnList: startsOnList, maxHeight: placement.height,
                        // Accounts and Custom Auto lists on the machine whose models these are
                        // (each has its own).
                        openSettings: { page in
                            switch page {
                            case .accounts: app.openAccounts(on: catalog.machine)
                            case .auto: app.openAuto(on: catalog.machine)
                            default: app.openSettings(page)
                            }
                        })
        }
        .onAppear { LogoImages.shared.prefetch(catalog.models.flatMap { [$0.makerLogoID, $0.providerID] }) }
        #if DEBUG
        .task {
            // KUVO_DEMO_MENU=model opens the picker after launch; =list, on the model list; =models,
            // with every model shown.
            guard let wanted = ProcessInfo.processInfo.environment["KUVO_DEMO_MENU"], ["model", "list", "models"].contains(wanted) else { return }
            try? await Task.sleep(for: .seconds(3))
            startsExpanded = wanted == "models"
            startsOnList = wanted == "list"
            placement = ModelPicker.Placement(room: anchor.room, prefersBelow: opensBelow)
            isOpen = true
            // KUVO_DEMO_EFFORT=<level>: with it set, as if picked.
            if let level = ProcessInfo.processInfo.environment["KUVO_DEMO_EFFORT"], let current {
                onSelect(ModelRef(id: current.id, providerID: current.providerID, variant: level))
            }
        }
        #endif
    }
}

extension ModelChip where Label == ModelChipLabel {
    /// `inUse`: on Auto, the model of your list at work now, shown beside it.
    init(selection: ModelRef?, onSelect: @escaping (ModelRef) -> Void, scope: ModelScope = .engine, offersAuto: Bool = true, inUse: ModelRef? = nil) {
        self.init(selection: selection, onSelect: onSelect, scope: scope, offersAuto: offersAuto) { model, variant in
            ModelChipLabel(model: model, variant: variant, inUse: model?.providerID == OutsideAgents.autoProvider ? inUse : nil)
        }
    }
}

/// The composer's chip: the model's name, its effort, and that it opens the picker.
struct ModelChipLabel: View {
    @Environment(Catalog.self) private var catalog
    let model: Model?
    let variant: String?
    /// On Auto, the model of your list at work now.
    var inUse: ModelRef?

    var body: some View {
        HStack(spacing: 5) {
            // One of your Auto lists, by its name.
            if model?.providerID == OutsideAgents.autoProvider {
                Image(systemName: "list.number")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            Text(model?.name ?? "Choose a Model")
                .lineLimit(1)
            if let variant {
                Text(EffortLevel.title(variant))
                    .foregroundStyle(.secondary)
            }
            if let inUse, let name = catalog.model(inUse)?.name ?? Optional(inUse.id) {
                Text(name)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
                    .help("Custom Auto is on \(name) now")
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .font(.callout)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .hoverHighlight(in: Capsule(), mutesInk: true)
    }
}

extension Model {
    /// The logo of who made the model, so a Claude model served through Copilot
    /// still shows Anthropic's mark. Falls back to the provider's logo.
    var makerLogoID: String {
        let family = (family ?? id).lowercased()
        let prefixes: [(String, String)] = [
            ("claude", "anthropic"), ("gpt", "openai"), ("o1", "openai"), ("o3", "openai"), ("o4", "openai"), ("codex", "openai"),
            ("gemini", "google"), ("gemma", "google"), ("grok", "xai"), ("kimi", "moonshotai"), ("deepseek", "deepseek"),
            ("mistral", "mistral"), ("codestral", "mistral"), ("devstral", "mistral"), ("llama", "meta"), ("glm", "zhipuai"), ("minimax", "minimax"),
        ]
        return prefixes.first { family.hasPrefix($0.0) }?.1 ?? providerID
    }
}
