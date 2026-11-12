import ClientDesign
import OpenCodeKit
import SwiftUI

// Controls for the engine's settings file (`EngineConfig`). Each reads its value from the file
// and writes it back: toggles and pickers at once, text when you press Return or leave the
// field. An empty field removes the setting, so the engine's default applies.

extension EngineConfig {
    func bool(_ path: [String], default fallback: Bool) -> Binding<Bool> {
        Binding(get: { self.value(at: path)?.bool ?? fallback }, set: { self.set(.bool($0), at: path) })
    }

    /// A string choice; `nil` (the "Default" option) removes the setting.
    func string(_ path: [String]) -> Binding<String?> {
        Binding(get: { self.value(at: path)?.string }, set: { self.set($0.map(JSONValue.string), at: path) })
    }

    /// A list's items as they are, whatever they hold.
    func items(_ path: [String]) -> [JSONValue] {
        value(at: path)?.array ?? []
    }

    func setItems(_ items: [JSONValue], at path: [String]) {
        set(items.isEmpty ? nil : .array(items), at: path)
    }
}

extension EnvironmentValues {
    /// The settings the controls below edit, when it isn't the engine's file: a draft of
    /// something being made (a new agent).
    @Entry var editedConfig: EngineConfig?
    /// Shows one of the settings' computer's folders to choose, for a control deep in a page (a
    /// rule's pattern) on a machine: set by the page that shows the browser. Nil where none can.
    @Entry var chooseBoxFolder: ((@escaping (_ path: String, _ home: String) -> Void) -> Void)?
}

/// A text setting, saved when you press Return or leave the field.
struct ConfigTextField: View {
    let title: String
    let path: [String]
    var prompt = ""
    /// For a few sentences (a description): its name above it, and the field as tall as what's
    /// written in it, so all of it shows.
    var multiline = false
    /// What it's often set to, in a menu beside it (a title, and the value it sets), called
    /// `choicesTitle`; `chose` hears which was picked.
    var choices: [(title: String, value: String)] = []
    var choicesTitle = "Choices"
    var choicesHelp = "What it’s often set to"
    var chose: (String) -> Void = { _ in }
    /// What it shows where the computer has none: its box's own default (Settings › Git's
    /// `kuvo/`). With one, emptied is kept empty (none), not removed.
    var unset: String?
    /// The field alone, its label hidden, for a row or group that names it.
    var bare = false
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.editedConfig) private var edited
    @State private var field = SettingField()
    @FocusState private var isFocused: Bool

    private var config: EngineConfig { edited ?? app.config(for: box) }

    var body: some View {
        if bare {
            text
                .labelsHidden()
        } else if multiline {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                text
                    .labelsHidden()
                    .lineLimit(1...10)
            }
        } else if choices.isEmpty {
            SettingsTextRow(title: title) { text }
        } else {
            SettingsTextRow(title: title) {
                HStack(spacing: 4) {
                    text
                    ChoicesMenu(title: choicesTitle, help: choicesHelp) {
                        ForEach(choices, id: \.value) { choice in
                            Button {
                                field.load(choice.value)
                                config.set(.string(choice.value), at: path)
                                chose(choice.value)
                            } label: {
                                Text(choice.title)
                                Text(choice.value)
                            }
                        }
                    }
                }
            }
        }
    }

    private var text: some View {
        let stored = config.value(at: path)?.string ?? unset ?? ""
        return TextField(title, text: $field.text, prompt: Text(prompt), axis: multiline ? .vertical : .horizontal)
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { if !isFocused { commit() } }
            // A draft keeps up with every key: there's no file to write, and its Create can come
            // before you leave the field.
            .onChange(of: field.text) { if config.isDraft { commit() } }
            .onAppear { field.load(stored) }
            .onChange(of: stored) { if !isFocused { field.load(stored) } }
            .onDisappear(perform: commit)
    }

    private func commit() {
        guard let value = field.edit(trimming: true) else { return }
        config.set(value.isEmpty && unset == nil ? nil : .string(value), at: path)
    }
}

/// A whole-number setting, more than zero; empty means the engine's default.
struct ConfigNumberField: View {
    let title: String
    let path: [String]
    var prompt = "Default"
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.editedConfig) private var edited
    @State private var field = SettingField()
    @FocusState private var isFocused: Bool

    private var config: EngineConfig { edited ?? app.config(for: box) }

    var body: some View {
        let stored = config.value(at: path)?.int.map(String.init) ?? ""
        SettingsTextRow(title: title) { numberField(stored) }
    }

    private func numberField(_ stored: String) -> some View {
        TextField(title, text: $field.text, prompt: Text(prompt))
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { if !isFocused { commit() } }
            .onChange(of: field.text) { if config.isDraft, isFocused { commit() } }
            .onAppear { field.load(stored) }
            .onChange(of: stored) { if !isFocused { field.load(stored) } }
            .onDisappear(perform: commit)
    }

    private func commit() {
        // Digits only; zero isn't a setting the engine takes, so it means the default.
        let number = Int(field.text.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil }
        field.text = number.map(String.init) ?? ""
        guard field.edit(trimming: true) != nil else { return }
        config.set(number.map { .number(Double($0)) }, at: path)
    }
}

/// Longer text, like an agent's instructions: saved when you leave it. Monospaced, like a
/// skill's instructions, and on the group's own background: the group is the text area.
struct ConfigTextEditor: View {
    let path: [String]
    var minHeight: CGFloat = 120
    /// Grey words in it while it's empty, like a text field's.
    var prompt = ""
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.editedConfig) private var edited
    @State private var field = SettingField()
    @FocusState private var isFocused: Bool

    private var config: EngineConfig { edited ?? app.config(for: box) }

    var body: some View {
        let stored = config.value(at: path)?.string ?? ""
        TextEditor(text: $field.text)
            .font(.system(.body, design: .monospaced))
            .scrollContentBackground(.hidden)
            .frame(minHeight: minHeight)
            .overlay(alignment: .topLeading) {
                if field.text.isEmpty, !prompt.isEmpty {
                    // Where the editor's first line starts.
                    Text(prompt)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                }
            }
            .focused($isFocused)
            .onChange(of: isFocused) { if !isFocused { commit() } }
            .onChange(of: field.text) { if config.isDraft { commit() } }
            .onAppear { field.load(stored) }
            .onChange(of: stored) { if !isFocused { field.load(stored) } }
            .onDisappear(perform: commit)
    }

    private func commit() {
        guard let value = field.edit(trimming: true) else { return }
        config.set(value.isEmpty ? nil : .string(value), at: path)
    }
}

/// A field's text and what the file had when it was shown. Only a change you made is
/// saved: leaving a field you didn't touch writes nothing (so it can't bring back an entry
/// you just removed, or undo an edit made to the file elsewhere).
struct SettingField {
    var text = ""
    private var loaded = ""

    mutating func load(_ value: String) {
        text = value
        loaded = value
    }

    /// The text to save, if you changed it; it counts as saved from then on.
    mutating func edit(trimming: Bool) -> String? {
        let value = trimming ? text.trimmingCharacters(in: .whitespacesAndNewlines) : text
        guard value != loaded else { return nil }
        loaded = value
        return value
    }
}

/// A model setting, as "provider/model"; Default removes it.
struct ConfigModelPicker: View {
    let title: String
    let path: [String]
    var defaultTitle = "Default"
    /// Your coding agents' accounts' models too (Claude Code's, Codex's…), first, as the composer's
    /// picker lists them: for a setting those agents read as well.
    var withAgents = false
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @Environment(\.editedConfig) private var edited

    private var config: EngineConfig { edited ?? app.config(for: box) }

    var body: some View {
        LabeledContent(title) { picker.labelsHidden().fixedSize() }
    }

    private var picker: some View {
        Picker(title, selection: config.string(path)) {
            Text(defaultTitle).tag(String?.none)
            if withAgents {
                ForEach(catalog.pickerProviders(.all).filter { !$0.models.isEmpty }) { provider in
                    Section(provider.name) {
                        ForEach(provider.models) { model in
                            Text(model.name).tag(Optional("\(model.providerID)/\(model.id)"))
                        }
                    }
                }
            } else {
                ForEach(catalog.modelsByProvider, id: \.provider) { group in
                    Section(group.provider) {
                        ForEach(group.models) { model in
                            Text(model.name).tag(Optional("\(model.providerID)/\(model.id)"))
                        }
                    }
                }
            }
            // One set by hand, or one the pickers don't offer (its account isn't connected here),
            // as it's written.
            if let current = config.value(at: path)?.string,
               !catalog.offered.contains(where: { "\($0.providerID)/\($0.id)" == current }) {
                Text(current).tag(Optional(current))
            }
        }
    }
}

/// A list of strings (paths, patterns, packages): each removable, a field to add one. Items
/// that aren't plain strings (set up by hand) are kept as they are and shown as such.
struct ConfigStringList: View {
    let path: [String]
    let prompt: String
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var newItem = ""

    var body: some View {
        let value = app.config(for: box).value(at: path)
        if let value, value.array == nil {
            Text("Set up by hand in the settings file.")
                .foregroundStyle(.secondary)
        } else {
            let items = app.config(for: box).items(path)
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack {
                    Text(item.string ?? item["package"]?.string ?? "Set up in the settings file")
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .foregroundStyle(item.string == nil ? .secondary : .primary)
                    Spacer()
                    Button {
                        var items = items
                        items.remove(at: index)
                        app.config(for: box).setItems(items, at: path)
                    } label: {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(RemoveButtonStyle())
                    .accessibilityLabel("Remove")
                    .help("Remove")
                }
            }
            TextField("Add", text: $newItem, prompt: Text(prompt))
                .labelsHidden()
                .onSubmit {
                    let item = newItem.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !item.isEmpty, !items.contains(.string(item)) else { return }
                    app.config(for: box).setItems(items + [.string(item)], at: path)
                    newItem = ""
                }
        }
    }
}

/// Names and values (environment variables, headers): each value editable in place and each
/// removable, a row to add one. A name and value typed in the last row are added on Return,
/// with Add, or when the list goes away (a sheet's Done).
struct ConfigKeyValueList: View {
    let path: [String]
    var keyPrompt = "Name"
    var valuePrompt = "Value"
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var newKey = ""
    @State private var newValue = ""
    /// The kind of what the list is in (an MCP server's "local" or "remote") as it appeared: one
    /// switched since has put these aside, and what a row still holds isn't written into the other.
    @State private var kind: JSONValue?

    private var kindNow: JSONValue? { app.config(for: box).value(at: Array(path.dropLast()) + ["type"]) }

    /// The names' column, the same in every row so the values line up.
    static let keyWidth: CGFloat = 210

    var body: some View {
        let items = (app.config(for: box).value(at: path)?.object ?? [:]).compactMapValues(\.string).sorted { $0.key < $1.key }
        ForEach(items, id: \.key) { item in
            KeyValueRow(key: item.key, value: item.value, prompt: valuePrompt) { value in
                guard kindNow == kind else { return }
                app.config(for: box).set(.string(value), at: path + [item.key])
            } remove: {
                app.config(for: box).set(nil, at: path + [item.key])
            }
        }
        HStack {
            TextField(keyPrompt, text: $newKey, prompt: Text(keyPrompt))
                .labelsHidden()
                .fontDesign(.monospaced)
                .frame(width: Self.keyWidth)
                .onSubmit(add)
            TextField(valuePrompt, text: $newValue, prompt: Text(valuePrompt))
                .labelsHidden()
                .onSubmit(add)
            Button("Add", action: add)
                .disabled(newKey.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .onAppear { kind = kindNow }
        .onDisappear(perform: add)
    }

    private func add() {
        let key = newKey.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, kindNow == kind else { return }
        app.config(for: box).set(.string(newValue), at: path + [key])
        newKey = ""
        newValue = ""
    }
}

/// One name and its value. The value is saved when you press Return or leave the field. Values
/// are often secrets, so one that isn't a reference to an environment variable ({env:NAME})
/// shows as dots until you click into it.
private struct KeyValueRow: View {
    let key: String
    let value: String
    let prompt: String
    let change: (String) -> Void
    let remove: () -> Void
    @State private var field = SettingField()
    @FocusState private var isFocused: Bool

    private var isMasked: Bool {
        !isFocused && !field.text.isEmpty && !field.text.hasPrefix("{env:")
    }

    var body: some View {
        HStack {
            Text(key)
                .fontDesign(.monospaced)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(key)
                .frame(width: ConfigKeyValueList.keyWidth, alignment: .leading)
            TextField(prompt, text: Binding(
                get: { isMasked ? "••••••••" : field.text },
                set: { if !isMasked { field.text = $0 } }
            ), prompt: Text(prompt))
            .labelsHidden()
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { if !isFocused { commit() } }
            .onAppear { field.load(value) }
            .onChange(of: value) { if !isFocused { field.load(value) } }
            .onDisappear(perform: commit)
            Button {
                // Drop what was typed first, so going away doesn't save it back.
                field.load(value)
                remove()
            } label: {
                Image(systemName: "minus.circle.fill")
            }
            .buttonStyle(RemoveButtonStyle())
            .accessibilityLabel("Remove")
            .help("Remove")
        }
    }

    private func commit() {
        guard let edited = field.edit(trimming: false) else { return }
        change(edited)
    }
}

/// When the settings file can't be used: why, and a way to open it; and a machine's change that
/// didn't get there.
struct ConfigProblem: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box

    var body: some View {
        let config = app.config(for: box)
        if let problem = config.problem {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(config.file != nil ? "The engine's settings file can't be changed here" : "\(app.name(of: box))’s settings can't be changed here")
                        Text(problem).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
                HStack {
                    if let file = config.file {
                        Button("Open Settings File") { NSWorkspace.shared.open(file) }
                    }
                    Button("Try Again") { config.reload() }
                }
            }
        } else if let failure = config.notSaved {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Your last change didn’t reach \(app.name(of: box))")
                        Text(failure).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }
        }
    }
}

/// A page of settings: its sections as groups on the page's card, lined up with its title, that
/// opens at its top.
struct ScrollingSettingsForm<Content: View>: View {
    @ViewBuilder var content: Content
    @State private var position = ScrollPosition(edge: .top)
    @Environment(\.settingsInset) private var inset

    var body: some View {
        ScrollView {
            SettingsGroups { content }
                .padding(.horizontal, inset)
                .padding(.top, 18)
                .padding(.bottom, 28)
        }
        .scrollPosition($position)
        .scrollBounceBehavior(.basedOnSize)
        // A row scrolled to the page's edge fades there, rather than being sliced in half.
        .fadingScrollEdges()
        #if DEBUG
        // KUVO_DEMO_SETTINGS_SCROLL=bottom: scrolled to its end once it's filled, for a look at
        // what's below the fold without scrolling the window.
        .task {
            guard ProcessInfo.processInfo.environment["KUVO_DEMO_SETTINGS_SCROLL"] == "bottom" else { return }
            try? await Task.sleep(for: .seconds(6))
            position.scrollTo(edge: .bottom)
        }
        #endif
    }
}

/// Sections as Settings draws them: each a heading over one quiet group of rows, the rows split by
/// hairlines, and its footer under it, with the same room between every section. Toggles and
/// labeled rows put their title on the left (and a line under it, in secondary text) and their
/// control on the right; text fields with a title get it the same way (see `SettingsTextRow`).
struct SettingsGroups<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: SettingsMetrics.sectionSpacing) {
            ForEach(sections: content) { section in
                if !section.content.isEmpty || !section.header.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        if !section.header.isEmpty {
                            section.header
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.primary)
                                .textCase(nil)
                                .padding(.horizontal, SettingsMetrics.rowPadding)
                        }
                        if !section.content.isEmpty {
                            SettingsGroupBox { section.content }
                        }
                        if !section.footer.isEmpty {
                            section.footer
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .settingsText()
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, SettingsMetrics.rowPadding)
                                .padding(.top, -2)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .toggleStyle(SettingsToggleStyle())
        .labeledContentStyle(SettingsLabeledStyle())
        .textFieldStyle(.plain)
        .pickerStyle(.menu)
    }
}

/// One group of rows: a quiet fill a step off the card, hairlines between its rows.
private struct SettingsGroupBox<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group(subviews: content) { rows in
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    row
                        .frame(maxWidth: .infinity, minHeight: SettingsMetrics.rowHeight - 2 * SettingsMetrics.rowVerticalPadding, alignment: .leading)
                        .padding(.horizontal, SettingsMetrics.rowPadding)
                        .padding(.vertical, SettingsMetrics.rowVerticalPadding)
                        .overlay(alignment: .top) {
                            if row.id != rows.first?.id {
                                Rectangle()
                                    .fill(Surface.hairline(scheme))
                                    .frame(height: 1)
                                    .padding(.horizontal, SettingsMetrics.rowPadding)
                            }
                        }
                }
            }
        }
        .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
    }
}

extension View {
    /// Text in Settings: its secondary and tertiary levels a step brighter than the system's, so
    /// descriptions read at 4.5:1 or better on a group in either mode. Only for text: controls
    /// draw their fills from these levels, and turned pale under it.
    func settingsText() -> some View {
        modifier(SettingsTextInk())
    }
}

private struct SettingsTextInk: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.foregroundStyle(.primary, SettingsMetrics.secondaryInk(scheme), SettingsMetrics.tertiaryInk(scheme))
    }
}

/// A setting's title, and the line under it in secondary text: what a toggle's or a labeled row's
/// label holds, as its first text and the rest. A disabled one stays readable.
struct SettingsRowLabel<Label: View>: View {
    let label: Label
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Group(subviews: label) { parts in
            VStack(alignment: .leading, spacing: 3) {
                if let title = parts.first {
                    title
                        .font(.system(size: 13))
                        .foregroundStyle(.primary)
                }
                ForEach(parts.dropFirst()) { line in
                    line
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .settingsText()
        }
        .opacity(isEnabled ? 1 : 0.6)
    }
}

/// A toggle as a settings row: its title on the left, a switch on the right.
struct SettingsToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        SettingsRowLayout {
            SettingsRowLabel(label: configuration.label)
            Toggle("", isOn: configuration.$isOn)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
        }
        .contentShape(.rect)
    }
}

/// A labeled row: its title on the left, what it holds (a button, a menu, a value) on the right.
struct SettingsLabeledStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        SettingsRowLayout {
            SettingsRowLabel(label: configuration.label)
            configuration.content
        }
    }
}

/// A row's title and its control: side by side, the control at the trailing edge at its own
/// width; in a window too narrow to leave the title room beside it, the control goes under the
/// title instead of squeezing it (or itself) into a column of single words.
struct SettingsRowLayout: Layout {
    /// The least the title keeps beside the control before the control goes under it.
    var titleRoom: CGFloat = 150
    var spacing: CGFloat = 16

    private func control(_ subviews: Subviews, width: CGFloat) -> CGSize {
        let ideal = subviews[1].sizeThatFits(.unspecified)
        return subviews[1].sizeThatFits(ProposedViewSize(width: min(ideal.width, width), height: nil))
    }

    private func isSideBySide(_ subviews: Subviews, width: CGFloat) -> Bool {
        width - subviews[1].sizeThatFits(.unspecified).width - spacing >= titleRoom
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        // A title with nothing beside it (a control that's only there sometimes).
        if subviews.count == 1 {
            let title = subviews[0].sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
            return CGSize(width: proposal.width ?? title.width, height: title.height)
        }
        guard subviews.count == 2 else { return .zero }
        let width = proposal.width ?? 10_000
        let control = control(subviews, width: width)
        if isSideBySide(subviews, width: width) {
            let title = subviews[0].sizeThatFits(ProposedViewSize(width: width - control.width - spacing, height: nil))
            return CGSize(width: proposal.width ?? title.width + spacing + control.width, height: max(title.height, control.height))
        }
        let title = subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: proposal.width ?? max(title.width, control.width), height: title.height + 8 + control.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        if subviews.count == 1 {
            subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
            return
        }
        guard subviews.count == 2 else { return }
        let control = control(subviews, width: bounds.width)
        if isSideBySide(subviews, width: bounds.width) {
            let titleWidth = bounds.width - control.width - spacing
            let title = subviews[0].sizeThatFits(ProposedViewSize(width: titleWidth, height: nil))
            subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY - title.height / 2), proposal: ProposedViewSize(width: titleWidth, height: title.height))
            subviews[1].place(at: CGPoint(x: bounds.maxX - control.width, y: bounds.midY - control.height / 2), proposal: ProposedViewSize(control))
        } else {
            let title = subviews[0].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: title.height))
            subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + title.height + 8), proposal: ProposedViewSize(control))
        }
    }
}

/// A text setting with its title, as a row: the title (and a line under it) on the left, the
/// field on the right in a well of its own, so it reads as a place to type.
struct SettingsTextRow<Field: View, Label: View>: View {
    @ViewBuilder var field: Field
    @ViewBuilder var label: Label
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        LabeledContent {
            field
                .labelsHidden()
                .settingsFieldWell()
                .frame(minWidth: 160, idealWidth: 260, maxWidth: 300)
        } label: {
            label
        }
    }
}

extension View {
    /// A one-line text field in a row: in a well a step below its group, so it reads as a place
    /// to type beside the row's title. (A text area is the group itself, with no well.)
    func settingsFieldWell(padding: CGFloat = 5) -> some View {
        modifier(SettingsFieldWell(padding: padding))
    }
}

private struct SettingsFieldWell: ViewModifier {
    let padding: CGFloat
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .focusEffectDisabled()
            .padding(.horizontal, 8)
            .padding(.vertical, padding)
            .background(Surface.well(scheme), in: .rect(cornerRadius: 6))
    }
}

extension SettingsTextRow where Label == Text {
    init(title: String, @ViewBuilder field: () -> Field) {
        self.init(field: field) { Text(title) }
    }
}

/// Signing in to something from a Settings page (an MCP server, a web search service), in the
/// page's place: the same steps as in Accounts, under the service's mark, with the page's way
/// back as the way out.
struct ConnectDetail: View {
    let integrationID: String
    var name: String? = nil
    var symbol: String? = nil
    /// What the last step says the connection gives you.
    var note = "Its models are now in the model picker."
    var highlights: [ConnectView.Highlight] = []
    let done: () -> Void

    var body: some View {
        ConnectView(integrationID: integrationID, name: name, symbol: symbol, connectedNote: note, highlights: highlights, onDone: done)
    }
}

/// The engine's MCP servers and how each is doing, for a page that shows them (MCP Servers,
/// Integrations): read again a moment after the settings change, as the engine picks up the
/// file, and every few seconds while it's open, as servers connect in their own time.
struct LiveMCPServers<Change: Equatable>: ViewModifier {
    @Binding var servers: [MCPServer]
    /// The engine as it is each time (it restarts to take a new key).
    let api: () -> OpenCodeAPI?
    /// What, changing, means the engine's settings did.
    let change: Change

    func body(content: Content) -> some View {
        content
            .task(id: change) { servers = await MCPStatus.read(api()) ?? [] }
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3))
                    if let read = try? await api()?.mcpServers() { servers = read }
                }
            }
    }

}

enum MCPStatus {
    /// The engine's MCP servers, after a moment for it to pick up a change to its settings.
    static func read(_ api: OpenCodeAPI?) async -> [MCPServer]? {
        try? await Task.sleep(for: .milliseconds(400))
        return try? await api?.mcpServers()
    }
}

/// The buttons along the bottom of an editor a Settings page opens in its place (an agent, a
/// command, an MCP server, a provider). Making one: Cancel and the button that makes it. Editing
/// one, which is saved as you go: Done, the way back; and its Remove or Delete at the leading edge.
struct SettingsEditorButtons: View {
    /// What makes a new one ("Create Agent"); nil while editing one.
    let create: String?
    var canCreate = true
    var onCreate: () -> Void = {}
    /// Deletes the one being edited ("Delete Agent…"), when it can be.
    var remove: String?
    var onRemove: () -> Void = {}
    let done: () -> Void

    var body: some View {
        EditorFooter(primary: create ?? "Done", canDoPrimary: create == nil || canCreate, onPrimary: create == nil ? done : onCreate, onCancel: create == nil ? nil : done) {
            if create == nil, let remove {
                EditorFooterRemove(title: remove, action: onRemove)
            }
        }
    }
}

/// An integration, by its ID, for a sign-in; with what you know it as, when that's another name.
struct IntegrationRef: Identifiable {
    let id: String
    var service: Integrations.Service? = nil
}

/// A search field as a row of a settings group: a magnifying glass, the text, and a clear button.
struct SettingsSearchRow: View {
    @Binding var text: String
    let prompt: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(prompt, text: $text, prompt: Text(prompt))
                .textFieldStyle(.plain)
                .labelsHidden()
                .multilineTextAlignment(.leading)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(ClearFieldButtonStyle())
                .accessibilityLabel("Clear")
                .help("Clear")
            }
        }
    }
}

/// What a field is often set to, in a menu beside it: its title and the app's chevron, so it
/// reads as a menu and has room to click.
struct ChoicesMenu<Items: View>: View {
    let title: String
    let help: String
    @ViewBuilder let items: Items

    var body: some View {
        Menu {
            items
        } label: {
            HStack(spacing: 4) {
                Text(title)
                MenuChevron()
            }
        }
        .menuStyle(.button)
        .buttonStyle(.glass)
        // Its own chevron, not the system's beside it too.
        .menuIndicator(.hidden)
        .fixedSize()
        .help(help)
    }
}
