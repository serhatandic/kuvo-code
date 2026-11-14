#if DEBUG
import AppKit
import ClientDesign
import Darwin
import OpenCodeKit
import os

/// KUVO_DEMO_GROUP_REPLAY: a group chat's discussion measured the same way every time. Three bots
/// (Ada leads, Ben, Cy) on a stand-in model that Tests/Perf/kuvo_perf.py serves at
/// KUVO_PERF_PROVIDER (a recorded discussion, at the pace it was written), in one of 40 chats on
/// this Mac. `setup` makes the bots and chats and quits; anything else then sends the discussion's
/// question and measures until it's over: the main thread's waits, its CPU and the app's, this
/// Mac's coding agents' bridge's and engine's CPU, and when each bot's message reached the chat
/// (to set against when the stand-in finished it). What it says goes to KUVO_PERF_LOG, one JSON
/// line. The chats the window had in its first moment are counted too. Debug builds only.
@MainActor
enum PerfGroups {
    static let bots = ["Ada", "Ben", "Cy"]
    static let chat = "Perf discussion"
    static let question = "Should we ship 2.0 on Friday, or hold it a week?"
    static let model = ModelRef(id: "standin", providerID: "perf")
    private static let log = Logger(subsystem: "run.kuvo.code", category: "perf")

    /// The stand-in's provider, for the engine's settings.
    static var providerConfig: [String: Any]? {
        guard let url = ProcessInfo.processInfo.environment["KUVO_PERF_PROVIDER"] else { return nil }
        return ["provider": ["perf": ["npm": "@ai-sdk/openai-compatible", "name": "Perf", "options": ["baseURL": url, "apiKey": "perf"],
                                      "models": ["standin": ["name": "Stand-in", "tool_call": false]]]]]
    }

    static func run(_ mode: String, app: AppModel) async {
        // What the window showed in its first moment: the chats kept from last time.
        let firstFrame = app.chats.list.count
        let started = Date.now
        guard await DemoWait.until("the engine (KUVO_DEMO_GROUP_REPLAY)", limit: .seconds(180), { app.api != nil }) else { return }
        guard await ready(app) else { return }
        let ready = Date.now.timeIntervalSince(started)
        if mode == "setup" {
            await setUp(app)
            write(["setup": true, "chats": app.chats.list.count])
            return
        }
        guard let group = app.chats.list.first(where: { $0.name == chat }) else { return write(["error": "no chat: run setup first"]) }
        app.tabs.open(.group(group.id))
        try? await Task.sleep(for: .seconds(2))

        var appeared: [[String: Any]] = []
        var seen = Set(app.chats.messages(in: group.id).map(\.id))
        let cpu = Children()
        var meter = PerfMeter()
        meter.start()
        let began = ContinuousClock.now
        _ = app.chats.send(question, to: group.id)
        // Until its talk is over: each bot's message as it reaches the chat, a frame after.
        let before = app.chats.messages(in: group.id).count
        while ContinuousClock.now - began < .seconds(600) {
            await changed { _ = (app.chats.messages(in: group.id).count, app.chats.isDiscussing(group.id)) }
            for message in app.chats.messages(in: group.id) where !seen.contains(message.id) {
                seen.insert(message.id)
                guard message.author != nil, message.kind != .note else { continue }
                await nextFrame()
                appeared.append(["at": (Date.now.timeIntervalSince1970 * 1000).rounded(), "text": String(message.text.prefix(80)), "kind": message.kind.rawValue])
            }
            // Over: nothing talking, and more than your question said since.
            if !app.chats.isDiscussing(group.id), app.chats.messages(in: group.id).count > before + 1 { break }
        }
        try? await Task.sleep(for: .seconds(1))
        // KUVO_PERF_GROUP_SECONDS: measured that long from the question when the talk ends sooner, so
        // builds that answer at different speeds are measured over the same span (the main thread's
        // waits are sampled all along: a shorter run puts its few long waits higher in the percentiles).
        if let span = ProcessInfo.processInfo.environment["KUVO_PERF_GROUP_SECONDS"].flatMap(Double.init) {
            try? await Task.sleep(until: began + .seconds(span), clock: .continuous)
        }
        let seconds = (ContinuousClock.now - began).components.seconds
        if let file = ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        let measured = meter.stop()
        let used = cpu.used()
        write(["firstFrameChats": firstFrame, "readyAfter": ready, "seconds": seconds, "meter": measured,
               "bridgeCPU": used.bridge / Double(max(1, seconds)) * 100, "engineCPU": used.engine / Double(max(1, seconds)) * 100,
               "appCPU": used.app / Double(max(1, seconds)) * 100, "appeared": appeared])
    }

    /// The chats on this Mac ready to be made and written to (its bridge, where they run there).
    private static func ready(_ app: AppModel) async -> Bool {
        await DemoWait.until("this Mac's group chats (KUVO_DEMO_GROUP_REPLAY)", limit: .seconds(180)) { app.chats.macReach == .ready }
    }

    /// The three bots on the stand-in model, and 40 chats (the discussion's among them).
    private static func setUp(_ app: AppModel) async {
        // The stand-in signed in to, as a key you'd add in Settings › Accounts, so its model is one
        // a bot can be made on.
        try? await app.api?.connectKey(integration: "perf", key: "perf")
        await app.catalog.refresh()
        var members: [String] = []
        for name in bots {
            if let bot = app.bots.list.first(where: { $0.name == name }) { members.append(bot.id); continue }
            if let bot = try? await app.bots.create(name: name, look: .random(), model: model, machine: nil, project: nil) { members.append(bot.id) }
        }
        guard members.count == 3 else { return write(["error": "the bots weren't made"]) }
        for index in 0..<40 {
            let name = index == 0 ? chat : "Chat \(index)"
            guard !app.chats.list.contains(where: { $0.name == name }) else { continue }
            _ = try? await make(name, members: index == 0 ? members : Array(members.prefix(2)), app: app)
        }
    }

    private static func make(_ name: String, members: [String], app: AppModel) async throws -> BotGroup {
        try await app.chats.create(name: name, purpose: nil, members: members, meeting: nil)
    }

    private static func write(_ value: [String: Any]) {
        guard let file = ProcessInfo.processInfo.environment["KUVO_PERF_LOG"],
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        try? (data + Data("\n".utf8)).write(to: URL(filePath: file))
        log.notice("\(String(decoding: data, as: UTF8.self), privacy: .public)")
    }

    /// Returns once what `read` reads changes, or after a second.
    private final class Once {
        var done: CheckedContinuation<Void, Never>?
        func resume() { done?.resume(); done = nil }
    }

    private static func changed(_ read: @escaping @MainActor () -> Void) async {
        let once = Once()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            once.done = done
            withObservationTracking { _ = read() } onChange: { Task { @MainActor in once.resume() } }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                once.resume()
            }
        }
    }

    /// Once the run loop has gone round (what changed laid out and drawn in that pass).
    private static func nextFrame() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { done.resume() }
        }
    }

    /// The CPU this app and the processes it started have used since this was made: its coding
    /// agents' bridge (`kuvo-agents`), its engine, and itself.
    final class Children {
        private let start: (app: Double, bridge: Double, engine: Double)

        init() { start = Self.now() }

        func used() -> (app: Double, bridge: Double, engine: Double) {
            let now = Self.now()
            return (now.app - start.app, now.bridge - start.bridge, now.engine - start.engine)
        }

        private static func now() -> (app: Double, bridge: Double, engine: Double) {
            var bridge = 0.0, engine = 0.0
            var pids = [pid_t](repeating: 0, count: 64)
            let count = proc_listchildpids(getpid(), &pids, Int32(MemoryLayout<pid_t>.size * pids.count))
            for pid in pids.prefix(Int(max(0, count))) where pid > 0 {
                let arguments = Self.arguments(pid)
                if arguments.contains("kuvo-agents") { bridge += cpu(pid) } else if arguments.contains("opencode") && !arguments.contains("kuvo-link") { engine += cpu(pid) }
            }
            return (cpu(getpid()), bridge, engine)
        }

        private static func cpu(_ pid: pid_t) -> Double {
            var info = rusage_info_v2()
            let result = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
            }
            guard result == 0 else { return 0 }
            var timebase = mach_timebase_info_data_t()
            mach_timebase_info(&timebase)
            return Double(info.ri_user_time + info.ri_system_time) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
        }

        private static func arguments(_ pid: pid_t) -> String {
            var mib = [CTL_KERN, KERN_PROCARGS2, pid]
            var size = 0
            guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return "" }
            var buffer = [UInt8](repeating: 0, count: size)
            guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return "" }
            return String(decoding: buffer.prefix(size).map { $0 == 0 ? 32 : $0 }, as: UTF8.self)
        }
    }
}
#endif
