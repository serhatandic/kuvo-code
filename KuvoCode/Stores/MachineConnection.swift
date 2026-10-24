import Foundation

/// One connection to a machine, from the moment its engine is up until it closes: Disconnect,
/// Remove, a reconnect, the app quitting, or the connection lost (`MachineEngine.disconnect`).
/// What runs for it (the steps after it connects, the syncs that keep it current) runs as its
/// tasks and ends with it, so nothing acts for a connection that's gone, and a machine connected
/// again runs one set, not two. Another sync joins with `run` or `every`.
final class MachineConnection {
    typealias Step = @MainActor () async -> Void

    private var tasks: [String: Task<Void, Never>] = [:]
    /// It closed: nothing more starts for it.
    private var hasEnded = false

    /// Runs `work` for as long as the connection lasts. One already running under `name` (a sync
    /// asked for again) ends first.
    @discardableResult
    func run(_ name: String, _ work: @escaping Step) -> Task<Void, Never> {
        tasks[name]?.cancel()
        guard !hasEnded else { return Task {} }
        let task = Task { await work() }
        tasks[name] = task
        return task
    }

    /// Runs `steps`, `seconds` apart, for as long as the connection lasts.
    func every(_ seconds: Int, _ name: String, _ steps: [Step]) {
        run(name) {
            while !Task.isCancelled {
                await MachineClock.wait(seconds)
                await Self.inTurn(steps)
            }
        }
    }

    /// Closes it: what runs for it is cancelled, and nothing more starts.
    func end() {
        hasEnded = true
        for task in tasks.values { task.cancel() }
        tasks = [:]
    }

    /// Runs `steps` one after another, for as long as the task they run in isn't cancelled: none
    /// starts after it is, and one begun goes on to its end, as each did before connections ended
    /// this way (what it sends there, or delivers here, isn't cut off halfway). Whether all ran.
    @discardableResult
    static func inTurn(_ steps: [Step]) async -> Bool {
        for step in steps {
            guard !Task.isCancelled else { return false }
            await Task { await step() }.value
        }
        return !Task.isCancelled
    }
}
