import ClientDesign
import OpenCodeKit
import SwiftUI

/// Skills: instructions and scripts the agent loads when a task calls for them, on each computer
/// (each has its own, which its box keeps: `BoxSkills`). The ones it has, each can be turned off;
/// popular collections on GitHub to add more from; other folders and catalogs to read them from.
struct SkillsSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    /// Nil until the engine has listed them.
    @State private var skills: [Skill]?
    /// Where each comes from, as its box says.
    @State private var here = SkillsShown()
    /// Why its box couldn't say.
    @State private var boxFailure: String?
    /// Why its engine couldn't list them.
    @State private var listFailure: String?
    /// GitHub's well-known collections; nil until they're listed.
    @State private var collections: [SkillCollection]?
    @State private var collectionsFailure: String?
    /// Why a skill couldn't be removed: the list stays.
    @State private var removeFailure: String?
    @State private var browsing: Browsing?
    @State private var repositoryName = ""
    /// While a repository typed by name is being looked up on GitHub.
    @State private var isOpening = false
    @State private var failure: String?
    /// The skill being written or changed: a new one has no name yet.
    @State private var writing: SkillDraft?
    /// What the list is narrowed to.
    @State private var search = ""
    /// Its box's Recently Deleted; nil until the page has read it.
    @State private var deleted: RecentlyDeletedSkills?
    @State private var showsDeleted = false

    private var config: EngineConfig { app.config(for: box) }
    private var routes: BoxSkills { BoxSkills(box: app.box(box.id), library: app.box(BoxClient.thisMac)) }

    /// The skills, narrowed to what's searched for.
    private var shown: [Skill] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return skills ?? [] }
        return (skills ?? []).filter { "\($0.name) \($0.description ?? "")".localizedCaseInsensitiveContains(query) }
    }

    /// A description's first sentence.
    static func summary(_ description: String) -> String {
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let end = text.range(of: #"[.!?](\s|$)"#, options: .regularExpression) else { return text }
        return String(text[..<end.upperBound]).trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                if skills == nil {
                    Placeholder(.rows(count: 3), label: "Loading skills", fadesOut: false)
                        .padding(.vertical, 6)
                } else if let listFailure {
                    FailureLabel(title: "Couldn’t list the skills", detail: listFailure, retrying: "the skills") {
                        Task { await refresh() }
                    }
                } else if skills?.isEmpty == true {
                    Text("None yet.")
                        .foregroundStyle(.secondary)
                } else if (skills?.count ?? 0) > 6 {
                    SettingsSearchRow(text: $search, prompt: "Search skills")
                }
                if let boxFailure {
                    FailureLabel(title: "Couldn’t read the skills you added", detail: boxFailure, retrying: "the skills you added") {
                        Task {
                            // This Mac's box, started again if it stopped for good.
                            if box.machine == nil { await app.box.startAgain() }
                            await refresh()
                        }
                    }
                }
                ForEach(shown) { skill in
                    SettingsRowLayout {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(skill.name)  \(Text(here.source(of: skill) ?? "").font(.subheadline).foregroundStyle(.secondary))")
                            if let description = skill.description {
                                // Written for the model, often at length: its first sentence,
                                // and all of it on hover.
                                Text(Self.summary(description))
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .help(description)
                            }
                        }
                        .settingsText()
                        HStack {
                            if here.isYours(skill) {
                                // Deleting one you wrote is in its editor, behind a confirmation.
                                Button("Edit…") { writing = SkillDraft(name: here.folder(of: skill) ?? skill.id) }
                            }
                            if here.gitHub(skill) != nil, let folder = here.folder(of: skill) {
                                // From GitHub, so it can be added back.
                                Button("Remove") { remove(folder) }
                            }
                            Toggle("Use \(skill.name)", isOn: isOn(skill.id))
                                .labelsHidden()
                                .toggleStyle(.switch)
                                .controlSize(.small)
                        }
                    }
                    // Where it is, for one found in a folder of its own.
                    .help(here.place(of: skill) ?? "")
                }
                if let removeFailure {
                    Text(removeFailure)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Only while there's something in it.
                if deleted?.failure == nil, let count = deleted?.entries?.count, count > 0 {
                    Button {
                        showsDeleted = true
                    } label: {
                        HStack {
                            Label("Recently Deleted", systemImage: "trash")
                            Spacer()
                            Text(count, format: .number)
                                .foregroundStyle(.secondary)
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                    .accessibilityLabel("Recently Deleted, \(count.counting("skill"))")
                }
                Button("New Skill…") { writing = SkillDraft(name: nil) }
            } header: {
                Text("Skills the Agent Can Use")
            } footer: {
                Text("The agent loads a skill when a task calls for it. Skills in ~/.claude/skills and ~/.agents/skills\(box.machine == nil ? "" : " on \(app.name(of: box))"), and in a project's .opencode/skills, are found on their own.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()

            Section {
                if let collectionsFailure {
                    FailureLabel(title: "Couldn’t list the collections", detail: collectionsFailure, retrying: "the collections") {
                        Task {
                            // They're read through this Mac's box: started again if it stopped for good.
                            await app.box.startAgain()
                            await listCollections()
                        }
                    }
                } else if collections == nil {
                    Placeholder(.rows(count: 3), label: "Loading collections", fadesOut: false)
                        .padding(.vertical, 6)
                }
                ForEach(collections ?? []) { repository in
                    Button {
                        browsing = Browsing(collection: repository)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(repository.title)
                                    Text(repository.id)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                Text(repository.summary)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                }
                HStack {
                    TextField("Repository", text: $repositoryName, prompt: Text("Another repository on GitHub, like owner/skills"))
                        .labelsHidden()
                        .onSubmit(openRepository)
                    if isOpening {
                        Spinner(size: 16)
                    }
                    Button("Open", action: openRepository)
                        .disabled(isOpening || repositoryName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let failure {
                    Text(failure).foregroundStyle(.red)
                }
            } header: {
                Text("Get Skills")
            } footer: {
                Text("These come from their authors on GitHub, not from Kuvo Code. A skill can include scripts the agent may run, so look at what's in one before you add it.")
                    .foregroundStyle(.secondary)
            }

            Section {
                ConfigStringList(path: ["skills"], prompt: "A folder, or the address of a skill catalog")
            } header: {
                Text("Other Places")
            } footer: {
                Text("A catalog is a web address with an index.json listing its skills.")
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: config.settings) { await refresh() }
        // Again as this Mac's box stops or comes back (its collections are read there, and this
        // Mac's skills): the page says so, and fills again.
        .task(id: app.box.endpoint?.url) {
            await listCollections()
            if box.machine == nil { await refresh() }
        }
        // Again once its engine answers (a machine's, connecting as the page opened).
        .task(id: app.isReady(box)) { if app.isReady(box) { await refresh() } }
        #if DEBUG
        // KUVO_DEMO_SKILLS_COLLECTION=<owner/name>: that collection opened, as if typed and opened.
        .task {
            guard let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_SKILLS_COLLECTION"], let name = demo.split(separator: "|").first else { return }
            repositoryName = String(name)
            openRepository()
        }
        // KUVO_DEMO_SKILLS_DELETED=open: Recently Deleted opened; restore:<folder> also restores
        // that one, as Restore does.
        .task {
            guard let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_SKILLS_DELETED"] else { return }
            await refresh()
            showsDeleted = true
            guard demo.hasPrefix("restore:"), let deleted, let entry = deleted.entries?.first(where: { $0.folder == demo.dropFirst("restore:".count) }) else { return }
            if await deleted.restore(entry) { await refresh() }
        }
        #endif
        .settingsDetail(item: $writing, title: { $0.name ?? "New Skill" }) { draft in
            SkillEditor(name: draft.name, routes: routes, folder: box.machine == nil ? here.folder : nil, taken: here.taken(listed: skills ?? []),
                        recentlyDeleted: deleted?.isOffered == true) {
                writing = nil
                Task { await refresh() }
            }
        }
        .settingsDetail(isPresented: $showsDeleted, title: "Recently Deleted") {
            if let deleted {
                RecentlyDeletedPage(deleted: deleted, computer: box.machine == nil ? nil : app.name(of: box)) {
                    Task { await refresh() }
                } done: {
                    showsDeleted = false
                }
            }
        }
        .settingsDetail(item: $browsing, title: { $0.collection.title }) { opened in
            RepositorySkills(repository: opened.collection, listed: opened.listing, routes: routes,
                             isWellKnown: collections?.contains { $0.id == opened.collection.id } == true) {
                Task { await refresh() }
            } done: {
                browsing = nil
            }
        }
    }

    private func refresh() async {
        do {
            here = SkillsShown(try await routes.folder())
            boxFailure = nil
        } catch {
            // Nothing's yours to edit until its box answers.
            here = SkillsShown()
            boxFailure = error.localizedDescription
        }
        // Its Recently Deleted, this box's (the page can be another box's now). While the box
        // can't list it, the page shows none: the failure above says why.
        if deleted?.routes.box.box != box.id { deleted = RecentlyDeletedSkills(routes: routes) }
        await deleted?.load()
        // Its engine not answering yet (a machine's, connecting): still loading, and read again
        // once it does.
        guard let api = app.api(for: box) else { return }
        // The engine notices a folder added or taken away within a moment: its list shown as the
        // box has the folder, and asked again a few times while the two still differ.
        for attempt in 0..<4 {
            try? await Task.sleep(for: .milliseconds(attempt == 0 ? 500 : 1_000))
            if Task.isCancelled { return }
            let listed: [Skill]
            do {
                listed = try await api.skills()
                listFailure = nil
            } catch {
                listFailure = error.localizedDescription
                skills = []
                return
            }
            skills = here.current(listed).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            if here.folder == nil || (here.current(listed).count == listed.count && here.unlisted(listed).isEmpty) { break }
        }
    }

    private func listCollections() async {
        collectionsFailure = nil
        do {
            collections = try await routes.collections()
        } catch {
            // None to open while they can't be read: each would fail as it opened.
            collections = nil
            collectionsFailure = error.localizedDescription
        }
    }

    /// Off is a rule that denies the skill (or one a newer engine set that holds it back); turning
    /// it on takes that rule out, and leaves any other rule for it alone.
    private func isOn(_ id: String) -> Binding<Bool> {
        Binding {
            !config.items(["permissions"]).compactMap(\.rule).contains { $0.action == "skill" && $0.resource == id && $0.effect.holdsBack }
        } set: { on in
            var items = config.items(["permissions"]).filter { item in
                guard let rule = item.rule else { return true }
                return !(rule.action == "skill" && rule.resource == id && rule.effect.holdsBack)
            }
            if !on { items.append(PermissionRule(action: "skill", resource: id, effect: .deny).json) }
            config.setItems(items, at: ["permissions"])
        }
    }

    private func remove(_ id: String) {
        let routes = routes
        removeFailure = nil
        Task {
            do {
                try await routes.remove(id)
            } catch {
                removeFailure = "Couldn’t remove \(id): \(error.localizedDescription)"
            }
            await refresh()
        }
    }

    private func openRepository() {
        let name = repositoryName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !isOpening else { return }
        failure = nil
        isOpening = true
        let routes = routes
        Task {
            defer { isOpening = false }
            do {
                let listing = try await routes.listing(name)
                // A skill you started writing, or a repository you opened, meanwhile stays in view,
                // and the name stays typed.
                guard writing == nil, browsing == nil else { return }
                browsing = Browsing(collection: listing.repository, listing: listing)
                repositoryName = ""
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// A collection being browsed: one typed by name comes with its skills, listed as it was opened.
private struct Browsing: Identifiable {
    var collection: SkillCollection
    var listing: CollectionListing?
    var id: String { collection.id }
}

/// Why something couldn't be read, with a way to try again (Skills, Phone).
struct FailureLabel: View {
    let title: String
    let detail: String
    /// What Try Again reads again, for VoiceOver ("the collections").
    let retrying: String
    /// What Try Again does, for VoiceOver, where it does more than read again.
    var retryLabel: String?
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            Spacer()
            Button("Try Again", action: retry)
                .accessibilityLabel(retryLabel ?? "Try reading \(retrying) again")
        }
    }
}

/// Recently Deleted, in the page's place: the skills its box put away, each kept 30 days from when
/// it was deleted, to restore. The box says what's there and whether one can be restored.
private struct RecentlyDeletedPage: View {
    @Environment(AppModel.self) private var app
    let deleted: RecentlyDeletedSkills
    /// The machine's name, for one that isn't this Mac.
    let computer: String?
    let changed: () -> Void
    let done: () -> Void
    @State private var search = ""

    private var shown: [DeletedSkill] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return deleted.entries ?? [] }
        return (deleted.entries ?? []).filter { "\($0.name) \($0.folder) \($0.description ?? "")".localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        SettingsDetailPage {
            Section {
                if let failure = deleted.failure {
                    FailureLabel(title: "Couldn’t read Recently Deleted", detail: failure, retrying: "Recently Deleted") {
                        Task {
                            // This Mac's box, started again if it stopped for good.
                            if computer == nil { await app.box.startAgain() }
                            await deleted.load()
                        }
                    }
                } else if deleted.entries == nil {
                    Placeholder(.rows(count: 3), label: "Loading recently deleted skills", fadesOut: false)
                        .padding(.vertical, 6)
                } else if deleted.entries?.isEmpty == true {
                    Text("No skills were deleted in the last 30 days.")
                        .foregroundStyle(.secondary)
                } else {
                    if (deleted.entries?.count ?? 0) > 6 {
                        SettingsSearchRow(text: $search, prompt: "Search recently deleted")
                    }
                    if shown.isEmpty {
                        Text("No deleted skill matches “\(search.trimmingCharacters(in: .whitespaces))”.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(shown) { entry in
                        DeletedSkillRow(entry: entry, isRestoring: deleted.restoring == entry.id, canRestore: deleted.restoring == nil,
                                        refusal: deleted.refusals[entry.id]) {
                            Task {
                                if await deleted.restore(entry) {
                                    changed()
                                } else if let refusal = deleted.refusals[entry.id] {
                                    // Said where it shows, and to VoiceOver, which wouldn't hear it otherwise.
                                    AccessibilityNotification.Announcement("Couldn’t restore \(entry.name). \(refusal)").post()
                                }
                            }
                        }
                    }
                }
            } footer: {
                Text("Skills you delete\(computer.map { " on \($0)" } ?? "") stay here for 30 days, then they’re gone for good.")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            EditorFooter(primary: "Done", onPrimary: done)
        }
        .task { await deleted.load() }
    }
}

/// A deleted skill: what it says it is, when it was deleted and when it goes, and Restore.
private struct DeletedSkillRow: View {
    let entry: DeletedSkill
    let isRestoring: Bool
    let canRestore: Bool
    /// Why its box didn't restore it.
    let refusal: String?
    let restore: () -> Void

    var body: some View {
        SettingsRowLayout {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                if entry.name != entry.folder {
                    // The name it comes back under, which a refusal names.
                    Text("Restores as \(entry.folder)")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if let description = entry.description {
                    Text(SkillsSettings.summary(description))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .help(description)
                }
                Text(entry.when())
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if let refusal {
                    Text(refusal)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .settingsText()
            .accessibilityElement(children: .combine)
            HStack {
                if isRestoring {
                    Spinner(size: 16)
                        .accessibilityLabel("Restoring \(entry.name)")
                }
                Button("Restore", action: restore)
                    .disabled(!canRestore)
                    .accessibilityLabel("Restore \(entry.name)")
            }
        }
    }
}

private struct SkillDraft: Identifiable {
    /// Nil for a new skill.
    var name: String?
    var id: String { name ?? "" }
}

/// Writing a skill of your own, in the page's place: its name, when the agent should use it, and
/// its instructions, in a SKILL.md in its own folder (where scripts and other files it needs can
/// go too).
private struct SkillEditor: View {
    /// Nil for a new skill.
    let name: String?
    let routes: BoxSkills
    /// The skills folder, when it's on this Mac (for Show in Finder).
    let folder: String?
    /// Names other skills have.
    let taken: Set<String>
    /// Its box has Recently Deleted (`skills.trash`), where a deleted skill goes.
    let recentlyDeleted: Bool
    let done: () -> Void

    @State private var newName = ""
    @State private var summary = ""
    @State private var instructions = ""
    @State private var failure: String?
    @State private var confirmsRemoval = false
    @State private var isSaving = false
    /// Its SKILL.md as it was read, whose header saving keeps.
    @State private var existing: String?

    private var id: String { name ?? SkillFile.name(from: newName) }
    private var canSave: Bool {
        !id.isEmpty && !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (name != nil || !isTaken) && !isSaving
    }

    /// A new skill's name is one there is already, in the engine's list. (Its box looks at its
    /// folder too as it's saved, and says so.)
    private var isTaken: Bool { taken.contains(id) }

    /// What's under a new skill's name: the name it's saved as when that isn't what you typed,
    /// or why it can't be saved. Always a line, so the fields below don't move as you type.
    private var nameNote: (text: String, isProblem: Bool) {
        let typed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty, id.isEmpty { return ("Names use the letters a to z and digits, and this one has none.", true) }
        if !id.isEmpty, isTaken { return ("There’s a skill called \(id) already.", true) }
        if !typed.isEmpty, id != typed { return ("It's saved as \(id).", false) }
        return ("Names use lowercase letters a to z, digits and hyphens.", false)
    }

    var body: some View {
        SettingsDetailPage {
            if name == nil {
                Section {
                    SettingsTextRow(title: "Name") { TextField("Name", text: $newName, prompt: Text("release-notes")) }
                } footer: {
                    Text(nameNote.text)
                        .foregroundStyle(nameNote.isProblem ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Use it when")
                    TextField("Use it when", text: $summary, prompt: Text("Writing release notes from the commits since the last tag"), axis: .vertical)
                        .labelsHidden()
                        .lineLimit(1...10)
                }
            } footer: {
                Text("The agent reads this to decide when the skill is needed, and loads the instructions only then.")
                    .foregroundStyle(.secondary)
            }
            Section {
                TextEditor(text: $instructions)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 260)
            } header: {
                Text("Instructions")
            } footer: {
                Text("Markdown. Scripts and other files can go in the skill's folder; mention them here so the agent knows to use them.")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 10) {
                if let failure {
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                EditorFooter(primary: name == nil ? "Create Skill" : "Save", canDoPrimary: canSave, onPrimary: save, onCancel: done) {
                    if name != nil {
                        EditorFooterRemove(title: "Delete Skill…") { confirmsRemoval = true }
                        if let folder {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: folder).appending(path: id).appending(path: "SKILL.md")]) }
                                .buttonStyle(.glass)
                        }
                    }
                }
            }
        }
        .task { await load() }
        .confirmationDialog("Delete \(id)?", isPresented: $confirmsRemoval) {
            Button("Delete", role: .destructive, action: delete)
        } message: {
            Text(RecentlyDeletedSkills.deletionNote(recentlyDeleted: recentlyDeleted))
        }
    }

    private func load() async {
        guard let name else { return }
        let text: String
        do {
            text = try await routes.text(of: name)
        } catch {
            failure = error.localizedDescription
            return
        }
        existing = text
        let parsed = SkillFile.parse(text)
        summary = parsed.description
        instructions = parsed.body
    }

    private func save() {
        guard name != nil || !isTaken else {
            failure = "There’s a skill called \(id) already."
            return
        }
        let id = id, isNew = name == nil
        // A skill's own file keeps whatever else its header has.
        let text = SkillFile.text(name: id, description: summary, body: instructions, replacing: isNew ? nil : existing)
        isSaving = true
        failure = nil
        let routes = routes
        Task {
            defer { isSaving = false }
            do {
                // A new one never goes over another: its box says when the name's taken.
                try await routes.write(id, text, isNew: isNew)
                if isNew { Analytics.shared.track("skill_written") }
                done()
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func delete() {
        let id = id, routes = routes
        Task {
            do {
                try await routes.remove(id)
                done()
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// A SKILL.md: a header with its name and description, then its instructions.
nonisolated enum SkillFile {
    /// A skill's name as skills want it: lowercase letters, digits and hyphens.
    /// A skill's name from what's typed: its words in a to z and digits, joined by single
    /// hyphens (words in other scripts left out, so none at the start, the end or doubled).
    static func name(from text: String) -> String {
        let words = text.lowercased().split { !$0.isLetter && !$0.isNumber }.map { $0.filter(\.isASCII) }.filter { !$0.isEmpty }
        var name = String(words.joined(separator: "-").prefix(64))
        while name.hasSuffix("-") { name.removeLast() }
        return name
    }

    static func parse(_ text: String) -> (description: String, body: String) {
        guard text.hasPrefix("---"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex) else {
            return ("", text)
        }
        let header = text[text.index(text.startIndex, offsetBy: 3)..<end.lowerBound]
        var description = ""
        for line in header.split(separator: "\n") where line.hasPrefix("description:") {
            description = unquote(line.dropFirst("description:".count).trimmingCharacters(in: .whitespaces))
        }
        var body = String(text[end.upperBound...])
        if let newline = body.firstIndex(of: "\n") { body = String(body[body.index(after: newline)...]) }
        return (description, body.trimmingCharacters(in: .newlines))
    }

    /// The file's text. `existing`'s header lines other than the name and description stay.
    static func text(name: String, description: String, body: String, replacing existing: String? = nil) -> String {
        var others: [String] = []
        if let existing, existing.hasPrefix("---"),
           let end = existing.range(of: "\n---", range: existing.index(existing.startIndex, offsetBy: 3)..<existing.endIndex) {
            others = existing[existing.index(existing.startIndex, offsetBy: 3)..<end.lowerBound].split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init).filter { !$0.isEmpty && !$0.hasPrefix("name:") && !$0.hasPrefix("description:") }
        }
        let summary = description.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let header = (["name: \(name)", "description: \(quote(summary))"] + others).joined(separator: "\n")
        return "---\n\(header)\n---\n\n\(body.trimmingCharacters(in: .newlines))\n"
    }

    /// YAML's double quotes, so colons and quotes in it read as text.
    private static func quote(_ text: String) -> String {
        "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private static func unquote(_ text: String) -> String {
        if text.count >= 2, text.hasPrefix("\""), text.hasSuffix("\"") {
            return String(text.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\")
        }
        if text.count >= 2, text.hasPrefix("'"), text.hasSuffix("'") {
            return String(text.dropFirst().dropLast()).replacingOccurrences(of: "''", with: "'")
        }
        return text
    }
}

/// A repository's skills, each with what it says it does, to add or remove.
private struct RepositorySkills: View {
    @Environment(AppModel.self) private var app
    let repository: SkillCollection
    /// Its skills, when they were listed as it was opened.
    let listed: CollectionListing?
    let routes: BoxSkills
    /// One of the well-known collections (for what's counted of adding one).
    let isWellKnown: Bool
    let changed: () -> Void
    let done: () -> Void
    @State private var skills: [CollectionSkill]?
    @State private var isPartial = false
    /// Those added to the box, by name; nil while it couldn't say.
    @State private var installed: [String: SkillSource]?
    /// Why the box couldn't say which are added.
    @State private var installedFailure: String?
    @State private var query = ""
    /// Why the list couldn't be loaded.
    @State private var failure: String?
    /// Why a skill couldn't be added or removed: the list stays.
    @State private var actionFailure: ActionFailure?
    @State private var confirming: CollectionSkill?
    @State private var working: String?

    /// The filter, without the spaces around it.
    private var search: String { query.trimmingCharacters(in: .whitespaces) }

    private var shown: [CollectionSkill] {
        guard let skills else { return [] }
        return search.isEmpty ? skills : skills.filter { $0.path.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        SettingsDetailPage {
            Section {
                LabeledContent("On GitHub") {
                    Link(repository.id, destination: repository.webURL)
                }
            }
            Section {
                if let failure {
                    FailureLabel(title: "Couldn’t load the skills", detail: failure, retrying: "this collection’s skills") {
                        Task {
                            // Read through this Mac's box: started again if it stopped for good.
                            await app.box.startAgain()
                            await list()
                        }
                    }
                } else if skills == nil {
                    Placeholder(.rows(count: 4), label: "Loading skills", fadesOut: false)
                        .padding(.vertical, 6)
                } else {
                    SettingsSearchRow(text: $query, prompt: "Filter skills")
                    if let installedFailure {
                        FailureLabel(title: "Couldn’t read which skills are added", detail: installedFailure, retrying: "which skills are added") {
                            Task { await reload() }
                        }
                    }
                    if shown.isEmpty {
                        Text(search.isEmpty ? "This repository doesn’t have any skills." : "No skills match “\(search)”.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(shown) { skill in
                        RemoteSkillRow(skill: skill, collection: repository, state: state(of: skill)) {
                            confirming = skill
                        } remove: {
                            remove(skill)
                        }
                    }
                }
            } header: {
                Text("Skills")
            } footer: {
                if isPartial {
                    Text("This collection is too big for GitHub to list in full, so some of its skills aren't here.")
                        .foregroundStyle(.secondary)
                }
            }
        } footer: {
            EditorFooter(primary: "Done", onPrimary: done)
        }
        .task {
            await reload()
            if let listed {
                skills = listed.skills
                isPartial = listed.partial
            } else {
                await list()
            }
            #if DEBUG
            // KUVO_DEMO_SKILLS_COLLECTION=<owner/name>|<skill>: that skill added, as Add Skill does.
            if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_SKILLS_COLLECTION"]?.split(separator: "|").dropFirst().first,
               let skill = skills?.first(where: { $0.name == demo }) {
                install(skill)
            }
            #endif
        }
        .alert(actionFailure?.title ?? "", isPresented: Binding(get: { actionFailure != nil }, set: { if !$0 { actionFailure = nil } })) {
            Button("OK") {}
        } message: {
            Text(actionFailure?.message ?? "")
        }
        .confirmationDialog("Add \(confirming?.name ?? "")?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { skill in
            Button("Add Skill") { install(skill) }
            Button("Cancel", role: .cancel) {}
        } message: { skill in
            Text(Self.summary(of: skill, in: repository))
        }
    }

    /// Its files, saying so when some are scripts.
    static func summary(of skill: CollectionSkill, in repository: SkillCollection) -> String {
        let names = skill.files.map { skill.relative($0) }
        let scripts = names.filter { ["sh", "py", "js", "ts", "rb", "pl", "bash", "zsh"].contains(($0 as NSString).pathExtension.lowercased()) }
        var lines = names.prefix(12).map { "• " + $0 }
        if names.count > 12 { lines.append("and \(names.count - 12) more") }
        let note = scripts.isEmpty ? "" : "\n\nIt has \(scripts.count == 1 ? "a script" : "\(scripts.count) scripts") the agent may run."
        return "From \(repository.id):\n\n" + lines.joined(separator: "\n") + note
    }

    private func list() async {
        failure = nil
        do {
            let listing = try await routes.listing(repository.id)
            skills = listing.skills
            isPartial = listing.partial
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Which are added, as the box says now; unknown (no Add or Remove) while it can't say.
    private func reload() async {
        do {
            installed = try await routes.folder().github
            installedFailure = nil
        } catch {
            installed = nil
            installedFailure = error.localizedDescription
        }
        changed()
    }

    /// What a skill's row offers.
    private func state(of skill: CollectionSkill) -> RemoteSkillRow.State {
        if working == skill.id { return .working }
        guard let installed else { return .unknown }
        guard let added = installed[skill.name] else { return .addable }
        return added.repository == repository.id && added.path == skill.path ? .added : .another(added.repository)
    }

    private func remove(_ skill: CollectionSkill) {
        working = skill.id
        let routes = routes
        Task {
            defer { working = nil }
            do {
                try await routes.remove(skill.name)
            } catch {
                actionFailure = ActionFailure(title: "Couldn't Remove the Skill", message: error.localizedDescription)
            }
            await reload()
        }
    }

    private func install(_ skill: CollectionSkill) {
        working = skill.id
        let routes = routes, repository = repository, isWellKnown = isWellKnown
        Task {
            defer { working = nil }
            do {
                try await routes.add(skill, from: repository)
                // The collection by name when it's one of the listed ones, else just that it was another.
                Analytics.shared.track("skill_added", ["collection": isWellKnown ? repository.id : "other"])
                await reload()
            } catch {
                actionFailure = ActionFailure(title: "Couldn't Add the Skill", message: error.localizedDescription)
            }
        }
    }
}

/// What couldn't be done, for its alert.
private struct ActionFailure {
    var title: String
    var message: String
}

/// A skill in a collection, with what its SKILL.md says it is (listed with the collection).
private struct RemoteSkillRow: View {
    enum State {
        case working
        /// The box couldn't say whether it's added.
        case unknown
        case addable
        case added
        /// Another skill by this name is added, from this repository (they'd share a folder).
        case another(String)
    }

    let skill: CollectionSkill
    let collection: SkillCollection
    let state: State
    let add: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.about?.name ?? skill.name)
                Text(skill.about?.description ?? " ")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            Spacer()
            switch state {
            case .working:
                Spinner(size: 16)
            case .unknown:
                EmptyView()
            case .added:
                Button("Remove", action: remove)
                    .accessibilityLabel("Remove \(skill.name)")
            case .another(let repository):
                Text("Another \(skill.name) is added, from \(repository)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            case .addable:
                Button("Add", action: add)
                    .accessibilityLabel("Add \(skill.name)")
            }
        }
    }
}
