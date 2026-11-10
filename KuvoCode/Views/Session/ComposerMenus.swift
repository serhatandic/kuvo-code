import AppKit
import ClientSessions
import OpenCodeKit
import SwiftUI

/// How much a conversation's agent does on its own: kept on its box with the conversation
/// (`metadata.kuvo.approval`), which makes its rules and holds what each can't do here now
/// (PROTOCOL.md, "Approval"), so every client shows the same one.
enum ToolApproval: String, CaseIterable, Codable {
    /// Edits, commands and the rest wait for your OK.
    case askFirst
    /// Edits in its folders go ahead; commands still wait for your OK.
    case acceptEdits
    /// Everything inside the sandbox goes ahead; past it, a reviewer decides, and what it refuses
    /// is held back for you, never left waiting on you.
    case auto
    /// No sandbox, no reviewer, nothing asks. Confirmed once on each computer.
    case fullAccess

    /// This Mac's last pick, for what isn't a conversation's own (a bot's kit, group chats).
    static let key = "toolApproval"

    /// One kept by name: an older version's Approve All is Auto now.
    init?(kept: String) {
        if kept == "approveAll" { self = .auto } else { self.init(rawValue: kept) }
    }

    /// This Mac's last pick (`key`), Auto where there's none.
    static var lastPicked: ToolApproval {
        get { UserDefaults.standard.string(forKey: key).flatMap(ToolApproval.init(kept:)) ?? .auto }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    // Its words, the same on every client (KuvoClient's ApprovalWords).
    var title: String { ApprovalWords.title(rawValue) }
    var detail: String { ApprovalWords.detail(rawValue) }
    var symbol: String { ApprovalWords.symbol(rawValue) }

    /// A conversation's, as it's kept with it; one from before (or a box that doesn't keep them)
    /// as its rules say: asking before commands is Ask First, nothing asking is Auto, until its
    /// box says (`SessionModel.approvalShown`).
    static func of(_ session: Session) -> ToolApproval {
        session.metadata?["kuvo"]?["approval"]?.string.flatMap(ToolApproval.init(rawValue:))
            ?? (asksBeforeCommands(session.permissions) ? .askFirst : .auto)
    }

    /// What a conversation runs with on its box now (`kuvo.applied`: Auto that asks first without
    /// the sandbox is Ask First), else as it's kept.
    static func applied(_ session: Session) -> ToolApproval {
        session.metadata?["kuvo"]?["applied"]?.string.flatMap(ToolApproval.init(rawValue:)) ?? of(session)
    }

    /// The rules a conversation is made with until its box makes its own a moment later (from
    /// this, with its Settings › Permissions): Ask First's asks for Ask First and Accept Edits,
    /// so nothing runs unasked meanwhile; the rest as Settings says, its asks let through. Both
    /// keep what Settings doesn't allow.
    func provisionalRules(settings: [PermissionRule]) -> [PermissionRule] {
        let denied = settings.filter { $0.effect.holdsBack }
        switch self {
        case .auto, .fullAccess:
            return settings.filter { $0.effect == .ask }.map { PermissionRule(action: $0.action, resource: $0.resource, effect: .allow) } + denied
        case .askFirst, .acceptEdits:
            // A PDF the browser saves is a file written, and an upload sends one of yours to a
            // site. A watch runs its check, a command, whenever it's due. Folders outside the
            // project ask already, unless Settings allows them all.
            let everywhere = settings.last { $0.action == "external_directory" && $0.resource == "*" }?.effect == .allow
            let asks = ["edit", "write", "patch", "shell", "webfetch", "external_directory", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"]
                .filter { everywhere || $0 != "external_directory" }
                .map { PermissionRule(action: $0, effect: .ask) }
            return asks + settings.filter { !$0.effect.holdsBack && $0.resource != "*" && $0.action != "external_directory" } + denied
        }
    }

    /// A rule a session has for something of its own, which neither its approval nor Settings
    /// make: a folder it may work in (the project's others, a bot's). Its box keeps them as it
    /// makes the rest from its approval.
    static func isParticular(_ rule: PermissionRule) -> Bool {
        rule.action == "external_directory" && rule.effect == .allow && rule.resource != "*"
    }

    /// Whether rules ask before every command (Ask First's and Accept Edits', as their box makes them).
    static func asksBeforeCommands(_ rules: [PermissionRule]?) -> Bool {
        (rules ?? []).contains { $0.action == "shell" && $0.resource == "*" && $0.effect == .ask }
    }

    /// Whether a conversation with these rules asks before commands, but nothing has asked you
    /// about a watch's check before its tool ran: its rules are from before watches asked, or it
    /// runs with the coding agents (`agents`), whose bridge doesn't check Kuvo Code's tools against
    /// them. Then the tool mustn't start it (see `WakeUps.call`).
    static func watchWentUnasked(_ rules: [PermissionRule]?, agents: Bool) -> Bool {
        guard asksBeforeCommands(rules) else { return false }
        return agents || !(rules ?? []).contains { $0.action == "kuvo-browser_watch_for_change" && $0.effect == .ask }
    }

    /// What the agent hears instead: the same watch, as a command, which asks you with the check
    /// written out.
    static let watchAsCommand = "This conversation asks before running commands, and a watch runs its check by itself, so the user approves it first: start it with the shell command kuvo-wake watch <every> \"<check>\" \"<what to do when it changes>\" instead, which asks them."
}

/// A conversation's approval as its box shows it (`GET kuvo/sessions/<id>/approval`): the one
/// picked, what it comes to here now and why that's less, and each one it can be set to.
struct ApprovalShown: Decodable, Equatable {
    struct Why: Decodable, Equatable {
        /// `sandbox` (Auto asks first for now), `fullAccessOff` (not confirmed on this computer
        /// yet).
        var reason: String
        var why: String
    }
    struct Option: Decodable, Equatable {
        var approval: ToolApproval
        var unavailable: Why?
        var held: Why?
    }
    var approval: ToolApproval
    var effective: ToolApproval
    var held: Why?
    var options: [Option]

    /// Why it does less than picked for now, where it does: Auto asking first without the sandbox.
    var holding: Why? { effective != approval ? held : nil }

    func option(_ approval: ToolApproval) -> Option? { options.first { $0.approval == approval } }
}

/// A computer's approvals as its box shows them (`GET kuvo/approval`): whether you confirmed Full
/// Access there, the one a new conversation starts with, and why Auto asks first there for now.
struct ApprovalHere: Decodable, Equatable {
    struct Auto: Decodable, Equatable {
        struct Held: Decodable, Equatable { var held: ApprovalShown.Why? }
        var engine: Held
        var agents: Held
    }
    var fullAccess: Bool
    var `default`: ToolApproval
    var auto: Auto

    /// As a new conversation's composer shows it (no conversation yet to read one of).
    func shown(_ approval: ToolApproval, agents: Bool) -> ApprovalShown {
        let held = (agents ? auto.agents : auto.engine).held
        let fullAccessOff = ApprovalShown.Why(reason: "fullAccessOff", why: "Confirm it once on this computer first.")
        return ApprovalShown(
            approval: approval,
            effective: approval == .auto && held != nil ? .askFirst : approval,
            held: approval == .auto ? held : nil,
            options: ToolApproval.allCases.map { each in
                ApprovalShown.Option(approval: each, unavailable: each == .fullAccess && !fullAccess ? fullAccessOff : nil, held: each == .auto ? held : nil)
            }
        )
    }
}

/// The mode chip: how much the agent does on its own ("Auto ⌄"). A dot says it does less than
/// picked for now (Auto without the sandbox). Plan is `/plan`'s, with a chip of its own (`AgentChip`).
struct ModeChip: View {
    let approval: ToolApproval
    /// As its box shows it; nil until read (or for a new conversation's: this computer's).
    var shown: ApprovalShown?
    /// Opens the conversation's Decisions (nil: none to open, as for a new conversation).
    var onDecisions: (() -> Void)?
    /// Autopilot, in a group of its own under the modes (nil: not offered here).
    var autopilot: AutopilotChoice?
    var onSelectAutopilot: (Bool) -> Void = { _ in }
    let onSelectApproval: (ToolApproval) -> Void

    private var holding: ApprovalShown.Why? { shown?.holding }

    var body: some View {
        NativeMenuButton(name: "mode", menu: makeMenu) {
            // Short of room, it gives way first, down to its icon, so the model keeps its name
            // (the composer's row gives it what's left once the rest has theirs).
            ViewThatFits(in: .horizontal) {
                label(words: true)
                label(words: false)
            }
            .font(.callout)
            .lineLimit(1)
            .foregroundStyle(.foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .hoverHighlight(in: Capsule(), mutesInk: true)
        }
        .help(holding.map { "\(approval.title) asks first for now. \($0.why)" } ?? "\(approval.title): \(approval.detail.lowercasedFirst)")
        .accessibilityLabel("Mode")
        .accessibilityValue(holding != nil ? "\(approval.title), asks first for now" : approval.title)
    }

    /// The approval's icon and, with `words`, its name; the orange dot while it asks first for now.
    private func label(words: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: approval.symbol)
                // Beside its words, a step under them; alone, the row's size, as the paperclip and
                // the mic (#362).
                .font(words ? .caption : .system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
            if words { Text(approval.title) }
            if holding != nil {
                Circle()
                    .fill(.orange)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
            // The model chip's chevron: two menus side by side look alike.
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .fixedSize()
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        // (Each pick's check on its trailing side, lined up.)
        var checked: Set<NSMenuItem> = []
        menu.autoenablesItems = false
        // With Autopilot beside them, each group says what it's about: Auto and Autopilot answer
        // different questions, and both can be checked.
        if autopilot != nil { menu.addItem(.sectionHeader(title: "Tools")) }
        for option in ToolApproval.allCases {
            // Not to be had here, as its box says (a bot's on a box before 0.9.188).
            let refused = shown?.option(option)?.unavailable.flatMap { $0.reason == "fullAccessOff" ? nil : $0 }
            let note = refused?.why ?? (option == approval ? holding : shown?.option(option)?.held).map { "Asks first for now. \($0.why)" }
            let item = ActionItem(option.title, subtitle: note ?? option.detail, image: NSImage(systemSymbolName: option.symbol, accessibilityDescription: nil)) { onSelectApproval(option) }
            item.isEnabled = refused == nil
            menu.addItem(item)
            if option == approval { checked.insert(item) }
        }
        if let autopilot {
            menu.addItem(.separator())
            menu.addItem(.sectionHeader(title: "Questions"))
            let item = ActionItem("Autopilot", subtitle: autopilot.unavailable ?? AutopilotShown.detail, image: NSImage(systemSymbolName: AutopilotShown.symbol, accessibilityDescription: nil)) { [onSelectAutopilot] in
                onSelectAutopilot(!autopilot.on)
            }
            item.isEnabled = autopilot.unavailable == nil
            menu.addItem(item)
            if autopilot.on { checked.insert(item) }
        }
        if let onDecisions {
            menu.addItem(.separator())
            menu.addItem(ActionItem("Auto's Decisions…", subtitle: ApprovalWords.decisions, image: NSImage(systemSymbolName: "list.bullet.rectangle", accessibilityDescription: nil)) { onDecisions() })
        }
        menu.checksOnTrailingSide(checked)
        return menu
    }
}

/// In the composer's row, while its conversation isn't with Build: Plan (`/plan`), or an agent
/// of your own it was started with; ✕ goes back to Build.
struct AgentChip: View {
    @Environment(Catalog.self) private var catalog
    let agent: String
    let onLeave: () -> Void

    private var name: String { agent == "plan" ? "Plan" : catalog.agents.first { $0.id == agent }?.name ?? agent.capitalized }

    var body: some View {
        Button(action: onLeave) {
            HStack(spacing: 5) {
                Image(systemName: agent == "plan" ? "list.bullet.clipboard" : "person.crop.circle")
                    .font(.caption)
                Text(name)
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .font(.callout)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.accentColor.opacity(0.16), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(agent == "plan" ? "Plan mode: it explores and plans, without changing files. Click to leave it, or type /plan." : "Click to go back to Build")
        .accessibilityLabel(agent == "plan" ? "Plan mode" : name)
        .accessibilityHint("Goes back to Build")
        .accessibilityAddTraits(.isButton)
    }
}

/// In the composer's row while its conversation is on Autopilot, before the mode chip: it decides
/// for itself and leaves what needs you for the end; ✕ goes back to Interactive.
struct AutopilotChip: View {
    let onLeave: () -> Void

    var body: some View {
        Button(action: onLeave) {
            HStack(spacing: 5) {
                Image(systemName: AutopilotShown.symbol)
                    .font(.caption)
                Text("Autopilot")
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .font(.callout)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.accentColor.opacity(0.16), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help("Autopilot")
        .accessibilityLabel("Autopilot")
        .accessibilityHint("Goes back to Interactive")
        .accessibilityAddTraits(.isButton)
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
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
            Text(worktree ? (attempts > 1 ? "Worktree ×\(attempts)" : "Worktree") : "Local")
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
    /// Opens it when it changes.
    var openRequest = 0
    /// Drawn as a filled pop-up button, like the pop-up menus in a row beside it, rather than the
    /// composer's quiet chip.
    var popUp = false
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
    private var current: Model? { selection.map { !scope.allows($0.providerID) } == true ? nil : catalog.chipModel(selection) }
    private var variant: String? { current.flatMap { model in selection.map({ catalog.isSameModel(model.ref, $0) }) == true ? selection?.variant : nil } }

    var body: some View {
        Button {
            if !isOpen { placement = ModelPicker.Placement(room: anchor.room, prefersBelow: opensBelow) }
            isOpen.toggle()
        } label: {
            label(current, variant)
        }
        .modelChipStyle(popUp: popUp)
        .clickablePointer()
        .help(catalog.needsSignIn(selection) ? catalog.unavailable(selection!, on: catalog.machine.map { app.name(of: .machine($0)) }) : isUnavailable ? "\(catalog.model(selection)?.name ?? selection?.id ?? "") isn't available now: choose another model" : "Model and effort")
        .background(ScreenRoomReader(room: anchor))
        .closesWhenKept($isOpen)
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
            .popoverContent()
        }
        .onAppear { LogoImages.shared.prefetch(catalog.models.flatMap { [$0.makerLogoID, $0.providerID] }) }
        .onChange(of: openRequest) {
            placement = ModelPicker.Placement(room: anchor.room, prefersBelow: opensBelow)
            isOpen = true
        }
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

private extension View {
    @ViewBuilder func modelChipStyle(popUp: Bool) -> some View {
        if popUp { buttonStyle(.bordered) } else { buttonStyle(.plain) }
    }
}

extension ModelChip where Label == ModelChipLabel {
    /// `inUse`: on Auto, the model of your list at work now, shown beside it.
    init(selection: ModelRef?, onSelect: @escaping (ModelRef) -> Void, scope: ModelScope = .engine, offersAuto: Bool = true, inUse: ModelRef? = nil, openRequest: Int = 0) {
        self.init(selection: selection, onSelect: onSelect, scope: scope, offersAuto: offersAuto, openRequest: openRequest) { model, variant in
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
