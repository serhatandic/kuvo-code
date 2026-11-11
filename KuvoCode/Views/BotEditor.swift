import AppKit
import ClientDesign
import ClientSessions
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
    /// Its job as you change it here, beside the job it keeps (`JobDraft`).
    @State private var job: JobDraft
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
    /// This New Bot, sent as one however often Create is clicked.
    @State private var request = Bots.NewBotRequest()
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
    /// Closed, for what's still under way when it is (a shared bot's personality being added).
    @State private var lifetime = Lifetime()
    private final class Lifetime { var isClosed = false }
    @FocusState private var focus: Field?

    private enum Field { case name }

    /// `recipe`: a shared bot that a new one starts from. `machine`: where a new one starts to live
    /// (nil for this Mac).
    init(bot: Bot?, recipe: BotRecipe? = nil, machine: String? = nil, close: @escaping () -> Void, created: @escaping (Bot) -> Void = { _ in }) {
        self.bot = bot
        self.close = close
        self.created = created
        _look = State(initialValue: bot?.look ?? recipe?.look ?? .random())
        _name = State(initialValue: bot?.name ?? recipe?.name ?? "")
        _job = State(initialValue: JobDraft(line: bot?.job ?? "", details: bot?.instructions ?? ""))
        _machine = State(initialValue: bot == nil ? machine : bot?.machine)
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
            .onDisappear {
                lifetime.isClosed = true
                dropAddedPersonality()
            }
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
            // Starting on a machine that couldn't connect: tried again, as picking it does.
            if isNew, let engine = machine.flatMap({ app.machines.engine($0) }), case .failed = engine.state { app.connect(engine) }
            #if DEBUG
            // KUVO_DEMO_NEW_BOT_MACHINE=<machine>: a new bot set to live on that machine.
            if isNew, let machine = ProcessInfo.processInfo.environment["KUVO_DEMO_NEW_BOT_MACHINE"] { self.machine = machine }
            #endif
            // A shared bot's personality, found here (or added) once, not at every redraw.
            if isNew, !adoptedRecipe, let recipe {
                adoptedRecipe = true
                let lifetime = lifetime
                Task {
                    do {
                        guard personality == nil, let found = try await recipe.personalityHere() else { return }
                        // Closed meanwhile without making it: none of it stays.
                        if lifetime.isClosed {
                            if found.added, let added = Personalities.shared.personality(found.id) { try? await Personalities.shared.delete(added) }
                            return
                        }
                        personality = found.id
                        if found.added { addedPersonality = found.id }
                    } catch {
                        // Yours are full (or couldn't be reached): it starts without one, and says why.
                        failure = "Its personality, “\(recipe.personality?.name ?? "")”, couldn’t be added to yours: \(error.localizedDescription) Pick one for it here, or open its file again."
                    }
                }
            }
            // The model it talks on: one picked for it whose account you've signed out of (none
            // to show) gives way to its conversation's, as in its group chats. A bot made before
            // bots had a model: the one its conversation uses.
            if let bot, model == bot.model, let talking = app.bots.talkingModel(of: bot) { model = talking }
            if model == nil { model = bot.flatMap { workspace.session($0.sessionID)?.model } ?? placeCatalog.startingModel(lastModel, scope: modelScope) }
            #if DEBUG
            // KUVO_DEMO_EDIT_BOT_SAVE=<job>: its job in a few words changed to that, and saved, to
            // see what Save says (a computer that's away, this Mac's box down).
            if let line = ProcessInfo.processInfo.environment["KUVO_DEMO_EDIT_BOT_SAVE"], bot != nil {
                job.line = line
                Task {
                    // (After KUVO_DEMO_BOX_FAILED has stopped this Mac's box.)
                    try? await Task.sleep(for: .seconds(10))
                    save()
                }
            }
            #endif
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
                    section("Start From") {
                        TemplatePicker(selection: template) { use($0) }
                    }
                }

                identity

                if let bot {
                    section("Job") {
                        JobFields(name: bot.name, job: $job)
                    }
                    // Its job as the bot keeps it, changed while this was open: yours stays, unless
                    // you take its own.
                    .onChange(of: bots.bot(bot.id).map { JobDraft.Job(line: $0.job, details: $0.instructions) }) { _, kept in
                        // (Not what your own Save brings back, as its box words it.)
                        guard let kept, !isWorking else { return }
                        withAnimation(.ui) { job.botKept(kept) }
                    }
                }

                section("Look") {
                    LookPicker(look: $look)
                }

                section("Personality") {
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
                    section("Work") {
                        BotWorkLimits(bot: bot)
                    }
                    section("Wake-Ups") {
                        WakeList(owner: bot.wakeOwner, name: bot.name)
                    }
                    if bot.project == nil {
                        section("Keys") {
                            BotKeysSection(bot: bot) { service in withAnimation(.ui) { keyFor = service } }
                        }
                    } else {
                        section("Keys") {
                            WellGroup {
                                WellRow { Image(systemName: "key") } content: {
                                    Text("It uses its project’s keys, from Settings › Integrations.")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    section("Vault") {
                        BotVaultSection(bot: bot)
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
            // What you changed while its machine was away, waiting for it.
            if let bot, let place = bots.waitingFor(bot) {
                Label("Your changes are waiting for \(place), which isn’t connected. They go to it as soon as it’s back.", systemImage: "clock.arrow.circlepath")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
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
                WellGroup(isFocused: focus == .name) {
                    WellRow {
                        Image(systemName: "face.smiling")
                    } content: {
                        TextField("Name", text: $name, prompt: Text("Name, like Scout"))
                            .textFieldStyle(.plain)
                            .font(.system(size: 15, weight: .medium))
                            .focused($focus, equals: .name)
                    }
                }
                // As tall as its row, beside the avatar.
                .fixedSize(horizontal: false, vertical: true)
                if isNew {
                    Text("Its job is what you tell it in its conversation. It keeps it and works on it from then on.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
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
        Task { try? await Personalities.shared.delete(added) }
    }

    // MARK: Saving

    private func save() {
        guard !trimmedName.isEmpty, !isWorking else { return }
        if var bot {
            bot.name = trimmedName
            bot.look = look
            bot.model = model
            bot.personality = personality
            bot.job = job.line
            bot.instructions = job.details
            // Sent to its box; one for a computer that's away waits for it. What its box turns
            // down shows here, with what you changed as you left it.
            isWorking = true
            failure = nil
            Task {
                defer { isWorking = false }
                do {
                    try await bots.update(bot, job: true)
                    close()
                } catch {
                    failure = error.localizedDescription
                }
            }
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
                // From a template or a shared bot, its job is typed in its conversation for you;
                // otherwise the bot writes first.
                let made = try await request.make(with: bots, name: trimmedName, look: look, personality: personality, model: model, machine: machine, project: project,
                                                  template: template, shared: recipe.map { ($0.job, $0.instructions) })
                if let first = made.firstMessage, !first.isEmpty { Drafts.shared[made.bot.sessionID].text = first }
                created(made.bot)
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

/// A bot's job in Edit Bot: what it does in a few words (shown under its name) and the details. The
/// bot keeps it as you talk to it, and a change made here goes to it.
private struct JobFields: View {
    let name: String
    @Binding var job: JobDraft
    @FocusState private var focus: Field?

    private enum Field { case line, details }

    static func keptWords(_ kept: JobDraft.Job, name: String) -> String {
        kept.line.isEmpty ? "\(name) cleared its job meanwhile. Save keeps yours." : "\(name) changed its job meanwhile, to “\(kept.line)”. Save keeps yours."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let kept = job.keptMeanwhile {
                // The bot changed its job while you were changing it here.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text(Self.keptWords(kept, name: name))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 8)
                    Button("Use Its Job") { withAnimation(.ui) { job.useKept() } }
                        .buttonStyle(TextButtonStyle())
                }
                .font(.callout)
                .transition(.opacity)
            }
            WellGroup(isFocused: focus != nil) {
                WellRow {
                    Image(systemName: "briefcase")
                } content: {
                    TextField("In a Few Words", text: $job.line, prompt: Text("In a few words, like Keeps the build green"))
                        .textFieldStyle(.plain)
                        .focused($focus, equals: .line)
                        .accessibilityLabel("Job, in a few words")
                }
                WellDivider()
                TextField("Details", text: $job.details, prompt: Text("The details: what to watch, what to make, what never to do without asking"), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(3...12)
                    .focused($focus, equals: .details)
                    .accessibilityLabel("Job details")
                    .padding(12)
            }
        }
        // Said as it appears, for one who can't see it come.
        .onChange(of: job.keptMeanwhile) { _, kept in
            if let kept { AccessibilityNotification.Announcement(Self.keptWords(kept, name: name)).post() }
        }
    }
}

/// Bots to start from: their faces and names, and one line for what the picked one does.
private struct TemplatePicker: View {
    let selection: String?
    let pick: (BotTemplate) -> Void

    private var picked: BotTemplate? { BotTemplate.all.first { $0.id == selection } }

    var body: some View {
        WellGroup {
            VStack(alignment: .leading, spacing: 10) {
                // Two even rows across the well: wrapping by width left a short last row under
                // a gap.
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 60), spacing: 4), count: (BotTemplate.all.count + 1) / 2), spacing: 4) {
                    ForEach(BotTemplate.all) { template in
                        TemplateFace(template: template, isOn: selection == template.id) { pick(template) }
                    }
                }
                Text(picked.map(Self.line) ?? "Fills in a name, look and job for you to send. Or start from nothing and tell it there.")
                    .font(.callout)
                    .foregroundStyle(picked == nil ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
                    .contentTransition(.opacity)
                    .animation(.ui, value: selection)
            }
            .padding(8)
        }
    }

    /// "Herald sends you a morning news digest."
    static func line(_ template: BotTemplate) -> String {
        let job = template.job.prefix(1).lowercased() + template.job.dropFirst()
        return "\(template.name) \(job)."
    }

    private struct TemplateFace: View {
        let template: BotTemplate
        let isOn: Bool
        let action: () -> Void
        @State private var isHovering = false

        var body: some View {
            Button(action: action) {
                VStack(spacing: 6) {
                    BotAvatar(look: template.look, size: 36, noticed: isHovering)
                    Text(template.name)
                        .font(.system(size: 12, weight: isOn ? .semibold : .regular))
                        .lineLimit(1)
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .pickHighlight(RoundedRectangle(cornerRadius: 10), isOn: isOn)
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
            .accessibilityLabel("\(template.name): \(template.job)")
            .accessibilityAddTraits(isOn ? .isSelected : [])
            .help(template.job + (template.wantsProject ? ". Works best in one of your projects" : ""))
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

        var body: some View {
            Button {
                withAnimation(.ui) { action() }
            } label: {
                label
                    .frame(width: 38, height: 38)
                    .pickHighlight(RoundedRectangle(cornerRadius: 10), isOn: isOn)
            }
            .buttonStyle(.plain)
            .clickablePointer()
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
    /// Why the draft couldn't be saved (your personalities are full), above its buttons, or one
    /// couldn't be deleted, below them all.
    @State private var refusal: String?
    /// The draft being saved, or one being deleted: its buttons wait.
    @State private var isSaving = false
    @FocusState private var draftFocus: DraftField?

    private struct Draft: Equatable {
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
                        .heldContextMenu {
                            if personality.isCustom {
                                HeldRow.button("Edit…") { edit(personality) }
                                HeldRow.button("Delete", role: .destructive) { delete(personality) }
                            }
                        }
                    }
                    Tile(symbol: "plus", name: "New…", isOn: false, isQuiet: true) {
                        refusal = nil
                        draft = Draft()
                        draftFocus = .name
                    }
                    .help("Write a personality of your own")
                }
                .padding(8)
                WellDivider()
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(pickedDescription)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if let picked, picked.isCustom {
                        Button("Edit") { edit(picked) }
                            .buttonStyle(TextButtonStyle())
                        Button("Delete") { delete(picked) }
                            .buttonStyle(TextButtonStyle())
                            .disabled(isSaving)
                    }
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .animation(.ui, value: selection)
            }
            if draft != nil {
                form
            } else if let refusal {
                refusalText(refusal)
            }
        }
        .animation(.ui, value: draft == nil)
    }

    private var pickedDescription: String {
        if let picked { return picked.description }
        // One of yours, before they've been read (as Kuvo Code starts): still its own.
        if selection != nil, !store.isLoaded { return "Its own personality shows once Kuvo Code’s background service on this Mac has started." }
        return "No personality of its own: it talks the way its model does."
    }

    private func refusalText(_ refusal: String) -> some View {
        Text(refusal)
            .font(.callout)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Making or changing one of yours: its name, and how it talks.
    private var form: some View {
        VStack(alignment: .leading, spacing: 10) {
            WellGroup(isFocused: draftFocus != nil) {
                WellRow {
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
            if let refusal { refusalText(refusal) }
            HStack {
                Spacer()
                if isSaving { Spinner(size: 16) }
                Button("Cancel") { draft = nil }
                    .buttonStyle(.glass)
                    .disabled(isSaving)
                Button(draft?.id == nil ? "Add Personality" : "Save Personality", action: saveDraft)
                    .buttonStyle(.glassProminent)
                    .disabled(!canSave || isSaving)
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
        guard !isSaving else { return }
        isSaving = true
        refusal = nil
        // Bots with it hear it's gone as its box takes it away (`Personalities.onChange`).
        Task {
            defer { isSaving = false }
            do {
                try await store.delete(personality)
                if selection == personality.id { selection = nil }
            } catch {
                refusal = "“\(personality.name)” couldn’t be deleted: \(error.localizedDescription)"
                AccessibilityNotification.Announcement(refusal ?? "").post()
            }
        }
    }

    private func saveDraft() {
        guard canSave, !isSaving, let draft else { return }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        isSaving = true
        // Bots with it hear its new words as its box takes them (`Personalities.onChange`).
        Task {
            defer { isSaving = false }
            do {
                if let id = draft.id, var personality = store.personality(id) {
                    personality.name = name
                    personality.description = description
                    try await store.update(personality)
                } else {
                    selection = try await store.add(name: name, description: description).id
                }
            } catch {
                refusal = error.localizedDescription
                AccessibilityNotification.Announcement(error.localizedDescription).post()
                return
            }
            // Closed only if it's still the one saved (not changed, or another begun, meanwhile).
            if self.draft == draft { self.draft = nil }
        }
    }

    /// A personality to pick: on accent glass when it's the one, a soft fill under the pointer.
    private struct Tile: View {
        let symbol: String
        let name: String
        let isOn: Bool
        var isQuiet = false
        let action: () -> Void

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
                .pickHighlight(RoundedRectangle(cornerRadius: 8), isOn: isOn)
            }
            .buttonStyle(.plain)
            .clickablePointer()
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

/// The limits you set on the sessions a bot runs (Edit Bot › Work), kept on its box: none until you
/// set one, as it sizes its work to the job. Each changes as you pick it, from what its box says
/// now (`kuvo/bots`), so a pick never undoes another.
struct BotWorkLimits: View {
    let bot: Bot
    @Environment(AppModel.self) private var app
    @State private var failure: String?
    @State private var isSaving = false

    private var limits: WorkLimits { app.bots.bot(bot.id)?.limits ?? WorkLimits() }
    private var allowed: [WorkAction] { app.bots.bot(bot.id)?.allowed?.actions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if app.botWork.runsWork(bot) {
                WellGroup {
                    row("Sessions at once", symbol: "square.stack", value: limits.atOnce, choices: [1, 2, 3, 5, 8], words: { "\($0)" }) { $0.atOnce = $1 }
                    WellDivider()
                    row("New sessions a day", symbol: "calendar", value: limits.perDay, choices: [3, 5, 10, 20, 50], words: { "\($0)" }) { $0.perDay = $1 }
                    WellDivider()
                    row("Sessions they start", symbol: "arrow.turn.down.right", value: limits.depth, choices: [1, 2, 3], words: WorkWords.depth) { $0.depth = $1 }
                    WellDivider()
                    row("Tokens a day", symbol: "gauge.with.dots.needle.33percent", value: limits.tokensPerDay, choices: [250_000, 1_000_000, 5_000_000, 20_000_000], words: { WorkWords.tokens($0) }) { $0.tokensPerDay = $1 }
                }
                .disabled(isSaving)
                // What you let it do without asking (Always on its card), each taken back here.
                if !allowed.isEmpty {
                    WellGroup {
                        ForEach(Array(allowed.enumerated()), id: \.element) { index, action in
                            if index > 0 { WellDivider() }
                            WellRow {
                                Image(systemName: action == .cloneProject ? "square.and.arrow.down.on.square" : "folder.badge.plus")
                            } content: {
                                HStack(spacing: 8) {
                                    Text(WorkWords.allowed(action))
                                    Spacer(minLength: 8)
                                    Text("Without asking")
                                        .foregroundStyle(.secondary)
                                    Button("Ask First") { takeBack(action) }
                                        .buttonStyle(TextButtonStyle())
                                        .help("\(bot.name) asks you again before it does this.")
                                }
                            }
                        }
                    }
                    .disabled(isSaving)
                }
            } else {
                Text("\(bot.machine.map { app.machines.engine($0)?.machine.name ?? $0 } ?? "This Mac") needs a newer Kuvo Code for \(bot.name) to run sessions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // Whether its box runs its work (one from before doesn't).
        .task { await app.botWork.read(bot) }
    }

    private func row(_ title: String, symbol: String, value: Int?, choices: [Int], words: @escaping (Int) -> String, set: @escaping (inout WorkLimits, Int?) -> Void) -> some View {
        NativeMenuButton(name: title.lowercased(), opensBelow: true) {
            let menu = NSMenu()
            menu.addItem(ActionItem("No Limit", checked: value == nil) { change { set(&$0, nil) } })
            menu.addItem(.separator())
            for choice in choices {
                menu.addItem(ActionItem(words(choice), checked: value == choice) { change { set(&$0, choice) } })
            }
            return menu
        } label: {
            WellRow {
                Image(systemName: symbol)
            } content: {
                HStack(spacing: 8) {
                    Text(title)
                    Spacer(minLength: 8)
                    HStack(spacing: 8) {
                        Text(value.map(words) ?? "No limit")
                            .foregroundStyle(.secondary)
                        MenuChevron()
                    }
                    .nativeMenuValue()
                }
            }
            .contentShape(.rect)
        }
        .accessibilityLabel(title)
        .accessibilityValue(value.map(words) ?? "No limit")
    }

    private func takeBack(_ action: WorkAction) {
        isSaving = true
        failure = nil
        Task {
            do { try await app.botWork.setAllowed(allowed.filter { $0 != action }, for: bot) } catch { failure = error.localizedDescription }
            isSaving = false
        }
    }

    private func change(_ edit: (inout WorkLimits) -> Void) {
        var changed = limits
        edit(&changed)
        isSaving = true
        failure = nil
        Task {
            do { try await app.botWork.setLimits(changed, for: bot) } catch { failure = error.localizedDescription }
            isSaving = false
        }
    }
}
