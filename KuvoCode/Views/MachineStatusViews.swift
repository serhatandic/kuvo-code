import ClientDesign
import SwiftUI

/// A machine's connection, as a dot and a word or two: green when connected, a spinner while
/// connecting, orange when it couldn't, with the reason under it (all of it on hover).
struct MachineStatus: View {
    let engine: MachineEngine
    /// Says which other Mac runs it (Settings › Machines), not everywhere the status shows.
    var namesHome = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                MachineIndicator(connection: engine.connection, size: 7, progress: engine.installProgress)
                    .accessibilityHidden(true)
                // Another Mac runs it: which one, where its start said.
                Text((namesHome ? MachinesSettings.otherMac(engine) : nil).map { engine.statusText + " · runs from " + ($0.name ?? "another Mac") } ?? engine.statusDetail)
                    .monospacedDigit()
            }
            if engine.connection == .failed, let failure = engine.failure {
                // Under the words, past the dot.
                Text(failure)
                    .lineLimit(2)
                    .frame(maxWidth: 360, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 12)
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .help(engine.failure ?? engine.statusText)
        .accessibilityElement(children: .combine)
    }
}

/// A machine's connection as a dot: green connected, orange when it couldn't, gray when it isn't,
/// and a spinner while it's getting there. The same everywhere it shows.
struct MachineIndicator: View {
    let connection: MachineEngine.Connection
    var size: CGFloat = 7
    /// Only what needs you (it couldn't connect) or is under way; nothing while all is well.
    var quiet = false
    /// How far its engine has come to it, while that can say: the ring fills.
    var progress: Double? = nil

    var body: some View {
        Group {
            switch connection {
            case .connected: if !quiet { Circle().fill(.green).frame(width: size, height: size) }
            case .failed: Circle().fill(.orange).frame(width: size, height: size)
            case .notConnected, .stopped: Circle().fill(.secondary).frame(width: size, height: size)
            case .connecting, .reconnecting, .installing:
                if let progress {
                    ProgressRing(progress, size: size + 4)
                } else {
                    Spinner(size: size + 4)
                }
            }
        }
        // The dot says it by its color: VoiceOver says it in words, and how far an install is.
        .accessibilityElement()
        .accessibilityLabel(words)
        .accessibilityValue(progress.map { "\(Int(($0 * 100).rounded())) percent" } ?? "")
    }

    private var words: String {
        switch connection {
        case .connected: "Connected"
        case .failed: "Couldn’t connect"
        case .notConnected: "Not connected"
        case .stopped: "Stopped"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .installing: "Installing"
        }
    }
}

/// In place of a session or a new session on a machine that isn't connected: what's happening,
/// and a way to try again.
struct MachineWaitingView: View {
    let engine: MachineEngine
    /// What's kept meanwhile, under the title (a browser tab's pages).
    var note: String?
    @Environment(AppModel.self) private var app

    /// Up, its sessions not read yet: still on its way, from here.
    private var connection: MachineEngine.Connection { engine.connection == .connected ? .connecting : engine.connection }

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "server.rack")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.secondary)
            Text(engine.statusTitle(connection))
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            if let note {
                Text(note)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            switch engine.state {
            case .downloading, .starting:
                link
            case .failed where engine.isRetrying:
                link
            case .failed(let reason):
                Text(reason)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .frame(maxWidth: 440)
                Button("Try Again") { app.connect(engine) }
                    .buttonStyle(.glass)
                    .controlSize(.large)
            // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
            case .preparing where engine.isStopped:
                Text("It stays stopped, through restarts too, until you start it.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                Button("Start") { app.startEngine(engine) }
                    .buttonStyle(.glass)
                    .controlSize(.large)
            case .preparing:
                Button("Connect") { app.connect(engine) }
                    .buttonStyle(.glass)
                    .controlSize(.large)
            case .ready:
                link
            }
            Spacer()
            Spacer()
        }
        .padding(Metrics.gutter)
        .frame(maxWidth: .infinity)
    }

    /// On its way there (the title above says where): its wire filling as its engine is copied
    /// there, with the step under way and, where it can say, how far.
    private var link: some View {
        VStack(spacing: 12) {
            ConnectingLink(progress: engine.step?.isCopying == true ? engine.step?.fraction : nil)
                .accessibilityHidden(true)
            if let step = engine.step {
                // Its words under the title, where no bar says how far (the title names the copy).
                if !step.isInstalling {
                    Text(step.line(engine.machine.name))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .contentTransition(.opacity)
                        .animation(.ui, value: step.name)
                }
                switch step {
                case .copying(let sent, let total) where total > 0:
                    ProgressLine("Copying the engine", bytes: sent, of: total)
                        .frame(width: 240)
                case .downloading(let fraction):
                    ProgressLine("Downloading the engine", fraction: fraction)
                        .frame(width: 240)
                default:
                    EmptyView()
                }
            }
        }
    }

}

/// Over a group chat's composer while this Mac's group chats aren't running: starting (a moment
/// after launch), or stopped, with Restart. As `MachineOfflineBar` says it for a machine: the chat
/// above is as last seen, and what you write waits.
struct MacGroupsBar: View {
    @Environment(AppModel.self) private var app
    @Environment(GroupChats.self) private var groups

    var body: some View {
        let failure: String? = if case .stopped(let reason) = groups.macReach { reason } else { nil }
        HStack(spacing: 10) {
            if failure == nil {
                Spinner(size: 13)
            } else {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(failure == nil ? "Group chats on this Mac are starting" : "Group chats on this Mac stopped")
                    .font(.system(size: 13, weight: .medium))
                Text("This is the chat as last seen. You can write meanwhile, and send once they’re running.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .help(failure ?? "Group chats on this Mac are starting")
            Spacer(minLength: 8)
            if failure != nil {
                Button("Restart") { Task { await app.restartGroupChats() } }
                    .buttonStyle(.glass)
                    .help("Start what runs your group chats on this Mac again")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}

/// Over the composer while a session's machine can't be reached: what's happening, that the
/// conversation above is as last seen and what you write waits, and a way to connect now.
struct MachineOfflineBar: View {
    let engine: MachineEngine
    /// What's shown meanwhile, as last seen, and what waits: a conversation's by default.
    var kept = "This is the conversation as last seen. You can write meanwhile, and send once it’s back."
    @Environment(AppModel.self) private var app

    /// Up, but this conversation not on it yet (its sessions being read): still on its way.
    private var connection: MachineEngine.Connection { engine.connection == .connected ? .reconnecting : engine.connection }

    var body: some View {
        HStack(spacing: 10) {
            if connection.isUnderWay {
                Spinner(size: 13)
            } else {
                Image(systemName: "bolt.horizontal.circle")
                    .font(.system(size: 14))
                    .foregroundStyle(.orange)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(engine.statusTitle(connection))
                    .font(.system(size: 13, weight: .medium))
                if connection == .failed, let failure = engine.failure {
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(kept)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .help(engine.failure ?? engine.statusTitle(connection))
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            // Not while it's trying already.
            if !isAttempting {
                // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
                if connection == .stopped {
                    Button("Start") { app.startEngine(engine) }
                        .buttonStyle(.glass)
                        .help("Start \(engine.machine.name)’s engine")
                } else {
                    Button(connection.isUnderWay ? "Connect Now" : connection == .notConnected ? "Connect" : "Try Again") { app.reconnectNow(engine) }
                        .buttonStyle(.glass)
                        .help("Connect to \(engine.machine.name) again")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    /// Connecting this moment (not waiting to try again).
    private var isAttempting: Bool {
        switch engine.state {
        case .starting, .downloading: true
        // Up, its sessions being read: nothing to do.
        case .ready: engine.isLive
        default: false
        }
    }

}

/// A move waiting for a computer that went quiet, over its conversation's composer: where it's
/// going, what comes next, and how far its copy got, on a bar that stays still (nothing moves
/// meanwhile). No buttons: the two computers move it between themselves, so nothing here helps it
/// along, and it can't be taken back without the one that's away.
struct MoveWaitingCard: View {
    let going: Moves.Going

    var body: some View {
        let words = MoveWords.waitingCard(for: going.waitingFor ?? going.place, place: going.place)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(words.title)
                    .font(.system(size: 13, weight: .medium))
                Text(words.message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let size = going.size, size > 0 {
                    ProgressLine("Copied", bytes: Int64(going.sent ?? 0), of: Int64(size), layout: .inline, still: true)
                        .padding(.top, 6)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
