import AppKit
import ClientChanges
import ClientDesign
import OpenCodeKit
import SwiftUI

/// The agent wants to do something that needs your OK.
struct PermissionCard: View {
    let request: PermissionRequest
    /// For a command: the whole command line, pipes and all, which the request names in parts.
    var command: String?
    let directory: String
    let reply: (PermissionRequest.Decision) -> Void
    @Environment(\.takesCardKeys) private var takesKeys
    /// Files whose changes you asked to see all of.
    @State private var shownWhole: Set<String> = []
    /// A file's lines shown before Show All: enough to read, not so many that a huge new file
    /// holds the window up.
    private static let linesShown = 400

    var body: some View {
        // Read from its metadata once a drawing, not for each use.
        let diffs = request.diffs
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(.orange)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                    if let message = request.message {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // All that Allow allows: every file's changes, the whole command, scrolling when long.
            if !diffs.isEmpty {
                // Each file's changes, made as they scroll into view; a long one's rest a click
                // away, so nothing Allow allows is out of reach.
                AllowedWell(maxHeight: 360) {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(diffs) { diff in
                            let whole = shownWhole.contains(diff.id)
                            DiffView(diff: diff, title: relative(diff.file), maxLines: whole ? .max : Self.linesShown)
                            if !whole, DiffParser.file(from: diff, directory: directory).lines.count > Self.linesShown {
                                Button("Show All") { shownWhole.insert(diff.id) }
                                    .buttonStyle(TextButtonStyle())
                            }
                        }
                    }
                }
            } else if !request.resources.isEmpty {
                AllowedWell(maxHeight: 180) {
                    Text(command ?? request.resources.map(relative).joined(separator: "\n"))
                        .transcriptCodeFont()
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Sunk in like a code block, as it's paths and commands.
                .recessedWell(RoundedRectangle(cornerRadius: 10))
            }

            HStack(spacing: 8) {
                // The same words as the sandbox's card, so the two read as one family.
                Button("Don’t Allow", role: .cancel) { reply(.reject) }
                    .keyboardShortcut(takesKeys ? .cancelAction : nil)
                Spacer()
                Button("Always for This") { reply(.always) }
                    .help(alwaysHelp)
                Button("Allow Once") { reply(.once) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
        }
        .padding(16)
    }

    private var subject: String {
        guard let first = request.resources.first.map(relative) else { return "this" }
        let more = request.resources.count - 1
        return more == 0 ? first : "\(first) and \(more) more"
    }

    private var title: String {
        switch request.action {
        case "edit", "patch": "Allow editing \(subject)?"
        case "write": "Allow writing \(subject)?"
        case "read": "Allow reading \(subject)?"
        case "shell": request.resources.count > 1 && command == nil ? "Allow running these commands?" : "Allow running this command?"
        case "external_directory": "Allow working outside the project?"
        case "subagent": "Allow starting the \(subject) agent?"
        case "webfetch": "Allow fetching \(subject)?"
        default: "Allow \(request.action.replacingOccurrences(of: "_", with: " "))?"
        }
    }

    private var symbol: String {
        switch request.action {
        case "edit", "patch", "write": "pencil.circle.fill"
        case "shell": "terminal.fill"
        case "external_directory": "folder.badge.questionmark"
        default: "hand.raised.fill"
        }
    }

    private var alwaysHelp: String {
        let patterns = request.save ?? request.resources
        guard !patterns.isEmpty, patterns != ["*"] else {
            // Everything of its kind, which "*" doesn't say.
            let kind = switch request.action {
            case "edit", "patch", "write": "changes to any file"
            case "shell": "any command"
            case "webfetch": "any address"
            default: "this"
            }
            return "Don't ask again for \(kind) in this project"
        }
        return "Don't ask again for: " + patterns.joined(separator: ", ")
    }

    private func relative(_ path: String) -> String {
        let directory = RemoteFolder.parse(directory)?.path ?? directory
        let base = directory.hasSuffix("/") ? directory : directory + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}

/// The agent asked you something (its question tool), or a tool needs details.
struct QuestionCard: View {
    let form: FormRequest
    /// Your answers so far, kept with the session while you look elsewhere.
    @Binding var progress: QuestionProgress
    /// Keys go to it (numbers pick, typing writes): the first of the questions only.
    var takesKeys = true
    let submit: (FormAnswer) -> Void
    let dismiss: () -> Void

    var body: some View {
        if form.isQuestion, !form.fields.isEmpty, form.fields.allSatisfy(Self.isChoiceOrWords) {
            QuestionPager(form: form, progress: $progress, takesKeys: takesKeys, submit: submit, dismiss: dismiss)
        } else {
            FormCard(form: form, submit: submit, dismiss: dismiss)
        }
    }

    /// A question answered with a choice (or a few) or in words, which the pager shows.
    static func isChoiceOrWords(_ field: FormField) -> Bool {
        switch field.kind {
        case .string(_, _, _, _, let format, _): format != "password"
        case .multiselect: true
        default: false
        }
    }
}

/// The agent's questions, one at a time: the question, its choices, numbered (a number key
/// picks one), and a line to write your own (typing goes there). A choice goes on to the next
/// question; Skip leaves one unanswered; × dismisses them all.
private struct QuestionPager: View {
    let form: FormRequest
    @Binding var progress: QuestionProgress
    let takesKeys: Bool
    let submit: (FormAnswer) -> Void
    let dismiss: () -> Void

    @Environment(\.cardRoom) private var room
    @Environment(\.isEnabled) private var isEnabled
    private var answers: FormAnswer {
        get { progress.answers }
        nonmutating set { progress.answers = newValue }
    }
    /// What you wrote yourself, by question.
    private var written: [String: String] {
        get { progress.written }
        nonmutating set { progress.written = newValue }
    }
    private var page: Int {
        get { progress.page }
        nonmutating set { progress.page = newValue }
    }
    @State private var choicesHeight: CGFloat = 0
    @FocusState private var isWriting: Bool
    @State private var monitor: Any?
    @State private var windowBox = WindowBox()

    private var questions: [FormField] {
        form.fields.filter { !$0.isHidden && $0.isActive(given: answers) }
    }

    private var index: Int { min(page, max(questions.count - 1, 0)) }
    private var isLast: Bool { index >= questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if questions.indices.contains(index) {
                let field = questions[index]
                header(field)
                Text(field.description ?? field.title ?? form.title)
                    .font(.system(size: 14))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if !options(of: field).isEmpty {
                    // As tall as they are, up to the room there is; then they scroll.
                    ScrollView {
                        choices(field)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { choicesHeight = $0 }
                    }
                    .frame(height: min(max(choicesHeight, 1), room))
                    .scrollBounceBehavior(.basedOnSize)
                    // The rows' fill reaches out past the column, so their numbers line up
                    // with the question above.
                    .padding(.horizontal, -ChoiceRow.inset)
                }
                footer(field)
            }
        }
        .padding(16)
        .background(WindowReader(box: windowBox))
        .onDisappear {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
        .animation(.ui, value: index)
        // Greyed out (its machine away, Settings over it): keys aren't its.
        .onChange(of: isEnabled, initial: true) { _, enabled in windowBox.isEnabled = enabled }
        // Keys go to the first question only: this one, once the ones before it are answered.
        .onChange(of: takesKeys, initial: true) { _, takes in
            if takes {
                monitor = monitor ?? NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in key(event) ? nil : event }
            } else if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }
        .onAppear {
            if !progress.isStarted {
                progress = QuestionProgress(answers: FormFieldsView.defaults(for: form.fields), isStarted: true)
            }

            #if DEBUG
            // KUVO_DEMO_QUESTIONS=<n>: on the nth question (from 0).
            if let n = Int(ProcessInfo.processInfo.environment["KUVO_DEMO_QUESTIONS"] ?? "") { page = n }
            #endif
        }
    }

    private func header(_ field: FormField) -> some View {
        HStack(spacing: 6) {
            // The question tool's short header, when it has one.
            Text(field.description != nil ? field.title ?? "Question" : "Question")
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            if questions.count > 1 {
                Button { page = index - 1 } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
                    .help("Previous Question")
                Text("\(index + 1) of \(questions.count)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Button { page = index + 1 } label: { Image(systemName: "chevron.right") }
                    .disabled(isLast)
                    .help("Next Question")
            }
            Button(action: dismiss) { Image(systemName: "xmark") }
                .help("Dismiss: the agent carries on without your answers")
                .padding(.leading, 4)
        }
        .font(.callout)
        .buttonStyle(IconButtonStyle())
    }

    private func choices(_ field: FormField) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(options(of: field).enumerated()), id: \.element.id) { number, option in
                ChoiceRow(
                    number: number + 1,
                    option: option,
                    isSelected: isSelected(option, in: field),
                    isMultiple: isMultiple(field)
                ) { pick(option, in: field) }
            }
        }
    }

    private func footer(_ field: FormField) -> some View {
        HStack(spacing: 8) {
            if allowsWords(field) {
                Image(systemName: "pencil")
                    .foregroundStyle(.secondary)
                TextField(options(of: field).isEmpty ? "Write your answer" : "Or write your own response", text: Binding(
                    get: { written[field.key] ?? "" },
                    set: { written[field.key] = $0 }
                ), axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .focused($isWriting)
                // Focusing a field selects what's in it, and the next key would replace what
                // was typed to get there: the cursor goes after it.
                .onChange(of: isWriting) { _, writing in
                    guard writing else { return }
                    DispatchQueue.main.async {
                        guard let editor = windowBox.window?.firstResponder as? NSTextView, editor.isFieldEditor else { return }
                        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
                    }
                }
                .onSubmit { if isAnswered(field) { next(field) } }
            } else {
                Spacer()
            }
            Button("Skip") { skip(field) }
                .buttonStyle(.glass)
                .help(isLast ? "Leave this one unanswered and send the rest" : "Leave this one unanswered")
            Button(isLast ? "Answer" : "Next") { next(field) }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(takesKeys ? .defaultAction : nil)
                .disabled(!isAnswered(field))
        }
        .controlSize(.large)
    }

    /// Keys while nothing you type in has the keyboard (no field, terminal or page): a number
    /// picks that choice, Return goes on (the Next button's), and other typing goes to your own
    /// words.
    private func key(_ event: NSEvent) -> Bool {
        guard let window = windowBox.window, event.window === window, windowBox.isEnabled, !isWriting,
              Self.isFree(window.firstResponder, in: window),
              event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
              questions.indices.contains(index),
              let characters = event.characters, let character = characters.first,
              !character.isNewline, !character.isWhitespace || character == " ", character.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              // Arrows and other function keys.
              !(character.unicodeScalars.first.map { (0xF700...0xF8FF).contains($0.value) } ?? false) else { return false }
        let field = questions[index]
        let options = options(of: field)
        if let number = character.wholeNumberValue, number >= 1, number <= min(options.count, 9) {
            pick(options[number - 1], in: field)
            return true
        }
        guard allowsWords(field) else { return false }
        written[field.key, default: ""] += characters
        isWriting = true
        return true
    }

    /// Nothing that takes typing has the keyboard: the window does, or SwiftUI's own host
    /// view (a control, not a field). A text field, the terminal or a page keeps its keys.
    private static func isFree(_ responder: NSResponder?, in window: NSWindow) -> Bool {
        guard let responder, responder !== window else { return true }
        return String(describing: type(of: responder)).contains("HostingView")
    }

    // MARK: Answers

    private func options(of field: FormField) -> [FormField.Option] {
        switch field.kind {
        case .string(let options, _, _, _, _, _): options ?? []
        case .multiselect(let options, _, _, _, _): options
        default: []
        }
    }

    private func isMultiple(_ field: FormField) -> Bool {
        if case .multiselect = field.kind { return true }
        return false
    }

    private func allowsWords(_ field: FormField) -> Bool {
        switch field.kind {
        case .string(let options, let allowsCustom, _, _, _, _): allowsCustom || (options ?? []).isEmpty
        case .multiselect(_, let allowsCustom, _, _, _): allowsCustom
        default: false
        }
    }

    private func isSelected(_ option: FormField.Option, in field: FormField) -> Bool {
        switch answers[field.key] {
        case .string(let value): value == option.value && (written[field.key] ?? "").isEmpty
        case .list(let values): values.contains(option.value)
        default: false
        }
    }

    private func isAnswered(_ field: FormField) -> Bool {
        if !(written[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        switch answers[field.key] {
        case .string(let value): return !value.isEmpty
        case .list(let values): return !values.isEmpty
        default: return false
        }
    }

    /// A choice: one with one answer is picked, and goes on to the next question; one of
    /// several is turned on or off.
    private func pick(_ option: FormField.Option, in field: FormField) {
        if isMultiple(field) {
            var values: [String] = if case .list(let list) = answers[field.key] { list } else { [] }
            if let at = values.firstIndex(of: option.value) { values.remove(at: at) } else { values.append(option.value) }
            answers[field.key] = .list(values)
            return
        }
        answers[field.key] = .string(option.value)
        written[field.key] = nil
        if !isLast {
            let from = index
            Task {
                try? await Task.sleep(for: .milliseconds(200))
                if index == from { page = from + 1 }
            }
        }
    }

    private func next(_ field: FormField) {
        if isLast { submit(payload) } else { page = index + 1 }
    }

    private func skip(_ field: FormField) {
        answers[field.key] = nil
        written[field.key] = nil
        guard isLast else {
            page = index + 1
            return
        }
        // Nothing answered at all: the same as dismissing.
        if questions.contains(where: isAnswered) { submit(payload) } else { dismiss() }
    }

    /// The answers, with what you wrote yourself: in place of a choice, or added to the ones
    /// you picked.
    private var payload: FormAnswer {
        var merged = answers
        for (key, text) in written {
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty, let field = form.fields.first(where: { $0.key == key }) else { continue }
            if isMultiple(field) {
                let picked: [String] = if case .list(let list) = merged[key] { list } else { [] }
                merged[key] = .list(picked + [words])
            } else {
                merged[key] = .string(words)
            }
        }
        return FormFieldsView.payload(form.fields, merged)
    }
}

/// One of a question's choices: its number, its words, and under the pointer, where it goes.
private struct ChoiceRow: View {
    let number: Int
    let option: FormField.Option
    let isSelected: Bool
    let isMultiple: Bool
    let action: () -> Void
    @Environment(\.accent) private var accent
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            // The badge and the arrow centered on the choice's first line, which sits in a row as
            // tall as the badge.
            HStack(alignment: .top, spacing: 10) {
                badge
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .foregroundStyle(.primary)
                        .frame(minHeight: Self.badgeSize)
                    if let description = ChoiceText.detail(option.description, label: option.label) {
                        Text(description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if !isMultiple {
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.secondary)
                        .frame(height: Self.badgeSize)
                        .opacity(isHovering ? 1 : 0)
                }
            }
            .padding(.horizontal, Self.inset)
            .padding(.vertical, 8)
            .contentShape(.rect(cornerRadius: 10))
            .background(isSelected ? accent.opacity(0.14) : isHovering ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var badge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? accent : Color.primary.opacity(0.06))
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isSelected ? .clear : Color.primary.opacity(0.12))
            if isSelected && isMultiple {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
            } else {
                Text(number <= 9 ? "\(number)" : "")
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(isSelected ? .white : .secondary)
            }
        }
        .frame(width: Self.badgeSize, height: Self.badgeSize)
    }

    private static let badgeSize: CGFloat = 22
    /// How far its content sits inside its fill.
    static let inset: CGFloat = 10
}

/// A form a tool needs filled (an MCP server's, say): its fields together, then Answer.
private struct FormCard: View {
    let form: FormRequest
    let submit: (FormAnswer) -> Void
    let dismiss: () -> Void

    @Environment(\.cardRoom) private var room
    @Environment(\.takesCardKeys) private var takesKeys
    @State private var answers: FormAnswer = [:]
    @State private var fieldsHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text(title)
                    .font(.headline)
                Spacer()
                Button(action: dismiss) { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .help("Dismiss: the agent carries on without an answer")
            }
            if let message = form.message, !message.isEmpty {
                Text(message)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                FormFieldsView(fields: form.fields, answers: $answers, style: .question)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fieldsHeight = $0 }
            }
            .frame(height: min(max(fieldsHeight, 1), room))
            .scrollBounceBehavior(.basedOnSize)
            HStack {
                Spacer()
                Button("Answer") {
                    FormCard.kept[form.id] = nil
                    submit(answers)
                }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
                    .disabled(!FormFieldsView.isComplete(form.fields, answers))
            }
        }
        .padding(16)
        // What you'd filled in, back after another conversation was in view (its card made again).
        .onAppear { answers = Self.kept[form.id] ?? FormFieldsView.defaults(for: form.fields) }
        .onChange(of: answers) { _, now in Self.kept[form.id] = now }
    }

    /// Each form's answers so far, until it's answered: kept here for the app's run.
    static var kept: [String: FormAnswer] = [:]

    /// An integration's forms go by its name ("Outlook and Microsoft 365 needs an answer"); your
    /// own MCP servers' by theirs.
    private var title: String {
        if form.isQuestion { return "The agent has a question" }
        guard let server = form.server else { return form.title }
        return "\(Integrations.service(server)?.title ?? server) needs an answer"
    }
}

extension EnvironmentValues {
    /// How tall what's in a card over the composer can be before it scrolls, so the card, the
    /// composer and some of the conversation fit in the window.
    @Entry var cardRoom: CGFloat = 360
    /// Its cards answer Return, Esc and number keys: false in the half of a split you're not
    /// working in, so the keys go to the one you are.
    @Entry var takesCardKeys = true
}


/// The window a view is in, for what it does with AppKit (watching keys there).
final class WindowBox {
    weak var window: NSWindow?
    /// Whether what it's in takes input now (not greyed out).
    var isEnabled = true
}

/// Your answers to the agent's questions so far: the choices, your own words by question, and
/// the question in view.
struct QuestionProgress: Equatable {
    var answers: FormAnswer = [:]
    var written: [String: String] = [:]
    var page = 0
    /// Its answers start from the form's defaults, once.
    var isStarted = false
}

struct WindowReader: NSViewRepresentable {
    let box: WindowBox

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { box.window = view.window }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { box.window = view.window }
    }
}

/// What a permission allows, shown whole: as tall as it is, up to `maxHeight`, then it scrolls.
struct AllowedWell<Content: View>: View {
    var maxHeight: CGFloat
    @ViewBuilder var content: Content
    @State private var height: CGFloat = 1

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(height, maxHeight))
    }
}
