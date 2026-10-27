#if DEBUG
import AppKit
import ClientDesign
import Darwin
import OpenCodeKit
import os
import SwiftUI
import Textual

/// KUVO_DEMO_REPLAY=<file>: a run recorded from a real engine (one JSON object a line: `t`, ms
/// from the start, and `raw`, the event as the engine sent it) played into a new session in
/// KUVO_DEMO_FOLDER, at the pace it came, as if the engine were sending it now. How the app kept up
/// meanwhile goes to KUVO_PERF_LOG: the same run every time, to measure what streaming costs.
/// KUVO_DEMO_REPLAY_SPEED plays it that many times faster; KUVO_DEMO_REPLAY_HOLD measures that many
/// seconds after it ends instead. Debug builds only.
@MainActor
enum PerfReplay {
    private static let log = Logger(subsystem: "run.kuvo.code", category: "perf")

    struct Event {
        var time: Double
        var raw: String
    }

    /// The recorded session's events, in order.
    static func read(_ path: String) -> (session: String, events: [Event])? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        struct Line: Decodable { var t: Double; var raw: String }
        struct Head: Decodable { var type: String; var data: Data? }
        struct Data: Decodable { var sessionID: String? }
        var session: String?
        var events: [Event] = []
        for line in text.split(separator: "\n") {
            guard let entry = try? JSONDecoder().decode(Line.self, from: Foundation.Data(line.utf8)),
                  let head = try? JSONDecoder().decode(Head.self, from: Foundation.Data(entry.raw.utf8)),
                  let id = head.data?.sessionID, head.type.hasPrefix("session.") else { continue }
            // The first session to send something is the one recorded.
            if session == nil, head.type != "session.created" { session = id }
            guard id == session, !["session.created", "session.deleted", "session.moved"].contains(head.type) else { continue }
            events.append(Event(time: entry.t, raw: entry.raw))
        }
        return session.map { ($0, events) }
    }

    static func play(_ path: String, into id: String, workspace: Workspace) async {
        guard let (recorded, events) = read(path), let first = events.first else {
            return log.error("KUVO_DEMO_REPLAY: nothing to play in \(path, privacy: .public)")
        }
        let speed = Double(ProcessInfo.processInfo.environment["KUVO_DEMO_REPLAY_SPEED"] ?? "") ?? 1
        var meter = PerfMeter()
        meter.start()
        let start = ContinuousClock.now
        // Each block's words as shown, against the engine's when it ends: none lost or doubled.
        var checked = 0
        var wrong = 0
        // KUVO_DEMO_REPLAY_UNTIL=<ms>: only that much of it, to look at it there.
        let until = Double(ProcessInfo.processInfo.environment["KUVO_DEMO_REPLAY_UNTIL"] ?? "") ?? .infinity
        for event in events where event.time - first.time <= until {
            let due = start + .milliseconds(Int((event.time - first.time) / speed))
            if due > .now { try? await Task.sleep(until: due) }
            let raw = event.raw.replacingOccurrences(of: recorded, with: id)
            guard let event = try? ServerEvent(json: Foundation.Data(raw.utf8)) else { continue }
            if event.type == "session.text.ended" || event.type == "session.reasoning.ended",
               let ended = try? event.payload(as: EventPayload.BlockEnded.self) {
                // Once what streamed in has shown.
                try? await Task.sleep(for: .milliseconds(120))
                let shown = workspace.model(for: id)?.transcript.messages.reversed().lazy.compactMap { message -> String? in
                    guard case .assistant(let step) = message, step.id == ended.assistantMessageID else { return nil }
                    return step.content.reversed().lazy.compactMap { block -> String? in
                        switch block {
                        case .text(let text) where event.type == "session.text.ended": text.text
                        case .reasoning(let text) where event.type == "session.reasoning.ended": text.text
                        default: nil
                        }
                    }.first
                }.first
                checked += 1
                if shown != ended.text { wrong += 1 }
            }
            workspace.handle(event)
        }
        // A moment for the last of it to be drawn. KUVO_DEMO_REPLAY_HOLD: measured that many
        // seconds from then instead (scrolling the finished conversation with KUVO_DEMO_WANDER, say).
        try? await Task.sleep(for: .seconds(1))
        if let hold = ProcessInfo.processInfo.environment["KUVO_DEMO_REPLAY_HOLD"].flatMap(Double.init) {
            _ = meter.stop()
            meter = PerfMeter()
            meter.start()
            try? await Task.sleep(for: .seconds(hold))
        }
        let played = ContinuousClock.now - start
        let recordedLength = ((events.last?.time ?? 0) - first.time) / 1000 / speed
        let thinking = workspace.model(for: id)?.transcript.messages.reduce(0) { total, message in
            guard case .assistant(let step) = message else { return total }
            return total + step.content.reduce(0) { if case .reasoning(let text) = $1 { $0 + text.text.count } else { $0 } }
        } ?? 0
        // How far from the end the conversation is scrolled: 0 when it followed the end.
        let scroll = ScrollAnchor.conversationScrollView()
        let fromEnd = scroll.map { Int(($0.documentView?.frame.height ?? 0) - $0.contentView.bounds.maxY) } ?? -1
        if let file = ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        let line = "replay \((path as NSString).lastPathComponent) x\(speed): \(events.count) events, \(thinking) characters of thinking, \(wrong) of \(checked) blocks shown wrong, played in \(played) (recorded \(String(format: "%.1f", recordedLength)) s), ended \(fromEnd) pt from the end of \(Int(scroll?.documentView?.frame.height ?? 0)), \(workspace.model(for: id)?.transcript.messages.count ?? -1) messages; " + meter.stop() + "\n"
        log.notice("\(line, privacy: .public)")
        if let file = ProcessInfo.processInfo.environment["KUVO_PERF_LOG"] {
            if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Foundation.Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Foundation.Data(line.utf8)) }
        }
    }
}

/// How the app keeps up while it's measured: how long the main thread takes to get to something
/// asked of it (a stand-in for your clicks, keys and scrolling), its CPU time and the process's,
/// memory, and the frames drawn.
nonisolated final class PerfMeter: NSObject, @unchecked Sendable {
    private let lock = NSLock()
    private var isRunning = true
    private var waits: [Double] = []
    private var peakMemory: UInt64 = 0
    private var link: CADisplayLink?
    private var frames = 0
    private var lateFrames = 0
    private var lastFrame: CFTimeInterval = 0
    private var began = CACurrentMediaTime()
    var startedAt: CFTimeInterval { began }
    private var cpuAtStart: Double = 0
    private var made = (rows: 0, pieces: 0, codeBlocks: 0)
    private var rowsByID: [String: Int] = [:]
    private var mainAtStart: Double = 0
    private let mainThread = mach_thread_self()
    /// Where the main thread's stack is, to walk it only there.
    private let stackHigh = UInt(bitPattern: pthread_get_stackaddr_np(pthread_self()))
    private let stackLow = UInt(bitPattern: pthread_get_stackaddr_np(pthread_self())) - UInt(pthread_get_stacksize_np(pthread_self()))
    /// Each wait over 33 ms: when, how long, and the main thread's stacks while it lasted.
    private var stalls: [(at: Double, ms: Double, stacks: [[UInt]])] = []
    private let buffer = UnsafeMutablePointer<UInt>.allocate(capacity: 160)

    @MainActor func start() {
        began = CACurrentMediaTime()
        cpuAtStart = Self.processCPU()
        mainAtStart = mainCPU()
        made = (ScrollFrameMonitor.rowsMade, ScrollFrameMonitor.piecesMade, ScrollFrameMonitor.codeBlocksMade)
        rowsByID = ScrollFrameMonitor.rowsMadeByID
        if Self.profileFile != nil {
            Thread { [self] in profile() }.start()
        } else {
            Thread { [self] in pingMain() }.start()
        }
        if let view = NSApp.windows.first(where: \.isVisible)?.contentView {
            let link = view.displayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    /// "main thread …; process …; memory …; frames …".
    @MainActor func stop() -> String {
        lock.withLock { isRunning = false }
        if let file = Self.profileFile {
            Thread.sleep(forTimeInterval: 0.01)
            try? profileReport().write(toFile: file, atomically: true, encoding: .utf8)
        }
        link?.invalidate()
        let seconds = CACurrentMediaTime() - began
        let cpu = (Self.processCPU() - cpuAtStart) / seconds * 100
        let main = (mainCPU() - mainAtStart) / seconds * 100
        let sorted = lock.withLock { waits.sorted() }
        func percentile(_ p: Double) -> Int { sorted.isEmpty ? 0 : Int(sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]) }
        let over50 = sorted.count { $0 > 50 }
        let over100 = sorted.count { $0 > 100 }
        let stalled = sorted.filter { $0 > 16 }.reduce(0, +) / 1000
        return "main thread \(Int(main))% busy, waits p50 \(percentile(0.5)) ms, p95 \(percentile(0.95)) ms, p99 \(percentile(0.99)) ms, worst \(Int(sorted.last ?? 0)) ms, \(over50) over 50 ms, \(over100) over 100 ms, \(String(format: "%.1f", stalled)) s stalled; process \(Int(cpu))% CPU; memory peak \(peakMemory / 1_048_576) MB; \(frames) frames (\(Int(Double(frames) / seconds)) a second), \(lateFrames) late; made \(ScrollFrameMonitor.rowsMade - made.rows) rows, \(ScrollFrameMonitor.piecesMade - made.pieces) Markdown pieces, \(ScrollFrameMonitor.codeBlocksMade - made.codeBlocks) code blocks" + mostMade
    }

    /// The rows made most often meanwhile, as " (id ×count, …)".
    @MainActor private var mostMade: String {
        let counts = ScrollFrameMonitor.rowsMadeByID.map { ($0.key, $0.value - (rowsByID[$0.key] ?? 0)) }.filter { $0.1 > 1 }.sorted { $0.1 > $1.1 }.prefix(4)
        return counts.isEmpty ? "" : " (" + counts.map { "\($0.0) ×\($0.1)" }.joined(separator: ", ") + ")"
    }

    /// KUVO_PERF_PROFILE=<file>: what the main thread runs, sampled every 2 ms all along (not
    /// only in stalls), summed up by function when it stops: the time each took, with what it
    /// called, and on its own.
    private static let profileFile = ProcessInfo.processInfo.environment["KUVO_PERF_PROFILE"]
    private var busySamples = 0
    private var idleSamples = 0
    private var symbolOf: [UInt: Int] = [:]
    private var symbolIndex: [String: Int] = [:]
    private var symbolNames: [String] = []
    private var inclusive: [Int] = []
    private var exclusive: [Int] = []
    private var idleSymbols: Set<Int> = []

    private func profile() {
        while lock.withLock({ isRunning }) {
            if let stack = mainStack() {
                let symbols = stack.map(symbol)
                // Waiting in the run loop for something to do: idle.
                if symbols.contains(where: idleSymbols.contains) {
                    idleSamples += 1
                } else {
                    busySamples += 1
                    for index in Set(symbols) { inclusive[index] += 1 }
                    exclusive[symbols[0]] += 1
                }
            }
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// The function an address is in, as a number (looked up once).
    private func symbol(_ address: UInt) -> Int {
        if let known = symbolOf[address] { return known }
        var info = Dl_info()
        var name = "?"
        if dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0 {
            let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
            name = image + ":" + (info.dli_sname.map { String(cString: $0) } ?? "?")
        }
        let index: Int
        if let existing = symbolIndex[name] {
            index = existing
        } else {
            index = symbolNames.count
            symbolNames.append(name)
            symbolIndex[name] = index
            inclusive.append(0)
            exclusive.append(0)
            if name.contains("CFRunLoopServiceMachPort") { idleSymbols.insert(index) }
        }
        symbolOf[address] = index
        return index
    }

    /// The profile: "inclusive exclusive image:symbol", most time first.
    func profileReport() -> String {
        var out = "busy \(busySamples) idle \(idleSamples) samples of 2 ms\n"
        for index in symbolNames.indices.sorted(by: { inclusive[$0] > inclusive[$1] }) where inclusive[index] >= 3 {
            out += "\(inclusive[index]) \(exclusive[index]) \(symbolNames[index])\n"
        }
        return out
    }

    /// Asks the main thread for something, every few milliseconds, and notes how long it took. One
    /// that takes over 25 ms is sampled: what the main thread is running, every 5 ms till it's done.
    private func pingMain() {
        var count = 0
        while lock.withLock({ isRunning }) {
            let start = CACurrentMediaTime()
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.main.async { done.signal() }
            var stacks: [[UInt]] = []
            if done.wait(timeout: .now() + .milliseconds(25)) == .timedOut {
                repeat {
                    if stacks.count < 160, let stack = mainStack() { stacks.append(stack) }
                } while done.wait(timeout: .now() + .milliseconds(5)) == .timedOut
            }
            let wait = (CACurrentMediaTime() - start) * 1000
            count += 1
            let memory = count % 20 == 0 ? Self.memory() : 0
            lock.withLock {
                waits.append(wait)
                peakMemory = max(peakMemory, memory)
                if wait > 33 { stalls.append((start - began, wait, stacks)) }
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }

    /// The main thread's return addresses, innermost first: it's stopped for the moment it takes to
    /// read them (nothing that could wait on it, like allocating, meanwhile).
    private func mainStack() -> [UInt]? {
        guard thread_suspend(mainThread) == KERN_SUCCESS else { return nil }
        var n = 0
        var state = arm_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<UInt32>.size)
        let result = withUnsafeMutablePointer(to: &state) {
            $0.withMemoryRebound(to: natural_t.self, capacity: Int(count)) { thread_get_state(mainThread, thread_state_flavor_t(ARM_THREAD_STATE64), $0, &count) }
        }
        if result == KERN_SUCCESS {
            let mask: UInt = 0x0000_7FFF_FFFF_FFFF
            buffer[0] = UInt(state.__pc) & mask
            buffer[1] = UInt(state.__lr) & mask
            n = 2
            var fp = UInt(state.__fp)
            while fp >= stackLow, fp < stackHigh - 16, fp % 8 == 0, n < 160 {
                let frame = UnsafePointer<UInt>(bitPattern: fp)!
                let ret = frame[1] & mask
                let next = frame[0]
                guard ret != 0 else { break }
                buffer[n] = ret
                n += 1
                guard next > fp else { break }
                fp = next
            }
        }
        thread_resume(mainThread)
        return n > 0 ? Array(UnsafeBufferPointer(start: buffer, count: n)) : nil
    }

    /// Each stall, and where the main thread was meanwhile: a line a sample, its frames innermost
    /// first ("image:symbol | …", symbols as compiled: `swift demangle` reads them).
    func stallReport() -> String {
        let stalls = lock.withLock { self.stalls }
        var names: [UInt: String] = [:]
        func name(_ address: UInt) -> String {
            if let name = names[address] { return name }
            var info = Dl_info()
            var name = String(address, radix: 16)
            if dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0 {
                let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
                name = image + ":" + (info.dli_sname.map { String(cString: $0) } ?? "?")
            }
            names[address] = name
            return name
        }
        var out = ""
        for stall in stalls {
            out += String(format: "STALL at %.2f s, %.0f ms, %d samples\n", stall.at, stall.ms, stall.stacks.count)
            for stack in stall.stacks { out += "  " + stack.map(name).joined(separator: " | ") + "\n" }
        }
        return out
    }

    @objc private func tick(_ link: CADisplayLink) {
        if lastFrame > 0, link.timestamp - lastFrame > link.duration * 1.5 { lateFrames += 1 }
        lastFrame = link.timestamp
        frames += 1
    }

    private static func processCPU() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func seconds(_ time: timeval) -> Double { Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000 }
        return seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    private func mainCPU() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(mainThread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1_000_000
            + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1_000_000
    }

    private static func memory() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }
}
#endif

#if DEBUG
/// With KUVO_DEMO_READ, each row's frame in the window as it's laid out, for PerfRead.
struct RowProbe: ViewModifier {
    static let isOn = ProcessInfo.processInfo.environment["KUVO_DEMO_READ"] != nil || ProcessInfo.processInfo.environment["KUVO_PERF_OPEN"] != nil
    static var frames: [String: CGRect] = [:]
    /// Which copy of each row reported last, and rows reported by two copies at once.
    static var owners: [String: UUID] = [:]
    static var twins: Set<String> = []
    /// One just seen, for the test to stop and show.
    static var newTwin: String?
    let id: String
    @State private var copy = UUID()
    /// A conversation kept hidden has rows too, in the same place: not the ones in view.
    @Environment(\.isConversationShown) private var isShown

    func body(content: Content) -> some View {
        if Self.isOn {
            content
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                    guard isShown else {
                        if Self.owners[id] == copy {
                            Self.frames[id] = nil
                            Self.owners[id] = nil
                        }
                        return
                    }
                    if let owner = Self.owners[id], owner != copy, Self.twins.insert(id).inserted { Self.newTwin = id }
                    Self.owners[id] = copy
                    Self.frames[id] = $0
                }
                .onDisappear {
                    guard Self.owners[id] == copy else { return }
                    Self.frames[id] = nil
                    Self.owners[id] = nil
                }
                .onChange(of: isShown) {
                    guard !isShown, Self.owners[id] == copy else { return }
                    Self.frames[id] = nil
                    Self.owners[id] = nil
                }
        } else {
            content
        }
    }
}

/// KUVO_PERF_OPEN: for 4 seconds after a conversation's view appears, each frame where what it
/// shows changes: where it's scrolled to, how tall it is, the rows in view, and whether the last
/// is one of them. A conversation should show its end from the first frame it shows anything.
@MainActor
enum PerfOpen {
    private static var isStarted = false

    static func start(lastRow: @escaping () -> String?) {
        guard !isStarted, let file = ProcessInfo.processInfo.environment["KUVO_PERF_OPEN"] else { return }
        isStarted = true
        Task {
            let began = ContinuousClock.now
            var lines: [String] = []
            var last = ""
            // KUVO_PERF_OPEN_FOR: that many seconds instead.
            while ContinuousClock.now - began < .seconds(ProcessInfo.processInfo.environment["KUVO_PERF_OPEN_FOR"].flatMap(Double.init) ?? 4) {
                let scroll = ScrollAnchor.conversationScrollView()
                let origin = Int(scroll?.contentView.bounds.origin.y ?? -1)
                let height = Int(scroll?.documentView?.frame.height ?? -1)
                let view = scroll.map { $0.convert($0.bounds, to: nil) } ?? .zero
                let top = (scroll?.window?.contentView?.bounds.height ?? 0) - view.maxY
                let probed = ScrollAnchor.latest?.stack?.shownFrames().window ?? RowProbe.frames
                let shown = probed.filter { $0.value.maxY > top + 40 && $0.value.minY < top + view.height - 100 }.keys
                let end = lastRow()
                let insets = scroll.map { "insets \(Int($0.contentInsets.top))/\(Int($0.contentInsets.bottom)), view \(Int($0.contentView.bounds.height))" } ?? ""
                let lastFrame = end.flatMap { probed[$0] }.map { ", last row \(Int($0.minY))…\(Int($0.maxY))" } ?? ""
                // KUVO_PERF_OPEN_ROWS: each row in view too, where it is and how tall.
                let each = ProcessInfo.processInfo.environment["KUVO_PERF_OPEN_ROWS"] == nil ? "" : "; " + shown.compactMap { id in probed[id].map { (id, $0) } }.sorted { $0.1.minY < $1.1.minY }.map { "\($0.0.suffix(8)) \(Int($0.1.minY))+\(Int($0.1.height))" }.joined(separator: ", ")
                let state = "at \(origin) of \(height), \(shown.count) rows in view\(end.map { shown.contains($0) ? ", the last among them" : ", not the last" } ?? ""), \(insets)\(lastFrame)\(each)"
                if state != last {
                    lines.append(String(format: "%5.0f ms ", (ContinuousClock.now - began) / .milliseconds(1)) + state)
                    last = state
                }
                try? await Task.sleep(for: .milliseconds(8))
            }
            try? lines.joined(separator: "\n").write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
}

/// KUVO_DEMO_READ=<seconds>: that long after a conversation opens, reads through it as you would
/// with a trackpad, KUVO_DEMO_READ_SPEED points a frame (30): up to its top, earlier messages coming
/// in on the way, then back down to the end. Each frame where what's in view moved other than as
/// the scrolling did (a jump) is noted, with why if it can tell (rows in view or above it changing
/// height, rows coming in, the scroll view moving on its own), in KUVO_PERF_JUMPS; a line with how
/// many, the main thread's stalls and the frames drawn goes to KUVO_PERF_LOG.
@MainActor
enum PerfRead {
    private struct Snapshot {
        var frames: [String: CGRect]
        var inConversation: [String: CGRect] = [:]
        var origin: CGFloat
        var height: CGFloat
        var view: ClosedRange<CGFloat>
    }

    private static var isStarted = false
    /// Conversations that went away while it read (made again, say).
    static var viewsGone = 0

    static func start() {
        guard !isStarted, ProcessInfo.processInfo.environment["KUVO_DEMO_READ"] != nil else { return }
        isStarted = true
        Task { await run() }
    }

    private static func run() async {
        let environment = ProcessInfo.processInfo.environment
        guard let wait = environment["KUVO_DEMO_READ"].flatMap(Double.init) else { return }
        try? await Task.sleep(for: .seconds(wait))
        let speed = CGFloat(Double(environment["KUVO_DEMO_READ_SPEED"] ?? "") ?? 30)
        guard let scroll = ScrollAnchor.conversationScrollView(),
              let root = scroll.window?.contentView else { return }
        func snapshot() -> Snapshot {
            // The part of the window the conversation shows, as SwiftUI's global space has it
            // (from the top), less the edges under the header and the composer.
            let rect = scroll.convert(scroll.bounds, to: nil)
            let top = root.bounds.height - rect.maxY
            let stacked = ScrollAnchor.latest?.stack?.shownFrames()
            return Snapshot(frames: stacked?.window ?? RowProbe.frames, inConversation: stacked?.document ?? ScrollAnchor.latest?.conversationFrames ?? [:], origin: scroll.contentView.bounds.origin.y,
                            height: scroll.documentView?.frame.height ?? 0, view: (top + 60)...(top + rect.height - 120))
        }
        func send(_ delta: CGFloat, phase: CGScrollPhase) {
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else { return }
            event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
            event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            if let ns = NSEvent(cgEvent: event) { scroll.scrollWheel(with: ns) }
        }
        var report = ""
        var jumps = 0
        var worst: CGFloat = 0
        var total: CGFloat = 0
        var steps = 0
        // The scrolling sent that the scroll view hasn't shown yet, and times it went elsewhere.
        var pending: CGFloat = 0
        var leaps = 0
        var worstLeap: CGFloat = 0
        var trace = ""
        var costs = ""
        var captures = 0
        let meter = PerfMeter()
        meter.start()
        let started = ContinuousClock.now
        for (pass, direction) in [("up", CGFloat(1)), ("down", -1)] {
            var still = 0
            var frame = 0
            var before = snapshot()
            var passSteps = 0
            // At the top, long enough for earlier messages to come in.
            while still < (direction > 0 ? 150 : 45), passSteps < 4000 {
                // A gesture a second, as you'd move your fingers again and again.
                let delta = speed * direction
                if frame == 0 { send(0, phase: .began) }
                send(delta, phase: .changed)
                frame += 1
                if frame == 60 {
                    send(0, phase: .ended)
                    frame = 0
                    // A new gesture may drop its first bit of scrolling: not a jump.
                    pending = 0
                }
                // A row drawn twice: stopped a moment, for a look (KUVO_PERF_CAPTURE: a file says
                // so there, for a capture from outside).
                if let twin = RowProbe.newTwin {
                    RowProbe.newTwin = nil
                    if let folder = environment["KUVO_PERF_CAPTURE"] {
                        let copies = RowProbe.frames[twin].map { "\(Int($0.minY))" } ?? "?"
                        try? "\(twin) at \(copies)\n".write(toFile: folder + "/twin-\(steps).marker", atomically: true, encoding: .utf8)
                        try? await Task.sleep(for: .seconds(3))
                    }
                }
                // KUVO_PERF_LOCKSTEP=<folder>:<from>:<to>: in those steps, each one waits for a
                // capture of the window from outside (a file there says which step), so what's
                // drawn can be compared frame by frame.
                if let spec = environment["KUVO_PERF_LOCKSTEP"]?.split(separator: ":"), spec.count == 3,
                   let from = Int(spec[1]), let to = Int(spec[2]), (from...to).contains(steps) {
                    let marker = String(spec[0]) + "/step-\(String(format: "%05d", steps)).want"
                    try? "\(Int(scroll.contentView.bounds.origin.y))".write(toFile: marker, atomically: true, encoding: .utf8)
                    for _ in 0..<100 where FileManager.default.fileExists(atPath: marker) { try? await Task.sleep(for: .milliseconds(20)) }
                }
                let stepStart = ContinuousClock.now
                try? await Task.sleep(for: .milliseconds(16))
                let after = snapshot()
                steps += 1
                // How long the step took, and the rows that came in it with their heights.
                let took = (ContinuousClock.now - stepStart) / .milliseconds(1)
                let arrived = after.frames.keys.filter { before.frames[$0] == nil }.map { "\($0):\(Int(after.frames[$0]!.height))" }
                costs += "\(steps) \(Int(took)) \(String(format: "%.2f", CACurrentMediaTime() - meter.startedAt)) " + arrived.joined(separator: ",") + "\n"
                passSteps += 1
                defer { before = after }
                let moved = before.origin - after.origin
                // At an edge, it bounces: no telling. Some time there, and the pass is over.
                let end = after.height - scroll.contentView.bounds.height
                let atEdge = after.origin <= 0.5 || before.origin <= 0.5 || after.origin >= end - 0.5 || before.origin >= before.height - scroll.contentView.bounds.height - 0.5
                still = abs(moved) < 0.5 || (direction > 0 ? after.origin <= 0.5 : after.origin >= end - 0.5) ? still + 1 : 0
                trace += "\(pass) \(steps) \(Int(after.origin)) \(Int(after.height)) \(Int(moved)) \(after.frames.count)\n"
                if atEdge {
                    pending = 0
                    continue
                }
                // Rows in view both times, and how far each moved on screen.
                let shown = after.frames.filter { id, rect in
                    guard rect.height > 0, let old = before.frames[id], old.height > 0 else { return false }
                    return rect.maxY > after.view.lowerBound && rect.minY < after.view.upperBound && old.maxY > before.view.lowerBound && old.minY < before.view.upperBound
                }
                let all = shown.map { id, rect in (id, rect.minY - before.frames[id]!.minY) }.sorted { $0.1 < $1.1 }
                // Not a row that stays put to the point while the rest move: one the lazy stack
                // set aside, unseen, without telling it went (its place, as last told, stays).
                let moving = all.filter { abs($0.1) > 0.01 }
                let moves = moving.isEmpty ? all : moving
                guard !moves.isEmpty else { continue }
                let typical = moves[moves.count / 2].1
                // What's in view should move as your fingers did. A frame late (or two at once) is
                // fine, and so is nothing moving while the main thread is busy (that's a stall,
                // counted as one); what's left over once it moves again moved under you.
                pending += delta - typical
                var why: [String] = []
                if abs(typical) > 0.5, abs(pending) > abs(delta) * 2.5 {
                    jumps += 1
                    worst = max(worst, abs(pending))
                    total += abs(pending)
                    why.append("what's in view jumped \(Int(-pending)) pt")
                    pending = 0
                }
                // Rows in view moving apart: one of them changed height.
                if let apart = moves.max(by: { abs($0.1 - typical) < abs($1.1 - typical) }), abs(apart.1 - typical) > 2 {
                    leaps += 1
                    worstLeap = max(worstLeap, abs(apart.1 - typical))
                    why.append("\(apart.0) moved \(Int(apart.1 - typical)) pt from the rest")
                }
                guard !why.isEmpty else { continue }
                for (id, rect) in after.frames {
                    guard let old = before.frames[id], abs(old.height - rect.height) > 0.5 else { continue }
                    let place = rect.maxY < after.view.lowerBound ? "above" : rect.minY > after.view.upperBound ? "below" : "in view"
                    why.append("\(id) \(Int(old.height))→\(Int(rect.height)) \(place)")
                }
                let came = after.frames.keys.filter { before.frames[$0] == nil }
                let went = before.frames.keys.filter { after.frames[$0] == nil }
                if !came.isEmpty { why.append("came: " + came.sorted().joined(separator: ", ")) }
                if !went.isEmpty { why.append("went: " + went.sorted().joined(separator: ", ")) }
                if abs(moved - delta) > 0.5 { why.append("scroll view moved \(Int(moved)) for \(Int(delta))") }
                // Rows in view: how far each moved on screen, and in the conversation.
                why.append("in view: " + moves.map { id, move in
                    let shift = (after.inConversation[id]?.minY).flatMap { new in before.inConversation[id].map { new - $0.minY } }
                    return "\(id.suffix(8)) \(Int(move))/\(shift.map { String(Int($0)) } ?? "?")"
                }.joined(separator: ", "))
                if abs(after.height - before.height) > 0.5 { why.append("height \(Int(before.height))→\(Int(after.height))") }
                report += "\(pass) step \(steps) at \(Int(after.origin)): " + why.joined(separator: "; ") + "\n    anchor: " + ScrollAnchor.notes.suffix(10).joined(separator: "\n      ") + "\n"
                // KUVO_PERF_CAPTURE=<folder>: the window as it was then, the first few times.
                if let folder = environment["KUVO_PERF_CAPTURE"], captures < 12, let number = scroll.window?.windowNumber {
                    captures += 1
                    // Waited for without holding the main thread; a capture takes a moment.
                    _ = try? await ChildProcess.run("/usr/sbin/screencapture", ["-x", "-o", "-l", String(number), folder + "/step\(steps).png"],
                                                    output: .discard, errors: .discard, limit: .seconds(30))
                }
            }
            send(0, phase: .ended)
            try? await Task.sleep(for: .milliseconds(300))
        }
        let line = "read x\(Int(speed)) pt a frame (conversation views gone meanwhile: \(viewsGone)): \(steps) steps in \(ContinuousClock.now - started), \(jumps) jumps (worst \(Int(worst)) pt, \(Int(total)) pt in all), \(leaps) rows changing in view (worst \(Int(worstLeap)) pt), \(RowProbe.twins.count) rows drawn twice\(RowProbe.twins.isEmpty ? "" : " (" + RowProbe.twins.sorted().prefix(4).joined(separator: ", ") + ")"), ended \(Int(scroll.documentView?.frame.height ?? 0) - Int(scroll.contentView.bounds.maxY)) pt from the end of \(Int(scroll.documentView?.frame.height ?? 0)); " + meter.stop() + "\n"
        if let file = environment["KUVO_PERF_JUMPS"] {
            try? report.write(toFile: file, atomically: true, encoding: .utf8)
            try? trace.write(toFile: file + ".trace", atomically: true, encoding: .utf8)
            try? costs.write(toFile: file + ".costs", atomically: true, encoding: .utf8)
        }
        if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        if let file = environment["KUVO_PERF_LOG"] {
            if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Foundation.Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Foundation.Data(line.utf8)) }
        }
    }
}
#endif

#if DEBUG
/// KUVO_PERF_RENDER: once the conversation is read, each piece of its replies laid out and drawn
/// off screen, in Textual as the transcript draws it and in plainer ways, timed, to KUVO_PERF_LOG:
/// what drawing replies costs, and what it could.
@MainActor
enum PerfRender {
    static func run(model: SessionModel) async {
        guard ProcessInfo.processInfo.environment["KUVO_PERF_RENDER"] != nil else { return }
        func texts() -> [String] {
            model.transcript.messages.flatMap { message -> [String] in
                guard case .assistant(let step) = message else { return [] }
                return step.content.compactMap { if case .text(let text) = $0 { text.text } else { nil } }
            }
        }
        // The engine can take a while to start.
        for _ in 0..<240 where !model.isLoaded || texts().isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
        try? await Task.sleep(for: .seconds(3))
        let pieces = texts().flatMap { MarkdownChunks.split($0).map(\.text) }
        guard !pieces.isEmpty else { return }
        let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: 800, height: 800), styleMask: .borderless, backing: .buffered, defer: false)
        window.orderFrontRegardless()
        let width: CGFloat = 680
        var lines: [String] = []
        var slowest: [String] = []
        // KUVO_PERF_RENDER_ONLY=<name>: that one alone (and Textual's, which starts the meter).
        let only = ProcessInfo.processInfo.environment["KUVO_PERF_RENDER_ONLY"]
        func measure<V: View>(_ name: String, _ make: (String) -> V) async {
            if let only, name != only, name != "textual" { return }
            _ = time(make(pieces[0]), width: width, window: window)
            var times: [Double] = []
            var height: CGFloat = 0
            for piece in pieces {
                let (ms, h) = time(make(piece), width: width, window: window)
                times.append(ms)
                height += h
                // A stall of its own for each, for the sampler.
                try? await Task.sleep(for: .milliseconds(5))
            }
            let sorted = times.sorted()
            let chars = pieces.reduce(0) { $0 + $1.count }
            // The slowest pieces, and what's in them.
            for index in times.indices.sorted(by: { times[$0] > times[$1] }).prefix(5) {
                let lines = pieces[index].split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                let table = lines.filter { $0.hasPrefix("|") }.count
                let fences = lines.filter { $0.hasPrefix("```") }.count
                let items = lines.filter { $0.hasPrefix("- ") || $0.hasPrefix("* ") || ($0.first?.isNumber == true && $0.contains(". ")) }.count
                let inline = pieces[index].components(separatedBy: "`").count / 2 - fences
                slowest.append(String(format: "  %.0f ms: %d characters, %d lines, %d table rows, %d code fences, %d list items, %d inline code", times[index], pieces[index].count, lines.count, table, fences, items, inline))
            }
            lines.append(String(format: "%@: %.0f ms for %d pieces (%d characters, %.0f pt): median %.1f ms, worst %.1f ms, %.1f ms per 1000 characters",
                                name, times.reduce(0, +), pieces.count, chars, height, sorted[sorted.count / 2], sorted.last ?? 0, times.reduce(0, +) / Double(chars) * 1000))
        }
        func parsed(_ text: String) -> AttributedString { (try? FileLinkingParser(folders: { [] }).attributedString(for: text)) ?? AttributedString(text) }
        // KUVO_PERF_STALLS: where the main thread is while Textual draws them.
        let meter = PerfMeter()
        if ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"] != nil, only == nil { meter.start() }
        await measure("textual") { text in
            StructuredText(text, parser: FileLinkingParser(folders: { [] }))
                .transcriptFont()
                .textual.codeBlockStyle(CopyableCodeBlockStyle())
                .textual.listItemStyle(.firstLine)
                .textual.inlineStyle(.gitHub)
                .textual.highlighterTheme(CodeColors.theme)
                .textual.structuredTextStyle(.gitHub)
                .textual.textSelection(.enabled)
        }
        if let file = ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"], only == nil {
            try? await Task.sleep(for: .milliseconds(300))
            _ = meter.stop()
            try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8)
        }
        await measure("textual, no selection") { text in
            StructuredText(text, parser: FileLinkingParser(folders: { [] }))
                .transcriptFont()
                .textual.codeBlockStyle(CopyableCodeBlockStyle())
                .textual.listItemStyle(.firstLine)
                .textual.inlineStyle(.gitHub)
                .textual.highlighterTheme(CodeColors.theme)
                .textual.structuredTextStyle(.gitHub)
        }
        await measure("textual, code wrapped") { text in
            StructuredText(text, parser: FileLinkingParser(folders: { [] }))
                .transcriptFont()
                .textual.codeBlockStyle(CopyableCodeBlockStyle())
                .textual.listItemStyle(.firstLine)
                .textual.inlineStyle(.gitHub)
                .textual.highlighterTheme(CodeColors.theme)
                .textual.structuredTextStyle(.gitHub)
                .textual.textSelection(.enabled)
                .textual.overflowMode(.wrap)
        }
        await measure("textual, plain code blocks") { text in
            StructuredText(text, parser: FileLinkingParser(folders: { [] }))
                .transcriptFont()
                .textual.listItemStyle(.firstLine)
                .textual.inlineStyle(.gitHub)
                .textual.structuredTextStyle(.gitHub)
                .textual.textSelection(.enabled)
        }
        await measure("one Text") { text in
            Text(parsed(text)).transcriptFont().textSelection(.enabled)
        }
        await measure("a Text a block") { text in
            let string = parsed(text)
            let blocks = string.runs[\.presentationIntent].map { string[$0.1] }
            return VStack(alignment: .leading, spacing: 12) {
                ForEach(blocks.indices, id: \.self) { Text(AttributedString(blocks[$0])) }
            }
            .transcriptFont()
        }
        await measure("NSTextView") { text in PlainTextView(text: NSAttributedString(parsed(text))) }
        let textKitMeter = PerfMeter()
        if only == "textkit", ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"] != nil { textKitMeter.start() }
        await measure("textkit") { text in ReplyView(markdown: text, parser: FileLinkingParser(folders: { [] })) }
        if only == "textkit", let file = ProcessInfo.processInfo.environment["KUVO_PERF_STALLS"] {
            _ = textKitMeter.stop()
            try? textKitMeter.stallReport().write(toFile: file, atomically: true, encoding: .utf8)
        }
        window.orderOut(nil)
        let line = "render " + lines.joined(separator: "\nrender ") + "\nslowest (textual first):\n" + slowest.prefix(5).joined(separator: "\n") + "\n"
        if let file = ProcessInfo.processInfo.environment["KUVO_PERF_LOG"] {
            if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Foundation.Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Foundation.Data(line.utf8)) }
        }
    }

    /// Laid out at `width`, as tall as it needs, and drawn.
    private static func time<V: View>(_ view: V, width: CGFloat, window: NSWindow) -> (Double, CGFloat) {
        let start = CACurrentMediaTime()
        let host = NSHostingView(rootView: view.frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true))
        window.contentView = host
        let size = host.fittingSize
        window.setContentSize(NSSize(width: width, height: min(size.height, 8000)))
        host.layoutSubtreeIfNeeded()
        host.display()
        CATransaction.flush()
        let ms = (CACurrentMediaTime() - start) * 1000
        window.contentView = nil
        return (ms, size.height)
    }
}

/// KUVO_PERF_COMPARE=<file.md>: once the window is up, a window of its own with the Markdown drawn
/// by Textual on the left and by TextKit (`ReplyView`) on the right, for comparing their looks.
enum PerfCompare {
    private static var window: NSWindow?

    static func run() {
        guard window == nil, let path = ProcessInfo.processInfo.environment["KUVO_PERF_COMPARE"],
              let markdown = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        let width: CGFloat = 640
        // KUVO_PERF_COMPARE_FOLDER: a project folder, for links to its files.
        let folders = ProcessInfo.processInfo.environment["KUVO_PERF_COMPARE_FOLDER"].map { [$0] } ?? []
        let view = ScrollView {
            HStack(alignment: .top, spacing: 40) {
                StructuredText(markdown, parser: FileLinkingParser(folders: { folders }))
                    .transcriptFont()
                    .textual.codeBlockStyle(CopyableCodeBlockStyle())
                    .textual.listItemStyle(.firstLine)
                    .textual.inlineStyle(.gitHub)
                    .textual.highlighterTheme(CodeColors.theme)
                    .textual.structuredTextStyle(.gitHub)
                    .textual.textSelection(.enabled)
                    .frame(width: width, alignment: .topLeading)
                ReplyView(markdown: markdown, parser: FileLinkingParser(folders: { folders }))
                    .frame(width: width, alignment: .topLeading)
            }
            .padding(30)
        }
        .background(Color(nsColor: Surface.cardFillColor(dark: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua, focused: true)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width * 2 + 100, height: 1400), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.title = "Textual | TextKit"
        window.contentView = NSHostingView(rootView: view.appLook())
        window.isReleasedWhenClosed = false
        if ProcessInfo.processInfo.environment["KUVO_DEMO_OFFSCREEN"] != nil { window.setFrameOrigin(NSPoint(x: -20000, y: 0)) }
        window.orderFrontRegardless()
        self.window = window
    }
}

/// KUVO_PERF_COPY_TEST=<file>: a few seconds after launch, all of each TextKit reply text in the
/// window selected and copied (to a pasteboard of its own), written to the file one after another.
@MainActor
enum PerfCopyTest {
    static func run() {
        guard let file = ProcessInfo.processInfo.environment["KUVO_PERF_COPY_TEST"] else { return }
        Task {
            try? await Task.sleep(for: .seconds(8))
            func texts(in view: NSView) -> [ReplyTextView] { (view as? ReplyTextView).map { [$0] } ?? view.subviews.flatMap(texts) }
            let views = NSApp.windows.compactMap(\.contentView).flatMap(texts)
            let board = NSPasteboard(name: .init("kuvo.copy-test"))
            var out = ""
            for view in views.prefix(6) {
                view.selectAll(nil)
                _ = view.writeSelection(to: board, types: [.string])
                out += "=== \(view.textStorage?.length ?? 0) characters\n" + (board.string(forType: .string) ?? "(nothing)") + "\n"
                view.setSelectedRange(NSRange(location: 0, length: 0))
            }
            try? out.write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
}

/// KUVO_PERF_SELECT=<file>: eight seconds after launch, a drag from the last reply text in view
/// up past the top of the conversation, held there KUVO_PERF_SELECT_HOLD seconds (1.5) so it
/// scrolls; what the selection copies written to the file.
@MainActor
enum PerfSelectTest {
    static func run() {
        guard let file = ProcessInfo.processInfo.environment["KUVO_PERF_SELECT"] else { return }
        let hold = Double(ProcessInfo.processInfo.environment["KUVO_PERF_SELECT_HOLD"] ?? "") ?? 1.5
        Task {
            try? await Task.sleep(for: .seconds(8))
            guard let stack = ScrollAnchor.shownAnchor?.stack, let window = stack.window, let scroll = stack.enclosingScrollView else { return }
            func texts(in view: NSView) -> [ReplyTextView] { (view as? ReplyTextView).map { [$0] } ?? view.subviews.flatMap(texts) }
            let clip = scroll.contentView
            let visible = scroll.convert(scroll.bounds, to: nil)
            guard let last = texts(in: stack).filter({ $0.window != nil && clip.convert($0.bounds, from: $0).intersects(clip.bounds) })
                .max(by: { $0.convert($0.bounds, to: nil).minY > $1.convert($1.bounds, to: nil).minY }) else { return }
            let box = last.convert(last.bounds, to: nil)
            // Near the end of its text (window coordinates are from the bottom).
            let start = NSPoint(x: box.midX, y: max(box.minY + 6, visible.minY + 110))
            let end = NSPoint(x: visible.midX, y: visible.maxY + 30)
            func event(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent? {
                NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            }
            for step in 1...12 {
                let t = CGFloat(step) / 12
                if let drag = event(.leftMouseDragged, at: NSPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)) { NSApp.postEvent(drag, atStart: false) }
            }
            let up = Timer(timeInterval: hold, repeats: false) { _ in
                MainActor.assumeIsolated { if let up = event(.leftMouseUp, at: end) { NSApp.postEvent(up, atStart: false) } }
            }
            RunLoop.main.add(up, forMode: .common)
            let before = clip.bounds.origin.y
            guard let down = event(.leftMouseDown, at: start) else { return }
            last.mouseDown(with: down)
            let copied = stack.selectedText()
            let spots = stack.selection.map { "anchor \($0.anchor), focus \($0.focus)" } ?? "no selection"
            let out = "scrolled \(Int(before)) → \(Int(clip.bounds.origin.y)) of \(Int(scroll.documentView?.frame.height ?? 0)), insets \(scroll.contentInsets.top)/\(scroll.contentInsets.bottom); start \(start), end \(end), view \(visible), text at \(box); \(spots); first responder \(window.firstResponder.map { String(describing: type(of: $0)) } ?? "none"); \(copied.count) characters copied\n\n" + copied
            try? out.write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
}

/// KUVO_PERF_LAYOUT_CHECK=<file>: for 30 seconds after launch, twice a second, each TextKit reply
/// text in the window whose text isn't laid out at its own width, or doesn't fit its frame (lines
/// drawn over what's under it, or a gap), written to the file; "all right" at the end if none.
@MainActor
enum PerfLayoutCheck {
    static func run() {
        guard let file = ProcessInfo.processInfo.environment["KUVO_PERF_LAYOUT_CHECK"] else { return }
        Task {
            var problems: [String] = []
            var looks = 0
            var blankFor = 0
            var trace: [String] = []
            for _ in 0..<60 {
                try? await Task.sleep(for: .milliseconds(500))
                func texts(in view: NSView) -> [ReplyTextView] { (view as? ReplyTextView).map { [$0] } ?? view.subviews.flatMap(texts) }
                for view in NSApp.windows.compactMap(\.contentView).flatMap(texts) where view.window != nil && view.frame.width > 0 {
                    looks += 1
                    guard let container = view.textContainer, let layout = view.layoutManager else { continue }
                    if abs(container.size.width - view.frame.width) > 0.5 {
                        problems.append("laid out at \(Int(container.size.width)) in a frame \(Int(view.frame.width)) wide")
                        continue
                    }
                    layout.ensureLayout(for: container)
                    let used = layout.usedRect(for: container).height
                    if used > view.frame.height + 8 { problems.append("text \(Int(used)) tall in a frame \(Int(view.frame.height)) tall (over what's under it)") }
                    if used < view.frame.height - 12 { problems.append("text \(Int(used)) tall in a frame \(Int(view.frame.height)) tall (a gap)") }
                }
                if let anchor = ScrollAnchor.shownAnchor { trace.append(String(format: "%.1f ", CACurrentMediaTime()) + anchor.describeView()) }
                // The conversation in view showing no rows, for a second or more.
                if let anchor = ScrollAnchor.shownAnchor, !anchor.showsRows() {
                    blankFor += 1
                    if blankFor == 2 { problems.append("the conversation showed no rows for a second: " + anchor.describeView()) }
                } else {
                    blankFor = 0
                }
                // As it goes, so it's there whenever the app is quit.
                let out = "\(looks) looks, \(ScrollAnchor.blankRecoveries) blank conversations brought back: " + (problems.isEmpty ? "all right" : "\(problems.count) wrong\n" + problems.prefix(20).joined(separator: "\n")) + "\n"
                try? out.write(toFile: file, atomically: true, encoding: .utf8)
                try? trace.suffix(40).joined(separator: "\n").write(toFile: file + ".trace", atomically: true, encoding: .utf8)
            }
        }
    }
}

/// TextKit's own view, for comparing.
private struct PlainTextView: NSViewRepresentable {
    let text: NSAttributedString

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView(usingTextLayoutManager: true)
        view.isEditable = false
        view.drawsBackground = false
        view.textStorage?.setAttributedString(text)
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {}

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 680
        nsView.frame.size.width = width
        nsView.textContainer?.size = NSSize(width: width, height: .greatestFiniteMagnitude)
        nsView.textLayoutManager?.ensureLayout(for: nsView.textLayoutManager!.documentRange)
        let height = nsView.textLayoutManager?.usageBoundsForTextContainer.height ?? 0
        return CGSize(width: width, height: height)
    }
}

/// KUVO_DEMO_DRAG=<x1>,<y1>,<x2>,<y2>: that long after the conversation opens (KUVO_DEMO_DRAG_AT
/// seconds, 6 by default), the pointer comes to the first point, rests, and drags to the second
/// (points in the window, from its top left), as events posted to the app: selecting text
/// without the real pointer. KUVO_DEMO_DRAG_REST=0 clicks at once, without resting first.
enum PerfDrag {
    static func run() async {
        let env = ProcessInfo.processInfo.environment
        guard let spec = env["KUVO_DEMO_DRAG"] else { return }
        let xy = spec.split(separator: ",").compactMap { Double($0) }
        guard xy.count == 4 else { return }
        try? await Task.sleep(for: .seconds(env["KUVO_DEMO_DRAG_AT"].flatMap(Double.init) ?? 6))
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.frame.width > 600 }),
              let content = window.contentView else { return }
        // KUVO_DEMO_DRAG_DIRECT=1: to the view under the first point itself, as a window in the
        // background takes a first click only to come forward.
        let direct = env["KUVO_DEMO_DRAG_DIRECT"] == "1"
        let start = NSPoint(x: xy[0], y: content.bounds.height - xy[1])
        let target = content.hitTest(start)
        if direct { print("drag target: \(target.map { String(describing: type(of: $0)) } ?? "none")") }
        func post(_ type: NSEvent.EventType, _ x: Double, _ y: Double, clicks: Int = 1) {
            let point = NSPoint(x: x, y: content.bounds.height - y)
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1) else { return }
            guard direct, let target else { return NSApp.postEvent(event, atStart: false) }
            switch type {
            case .leftMouseDown: target.mouseDown(with: event)
            case .leftMouseDragged: target.mouseDragged(with: event)
            case .leftMouseUp: target.mouseUp(with: event)
            default: break
            }
        }
        if env["KUVO_DEMO_DRAG_REST"] != "0" {
            post(.mouseMoved, xy[0] - 4, xy[1])
            try? await Task.sleep(for: .milliseconds(80))
            post(.mouseMoved, xy[0], xy[1])
            try? await Task.sleep(for: .milliseconds(400))
        }
        post(.leftMouseDown, xy[0], xy[1])
        for step in 1...12 {
            try? await Task.sleep(for: .milliseconds(16))
            let t = Double(step) / 12
            post(.leftMouseDragged, xy[0] + (xy[2] - xy[0]) * t, xy[1] + (xy[3] - xy[1]) * t)
        }
        try? await Task.sleep(for: .milliseconds(16))
        post(.leftMouseUp, xy[2], xy[3])
    }
}

/// KUVO_PERF_LAYERS=<file>: the window's layers drawn on the CPU (with contents of their own)
/// that were drawn again between two looks, KUVO_PERF_LAYERS_AT seconds after launch (12 by
/// default) and 1.2 s later, largest first: class, size, what draws them, the view they're in.
enum PerfLayers {
    static func run() async {
        let env = ProcessInfo.processInfo.environment
        guard let file = env["KUVO_PERF_LAYERS"] else { return }
        try? await Task.sleep(for: .seconds(env["KUVO_PERF_LAYERS_AT"].flatMap(Double.init) ?? 12))
        func look() -> [ObjectIdentifier: (contents: ObjectIdentifier?, pixels: Double, line: String)] {
            var found: [ObjectIdentifier: (ObjectIdentifier?, Double, String)] = [:]
            func walk(_ layer: CALayer, depth: Int, view: String) {
                let owner = (layer.delegate as? NSView).map { String(String(describing: type(of: $0)).prefix(60)) } ?? view
                if let contents = layer.contents {
                    let scale = layer.contentsScale
                    let pixels = layer.bounds.width * scale * layer.bounds.height * scale
                    found[ObjectIdentifier(layer)] = (ObjectIdentifier(contents as AnyObject), pixels, "\(Int(layer.bounds.width))x\(Int(layer.bounds.height)) \(type(of: layer)) in \(owner) at \(Int(layer.frame.minX)),\(Int(layer.frame.minY)) depth \(depth)")
                }
                for sub in layer.sublayers ?? [] { walk(sub, depth: depth + 1, view: owner) }
            }
            for window in NSApp.windows where window.isVisible {
                if let layer = window.contentView?.superview?.layer ?? window.contentView?.layer { walk(layer, depth: 0, view: "window") }
            }
            return found
        }
        var lines: [String] = []
        for round in 0..<4 {
            let before = look()
            try? await Task.sleep(for: .milliseconds(1500))
            let after = look()
            let redrawn = after.filter { id, now in before[id].map { $0.contents != now.contents } ?? true }
            lines.append("round \(round): \(redrawn.count) of \(after.count) drawn layers new or drawn again, \(Int(redrawn.values.reduce(0) { $0 + $1.pixels } / 1_000_000)) MP")
            lines += redrawn.values.sorted { $0.pixels > $1.pixels }.prefix(12).map { "  " + $0.line }
        }
        try? (lines.joined(separator: "\n") + "\n").write(toFile: file, atomically: true, encoding: .utf8)
    }
}
#endif
