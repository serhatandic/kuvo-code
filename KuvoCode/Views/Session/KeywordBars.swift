import ClientDesign
import OpenCodeKit
import SwiftUI

// What a keyword starts, in a bar over the composer like the goal's: a side question's answer
// ("/btw"), a review's findings ("/review") and a handoff under way ("/handoff"). Each box runs
// them, so they go on with the window closed.

/// What the keywords started, in bars over the composer: a handoff under way, a review's
/// findings and a side question's answer (below).
struct KeywordBars: View {
    @Bindable var model: SessionModel
    let glass: Namespace.ID
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

    var body: some View {
        if let handoff = shownHandoff {
            HandoffBar(handoff: handoff) {
                Task { await workspace.openHandoff(handoff) }
            } done: {
                model.putAwayHandoff = handoff
            }
            .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
            .glassEffectID("handoff", in: glass)
            .transition(.opacity)
        }
        if let review = model.review {
            ReviewBar(review: review, isHidden: $model.hidesReview) {
                model.fixReview()
            } done: {
                model.dismissReview()
            } open: { place in
                if let url = Self.file(place.file, in: model.session.location.directory) { app.utilities.show(url) }
            }
            .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
            .glassEffectID("review", in: glass)
            .transition(.opacity)
        }
        if let question = shownSideQuestion {
            SideQuestionBar(question: question, all: model.sideQuestions, show: { model.shownSideQuestion = $0.id }, isHidden: $model.hidesSideQuestion) {
                model.askAnotherSideQuestion()
            } remove: {
                model.removeSideQuestion(question.id)
            } done: {
                model.shownSideQuestion = nil
            }
            .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
            .glassEffectID("btw", in: glass)
            .transition(.opacity)
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
                    accessory: AnyView(actions), showHelp: "Show the question and its answer", hideHelp: "Hide them: this line stays", isHidden: $isHidden)
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
            Button("Done", systemImage: "checkmark", action: done)
                .help("Put this away: it stays with this conversation’s side questions in the sidebar")
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

/// A review with fresh eyes: under way, then what it found, bugs first, each with its file and
/// line. Ask the Agent to Fix sends the findings to the agent as your message; Done puts it away.
struct ReviewBar: View {
    let review: Review
    @Binding var isHidden: Bool
    let fix: () -> Void
    let done: () -> Void
    let open: (Review.Place) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BarLine(mark: AnyView(mark), title: title, progress: count, detail: review.summary.map { Text($0) },
                    accessory: AnyView(actions), showHelp: "Show what the review found", hideHelp: "Hide it: this line stays", isHidden: $isHidden)
            if !isHidden {
                details
                    .padding(.leading, 42)
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
                    .transition(.fold)
            }
        }
        .animation(.ui, value: review.state)
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
        case .reviewing: "Reviewing the changes…"
        case .failed: "Review couldn’t be done"
        case .done: review.findings.isEmpty ? "Review found nothing to fix" : "Review"
        }
    }

    /// "2 bugs · 1 risk · 3 nits".
    private var count: String? {
        guard review.state == .done, !review.findings.isEmpty else { return nil }
        let names: [(Review.Severity, String)] = [(.bug, "bug"), (.risk, "risk"), (.nit, "nit")]
        return names.compactMap { severity, name in
            let n = review.findings.filter { $0.severity == severity }.count
            return n == 0 ? nil : n.counting(name)
        }.joined(separator: " · ")
    }

    private var actions: some View {
        HStack(spacing: 2) {
            if review.state == .done, review.fix != nil {
                Button("Ask the Agent to Fix", systemImage: "wrench.and.screwdriver", action: fix)
                    .help("Send these findings to the agent as your message, to fix the real problems")
            }
            if review.state != .reviewing {
                Button("Done", systemImage: "checkmark", action: done)
                    .help("Put the review away")
            }
        }
        .buttonStyle(TextButtonStyle())
        .font(.system(size: 13))
        .labelStyle(.titleOnly)
    }

    @ViewBuilder private var details: some View {
        switch review.state {
        case .reviewing:
            Text("A model without this conversation reads the changes not committed yet. It changes nothing.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        case .failed:
            Text(review.error ?? "It couldn’t be done. Try again.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        case .done:
            VStack(alignment: .leading, spacing: 8) {
                if let summary = review.summary {
                    Text(summary)
                        .font(.system(size: 13))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !review.findings.isEmpty {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(review.findings) { finding in
                                FindingRow(finding: finding, open: open)
                            }
                        }
                    }
                    .frame(maxHeight: 220)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct FindingRow: View {
    let finding: Review.Finding
    let open: (Review.Place) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(severity)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(finding.severity == .nit ? AnyShapeStyle(.secondary) : AnyShapeStyle(.orange))
                .frame(width: 30, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(finding.title)
                    .font(.system(size: 13, weight: .medium))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !finding.explanation.isEmpty {
                    Text(finding.explanation)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(finding.locations, id: \.self) { place in
                    Button { open(place) } label: {
                        Text(place.text)
                            .font(.system(size: 12, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(place.file) in the side panel")
                }
            }
        }
        .accessibilityElement(children: .combine)
        // Read as one, each of its places still opens.
        .accessibilityActions {
            ForEach(finding.locations, id: \.self) { place in
                Button("Open \(place.text)") { open(place) }
            }
        }
    }

    private var severity: String {
        switch finding.severity {
        case .bug: "Bug"
        case .risk: "Risk"
        case .nit: "Nit"
        }
    }
}

/// A handoff while its note is written, or why it couldn't be. Once it's done, the new
/// conversation opens; this one's bar says where the work went.
struct HandoffBar: View {
    let handoff: Handoff
    let open: () -> Void
    let done: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Group {
                switch handoff.state {
                case .writing: Spinner(size: 14)
                case .failed: Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                case .done: Image(systemName: Keyword.handoff.symbol).foregroundStyle(.tint)
                }
            }
            .font(.system(size: 13))
            .frame(width: 18)
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            HStack(spacing: 2) {
                if handoff.state == .done {
                    Button("Open", action: open)
                        .help("Open the conversation the work carries on in")
                }
                if handoff.state != .writing {
                    Button("Done", action: done)
                }
            }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .frame(minHeight: 36)
        .accessibilityElement(children: .contain)
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
