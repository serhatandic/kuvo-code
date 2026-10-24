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
    /// GitHub's well-known collections; nil until they're listed.
    @State private var collections: [SkillCollection]?
    @State private var collectionsFailure: String?
    @State private var browsing: Browsing?
    @State private var repositoryName = ""
    /// While a repository typed by name is being looked up on GitHub.
    @State private var isOpening = false
    @State private var failure: String?
    /// The skill being written or changed: a new one has no name yet.
    @State private var writing: SkillDraft?
    /// What the list is narrowed to.
    @State private var search = ""

    private var config: EngineConfig { app.config(for: box) }
    private var routes: BoxSkills { BoxSkills(box: app.box(box.id), library: app.box(BoxClient.mac)) }

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
                    Spinner(size: 16)
                        .frame(maxWidth: .infinity)
                } else if skills?.isEmpty == true {
                    Text("None yet.")
                        .foregroundStyle(.secondary)
                } else if (skills?.count ?? 0) > 6 {
                    SettingsSearchRow(text: $search, prompt: "Search skills")
                }
                if let boxFailure {
                    FailureLabel(title: "Couldn’t read the skills added here", detail: boxFailure) {
                        Task {
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
                                    .lineLimit(2)
                                    .help(description)
                            }
                        }
                        .settingsText()
                        HStack {
                            if here.isYours(skill) {
                                // Deleting one you wrote is in its editor, behind a confirmation.
                                Button("Edit…") { writing = SkillDraft(name: skill.id) }
                            }
                            if here.github[skill.id] != nil {
                                // From GitHub, so it can be added back.
                                Button("Remove") { remove(skill.id) }
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
                    FailureLabel(title: "Couldn’t list the collections", detail: collectionsFailure) {
                        Task { await listCollections() }
                    }
                } else if collections == nil {
                    Spinner(size: 16)
                        .frame(maxWidth: .infinity)
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
        .task { await listCollections() }
        // Again once its engine answers (a machine's, connecting as the page opened).
        .task(id: app.isReady(box)) { if app.isReady(box) { await refresh() } }
        .settingsDetail(item: $writing, title: { $0.name ?? "New Skill" }) { draft in
            SkillEditor(name: draft.name, routes: routes, folder: box.machine == nil ? here.folder : nil, taken: Set((skills ?? []).map(\.id))) {
                writing = nil
                Task { await refresh() }
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
            boxFailure = error.localizedDescription
        }
        // The engine notices a new folder within a moment.
        try? await Task.sleep(for: .milliseconds(500))
        skills = ((try? await app.api(for: box)?.skills()) ?? []).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func listCollections() async {
        collectionsFailure = nil
        do {
            collections = try await routes.collections()
        } catch {
            collectionsFailure = error.localizedDescription
        }
    }

    /// Off is a rule that denies the skill; turning it on takes that rule out, and leaves any
    /// other rule for it alone.
    private func isOn(_ id: String) -> Binding<Bool> {
        Binding {
            !config.items(["permissions"]).compactMap(\.rule).contains { $0.action == "skill" && $0.resource == id && $0.effect == .deny }
        } set: { on in
            var items = config.items(["permissions"]).filter { item in
                guard let rule = item.rule else { return true }
                return !(rule.action == "skill" && rule.resource == id && rule.effect == .deny)
            }
            if !on { items.append(PermissionRule(action: "skill", resource: id, effect: .deny).json) }
            config.setItems(items, at: ["permissions"])
        }
    }

    private func remove(_ id: String) {
        let routes = routes
        Task {
            try? await routes.remove(id)
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

/// Why something couldn't be read, with a way to try again.
private struct FailureLabel: View {
    let title: String
    let detail: String
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
        if !id.isEmpty, isTaken { return ("There's a skill called \(id) already.", true) }
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
            Text("Its folder, with anything else in it, is put away in Kuvo Code’s trash for 30 days.")
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
            failure = "There's a skill called \(id) already."
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
    @State private var installed: [String: SkillSource] = [:]
    @State private var query = ""
    /// Why the list couldn't be loaded.
    @State private var failure: String?
    /// Why a skill couldn't be added: the list stays.
    @State private var installFailure: String?
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
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Couldn’t load the skills")
                            Text(failure)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                    }
                } else if skills == nil {
                    HStack {
                        Spacer()
                        Spinner(size: 20)
                        Spacer()
                    }
                    .padding(.vertical, 16)
                } else {
                    SettingsSearchRow(text: $query, prompt: "Filter skills")
                    if shown.isEmpty {
                        Text(search.isEmpty ? "This repository doesn’t have any skills." : "No skills match “\(search)”.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(shown) { skill in
                        RemoteSkillRow(skill: skill, collection: repository, routes: routes, installed: installed[skill.name], isWorking: working == skill.id) {
                            confirming = skill
                        } remove: {
                            let routes = routes
                            Task {
                                try? await routes.remove(skill.name)
                                await reload()
                            }
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
            do {
                let listing = if let listed { listed } else { try await routes.listing(repository.id) }
                skills = listing.skills
                isPartial = listing.partial
            } catch {
                failure = error.localizedDescription
            }
        }
        .alert("Couldn't Add the Skill", isPresented: Binding(get: { installFailure != nil }, set: { if !$0 { installFailure = nil } })) {
            Button("OK") {}
        } message: {
            Text(installFailure ?? "")
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

    private func reload() async {
        installed = (try? await routes.folder().github) ?? installed
        changed()
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
                installFailure = error.localizedDescription
            }
        }
    }
}

private struct RemoteSkillRow: View {
    let skill: CollectionSkill
    let collection: SkillCollection
    let routes: BoxSkills
    /// The skill installed under this one's name, from wherever it came.
    let installed: SkillSource?
    let isWorking: Bool
    let add: () -> Void
    let remove: () -> Void
    @State private var about: SkillAbout?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(about?.name ?? skill.name)
                Text(about?.description ?? " ")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            Spacer()
            if isWorking {
                Spinner(size: 16)
            } else if let installed {
                if installed.repository == collection.id, installed.path == skill.path {
                    Button("Remove", action: remove)
                        .accessibilityLabel("Remove \(skill.name)")
                } else {
                    // Another skill by this name is installed (they'd share a folder).
                    Text("Another \(skill.name) is added, from \(installed.repository)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            } else {
                Button("Add", action: add)
                    .accessibilityLabel("Add \(skill.name)")
            }
        }
        .task { about = await routes.about(skill, in: collection) }
    }
}
