import SwiftUI

/// A machine's connection, as a dot and a word or two: green when connected, a spinner while
/// connecting, orange when it couldn't (the reason on hover).
struct MachineStatus: View {
    let engine: MachineEngine

    var body: some View {
        HStack(spacing: 5) {
            MachineIndicator(connection: engine.connection, size: 7)
            Text(engine.statusText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .help(engine.failure ?? engine.statusText)
    }
}

/// A machine's connection as a dot: green connected, orange when it couldn't, gray when it isn't,
/// and a spinner while it's getting there. The same everywhere it shows.
struct MachineIndicator: View {
    let connection: MachineEngine.Connection
    var size: CGFloat = 7
    /// Only what needs you (it couldn't connect) or is under way; nothing while all is well.
    var quiet = false

    var body: some View {
        switch connection {
        case .connected: if !quiet { Circle().fill(.green).frame(width: size, height: size) }
        case .failed: Circle().fill(.orange).frame(width: size, height: size)
        case .notConnected, .stopped: Circle().fill(.secondary).frame(width: size, height: size)
        case .connecting, .reconnecting, .installing: Spinner(size: size + 4)
        }
    }
}

/// In place of a session or a new session on a machine that isn't connected: what's happening,
/// and a way to try again.
struct MachineWaitingView: View {
    let engine: MachineEngine
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
            switch engine.state {
            case .downloading(let progress) where progress > 0:
                ProgressView(value: progress)
                    .frame(width: 220)
            case .downloading, .starting:
                Spinner(size: 16)
            case .failed where engine.isRetrying:
                Spinner(size: 16)
            case .failed(let reason):
                Text(reason)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .frame(maxWidth: 440)
                Button("Try Again") { app.connect(engine) }
                    .buttonStyle(.glass)
                    .controlSize(.large)
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
                Spinner(size: 16)
            }
            Spacer()
            Spacer()
        }
        .padding(Metrics.gutter)
        .frame(maxWidth: .infinity)
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
                Button("Restart") { Task { await app.agents.startAgain() } }
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
                Text("This is the conversation as last seen. You can write meanwhile, and send once it’s back.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .help(engine.failure ?? engine.statusTitle(connection))
            Spacer(minLength: 8)
            // Not while it's trying already.
            if !isAttempting {
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
