import ClientDesign
import OpenCodeKit
import SwiftUI

// What a keyword starts, in a bar over the composer like the goal's: a side question's answer
// ("/btw"), a review's findings ("/review") and a handoff under way ("/handoff"). Each box runs
// them, so they go on with the window closed.

/// What the keywords started, in the card over the composer: a handoff under way, a review's
/// findings and a side question's answer (below).
struct KeywordBars: View {
    @Bindable var model: SessionModel
    /// Whether a bar is folded, as the card has it (`BarFolds`), from how it was left.
    let hidden: (ComposerBar, Binding<Bool>) -> Binding<Bool>
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app

    /// The side question whose answer shows over the composer.
    private var shownSideQuestion: SideQuestion? {
        guard let id = model.shownSideQuestion else { return nil }
        return model.sideQuestions.first { $0.id == id }
    }

    /// The handoff to show: under way, failed, or done, until it's put away.
    private var shownHandoff: Handoff? {
        guard let handoff = model.handoff, handoff != model.putAwayHandoff else { return nil }
        return handoff
    }

    /// A finding's file in the conversation's folder: on its machine for one there, as the
    /// panel opens a machine's files.
    static func file(_ path: String, in folder: String) -> URL? {
        if let (machine, base) = RemoteFolder.parse(folder) {
            return RemoteFolder.url(RemoteFolder.folder(path.hasPrefix("/") ? path : base + "/" + path, on: machine))
        }
        let full = path.hasPrefix("/") ? path : folder + "/" + path
        return FileManager.default.fileExists(atPath: full) ? URL(filePath: full) : nil
    }

    /// Where Fix… › Send To sends: the other conversations in its folder, where the changes are,
    /// newest first, then the bots on its computer.
    private var sendTargets: [ReviewSendTarget] {
        let folder = model.session.location.directory
        let machine = RemoteFolder.machine(of: folder)
        let sessions = workspace.sessions
            .filter { $0.location.directory == folder && $0.id != model.id && $0.parentID == nil && !app.bots.sessionIDs.contains($0.id) }
            .sorted { $0.time.updated > $1.time.updated }
            .prefix(6)
            .map { ReviewSendTarget(id: $0.id, name: $0.title?.isEmpty == false ? $0.title! : "New Session", isBot: false) }
        let bots = app.bots.list.filter { $0.sessionID != model.id && $0.machine == machine }.prefix(6).map { ReviewSendTarget(id: $0.sessionID, name: $0.name, isBot: true) }
        return sessions + bots
    }

    /// Findings as a list to paste, from what shows (nothing to ask its computer for).
    private func copied(_ findings: [String]?) -> String? {
        guard let review = model.review else { return nil }
        let picked = findings.map { ids in review.findings.filter { ids.contains($0.id) } } ?? review.findings
        return picked.map { finding in
            let kind = finding.severity == .bug ? "Bug" : finding.severity == .risk ? "Risk" : "Small thing"
            let places = finding.locations.isEmpty ? "" : " (" + finding.locations.map(\.text).joined(separator: ", ") + ")"
            // Its own full stop not doubled before the explanation.
            let title = finding.explanation.isEmpty ? finding.title : finding.title.replacingOccurrences(of: "\\.+$", with: "", options: .regularExpression)
            return "- \(kind): \(title)\(places)" + (finding.explanation.isEmpty ? "" : ". " + finding.explanation)
        }.joined(separator: "\n")
    }

    /// Fix… for `findings` (nil: all): the box writes what to tell the agent, and it goes where
    /// it was asked to.
    private func fix(_ findings: [String]?, _ target: ReviewFixTarget) {
        let model = model
        if target == .copy, let text = copied(findings) { return Clipboard.copy(text) }
        Task {
            guard let text = await model.reviewFixText(findings) else { return }
            switch target {
            case .here:
                // All of them asked for here: the review's done with.
                if findings == nil { model.dismissReview() }
                model.sendReviewFix(text)
            case .newSession:
                do {
                    // As this conversation: its model and permissions, in its folder (a worktree's
                    // too, where the changes are).
                    let session = try await workspace.createSession(in: model.session.location.directory, model: model.session.model, agent: nil, approval: model.approval)
                    app.open(.session(session.id))
                    workspace.model(for: session.id)?.sendReviewFix(text)
                } catch {
                    model.failure = "A new session couldn’t be started: \(error.localizedDescription)"
                }
            case .session(let id):
                // There, and open, so you see it go.
                workspace.model(for: id)?.sendReviewFix(text)
                app.open(.session(id))
            case .copy:
                Clipboard.copy(text)
            }
        }
    }

    var body: some View {
        if let handoff = shownHandoff {
            HandoffBar(handoff: handoff) {
                Task { await workspace.openHandoff(handoff) }
            } done: {
                model.putAwayHandoff = handoff
            }
            .modifier(CardRow())
            .transition(.fold)
        }
        if let review = model.review, let text = model.putAways.text(.review(review.id)) {
            let item = PutAway.review(review.id)
            UndoLine(text: text, undo: model.putAways.canUndo(item) ? { model.putAways.undo(item) } : nil)
                .modifier(CardRow())
                .transition(.fold)
        } else if let review = model.shownReview {
            ReviewBar(review: review, isHidden: hidden(.review, $model.hidesReview), sendTargets: sendTargets,
                      readerName: review.model.flatMap { model.reviewCatalogNow?.model($0)?.name }) { findings, target in
                fix(findings, target)
            } putAway: {
                model.putAwayReview()
            } stop: {
                model.stopReview()
            } cancel: {
                model.dismissReview()
            } open: { place in
                if let url = Self.file(place.file, in: model.session.location.directory) { app.utilities.show(url) }
            }
            .modifier(CardRow())
            .transition(.fold)
        }
        if let question = shownSideQuestion {
            SideQuestionBar(question: question, all: model.sideQuestions, show: { model.shownSideQuestion = $0.id }, isHidden: hidden(.sideQuestion, $model.hidesSideQuestion)) {
                model.askAnotherSideQuestion()
            } remove: {
                model.removeSideQuestion(question.id)
            } done: {
                model.shownSideQuestion = nil
            }
            .modifier(CardRow())
            .transition(.fold)
        }
    }
}

/// A side question and its answer, which nothing adds to the conversation. Ask Another starts the
/// next; Done puts the bar away (the question stays with the others, under the conversation in
/// the sidebar).
struct SideQuestionBar: View {
    let question: SideQuestion
    /// This conversation's, oldest first, this one too: the others a menu away.
    let all: [SideQuestion]
    let show: (SideQuestion) -> Void
    @Binding var isHidden: Bool
    let askAnother: () -> Void
    let remove: () -> Void
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BarLine(mark: AnyView(mark), title: question.state == .answering ? "Answering on the side…" : "Side question",
                    progress: all.count > 1 ? "\(all.count) asked" : nil, detail: Text(question.question),
                    accessory: AnyView(actions), showHelp: "Show the question and its answer", hideHelp: "Hide them: this line stays", isHidden: $isHidden,
                    close: done, closeHelp: "Put this away: it stays with this conversation’s side questions in the sidebar")
            if !isHidden {
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.question)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(4)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    switch question.state {
                    case .answering:
                        Text("Asked of the conversation’s model, without adding to it.")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    case .answered:
                        ScrollView {
                            Text(Self.markdown(question.answer ?? ""))
                                .font(.system(size: 13))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 220)
                        .fixedSize(horizontal: false, vertical: true)
                    case .failed:
                        Label(question.error ?? "It couldn’t be answered.", systemImage: "exclamationmark.circle")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 42)
                .padding(.trailing, 16)
                .padding(.bottom, 12)
                .transition(.fold)
            }
        }
        .animation(.ui, value: question.state)
    }

    @ViewBuilder private var mark: some View {
        if question.state == .answering {
            Spinner(size: 14)
        } else {
            Image(systemName: question.state == .failed ? "exclamationmark.circle" : Keyword.btw.symbol)
                .font(.system(size: 13))
                .foregroundStyle(question.state == .failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint))
        }
    }

    private var actions: some View {
        HStack(spacing: 2) {
            Button("Ask Another", systemImage: "plus.bubble", action: askAnother)
                .help("Write another side question")
            Menu {
                if all.count > 1 {
                    Section("Asked Here") {
                        ForEach(all.reversed()) { each in
                            Button { show(each) } label: {
                                if each.id == question.id { Label(String(each.question.prefix(60)), systemImage: "checkmark") } else { Text(String(each.question.prefix(60))) }
                            }
                        }
                    }
                }
                Button("Remove This Question", role: .destructive, action: remove)
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 22, height: 22)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("More")
        }
        .buttonStyle(TextButtonStyle())
        .font(.system(size: 13))
        .labelStyle(.titleOnly)
    }

    /// An answer's Markdown, inline (bold, code, links), its lines kept.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Where a review's findings go to be fixed: the agent here, a new conversation that starts
/// with them, another conversation or bot, or the clipboard as a list.
enum ReviewFixTarget: Equatable {
    case here
    case newSession
    case session(String)
    case copy
}

/// A conversation or bot that findings can be sent to (Fix… › Send To).
struct ReviewSendTarget: Identifiable, Equatable {
    var id: String
    var name: String
    var isBot: Bool
}

/// How a review's findings show: a list, each opening in place (the default), or one at a time.
enum ReviewLayout: String {
    case list, single

    static let key = "reviewLayout"
}

/// A review with fresh eyes, in the card over the composer: under way, then what it found, bugs
/// first. Its line counts them by how bad they are, with Fix… for them all; under it, each with
/// what's wrong, why, and every place it's in, and its own Fix…. One read in parts says how far
/// along it is, with a thin bar, and shows what it found so far, the newest marked; Stop ends it
/// there, keeping them. ✕ asks before it throws one under way away; a finished one goes at once,
/// with Undo for a few seconds.
struct ReviewBar: View {
    let review: Review
    @Binding var isHidden: Bool
    let sendTargets: [ReviewSendTarget]
    /// Who read it, for the line under what it found.
    var readerName: String?
    /// `findings`: their ids, nil for all of them.
    let fix: (_ findings: [String]?, _ target: ReviewFixTarget) -> Void
    let putAway: () -> Void
    let stop: () -> Void
    let cancel: () -> Void
    let open: (Review.Place) -> Void
    @AppStorage(ReviewLayout.key) private var layout = ReviewLayout.list.rawValue
    @State private var confirmsCancel = false
    /// What the part read last found, while there were findings before it.
    @State private var newest: Set<String> = []

    /// What it found shows while it's still reading, too.
    private var showsFindings: Bool { review.state != .reviewing || !review.findings.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BarLine(mark: AnyView(mark), title: title, progress: count, detail: review.summary.map { Text($0) },
                    accessory: accessory,
                    showHelp: "Show what the review found", hideHelp: "Hide it: this line stays", isHidden: $isHidden,
                    opens: showsFindings,
                    close: review.state == .reviewing ? { confirmsCancel = true } : putAway,
                    closeHelp: review.state == .reviewing ? "Stop the review and throw it away" : "Put the review away")
                // Throwing one under way away can't be undone: it asks first, by the ✕.
                .overlay(alignment: .trailing) {
                    Color.clear
                        .frame(width: 24, height: 24)
                        .padding(.trailing, 8)
                        .popover(isPresented: $confirmsCancel, arrowEdge: .bottom) {
                            StopReviewConfirmation(inParts: review.progress != nil) {
                                confirmsCancel = false
                                cancel()
                            } keep: {
                                confirmsCancel = false
                            }
                            .popoverContent()
                        }
                }
            if let progress = review.progress, review.state == .reviewing {
                ProgressLine("Reviewing", fraction: Double(progress.read) / Double(max(progress.of, 1)), layout: .bar)
                    .padding(.leading, 42)
                    .padding(.trailing, 16)
                    .padding(.bottom, showsFindings && !isHidden ? 4 : 10)
                    .transition(.opacity)
            }
            if !isHidden, showsFindings {
                details
                    .padding(.leading, 42)
                    .padding(.trailing, 16)
                    .padding(.bottom, 10)
                    .transition(.fold)
            }
        }
        .animation(.ui, value: review.state)
        .animation(.ui, value: review.findings.count)
        // Done or gone meanwhile: nothing left to stop.
        .onChange(of: review.state) { if review.state != .reviewing { confirmsCancel = false } }
        .onChange(of: review.findings.map(\.id)) { old, new in
            // A part read after others: what it found is the newest.
            newest = old.isEmpty ? [] : Set(new).subtracting(old)
        }
        .onChange(of: review.id) { newest = [] }
    }

    /// While it reads in parts, Stop (and Fix… for what it found so far); once done, Fix….
    private var accessory: AnyView? {
        let fixes = !review.findings.isEmpty && review.state != .failed
        guard review.state == .reviewing, review.progress != nil else { return fixes ? AnyView(fixMenu(nil, label: "Fix…")) : nil }
        return AnyView(HStack(spacing: 2) {
            if fixes { fixMenu(nil, label: "Fix…") }
            Button("Stop", action: stop)
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .help("Stop reading: what it found so far stays")
        })
    }

    @ViewBuilder private var mark: some View {
        switch review.state {
        case .reviewing:
            Spinner(size: 14)
        case .failed:
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
        case .done:
            Image(systemName: review.findings.isEmpty ? "checkmark.circle.fill" : Keyword.review.symbol)
                .font(.system(size: 13))
                .foregroundStyle(review.findings.isEmpty ? AnyShapeStyle(.green) : AnyShapeStyle(.tint))
        }
    }

    private var title: String {
        switch review.state {
        case .reviewing: review.scope.map { "Reviewing " + $0.said } ?? "Review"
        case .failed: "Review couldn’t be done"
        case .done: review.findings.isEmpty ? "Review found nothing to fix" : "Review"
        }
    }

    /// "1 bug · 2 risks · 1 nit"; while it reads in parts, how far along it is ("part 4 of 9"),
    /// and where Stop ended it.
    private var count: String? {
        let names: [(Review.Severity, String)] = [(.bug, "bug"), (.risk, "risk"), (.nit, "nit")]
        let found = names.compactMap { severity, name in
            let n = review.findings.filter { $0.severity == severity }.count
            return n == 0 ? nil : n.counting(name)
        }
        if review.state == .reviewing {
            guard let progress = review.progress else { return review.scope?.readsFiles == true ? "Reading the files…" : "Reading the changes…" }
            // What it found so far is counted in the list under it: the line has room for how far along.
            return "part \(min(progress.read + 1, progress.of)) of \(progress.of)"
        }
        guard review.state == .done else { return nil }
        if let stopped = review.stopped { return "stopped after \(stopped.read) of \(stopped.of) parts" }
        return found.isEmpty ? nil : found.joined(separator: " · ")
    }

    /// What it covered and who read it, under what it found: for one that was asked for more
    /// than today's ("The whole project · security · read by Claude Sonnet 4.5").
    private var footnote: String? {
        guard review.state == .done, review.scope != nil || review.focus != nil else { return nil }
        let focus = review.focus.map { ReviewCommand.Preset(rawValue: $0)?.rawValue ?? "“\($0)”" }
        return [(review.scope ?? .uncommitted).title, focus, readerName.map { "read by " + $0 }].compactMap(\.self).joined(separator: " · ")
    }

    /// Fix… for `findings` (nil: all of them); `outset` lines its words up with the text above.
    private func fixMenu(_ findings: [String]?, label: String, outset: Bool = false) -> some View {
        Menu {
            Button("Fix in a New Session", systemImage: "plus.square") { fix(findings, .newSession) }
            Button("Fix Here", systemImage: "text.bubble") { fix(findings, .here) }
            Menu("Send To", systemImage: "arrow.right") {
                if sendTargets.isEmpty {
                    Text("No other conversations here yet")
                }
                ForEach(sendTargets) { target in
                    Button(target.name, systemImage: target.isBot ? "face.smiling" : "bubble.left") { fix(findings, .session(target.id)) }
                }
            }
            Divider()
            Button(findings?.count == 1 ? "Copy Finding" : "Copy Findings", systemImage: "doc.on.doc") { fix(findings, .copy) }
        } label: {
            Text(label)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(TextButtonStyle(outset: outset))
        .font(.system(size: 13))
        .fixedSize()
        .help(findings == nil ? "Fix what it found: in a new session, here, or elsewhere" : "Fix this one: in a new session, here, or elsewhere")
    }

    @ViewBuilder private var details: some View {
        switch review.state {
        case .reviewing:
            VStack(alignment: .leading, spacing: 6) {
                Text("Found so far:")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                findingList
            }
        case .failed:
            Text(review.error ?? "It couldn’t be done. Try again.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        case .done:
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let summary = review.summary {
                        Text(summary)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Spacer(minLength: 0)
                    }
                    if review.findings.count > 1 { layoutSwitch }
                }
                if !review.findings.isEmpty {
                    if layout == ReviewLayout.single.rawValue {
                        SingleFinding(findings: review.findings, fixMenu: { fixMenu([$0.id], label: "Fix This…", outset: true) }, open: open)
                    } else {
                        findingList
                    }
                }
                if let footnote {
                    Text(footnote)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var findingList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(review.findings) { finding in
                    FindingRow(finding: finding, isNew: newest.contains(finding.id), fixMenu: { fixMenu([finding.id], label: "Fix…") }, fix: { fix([finding.id], $0) }, open: open)
                }
            }
        }
        // About five, then it scrolls.
        .frame(maxHeight: 176)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, -8)
    }

    /// The list, or one at a time: kept for the next review too.
    private var layoutSwitch: some View {
        HStack(spacing: 0) {
            ForEach([ReviewLayout.list, .single], id: \.rawValue) { each in
                Button(each == .list ? "As a List" : "One at a Time", systemImage: each == .list ? "list.bullet" : "rectangle.portrait") {
                    withAnimation(.ui) { layout = each.rawValue }
                }
                .buttonStyle(IconButtonStyle(width: 22, height: 20))
                .foregroundStyle(layout == each.rawValue ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                .help(each == .list ? "Show them as a list" : "Show them one at a time")
                .accessibilityAddTraits(layout == each.rawValue ? .isSelected : [])
            }
        }
    }
}

/// How bad a finding is, as a dot by it: red for a bug, orange for a risk, grey for a small thing.
private struct SeverityDot: View {
    let severity: Review.Severity

    var body: some View {
        Circle()
            .fill(severity == .bug ? AnyShapeStyle(.red) : severity == .risk ? AnyShapeStyle(.orange) : AnyShapeStyle(.tertiary))
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
    }
}

private extension Review.Severity {
    var name: String {
        switch self {
        case .bug: "Bug"
        case .risk: "Risk"
        case .nit: "Small thing"
        }
    }
}

/// One finding in the list: its dot, what's wrong and its first place; clicked, why and every
/// place it's in, each opening in the side panel. Its Fix… shows under the pointer, in room kept
/// for it, so nothing moves.
private struct FindingRow: View {
    let finding: Review.Finding
    /// Found by the part read last.
    var isNew = false
    let fixMenu: () -> AnyView
    /// Its Fix…'s choices, for VoiceOver, which can't hover.
    let fix: (ReviewFixTarget) -> Void
    let open: (Review.Place) -> Void
    @State private var isOpen = false
    @State private var hovering = false

    init(finding: Review.Finding, isNew: Bool = false, fixMenu: @escaping () -> some View, fix: @escaping (ReviewFixTarget) -> Void, open: @escaping (Review.Place) -> Void) {
        self.finding = finding
        self.isNew = isNew
        self.fixMenu = { AnyView(fixMenu()) }
        self.fix = fix
        self.open = open
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SeverityDot(severity: finding.severity)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(finding.title)
                        .font(.system(size: 13, weight: isOpen ? .semibold : .regular))
                        .lineLimit(isOpen ? nil : 1)
                        .fixedSize(horizontal: false, vertical: isOpen)
                    if isNew {
                        Text("new")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.tint)
                            .fixedSize()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !isOpen { firstPlace }
                fixMenu()
                    .opacity(hovering ? 1 : 0)
            }
            // Its line opens and closes it; what opens can be selected.
            .contentShape(.rect)
            .onTapGesture { withAnimation(.ui) { isOpen.toggle() } }
            if isOpen {
                VStack(alignment: .leading, spacing: 3) {
                    if !finding.explanation.isEmpty {
                        Text(finding.explanation)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    PlacesLine(places: finding.locations, open: open)
                }
                .padding(.leading, 15)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(hovering ? AnyShapeStyle(Pressable.hoverFill) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 7))
        .contentShape(.rect)
        .onHover { hovering = $0 }
        .clickablePointer()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(finding.severity.name): \(finding.title)\(isNew ? ", new" : "")")
        .accessibilityValue(isOpen ? finding.explanation : "")
        .accessibilityHint(isOpen ? "Hides why" : "Shows why and where")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { withAnimation(.ui) { isOpen.toggle() } }
        .accessibilityActions {
            Button("Fix in a New Session") { fix(.newSession) }
            Button("Fix Here") { fix(.here) }
            Button("Copy Finding") { fix(.copy) }
            ForEach(finding.locations, id: \.self) { place in
                Button("Open \(place.text)") { open(place) }
            }
        }
    }

    /// Its first place, and how many more; none for one about the change as a whole.
    @ViewBuilder private var firstPlace: some View {
        if let first = finding.locations.first {
            Text(first.text + (finding.locations.count > 1 ? " +\(finding.locations.count - 1)" : ""))
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: 220, alignment: .trailing)
        } else {
            Text("the change as a whole")
                .font(.system(size: 11.5))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }
}

/// A finding's places, each opening in the side panel; for one with none, that it's about the
/// change as a whole.
private struct PlacesLine: View {
    let places: [Review.Place]
    let open: (Review.Place) -> Void

    var body: some View {
        if places.isEmpty {
            Text("About the change as a whole: no place in a file.")
                .font(.system(size: 11.5))
                .foregroundStyle(.tertiary)
        } else {
            FlowLine(spacing: 10) {
                ForEach(places, id: \.self) { place in
                    Button { open(place) } label: {
                        Text(place.text)
                            .font(.system(size: 11.5, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(place.file) in the side panel")
                }
            }
        }
    }
}

/// Views side by side, onto the next line when there's no room.
private struct FlowLine: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { y += line + 2; x = 0; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { y += line + 2; x = bounds.minX; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// One finding at a time, in full: a strip of them all by how bad, arrows to step through, its places each on a line of its own, and its own Fix….
private struct SingleFinding: View {
    let findings: [Review.Finding]
    let fixMenu: (Review.Finding) -> AnyView
    let open: (Review.Place) -> Void
    @State private var index = 0

    init(findings: [Review.Finding], fixMenu: @escaping (Review.Finding) -> some View, open: @escaping (Review.Place) -> Void) {
        self.findings = findings
        self.fixMenu = { AnyView(fixMenu($0)) }
        self.open = open
    }

    private var shown: Int { min(index, findings.count - 1) }

    var body: some View {
        let finding = findings[shown]
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Button("Previous Finding", systemImage: "chevron.left") { index = max(0, shown - 1) }
                    .buttonStyle(IconButtonStyle(width: 20, height: 20))
                    .disabled(shown == 0)
                Text("\(shown + 1) of \(findings.count)")
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.secondary)
                Button("Next Finding", systemImage: "chevron.right") { index = min(findings.count - 1, shown + 1) }
                    .buttonStyle(IconButtonStyle(width: 20, height: 20))
                    .disabled(shown == findings.count - 1)
                HStack(spacing: 4) {
                    ForEach(Array(findings.enumerated()), id: \.element.id) { offset, each in
                        Capsule()
                            .fill(each.severity == .bug ? AnyShapeStyle(.red) : each.severity == .risk ? AnyShapeStyle(.orange) : AnyShapeStyle(.tertiary))
                            .opacity(offset == shown ? 1 : 0.3)
                            .frame(maxWidth: 26)
                            .frame(height: 4)
                            .onTapGesture { index = offset }
                    }
                }
                .accessibilityHidden(true)
                Spacer(minLength: 0)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SeverityDot(severity: finding.severity)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                Text(finding.title)
                    .font(.system(size: 14, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(finding.severity.name): \(finding.title)")
            }
            if !finding.explanation.isEmpty {
                Text(finding.explanation)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 2) {
                if finding.locations.isEmpty {
                    Text("About the change as a whole: no place in a file.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tertiary)
                }
                ForEach(finding.locations, id: \.self) { place in
                    Button { open(place) } label: {
                        Label(place.text, systemImage: "doc")
                            .font(.system(size: 11.5, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(place.file) in the side panel")
                }
            }
            HStack(spacing: 8) {
                fixMenu(finding)
                if shown < findings.count - 1 {
                    Button("Next") { index = shown + 1 }
                        .buttonStyle(TextButtonStyle())
                        .font(.system(size: 13))
                }
            }
            .padding(.top, 2)
        }
        .animation(.ui, value: shown)
    }
}

/// Asked by a running review's ✕: throwing it away can't be undone (asked again, it reads from
/// the start). One read in parts has Stop, which keeps what it found, beside it.
private struct StopReviewConfirmation: View {
    var inParts = false
    let stop: () -> Void
    let keep: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Stop the review?")
                .font(.system(size: 13, weight: .semibold))
            Text(inParts ? "What it found so far goes too; Stop keeps it. Asked again, it reads from the start." : "What it has read so far isn’t kept. Asked again, it reads from the start.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Stop the Review", role: .destructive, action: stop)
                Button("Keep Reading", action: keep)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 280)
    }
}

/// A handoff while its note is written, or why it couldn't be. Once it's done, the new
/// conversation opens; this one's bar says where the work went.
struct HandoffBar: View {
    let handoff: Handoff
    let open: () -> Void
    let done: () -> Void

    var body: some View {
        BarLine(mark: AnyView(mark), title: title, detail: detail.map { Text($0) },
                accessory: handoff.state == .done ? AnyView(openButton) : nil, showHelp: "", hideHelp: "",
                isHidden: .constant(true), opens: false,
                close: handoff.state == .writing ? nil : done, closeHelp: "Put this away")
            .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var mark: some View {
        Group {
            switch handoff.state {
            case .writing: Spinner(size: 14)
            case .failed: Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            case .done: Image(systemName: Keyword.handoff.symbol).foregroundStyle(.tint)
            }
        }
        .font(.system(size: 13))
    }

    private var openButton: some View {
        Button("Open", action: open)
            .help("Open the conversation the work carries on in")
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
    }

    private var title: String {
        switch handoff.state {
        case .writing: "Writing a handoff note…"
        case .failed: "Couldn’t hand off"
        case .done: "Carried on in a fresh conversation"
        }
    }

    private var detail: String? {
        switch handoff.state {
        case .writing: "A fresh conversation starts from it, on the same model."
        case .failed: handoff.error
        case .done: handoff.title
        }
    }
}
