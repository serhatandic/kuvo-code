import ClientDesign
import OpenCodeKit
import SwiftUI

/// A subagent the agent handed part of the work to, in a row of its own in the conversation
/// rather than among the steps: its task and agent, what it's doing while it works (in the
/// background too, after the turn has ended) and what it used once done, opening to each step
/// it takes. Several started at once show one under another.
struct SubagentRow: View {
    let call: Message.ToolCall
    let directory: String
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @State private var model: SessionModel?
    @State private var isExpanded = false

    private static let iconWidth: CGFloat = 16
    private static let iconGap: CGFloat = 8

    private var input: JSONValue? { call.state.input }
    /// As the conversation knows it, which has its session when the step doesn't say (read back
    /// from the engine while it's under way).
    private var known: (subagent: SessionModel.Subagent, conversation: String)? { workspace.subagent(forStep: call.id) }
    /// Its session, once it has started.
    private var session: String? { call.state.metadata?["sessionID"]?.string ?? known?.subagent.id }

    /// At work, as the bar over the composer says: its session runs, or its step isn't done while
    /// the conversation runs.
    private var isWorking: Bool {
        if let known { return workspace.isWorking(known.subagent, for: known.conversation) }
        return !call.state.isFinished || session.map { workspace.running.contains($0) } == true
    }

    /// How it failed, once done: its step's error, or, for one sent off in the background (whose
    /// step is done at once), its own last step's.
    private var failure: StructuredError? {
        guard !isWorking else { return nil }
        if case .failed(_, let error, _, _) = call.state { return error }
        return model?.lastStepError
    }

    private var title: String {
        if let task = input?["description"]?.string, !task.isEmpty { return task }
        return isWorking ? "Starting a subagent…" : "A subagent's task"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Button {
                    withAnimation(.ui) { isExpanded.toggle() }
                } label: {
                    header
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .disabled(session == nil)
                .help(isExpanded ? "Hide its steps" : "Show its steps")
                if let session {
                    Button("Open") {
                        app.tabs.openInPlace(session)
                    }
                    .buttonStyle(TextButtonStyle())
                    .font(.callout)
                    .help("Open its conversation here: watch it, talk to it, stop it or give it another model")
                }
            }

            if isExpanded, let session {
                SubagentSteps(id: session, task: input?["prompt"]?.string, directory: directory)
                    .padding(.leading, Self.iconWidth + Self.iconGap)
                    .padding(.top, 8)
                    .overlay(alignment: .topLeading) {
                        // The line down from the icon, beside its steps.
                        Capsule()
                            .fill(.separator)
                            .frame(width: 1)
                            .padding(.top, 3)
                            .padding(.leading, (Self.iconWidth - 1) / 2)
                    }
                    .transition(.fold)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: session) {
            guard let session else { return }
            let model = await workspace.subagentModel(for: session, in: directory)
            if let model, !model.isLoaded { await model.load() }
            self.model = model
        }
    }

    private var header: some View {
        HStack(spacing: Self.iconGap) {
            icon
                .frame(width: Self.iconWidth)
            Text(title)
                .lineLimit(1)
                .truncationMode(.middle)
            if let agent = input?["agent"]?.string {
                // As the agent is called, as everywhere else ("General").
                Text(catalog.agents.first { $0.id == agent }?.name ?? agent)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let since = call.time?.created?.date {
                // Counting while it works; once done, how long it took.
                StepActivity.Elapsed(since: since, running: isWorking, until: call.time?.completed?.date)
            }
            if session != nil {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            status
                .lineLimit(1)
                .layoutPriority(-1)
                .padding(.leading, 4)
            Spacer(minLength: 0)
        }
        .font(.callout)
        .contentShape(.rect)
    }

    @ViewBuilder private var icon: some View {
        if let failure, !failure.isInterruption {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        } else {
            // One view working and done, so its ring closes as it finishes; open, its steps show
            // the work, and its arc holds still.
            StepActivity(symbol: "person.2", running: isWorking, size: Self.iconWidth, holds: isExpanded)
        }
    }

    /// While it works, what it's doing now (its ring says it's at work, so the words stay still);
    /// once done, what it used (under its steps, while it's open), or how it ended.
    @ViewBuilder private var status: some View {
        if isWorking {
            Text(currentStep)
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if let failure {
            Text(failure.isInterruption ? "Stopped" : "Failed")
                .font(.caption)
                .foregroundStyle(failure.isInterruption ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
                .help(failure.message)
        } else if !isExpanded, let model, let usage = SubagentSteps.usage(model) {
            Text(usage)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    /// "Ran a command", "Thinking…": its latest step, in a few words.
    private var currentStep: String {
        model?.currentStep ?? "Working…"
    }
}
