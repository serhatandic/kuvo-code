import Foundation
import KuvoLink

/// Settings › Machines for a phone (PROTOCOL.md, "Machines"): the machines this Mac runs
/// sessions on, how each is doing, and what the page does with them.
extension PhoneLink {
    func answerMachines(_ request: LinkRequest) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let path = URLComponents(string: request.path)?.percentEncodedPath ?? request.path
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map { String($0).removingPercentEncoding ?? String($0) }
        let method = request.method.uppercased()
        let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        if parts.count == 2 {
            switch method {
            case "GET": return (200, machinesJSON() ?? Data())
            case "POST": return await addMachine(body["destination"] as? String, app: app)
            default: return (405, Data())
            }
        }
        guard parts.count >= 3, let engine = app.machines.engine(parts[2]) else { return (404, Data()) }
        let machine = engine.machine
        switch (method, parts.count > 3 ? parts[3] : nil, parts.count) {
        case ("DELETE", nil, 3):
            app.removeMachine(machine.id)
            return (200, Data("{}".utf8))
        case ("POST", "uninstall", 4):
            app.removeMachine(machine.id, uninstall: true)
            return (200, Data("{}".utf8))
        case ("POST", let action?, 4) where ["connect", "disconnect", "start"].contains(action):
            // What the page offers for it now, and only that.
            let offered = action == "connect" ? [.connect, .connectNow].contains(engine.offer) : engine.offer?.rawValue == action
            guard offered else { return (409, Self.message(Self.sentence(engine.statusTitle))) }
            switch action {
            case "connect": app.connect(engine)
            case "disconnect": app.disconnect(engine)
            default: app.startEngine(engine)
            }
            return (200, Self.json(["machine": Self.machineEntry(engine)]))
        case ("POST", "same-as", 4):
            guard let other = (body["other"] as? String).flatMap({ app.machines.engine($0) }), other.machine.id != machine.id else { return (404, Data()) }
            guard app.machines.sameComputer(machine.id, as: other.machine.id) else {
                return (409, Self.message("\(machine.name) and \(other.machine.name) are two computers: each told Kuvo Code its own name when it connected, and they differ, so they stay two machines."))
            }
            return (200, Self.json(["machine": Self.machineEntry(other)]))
        case ("DELETE", "addresses", 5):
            guard machine.otherAddresses?.contains(parts[4]) == true else { return (404, Data()) }
            app.machines.removeAddress(parts[4], from: machine.id)
            return (200, Self.json(["machine": Self.machineEntry(engine)]))
        default:
            return (404, Data())
        }
    }

    /// `kuvo/machines` and its events: the machines as Settings › Machines lists them, the hosts
    /// in this Mac's `~/.ssh/config` not added yet (what Add a Machine suggests), and the address
    /// last found to be a machine already here.
    func machinesJSON() -> Data? {
        guard let machines = bots?.app?.machines else { return nil }
        let added = Set(machines.list.flatMap(\.addresses))
        var answer: [String: Any] = [
            "machines": machines.list.compactMap { machines.engine($0.id).map(Self.machineEntry) },
            "hosts": SSHConfig.hosts().filter { !added.contains($0) },
        ]
        if let folded = machines.folded { answer["folded"] = ["address": folded.address, "machine": folded.machine] }
        return Self.json(answer)
    }

    /// `POST kuvo/machines` with `{destination}`: added as Add a Machine adds one, once it's
    /// checked; one already here (at that address, or another reaching the same computer) is
    /// answered with `known`.
    private func addMachine(_ destination: String?, app: AppModel) async -> (Int, Data) {
        let destination = (destination ?? "").trimmingCharacters(in: .whitespaces)
        guard !destination.isEmpty else { return (400, Self.message("Give the machine’s SSH host: a Host from ~/.ssh/config, or user@host.")) }
        do {
            let (id, known) = try await app.addMachine(checking: destination)
            guard let engine = app.machines.engine(id) else { return (404, Data()) }
            return (200, Self.json(["machine": Self.machineEntry(engine), "known": known]))
        } catch let failure as AppModel.MachineFailure {
            return (400, Self.message(failure.message))
        } catch {
            return (502, Self.message(error.localizedDescription))
        }
    }

    /// One machine as the page shows it: its name, its other addresses, where its connection is
    /// (`status` in the page's words, `failure` why it couldn't connect) and the button it offers.
    static func machineEntry(_ engine: MachineEngine) -> [String: Any] {
        var entry: [String: Any] = [
            "id": engine.machine.id, "name": engine.machine.name, "otherAddresses": engine.machine.otherAddresses ?? [],
            "connection": engine.connection.rawValue, "status": engine.statusText,
        ]
        if let failure = engine.failure { entry["failure"] = failure }
        if let offer = engine.offer { entry["action"] = offer.rawValue }
        return entry
    }

    /// A status title as a sentence: "Connected to lokum." but "Connecting to lokum…".
    private static func sentence(_ text: String) -> String {
        text.hasSuffix("…") ? text : text + "."
    }
}
