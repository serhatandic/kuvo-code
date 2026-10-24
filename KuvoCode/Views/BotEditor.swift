import AppKit
import OpenCodeKit
import SwiftUI

/// Making a bot, or changing one, in the window's main card: how it looks, its name and job,
/// and, for a new one, where it lives and works. An existing bot also shows its waiting wake-ups
/// and its memory.
struct BotEditor: View {
    /// The bot being changed; nil for a new one.
    let bot: Bot?
    /// Back to what was there before.
    let close: () -> Void
    /// Called with the new bot, once it's made.
    var created: (Bot) -> Void = { _ in }

    @Environment(AppModel.self) private var app
    @Environment(Bots.self) private var bots
    @Environment(Workspace.self) private var workspace
    @Environment(Catalog.self) private var catalog
    @LastModel private var lastModel
    @State private var look: BotLook
    /// Its default model.
    @State private var model: ModelRef?
    /// How it talks.
    @State private var personality: String?
    @State private var name: String
    /// What a template or a shared bot says its job is: typed in its new conversation, for you
    /// to change and send (its job is what you tell it there).
    @State private var firstMessage: String
    /// The machine it lives on; nil for this Mac.
    @State private var machine: String?
    /// The project it works in; nil for a folder of its own.
    @State private var project: String?
    @State private var showsAddMachine = false
    /// An integration it's being given a key of its own for, in the form's place.
    @State private var keyFor: Integrations.Service?
    @State private var isWorking = false
    @State private var failure: String?
    /// Making it: waiting for its machine to connect first, if it's on its way.
    @State private var creating: Task<Void, Never>?
    @State private var waitsForMachine = false
    @State private var confirmsDelete = false
    @State private var isDeleting = false
    /// The template a new bot started from.
    @State private var template: String?
    @State private var isHoveringAvatar = false
    /// The shared bot's personality was looked for (once: the form appears again on coming back
    /// from adding a machine), and the one added to yours for it, if it was.
    @State private var adoptedRecipe = false
    @State private var addedPersonality: String?
    @FocusState private var focus: Field?

    private enum Field { case name }

    /// `recipe`: a shared bot that a new one starts from.
    init(bot: Bot?, recipe: BotRecipe? = nil, close: @escaping () -> Void, created: @escaping (Bot) -> Void = { _ in }) {
        self.bot = bot
        self.close = close
        self.created = created
        _look = State(initialValue: bot?.look ?? recipe?.look ?? .random())
        _name = State(initialValue: bot?.name ?? recipe?.name ?? "")
        _firstMessage = State(initialValue: recipe.map { BotTemplate.firstMessage(job: $0.job, instructions: $0.instructions) } ?? "")
        _machine = State(initialValue: bot?.machine)
        _project = State(initialValue: bot?.project)
        _model = State(initialValue: bot?.model)
        _personality = State(initialValue: bot?.personality)
        self.recipe = recipe
    }

    /// The shared bot a new one starts from.
    private let recipe: BotRecipe?

    /// The models of the engine where it lives.
    /// The models it can use, by where it lives, as for any conversation (see `ModelScope.on`).
    private var modelScope: ModelScope {
        .on(machine: machine)
    }

    private var placeCatalog: Catalog {
        machine.flatMap { app.machines.engine($0)?.catalog } ?? catalog
    }

    private var isNew: Bool { bot == nil }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        // The editor as a whole, for what goes when it's closed, however that is.
        ZStack { content }
            .onDisappear(perform: dropAddedPersonality)
    }

    @ViewBuilder private var content: some View {
        if showsAddMachine {
            // A machine to live on, added right here: the bot's form is as it was on coming back.
            EditorDetail(back: isNew ? "New Bot" : "Edit \(trimmedName)", title: "Add a Machine", onBack: { withAnimation(.ui) { showsAddMachine = false } }) {
                MachineForm(added: { added in
                    withAnimation(.ui) {
                        machine = added
                        project = nil
                        showsAddMachine = false
                    }
                }, cancel: { withAnimation(.ui) { showsAddMachine = false } })
            }
            .transition(.opacity)
        } else if let service = keyFor, let bot {
            EditorDetail(back: "Edit \(trimmedName)", title: "\(service.title) Key", onBack: { withAnimation(.ui) { keyFor = nil } }) {
                BotKeyEntry(service: service, bot: bot) { withAnimation(.ui) { keyFor = nil } }
            }
            .transition(.opacity)
        } else {
            editor
        }
    }

    private var editor: some View {
        VStack(spacing: 0) {
            ScrollView {
                form
                    .frame(maxWidth: 600)
                    .padding(.horizontal, Metrics.gutter + 8)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            #if DEBUG
            // KUVO_DEMO_EDIT_BOT=bottom: opens scrolled to its wake-ups and memory.
            .defaultScrollAnchor(ProcessInfo.processInfo.environment["KUVO_DEMO_EDIT_BOT"] == "bottom" ? .bottom : nil)
            #endif
            footer
                .frame(maxWidth: 600)
                .padding(.horizontal, Metrics.gutter + 8)
                .padding(.top, 12)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity)
        }
        // Gone while it waited for its machine: it isn't made after all. (One being made is
        // finished, so nothing's left half made.)
        .onDisappear { if waitsForMachine { creating?.cancel() } }
        .onAppear {
            if isNew { focus = .name }
            #if DEBUG
            // KUVO_DEMO_NEW_BOT_MACHINE=<machine>: a new bot set to live on that machine.
            if isNew, let machine = ProcessInfo.processInfo.environment["KUVO_DEMO_NEW_BOT_MACHINE"] { self.machine = machine }
            #endif
            // A shared bot's personality, found here (or added) once, not at every redraw.
            if isNew, !adoptedRecipe, let recipe {
                adoptedRecipe = true
                do {
                    if personality == nil, let found = try recipe.personalityHere() {
                        personality = found.id
                        if found.added { addedPersonality = found.id }
                    }
                } catch {
                    // Yours are full: it starts without one, and says why.
                    failure = "Its personality, “\(recipe.personality?.name ?? "")”, didn’t fit in yours. Shorten or remove one of yours, then pick one for it."
                }
            }
            // The model it talks on: one picked for it whose account you've signed out of (none
            // to show) gives way to its conversation's, as in its group chats. A bot made before
            // bots had a model: the one its conversation uses.
            if let bot, model == bot.model, let talking = app.groups.talkingModel(of: bot) { model = talking }
            if model == nil { model = bot.flatMap { workspace.session($0.sessionID)?.model } ?? placeCatalog.startingModel(lastModel, scope: modelScope) }
        }
        .alert("Delete \(bot?.name ?? "This Bot")?", isPresented: $confirmsDelete) {
            Button("Delete", role: .destructive) {
                guard let bot else { return }
                // A machine's bot goes once it's gone there too; what stops it shows above the buttons.
                isWorking = true
                isDeleting = true
                failure = nil
                Task {
                    defer {
                        isWorking = false
                        isDeleting = false
                    }
                    do {
                        try await bots.delete(bot)
                        close()
                    } catch {
                        failure = error.localizedDescription
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(deleteMessage)
        }
    }

    /// What deleting it does: its own folder (its memory and what it made there) goes to the Trash.
    private var deleteMessage: String {
        let folder = bot?.machine.map { "Its folder, with its memory and the files it made, goes to Kuvo Code’s trash folder on \($0)." }
            ?? "Its folder, with its memory and the files it made, goes to the Trash."
        return "Its conversation and wake-ups are deleted. " + folder + (bot?.project != nil ? " The project it worked in isn’t touched." : "")
    }

    private var form: some View {
            VStack(alignment: .leading, spacing: 20) {
                if isNew {
                    section("Start From", note: "Fills in a name, look and personality, and writes its job in its conversation for you to send; or start from nothing and tell it there.") {
                        TemplatePicker(selection: template) { use($0) }
                    }
                }

                identity

                section("Look") {
                    LookPicker(look: $look)
                }

                section("Personality", note: "How it talks, in its own conversation and in group chats.") {
                    PersonalityPicker(selection: $personality)
                }

                section("Model", note: "It uses this in group chats, and in its own conversation unless you pick another there.") {
                    WellGroup {
                        ModelChip(selection: model, onSelect: { model = $0 }, opensBelow: true, scope: modelScope) { current, variant in
                            WellRow {
                                if let current { ProviderLogo(id: current.makerLogoID, size: 16) } else { Image(systemName: "cpu") }
                            } content: {
                                HStack(spacing: 6) {
                                    Text(current?.name ?? "Choose a Model")
                                        .foregroundStyle(.primary)
                                    if let variant {
                                        Text("· \(EffortLevel.title(variant))")
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 8)
                                    MenuChevron()
                                }
                            }
                            .contentShape(.rect)
                        }
                        .environment(placeCatalog)
                    }
                }

                if isNew {
                    section("Lives On", note: machine == nil ? "On this Mac, it works while the Mac is awake." : "On a machine, it keeps working, and wakes itself up, while your Mac is off.") {
                        WellGroup {
                            locationMenu
                            WellDivider()
                            folderMenu
                        }
                        // Settled while it's being made (or waits for its machine).
                        .disabled(isWorking)
                    }
                } else if let bot {
                    // Where it lives stays where it was made.
                    section("Lives On") {
                        WellGroup {
                            WellRow {
                                Image(systemName: bot.machine == nil ? "laptopcomputer" : "server.rack")
                            } content: {
                                HStack(spacing: 8) {
                                    Text(bot.machine.map { app.machines.engine($0)?.machine.name ?? $0 } ?? "This Mac")
                                    if let engine = bot.machine.flatMap({ app.machines.engine($0) }) {
                                        MachineStatus(engine: engine)
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                        }
                    }
                    section("Wake-Ups", note: "The bot schedules these itself: wake-ups to carry on later, and watches, which check something without its model and wake it when that changes. Add a wake-up of your own, and at its time what it says to do arrives in its conversation.") {
                        WakeList(owner: bot.wakeOwner, name: bot.name)
                    }
                    if bot.project == nil {
                        section("Keys", note: "A key of its own, like a GitHub token only it should use: its tools take it in place of your shared one, and no other bot or session gets it.") {
                            BotKeysSection(bot: bot) { service in withAnimation(.ui) { keyFor = service } }
                        }
                    } else {
                        section("Keys", note: "It works in a project, beside your sessions there, so it uses the keys they do, from Settings › Integrations. A bot with a folder of its own can have its own.") {
                            EmptyView()
                        }
                    }
                    section("Memory") {
                        WellGroup {
                            Button {
                                app.utilities.show(RemoteFolder.fileURL(bot.memoryFile, in: bot.directory))
                            } label: {
                                WellRow {
                                    Image(systemName: "brain")
                                } content: {
                                    HStack {
                                        Text("Show in the Panel")
                                        Spacer()
                                        Text("MEMORY.md")
                                            .font(.system(size: 12, design: .monospaced))
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(WellRowButtonStyle())
                        }
                    }
                }
            }
    }

    /// In a narrow card, Delete and Export are icons rather than words cut short. What went wrong
    /// shows above the buttons, where it's seen.
    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ViewThatFits(in: .horizontal) {
                footerRow(compact: false)
                footerRow(compact: true)
            }
        }
    }

    /// The machine it'll live on, while it's still connecting: what's under way, in its words.
    private var waitingWords: String? {
        guard waitsForMachine, let engine = machine.flatMap({ app.machines.engine($0) }) else { return nil }
        return engine.statusTitle
    }

    private func footerRow(compact: Bool) -> some View {
        HStack(spacing: 10) {
            if let bot {
                Button(role: .destructive) { confirmsDelete = true } label: {
                    if compact { Image(systemName: "trash") } else { Text("Delete Bot…") }
                }
                .buttonStyle(.glass)
                .disabled(isWorking)
                .help(compact ? "Delete Bot…" : "")
                .accessibilityLabel("Delete Bot…")
                Button { BotRecipe.export(bot) } label: {
                    if compact { Image(systemName: "square.and.arrow.up") } else { Text("Export…") }
                }
                .buttonStyle(.glass)
                .help("Save a file to share \(bot.name): its look, personality and job")
                .accessibilityLabel("Export…")
            }
            if isWorking {
                Spinner(size: 16)
                if !compact {
                    Text(waitingWords ?? (isNew ? "Setting it up…" : isDeleting ? "Deleting…" : "Saving…"))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Cancel", role: .cancel) {
                if waitsForMachine { creating?.cancel() }
                close()
            }
                .keyboardShortcut(.cancelAction)
                .buttonStyle(.glass)
                // Its folder is going, or it's being made: the editor closes once that's done, or
                // says why not. (Waiting for a machine, Cancel stops it.)
                .disabled(isDeleting || (isWorking && !waitsForMachine))
            Button(isNew ? "Create Bot" : "Save", action: save)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.glassProminent)
                .disabled(trimmedName.isEmpty || isWorking)
        }
        .controlSize(.large)
    }

    /// The avatar, large, beside its name and job; shuffling picks a new look.
    private var identity: some View {
        HStack(alignment: .center, spacing: 18) {
            VStack(spacing: 8) {
                BotAvatar(look: look, size: 76, noticed: isHoveringAvatar)
                    .onHover { isHoveringAvatar = $0 }
                    // A little bounce at each new look.
                    .keyframeAnimator(initialValue: 1.0, trigger: look) { content, scale in
                        content.scaleEffect(scale, anchor: .bottom)
                    } keyframes: { _ in
                        SpringKeyframe(1.14, duration: 0.14)
                        SpringKeyframe(0.95, duration: 0.14)
                        SpringKeyframe(1.0, duration: 0.24)
                    }
                Button {
                    withAnimation(.ui) { look = .random() }
                } label: {
                    Label("Shuffle", systemImage: "shuffle")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help("A random look")
            }
            .frame(width: 92)
            VStack(alignment: .leading, spacing: 8) {
                WellGroup(isActive: focus == .name) {
                    WellRow(isActive: focus == .name) {
                        Image(systemName: "face.smiling")
                    } content: {
                        TextField("Name", text: $name, prompt: Text("Name, like Scout"))
                            .textFieldStyle(.plain)
                            .font(.system(size: 15, weight: .medium))
                            .focused($focus, equals: .name)
                    }
                }
                Text(bot.map { $0.job.isEmpty ? "\($0.name)'s job is what you tell it in its conversation." : "Its job: \($0.job). It keeps its job in its memory, as you tell it in its conversation." }
                     ?? "Its job is what you tell it in its conversation. It keeps it in its memory and works on it from then on.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Where it lives and works

    private var locationMenu: some View {
        NativeMenuButton(opensBelow: true) {
            let menu = NSMenu()
            menu.addItem(ActionItem("This Mac", image: NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: nil), checked: machine == nil) {
                machine = nil
                project = nil
            })
            for engine in app.machines.list.compactMap({ app.machines.engine($0.id) }) {
                menu.addItem(ActionItem(engine.machine.name, subtitle: engine.statusText, image: NSImage(systemSymbolName: "server.rack", accessibilityDescription: nil), checked: machine == engine.machine.id) {
                    machine = engine.machine.id
                    // One it can't use there (a coding agent's): that machine's engine's.
                    if let current = model, !modelScope.allows(current.providerID) { model = placeCatalog.startingModel(lastModel, scope: modelScope) }
                    project = nil
                    if case .failed = engine.state { app.connect(engine) }
                })
            }
            menu.addItem(.separator())
            menu.addItem(ActionItem("Add Machine…") { showsAddMachine = true })
            return menu
        } label: {
            LocationRow(machine: machine.flatMap { app.machines.engine($0) })
        }
    }

    /// Its own folder, or one of the projects where it lives.
    private var folderMenu: some View {
        let projects = workspace.projects.filter { RemoteFolder.machine(of: $0.directory) == machine }
        return NativeMenuButton(opensBelow: true) {
            let menu = NSMenu()
            menu.addItem(ActionItem("Its Own Folder", subtitle: "A workspace of its own, beside its memory", image: NSImage(systemSymbolName: "folder.badge.person.crop", accessibilityDescription: nil), checked: project == nil) {
                project = nil
            })
            if !projects.isEmpty {
                menu.addItem(.separator())
                menu.addItem(.sectionHeader(title: "Projects"))
                for item in projects {
                    menu.addItem(ActionItem(item.name, image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil), checked: project == item.directory) {
                        project = item.directory
                    })
                }
            }
            return menu
        } label: {
            WellRow {
                Image(systemName: project == nil ? "folder.badge.person.crop" : "folder")
            } content: {
                HStack(spacing: 8) {
                    Text("Works in")
                        .foregroundStyle(.secondary)
                    Text(project.map(workspace.projectName) ?? "Its own folder")
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    MenuChevron()
                }
            }
            .contentShape(.rect)
        }
    }

    /// Opening a shared bot and not making it leaves none of its personality behind (one being
    /// made keeps it).
    private func dropAddedPersonality() {
        guard !isWorking || waitsForMachine, let addedPersonality,
              !bots.list.contains(where: { $0.personality == addedPersonality }),
              let added = Personalities.shared.personality(addedPersonality) else { return }
        Personalities.shared.delete(added)
    }

    // MARK: Saving

    private func save() {
        guard !trimmedName.isEmpty, !isWorking else { return }
        if var bot {
            bot.name = trimmedName
            bot.look = look
            bot.model = model
            bot.personality = personality
            Task { await bots.update(bot) }
            close()
            return
        }
        isWorking = true
        failure = nil
        creating = Task {
            defer {
                isWorking = false
                waitsForMachine = false
            }
            do {
                try await waitForMachine()
                let bot = try await bots.create(name: trimmedName, look: look, personality: personality, model: model, machine: machine, project: project)
                // Its job, typed in its conversation, from a template or a shared bot; otherwise the
                // bot writes first.
                if !firstMessage.isEmpty {
                    Drafts.shared[bot.sessionID].text = firstMessage
                } else {
                    Task { await bots.greet(bot) }
                }
                created(bot)
            } catch is CancellationError {
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    /// A machine still connecting (or installing its engine) is waited for, with what's under way
    /// beside the buttons; one that can't be reached says so.
    private func waitForMachine() async throws {
        guard let machine, let engine = app.machines.engine(machine), !engine.isReady else { return }
        waitsForMachine = true
        while !engine.isReady {
            guard engine.connection.isUnderWay else { throw MachineUnreachable(title: engine.statusTitle) }
            try await Task.sleep(for: .milliseconds(250))
        }
        waitsForMachine = false
    }

    private struct MachineUnreachable: LocalizedError {
        let title: String
        var errorDescription: String? { "\(title). Try again once it’s connected, or make the bot on This Mac." }
    }

    /// Fills the form from a template.
    private func use(_ template: BotTemplate) {
        withAnimation(.ui) {
            self.template = template.id
            name = template.name
            firstMessage = BotTemplate.firstMessage(job: template.job, instructions: template.instructions)
            look = template.look
            personality = template.personality
        }
    }

    private func section(_ title: String, note: String? = nil, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
            if let note {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Bots to start from: each with its look, name and job.
private struct TemplatePicker: View {
    let selection: String?
    let pick: (BotTemplate) -> Void

    var body: some View {
        WellGroup {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 172), spacing: 6)], spacing: 6) {
                ForEach(BotTemplate.all) { template in
                    TemplateTile(template: template, isOn: selection == template.id) { pick(template) }
                }
            }
            .padding(8)
        }
    }

    private struct TemplateTile: View {
        let template: BotTemplate
        let isOn: Bool
        let action: () -> Void
        @State private var isHovering = false

        var body: some View {
            Button(action: action) {
                HStack(alignment: .top, spacing: 10) {
                    BotAvatar(look: template.look, size: 30, noticed: isHovering)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(template.name)
                            .font(.system(size: 13, weight: .semibold))
                        Text(template.job)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isOn ? AnyShapeStyle(.tint.opacity(0.14)) : isHovering ? AnyShapeStyle(Color.primary.opacity(0.06)) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10))
                .contentShape(.rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .accessibilityAddTraits(isOn ? .isSelected : [])
            .help(template.wantsProject ? "Works best in one of your projects" : "")
        }
    }
}

/// Color, shape and face, each a row of choices drawn as the bot would look with it. A picked
/// color has a quiet ring, as in Settings › Appearance; a picked shape or face sits on accent
/// glass, the app's mark for what's selected.
private struct LookPicker: View {
    @Binding var look: BotLook

    var body: some View {
        WellGroup {
            row("Color") {
                ForEach(BotLook.Tint.allCases) { tint in
                    Button {
                        withAnimation(.ui) { look.color = tint }
                    } label: {
                        Circle()
                            .fill(tint.color)
                            .frame(width: 20, height: 20)
                            .overlay { Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5) }
                            .padding(3.5)
                            .overlay {
                                if look.color == tint { Circle().strokeBorder(.primary.opacity(0.55), lineWidth: 1.5) }
                            }
                            .contentShape(.circle)
                    }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .help(tint.title)
                    .accessibilityLabel(tint.title)
                    .accessibilityAddTraits(look.color == tint ? .isSelected : [])
                }
            }
            WellDivider()
            row("Shape") {
                ForEach(BotLook.Form.allCases) { form in
                    Tile(isOn: look.shape == form, help: form.title) { look.shape = form } label: {
                        BotAvatar(look: BotLook(color: look.color, shape: form, face: look.face), size: 26, animates: false)
                    }
                }
            }
            WellDivider()
            row("Face") {
                ForEach(BotLook.Face.allCases) { face in
                    Tile(isOn: look.face == face, help: face.title) { look.face = face } label: {
                        BotAvatar(look: BotLook(color: look.color, shape: look.shape, face: face), size: 26, animates: false)
                    }
                }
            }
        }
    }

    /// The choices wrap onto another line when the card is narrow.
    private func row(_ title: String, @ViewBuilder choices: () -> some View) -> some View {
        HStack(alignment: .firstRowCenter, spacing: 0) {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(width: 66, alignment: .leading)
                .padding(.leading, 12)
            Flow(spacing: 4) { choices() }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .frame(minHeight: 48)
    }

    /// A shape or face to pick: on accent glass when it's the one, a soft fill under the pointer.
    private struct Tile<Label: View>: View {
        let isOn: Bool
        let help: String
        let action: () -> Void
        @ViewBuilder let label: Label
        @State private var isHovering = false

        var body: some View {
            Button {
                withAnimation(.ui) { action() }
            } label: {
                label
                    .frame(width: 38, height: 38)
                    .background(isHovering && !isOn ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 10))
                    .accentGlass(RoundedRectangle(cornerRadius: 10), isOn: isOn)
                    .contentShape(.rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .help(help)
            .accessibilityLabel(help)
            .accessibilityAddTraits(isOn ? .isSelected : [])
        }
    }
}

/// Its personality: Kuvo Code's, yours, or none, as tiles; the one picked described below; and
/// your own made or changed right here.
private struct PersonalityPicker: View {
    @Binding var selection: String?
    @Environment(Bots.self) private var bots
    /// A personality of yours being made (no ID yet) or changed.
    @State private var draft: Draft? {
        didSet { if draft?.id != oldValue?.id || draft == nil { refusal = nil } }
    }
    /// Why the draft couldn't be saved (your personalities are full), above its buttons.
    @State private var refusal: String?
    @FocusState private var draftFocus: DraftField?

    private struct Draft {
        var id: String?
        var name = ""
        var description = ""
    }

    private enum DraftField { case name, description }

    private var store: Personalities { .shared }
    private var picked: Personality? { store.personality(selection) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            WellGroup {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 156), spacing: 6)], spacing: 6) {
                    Tile(symbol: "circle.dashed", name: "None", isOn: selection == nil) { selection = nil }
                    ForEach(store.all) { personality in
                        Tile(symbol: personality.symbol, name: personality.name, isOn: selection == personality.id) {
                            selection = personality.id
                        }
                        .contextMenu {
                            if personality.isCustom {
                                Button("Edit…") { edit(personality) }
                                Button("Delete", role: .destructive) { delete(personality) }
                            }
                        }
                    }
                    Tile(symbol: "plus", name: "New…", isOn: false, isQuiet: true) {
                        draft = Draft()
                        draftFocus = .name
                    }
                    .help("Write a personality of your own")
                }
                .padding(8)
                WellDivider()
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(picked?.description ?? "No personality of its own: it talks the way its model does.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if let picked, picked.isCustom {
                        Button("Edit") { edit(picked) }
                            .buttonStyle(TextButtonStyle())
                        Button("Delete") { delete(picked) }
                            .buttonStyle(TextButtonStyle())
                    }
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .animation(.ui, value: selection)
            }
            if draft != nil { form }
        }
        .animation(.ui, value: draft == nil)
    }

    /// Making or changing one of yours: its name, and how it talks.
    private var form: some View {
        VStack(alignment: .leading, spacing: 10) {
            WellGroup(isActive: draftFocus != nil) {
                WellRow(isActive: draftFocus == .name) {
                    Image(systemName: "person.crop.circle")
                } content: {
                    TextField("Name", text: Binding(get: { draft?.name ?? "" }, set: { draft?.name = $0; refusal = nil }), prompt: Text("Name, like Night Owl"))
                        .textFieldStyle(.plain)
                        .focused($draftFocus, equals: .name)
                }
                WellDivider()
                TextField("How it talks", text: Binding(get: { draft?.description ?? "" }, set: { draft?.description = $0; refusal = nil }),
                          prompt: Text("How it talks, like Quiet and precise. Explains with examples, and asks before assuming."), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(2...10)
                    .focused($draftFocus, equals: .description)
                    .padding(12)
            }
            if let refusal {
                Text(refusal)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button("Cancel") { draft = nil }
                    .buttonStyle(.glass)
                Button(draft?.id == nil ? "Add Personality" : "Save Personality", action: saveDraft)
                    .buttonStyle(.glassProminent)
                    .disabled(!canSave)
            }
        }
        .transition(.opacity.combined(with: .offset(y: -6)))
    }

    private var canSave: Bool {
        guard let draft else { return false }
        return !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !draft.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func edit(_ personality: Personality) {
        draft = Draft(id: personality.id, name: personality.name, description: personality.description)
        draftFocus = .description
    }

    private func delete(_ personality: Personality) {
        store.delete(personality)
        if selection == personality.id { selection = nil }
        Task { await bots.personalityChanged(personality.id) }
    }

    private func saveDraft() {
        guard canSave, let draft else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let id = draft.id, var personality = store.personality(id) {
                personality.name = name
                personality.description = description
                try store.update(personality)
                Task { await bots.personalityChanged(id) }
            } else {
                selection = try store.add(name: name, description: description).id
            }
        } catch {
            refusal = error.localizedDescription
            AccessibilityNotification.Announcement(error.localizedDescription).post()
            return
        }
        self.draft = nil
    }

    /// A personality to pick: on accent glass when it's the one, a soft fill under the pointer.
    private struct Tile: View {
        let symbol: String
        let name: String
        let isOn: Bool
        var isQuiet = false
        let action: () -> Void
        @State private var isHovering = false

        var body: some View {
            Button {
                withAnimation(.ui) { action() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        .frame(width: 18)
                    Text(name)
                        .lineLimit(1)
                        .foregroundStyle(isQuiet ? .secondary : .primary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .frame(height: 34)
                .background(isHovering && !isOn ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 8))
                .accentGlass(RoundedRectangle(cornerRadius: 8), isOn: isOn)
                .contentShape(.rect(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .accessibilityAddTraits(isOn ? .isSelected : [])
        }
    }
}

/// When something happens (a bot's wake-up, a group chat's meeting) and how often: a date and
/// time, then Once or a repeat from `choices`.
struct ScheduleRow: View {
    @Binding var date: Date
    /// The earliest it can be; nil for any time.
    let from: Date?
    @Binding var every: Wakes.Repeat?
    let choices: [Wakes.Repeat?]
    let label: String

    var body: some View {
        HStack(spacing: 10) {
            PlainDatePicker(date: $date, from: from)
                .accessibilityLabel(label)
            Spacer(minLength: 8)
            Picker("Repeats", selection: $every) {
                ForEach(choices, id: \.self) { every in
                    Text(every.map { $0.words.prefix(1).uppercased() + $0.words.dropFirst() } ?? "Once").tag(every)
                }
            }
            .labelsHidden()
            .fixedSize()
        }
        .padding(.vertical, 6)
    }
}
