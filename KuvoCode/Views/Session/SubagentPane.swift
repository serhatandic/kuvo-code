import ClientDesign
import OpenCodeKit
import SwiftUI

// Subagents, where you can keep up with them: a bar over the conversation's composer while
// they work, and each one's own conversation, opened from there, its row in the conversation or
// in the sidebar under its session, with what it does as it does it and a composer of its own
// to talk to it, stop it, or give it another model.

/// The task a subagent's session starts with: the agent's words, after the engine's line
/// saying it's a subagent.
enum SubagentTask {
    static let preamble = "You are a subagent spawned by another session."

    /// The task in a subagent's first message; nil for any other message.
    static func parse(_ text: String) -> String? {
        guard text.hasPrefix(preamble) else { return nil }
        return text.dropFirst(preamble.count).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What a subagent's row calls it: its task, or, with none, that it has one.
    static func title(_ task: String) -> String {
        task.isEmpty ? "A subagent's task" : task
    }
}

extension EnvironmentValues {
    /// The conversation shown is a subagent's (in its tab): its first message is its task, from
    /// the agent that started it.
    @Entry var isSubagentConversation = false
}

extension SessionModel {
    /// Its latest step, in a few words: "Ran a command", "Thinking…".
    var currentStep: String {
        guard case .assistant(let step)? = transcript.messages.last(where: { if case .assistant = $0 { true } else { false } }),
              let block = step.content.last else { return "Working…" }
        switch block {
        case .tool(let call): return StepsSummary.summary(of: [call])
        case .reasoning: return "Thinking…"
        case .text: return "Writing…"
        default: return "Working…"
        }
    }

    /// How its last step ended, if it failed (or was stopped).
    var lastStepError: StructuredError? {
        guard case .assistant(let step)? = transcript.messages.last(where: { if case .assistant = $0 { true } else { false } }) else { return nil }
        return step.error
    }

    /// It's waiting for an answer to something it asked (a permission, a question), which shows
    /// in the conversation it works for.
    var waitsForYou: Bool { !permissions.isEmpty || !forms.isEmpty }
}

extension Workspace {
    /// At work: its session runs, or the step that waits on it isn't done while the conversation
    /// that started it runs (a step left unfinished by an engine that stopped isn't work).
    func isWorking(_ subagent: SessionModel.Subagent, for conversation: String) -> Bool {
        running.contains(subagent.id) || (!subagent.isStepDone && running.contains(conversation))
    }
}

// MARK: - The bar over the composer

/// The conversation's subagents at work, in a bar over the composer like the one for commands
/// left running: each with what it's doing, Open (its own conversation, to watch and talk to it)
/// and Stop.
struct SubagentsBar: View {
    let subagents: [SessionModel.Subagent]
    /// The conversation's folder, where they work.
    let folder: String
    @Binding var isHidden: Bool

    var body: some View {
        WorkBar(items: subagents, title: subagents.count == 1 ? "A subagent is at work" : "\(subagents.count) subagents at work",
                detail: subagents.count == 1 ? subagents.first.map { Text(SubagentTask.title($0.task)).font(.system(size: 12)) } : nil,
                showHelp: "Show the subagents at work", hideHelp: "Hide them: this line stays while they work", isHidden: $isHidden) { subagent in
            SubagentsBarRow(subagent: subagent, folder: folder)
        }
    }
}

private struct SubagentsBarRow: View {
    let subagent: SessionModel.Subagent
    let folder: String
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @State private var model: SessionModel?

    private var agentName: String? {
        subagent.agent.map { agent in catalog.agents.first { $0.id == agent }?.name ?? agent }
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(SubagentTask.title(subagent.task))
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            // Its agent and the step it's on, in one line that gives way at its end.
            Group {
                if let model, model.waitsForYou {
                    Text("Waiting for you")
                        .foregroundStyle(.orange)
                } else {
                    ShimmerText(text: [agentName, model?.currentStep ?? "Starting…"].compactMap { $0 }.joined(separator: " · "))
                }
            }
            .font(.system(size: 12))
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Open", systemImage: "arrow.turn.down.right") {
                app.tabs.open(.session(subagent.id))
            }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
            // Whole, in a narrow conversation too: the step gives way first.
            .fixedSize()
            .help("Open its conversation, to watch it and talk to it")
            // A coding agent's subagent stops with the conversation it works for.
            if !(model.map { OutsideAgents.isAgentSession($0.session) } ?? false) {
                Button("Stop", systemImage: "stop.circle") { model?.stop() }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .fixedSize()
                    .disabled(model == nil)
                    .help("Stop it: the agent hears it was stopped, and carries on")
            }
        }
        .task(id: subagent.id) {
            let model = await workspace.subagentModel(for: subagent.id, in: folder)
            if let model, !model.isLoaded { await model.load() }
            self.model = model
        }
    }
}

// MARK: - Its conversation

/// A subagent's conversation, in its own tab: the way back to the session that started it, what
/// it was asked and everything it does as it does it, its model and Stop, and a composer to talk
/// to it. While it works, what you send reaches it at its next step; once it's done, it carries
/// on from where it left off.
struct SubagentPane: View {
    let id: String
    /// The folder of the conversation it works for.
    let folder: String
    /// The session whose agent started it.
    let parent: String
    /// Opens a session: the one that started it.
    let open: (String) -> Void
    @Environment(Workspace.self) private var workspace
    @State private var model: SessionModel?
    @State private var isMissing = false

    var body: some View {
        Group {
            if let model {
                SubagentConversation(model: model, parent: parent, open: open)
            } else if isMissing {
                ContentUnavailableView("Subagent Not Found", systemImage: "person.2", description: Text("Its session is gone, or its machine can't be reached. Close this tab."))
                    .frame(maxHeight: .infinity)
            } else {
                Spinner(size: 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: id) {
            // Again every few seconds while it can't be read (its machine reconnecting), until it
            // can; it says it's missing meanwhile.
            while !Task.isCancelled {
                if let model = await workspace.subagentModel(for: id, in: folder) {
                    if !model.isLoaded { await model.load() }
                    self.model = model
                    isMissing = false
                    return
                }
                isMissing = true
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

private struct SubagentConversation: View {
    @Bindable var model: SessionModel
    let parent: String
    let open: (String) -> Void
    @Environment(Workspace.self) private var workspace
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    @LastModel private var lastModel

    private var isWorking: Bool { model.isRunning || workspace.running.contains(model.id) }
    /// A coding agent's (Claude Code's, say): its agent runs it, and it can't be written to here.
    private var isAgentsOwn: Bool { OutsideAgents.isAgentSession(model.session) }
    /// Its machine is out of reach: you can write, not send.
    private var isOffline: Bool { SessionView.offlineMachine(of: model, in: app) != nil }

    private var agentName: String? {
        model.session.agent.map { agent in catalog.agents.first { $0.id == agent }?.name ?? agent }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            TranscriptView(model: model)
                .environment(\.isSubagentConversation, true)
                .environment(\.isOffline, isOffline)
                .frame(maxHeight: .infinity)
                .conversationBar {
                    VStack(spacing: 10) {
                        if model.waitsForYou {
                            Label("It's asking you something in the conversation it works for.", systemImage: "hand.raised")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .modifier(ComposerSurface())
                        }
                        if let failure = model.failure {
                            FailureBar(text: failure) { model.failure = nil }
                                .modifier(ComposerSurface())
                        }
                        if isAgentsOwn {
                            // Its agent runs it for the conversation that started it, and takes
                            // nothing from elsewhere.
                            Label("Its agent runs it for the conversation that started it: write there to steer it, or stop it.", systemImage: "info.circle")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .modifier(ComposerSurface())
                        } else {
                            composer
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Group {
                if isWorking {
                    Spinner(size: 13)
                } else if let error = model.lastStepError, !error.isInterruption {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                } else {
                    Image(systemName: "person.2").foregroundStyle(.secondary)
                }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                // Its task is the card's title: here, whose it is, and the way back there.
                Button { open(parent) } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 10, weight: .semibold))
                        Text("From ") + Text(parentTitle).fontWeight(.semibold)
                    }
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.tail)
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help("Open the session that started it")
                Group {
                    if isWorking {
                        ShimmerText(text: [agentName, model.currentStep].compactMap { $0 }.joined(separator: " · "))
                    } else {
                        Text([agentName, status].compactMap { $0 }.joined(separator: " · "))
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.system(size: 12))
                .lineLimit(1)
            }
            // Stop is the composer's, as in any conversation.
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
    }

    private var parentTitle: String {
        if let bot = workspace.botName?(parent) { return bot }
        return (workspace.session(parent) ?? workspace.subSession(parent)).map { $0.parentID == nil ? $0.title ?? "New Session" : SubagentTask.title($0.title ?? "") } ?? "its session"
    }

    /// How it ended, with what it used.
    private var status: String? {
        if let error = model.lastStepError { return error.isInterruption ? "Stopped" : "Failed" }
        return ["Done", SubagentSteps.usage(model)].compactMap { $0 }.joined(separator: " · ")
    }

    private var composer: some View {
        Composer(
            session: model.id,
            text: $model.draftText,
            files: $model.draftFiles,
            quotes: $model.draftQuotes,
            quoteFocus: model.quoteFocus,
            agent: model.agent,
            approval: model.approval,
            model: model.session.model ?? catalog.startingModel(lastModel),
            isRunning: isWorking,
            hasQueue: !model.waiting.isEmpty,
            history: { model.sentMessages },
            folders: [model.session.location.directory],
            commands: catalog.commands(in: model.session.location.directory),
            focusRequest: model.composerFocus,
            isOffline: isOffline,
            onSelectAgent: { _ in },
            onSelectApproval: { _ in },
            onSelectModel: { ref in model.selectModel(ref) },
            onSend: send,
            onQueue: send,
            onStop: model.stop,
            showsMode: false,
            scope: .engine,
            focusesOnAppear: false,
            prompt: isWorking ? "Tell it something: it reads it at its next step…" : "Message it: it carries on from where it left off…"
        )
    }

    private func send() {
        guard !isOffline else { return }
        Analytics.shared.track("subagent_messaged", ["working": isWorking])
        model.submitDraft(for: catalog.model(model.session.model), queue: false, commands: catalog.commands(in: model.session.location.directory))
    }
}
