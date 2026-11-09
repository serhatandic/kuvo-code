import AppKit
import ClientChanges
import ClientDesign
import ClientText
import OpenCodeKit
import SwiftUI

/// The agent wants to do something that needs your OK, in the composer's place: what Allow allows,
/// then its answers numbered, as in Claude Code and Codex (and on the phone): 1 Allow Once,
/// 2 Always Allow…, 3 Don't Allow, 4 Tell It What to Do Instead… (a line to write in). The number
/// keys pick them, Return allows once, and Escape goes to the line, and again says no.
struct PermissionCard: View {
    let request: PermissionRequest
    /// For a command: the whole command line, pipes and all, which the request names in parts.
    var command: String?
    let directory: String
    /// A coding agent's conversation (Claude Code, Codex), where Always lasts for it, not the project.
    var forConversation = false
    /// What to do instead, as you write it, kept with the ask (paging away and back keeps it);
    /// the card's own where nothing keeps it.
    var instead: Binding<String>?
    /// The answer, and for Don't Allow what to do instead, when you wrote it.
    let reply: (PermissionRequest.Decision, String?) -> Void
    @Environment(\.takesCardKeys) private var takesKeys
    @Environment(\.cardRoom) private var room
    @Environment(\.isEnabled) private var isEnabled
    /// Files whose changes you asked to see all of.
    @State private var shownWhole: Set<String> = []
    @State private var ownInstead = ""
    /// "Tell It What to Do Instead…" opened its line.
    @State private var writesInstead = false
    @FocusState private var isWritingInstead: Bool
    /// Its keys answer only once the keyboard has been still a moment, after it shows and after
    /// each key typed: Return ending a message you were writing as it came doesn't allow it.
    @State private var typing = KeysTyped()
    /// The number keys, while it takes keys.
    @State private var monitor: Any?
    @State private var windowBox = WindowBox()
    /// A long command shown whole, and how tall it is whole and as shown.
    @State private var showsAll = false
    @State private var wholeHeight: CGFloat = 0
    @State private var shownHeight: CGFloat = 0
    private var isCut: Bool { shownHeight > 0 && wholeHeight > shownHeight + 1 }
    /// Lines of a command shown before Show All.
    private static let commandLines = 6
    /// A file's lines shown before Show All: enough to read, not so many that a huge new file
    /// holds the window up.
    private static let linesShown = 400

    private var words: Binding<String> { instead ?? $ownInstead }

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
                        .accessibilityAddTraits(.isHeader)
                    if let message = request.message {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            // All that Allow allows: every file's changes, the whole command, scrolling when long.
            if !diffs.isEmpty {
                // Each file's changes, made as they scroll into view; a long one's rest a click
                // away, so nothing Allow allows is out of reach.
                AllowedWell(maxHeight: room) {
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
                VStack(alignment: .leading, spacing: 6) {
                    AllowedWell(maxHeight: room) {
                        let allowed = allowed
                        Text(allowed.shown)
                            .transcriptCodeFont()
                            .lineLimit(showsAll ? nil : Self.commandLines)
                            .textSelection(.enabled)
                            .accessibilityLabel(allowed.spoken.map(Text.init) ?? Text(allowed.shown))
                            // Whether it's cut: as tall as it is whole, against as shown.
                            .background {
                                Text(allowed.shown)
                                    .transcriptCodeFont()
                                    .fixedSize(horizontal: false, vertical: true)
                                    .hidden()
                                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { wholeHeight = $0 }
                            }
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shownHeight = $0 }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    // Sunk in like a code block, as it's paths and commands.
                    .recessedWell(RoundedRectangle(cornerRadius: 10))
                    if isCut && !showsAll {
                        Button("Show All") { showsAll = true }
                            .buttonStyle(TextButtonStyle())
                            .accessibilityHint("Shows the whole command")
                    }
                }
            }

            // Its answers, numbered (KuvoClient's words, as on the phone).
            VStack(spacing: 2) {
                let always = always
                ForEach(PermissionAnswer.allCases, id: \.self) { choice in
                    if choice == .instead, writesInstead || !words.wrappedValue.isEmpty {
                        insteadLine
                            .padding(.horizontal, ChoiceRow.inset)
                            .padding(.top, 2)
                            .transition(.opacity)
                    } else {
                        ChoiceRow(number: choice.rawValue,
                                  label: Text(choice.title(always)) + (choice.named(always).map { Text(" ") + Text($0).monospaced() } ?? Text(""))) { pick(choice) }
                            .help(choice == .always ? always.help : choice == .once ? "Return" : "")
                            .accessibilityLabel(choice.spoken(always))
                    }
                }
            }
            // The rows' fill reaches out past the column, so their numbers line up with the title.
            .padding(.horizontal, -ChoiceRow.inset)
        }
        .padding(16)
        .background(returnKey)
        .background(escape)
        .background(WindowReader(box: windowBox))
        .animation(.ui, value: writesInstead)
        .onChange(of: request.id) { typing.restart() }
        // (What you write in its line is the card's own.)
        .onChange(of: isWritingInstead) { _, writing in
            typing.ignores = writing
            if !writing, words.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { writesInstead = false }
        }
        .onChange(of: isEnabled, initial: true) { _, enabled in windowBox.isEnabled = enabled }
        .onChange(of: takesKeys, initial: true) { _, takes in
            if takes {
                monitor = monitor ?? NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in key(event) ? nil : event }
            } else if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }
        .onAppear { typing.start() }
        .onDisappear {
            typing.stop()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }

    /// 4's line: Don't Allow, with what to do instead; Return says it.
    private var insteadLine: some View {
        TextField(PermissionAnswer.insteadPlaceholder, text: words, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...4)
            .focused($isWritingInstead)
            .onSubmit(refuse)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .recessedWell(RoundedRectangle(cornerRadius: 10), isFocused: isWritingInstead)
            .accessibilityLabel("What to do instead")
            .accessibilityHint("Return says no, and tells the agent this instead")
    }

    private func pick(_ choice: PermissionAnswer) {
        switch choice {
        case .once: reply(.once, nil)
        case .always: reply(.always, nil)
        // With what you wrote in 4's line, if you did.
        case .reject: refuse()
        case .instead: writeInstead()
        }
    }

    /// Opens 4's line, with the keyboard.
    private func writeInstead() {
        writesInstead = true
        DispatchQueue.main.async { isWritingInstead = true }
    }

    /// Return: Allow Once (in the line, it says no instead).
    private var returnKey: some View {
        Button("") { reply(.once, nil) }
            .keyboardShortcut(takesKeys && typing.isQuiet && !isWritingInstead ? .defaultAction : nil)
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
    }

    /// Escape: to the line, to say what to do instead; there, no.
    private var escape: some View {
        Button("") { if isWritingInstead { refuse() } else { writeInstead() } }
            .keyboardShortcut(takesKeys && typing.isQuiet ? .cancelAction : nil)
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
    }

    /// A number key picks its answer, while nothing you type in has the keyboard (the line, a
    /// terminal, a page keep theirs) and the keyboard's been still a moment.
    private func key(_ event: NSEvent) -> Bool {
        guard let window = windowBox.window, event.window === window, windowBox.isEnabled, takesKeys, typing.isQuiet, !isWritingInstead,
              QuestionKeys.isFree(window.firstResponder, in: window),
              event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
              let number = event.characters?.first?.wholeNumberValue, let choice = PermissionAnswer(rawValue: number) else { return false }
        pick(choice)
        return true
    }

    private var trimmedWords: String { words.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func refuse() {
        reply(.reject, trimmedWords.isEmpty ? nil : trimmedWords)
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

    /// What Allow allows, as the card shows it, and as VoiceOver reads it (nil: as shown). Folders
    /// outside the project as people know them ("~/notes"), not the engine's pattern for them
    /// ("/Users/me/notes/*", read as "slash star").
    var allowed: (shown: String, spoken: String?) {
        if let command { return (command, nil) }
        guard request.action == "external_directory" else { return (request.resources.map(relative).joined(separator: "\n"), nil) }
        let home = self.home
        return (request.resources.map { OutsideFolders.shown($0, home: home) }.joined(separator: "\n"),
                request.resources.map { OutsideFolders.spoken($0, home: home) }.joined(separator: "; "))
    }

    /// The home folder of the computer that asks: this Mac's (a machine's isn't known here).
    private var home: String? {
        RemoteFolder.parse(directory) == nil ? NSHomeDirectory() : nil
    }

    /// What Always for this ask saves, in words.
    var always: AlwaysWords {
        AlwaysWords.of(action: request.action, save: request.save, resources: request.resources, home: home, forConversation: forConversation)
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
                // Each question its own page: the one you leave goes as a whole, its pick with
                // it, never fading into the next one's rows.
                ZStack(alignment: .topLeading) {
                    question(field)
                        .id(field.key)
                        .transition(QuestionFade.transition)
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
            // KUVO_DEMO_QUESTIONS_PICK=<n>: five seconds on, picks the nth choice (from 1), as its
            // number key does (0 presses Next), and writes how the main thread kept up over the next second and a
            // half to KUVO_PERF_LOG (its stalls to KUVO_PERF_STALLS).
            let environment = ProcessInfo.processInfo.environment
            if let n = Int(environment["KUVO_DEMO_QUESTIONS_PICK"] ?? "") {
                Task {
                    try? await Task.sleep(for: .seconds(5))
                    let field = questions[index]
                    guard n == 0 || options(of: field).indices.contains(n - 1) else { return }
                    let meter = PerfMeter()
                    meter.start()
                    if n == 0 { next(field) } else { pick(options(of: field)[n - 1], in: field) }
                    try? await Task.sleep(for: .milliseconds(1500))
                    let line = "question pick: " + meter.stop() + "\n"
                    if let file = environment["KUVO_PERF_LOG"] { try? line.write(toFile: file, atomically: true, encoding: .utf8) }
                    if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
                }
            }
            #endif
        }
    }

    private func header(_ field: FormField) -> some View {
        HStack(spacing: 6) {
            // The question tool's short header, when it has one.
            let title = field.description != nil ? field.title ?? "Question" : "Question"
            Text(title)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                // It goes with its question, when it says something else.
                .id(title)
                .transition(QuestionFade.transition)
            Spacer()
            if questions.count > 1 {
                Button { go(to: index - 1) } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
                    .help("Previous Question")
                Text("\(index + 1) of \(questions.count)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .contentTransition(.identity)
                Button { go(to: index + 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(isLast)
                    .help("Next Question")
            }
            Button(action: dismiss) { Image(systemName: "xmark") }
                .accessibilityLabel("Dismiss")
                .help("Dismiss: the agent carries on without your answers")
                .padding(.leading, 4)
        }
        .font(.callout)
        .buttonStyle(IconButtonStyle())
    }

    /// The question and its choices.
    private func question(_ field: FormField) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(field.description ?? field.title ?? form.title)
                .font(.system(size: 14))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if !options(of: field).isEmpty {
                // As tall as they are, up to the room there is; then they scroll. Sized in the
                // same pass as the question, so the card grows with it rather than after it.
                ScrollView {
                    choices(field)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: room)
                .fixedSize(horizontal: false, vertical: true)
                // The rows' fill reaches out past the column, so their numbers line up
                // with the question above.
                .padding(.horizontal, -ChoiceRow.inset)
            }
        }
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
              QuestionKeys.isFree(window.firstResponder, in: window),
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
                // A beat to see it picked.
                try? await Task.sleep(for: QuestionFade.beat)
                if index == from { go(to: from + 1) }
            }
        }
    }

    /// To another question. The whole window moves with it, so the card's edge and the
    /// conversation above grow or shrink along with the question, not a frame ahead of it.
    private func go(to next: Int) {
        withAnimation(.ui) { page = next }
        // The row VoiceOver was on went with the question.
        if questions.indices.contains(next) {
            let field = questions[next]
            AccessibilityNotification.Announcement("\(next + 1) of \(questions.count). \(field.description ?? field.title ?? form.title)").post()
        }
    }

    private func next(_ field: FormField) {
        if isLast { submit(payload) } else { go(to: index + 1) }
    }

    private func skip(_ field: FormField) {
        answers[field.key] = nil
        written[field.key] = nil
        guard isLast else {
            go(to: index + 1)
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

/// A numbered choice (a question's, a permission's answer): its number and its words, drawn as on
/// the phone (KuvoClient's `ChoiceRowLabel`), for the pointer.
struct ChoiceRow: View {
    let number: Int
    let label: Text
    var detail: String?
    var isSelected = false
    var isMultiple = false
    let action: () -> Void

    init(number: Int, label: Text, detail: String? = nil, isSelected: Bool = false, isMultiple: Bool = false, action: @escaping () -> Void) {
        self.number = number
        self.label = label
        self.detail = detail
        self.isSelected = isSelected
        self.isMultiple = isMultiple
        self.action = action
    }

    init(number: Int, option: FormField.Option, isSelected: Bool, isMultiple: Bool, action: @escaping () -> Void) {
        self.init(number: number, label: Text(option.label), detail: ChoiceText.detail(option.description, label: option.label),
                  isSelected: isSelected, isMultiple: isMultiple, action: action)
    }

    var body: some View {
        Button(action: action) {
            ChoiceRowLabel(number: number, label: label, detail: detail, isSelected: isSelected, isMultiple: isMultiple, numberSize: 11)
                .padding(.horizontal, Self.inset)
                .padding(.vertical, 8)
                .pickHighlight(RoundedRectangle(cornerRadius: 10), isOn: isSelected)
        }
        .buttonStyle(.plain)
        .clickablePointer()
    }

    /// How far its content sits inside its fill.
    static let inset: CGFloat = 10
}

/// How one question goes to the next: the one you leave fades out before the next one fades
/// in, so the two never show over each other.
private enum QuestionFade {
    /// The beat between a pick and the next question.
    static var beat: Duration { .milliseconds(200 * slow) }

    static var transition: AnyTransition {
        .asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.16 * slow).delay(0.07 * slow)),
                    removal: .opacity.animation(.easeOut(duration: 0.07 * slow)))
    }

    /// KUVO_DEMO_SLOW, as `Animation.ui` reads it.
    private static var slow: Double {
        #if DEBUG
        if let slow = ProcessInfo.processInfo.environment["KUVO_DEMO_SLOW"].flatMap(Double.init) { return slow }
        #endif
        return 1
    }
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
                    .accessibilityLabel("Dismiss")
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
    /// The height of the conversation a stack over its composer is in (none: as tall as it is).
    @Entry var stackRoom: CGFloat = .infinity
    /// Its cards answer Return, Esc and number keys: false in the half of a split you're not
    /// working in, so the keys go to the one you are.
    @Entry var takesCardKeys = true
}


/// Where a card's keys (a number, typing) go to it.
enum QuestionKeys {
    /// Nothing that takes typing has the keyboard: the window does, or SwiftUI's own host
    /// view (a control, not a field). A text field, the terminal or a page keeps its keys.
    static func isFree(_ responder: NSResponder?, in window: NSWindow) -> Bool {
        guard let responder, responder !== window else { return true }
        return String(describing: type(of: responder)).contains("HostingView")
    }
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

/// Whether the app's keyboard has been quiet a moment (Return and Escape aside): a card's keys
/// wait for typing meant for something else to stop. Changes only as typing starts and stops.
@MainActor @Observable final class KeysTyped {
    /// How long still counts as quiet (a test's own, nothing).
    static var quietAfter = Duration.milliseconds(600)
    private(set) var isQuiet = false
    /// Typing that's the card's own (its line) doesn't count.
    @ObservationIgnored var ignores = false
    @ObservationIgnored private var monitor: Any?
    @ObservationIgnored private var wait: Task<Void, Never>?

    func start() {
        restart()
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // (Return, keypad Enter, Escape and the number keys: the card's own answers.)
            if let self, !ignores, ![36, 76, 53].contains(event.keyCode), !Self.isAnswer(event) { restart() }
            return event
        }
    }

    /// 1 to 9 alone: a card's number keys.
    private static func isAnswer(_ event: NSEvent) -> Bool {
        event.modifierFlags.intersection([.command, .control, .option]).isEmpty && (event.characters?.first?.wholeNumberValue).map { (1...9).contains($0) } == true
    }

    /// Quiet again a moment from now (a test's, at once).
    func restart() {
        guard Self.quietAfter > .zero else {
            wait?.cancel()
            return isQuiet = true
        }
        if isQuiet { isQuiet = false }
        wait?.cancel()
        wait = Task { [weak self] in
            guard (try? await Task.sleep(for: Self.quietAfter)) != nil else { return }
            self?.isQuiet = true
        }
    }

    func stop() {
        monitor.map(NSEvent.removeMonitor)
        monitor = nil
        wait?.cancel()
        wait = nil
    }
}
