import Foundation
import OpenCodeKit
import os

/// Keys a bot has of its own for integrations you bring a key for (a GitHub token of its own),
/// used only in its conversation and kept on the computer it lives on, by that computer's box
/// (`kuvo/bots/<id>/keys`, which a phone reaches too): for a bot on this Mac, in your Keychain
/// beside the shared ones (its box asks the app for them, `HostInterface`); for one on a machine,
/// on that machine, in `~/.kuvo-code/box/bot-keys`. Where it works, a settings file of its folder's
/// own, `.opencode/opencode.json`, names each such integration's server with its keys over the
/// shared ones, and no other bot's or session's settings name them. A bot that works in a project
/// shares that folder with your sessions there, so it uses the keys they do.
@MainActor
enum BotKeys {
    private static let log = Logger(subsystem: "run.kuvo.code", category: "integrations")

    /// The integrations a bot can have keys of its own for: those you bring a key or token for.
    /// (One you sign in to through your app is the same sign-in everywhere.)
    static var services: [Integrations.Service] {
        Integrations.all.filter { service in
            switch service.way {
            case .officialToken: true
            case .package(_, let keys, _, _, _, let macOnly): !keys.isEmpty && !macOnly
            default: false
            }
        }
    }

    /// What can be told of a bot's own keys where it lives.
    enum Status {
        /// The integrations it has every key of its own for, and those with a shared key.
        case read(own: Set<String>, shared: Set<String>)
        /// Its machine couldn't be asked, and why.
        case unreadable(String)

        var own: Set<String>? { if case .read(let own, _) = self { own } else { nil } }
    }

    static func status(of bot: Bot, app: AppModel) async -> Status {
        let place = bot.machine ?? "This Mac"
        do {
            let (status, body) = try await ask(bot, "GET", path(bot), app: app)
            if let failure = refusal(status, body) { return .unreadable(failure) }
            guard let listed = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["keys"] as? [[String: Any]] else {
                return .unreadable("\(place) didn’t say which keys it has. Its Kuvo Code may be older than this Mac’s.")
            }
            let ids = { (flag: String) in Set(listed.filter { $0[flag] as? Bool == true }.compactMap { $0["integration"] as? String }) }
            return .read(own: ids("own"), shared: ids("shared"))
        } catch {
            return .unreadable(error.localizedDescription)
        }
    }

    /// Saves `values` as `bot`'s own keys for `service` where it lives and puts them to use; why
    /// not, when they couldn't be.
    static func save(_ values: [String: String], for service: Integrations.Service, bot: Bot, app: AppModel) async -> String? {
        do {
            let (status, body) = try await ask(bot, "PUT", path(bot, service), body: ["keys": values], app: app)
            if let failure = refusal(status, body) { return failure }
            reconnect(service, bot: bot, app: app)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Takes away `bot`'s own keys for `service`, where it lives: it uses the shared one again, if
    /// there is one. Why not, when they couldn't be.
    @discardableResult
    static func remove(_ service: Integrations.Service, bot: Bot, app: AppModel) async -> String? {
        do {
            let (status, body) = try await ask(bot, "DELETE", path(bot, service), app: app)
            // Gone already: nothing to take away.
            if status == 404 { return nil }
            if let failure = refusal(status, body) { return failure }
            reconnect(service, bot: bot, app: app)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Its own keys where it lives now, by integration, each by its keys' names: to give it where
    /// it's going (`Moves`). Nil when they can't be read (its machine can't be asked).
    static func carried(_ bot: Bot, app: AppModel) async -> [String: [String: String]]? {
        guard let own = await status(of: bot, app: app).own else { return nil }
        var keys: [String: [String: String]] = [:]
        for service in services where own.contains(service.id) {
            guard let (status, body) = try? await ask(bot, "GET", path(bot, service), app: app), status == 200,
                  let values = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["keys"] as? [String: String] else { return nil }
            keys[service.id] = values
        }
        return keys
    }

    /// `bot`, where it's moved to, given the keys it had (`carried`), and its folder's settings
    /// made right for there (they came with it, naming its keys where it was).
    static func give(_ keys: [String: [String: String]], to bot: Bot, app: AppModel) async {
        for (id, values) in keys {
            guard let service = Integrations.service(id) else { continue }
            if let failure = await save(values, for: service, bot: bot, app: app) {
                log.error("A moved bot's own key didn't reach where it lives now: \(failure, privacy: .public)")
            }
        }
        await refresh(on: bot.machine, app: app)
    }

    /// A bot moving off where it lived (`Moves`, `bot` as it was there), once it's moved: its own
    /// keys where it was go, those it has where it lives now, so none is lost on the way.
    static func leave(_ bot: Bot, app: AppModel?) async {
        guard let app, let now = app.bots.bot(bot.id), now.machine != bot.machine,
              let there = await status(of: now, app: app).own else { return }
        for service in services where there.contains(service.id) {
            _ = try? await ask(bot, "DELETE", path(bot, service), app: app)
        }
    }

    /// As a machine's engine starts: keys this Mac kept for its bots from before they lived there
    /// go to it first, then each bot's folder settings there are made right for its catalog (which
    /// may be new). This Mac's box sees to its own as it starts.
    static func applyAll(on machine: String, app: AppModel) async {
        guard let engine = app.machines.engine(machine), engine.isReady else { return }
        let box = app.box(machine)
        await handOver(on: machine, app: app) { method, path, body in try await box.send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) }) }
        await refresh(on: machine, app: app)
    }

    /// Each bot's folder settings on a box made right for its keys and its integrations as they
    /// are now (after Settings › Integrations changed, or a bot moved there).
    static func refresh(on machine: String?, app: AppModel) async {
        if let machine, app.machines.engine(machine)?.isReady != true { return }
        let answer = try? await app.box(machine ?? BoxClient.mac).send("POST", "kuvo/bots/keys/refresh")
        // A machine's bridge from before the route: as it did it then.
        if answer?.status == 404, let machine, let engine = app.machines.engine(machine) {
            try? await MachineBox.refreshBotKeys(on: engine.machine.connection)
        }
    }

    /// A request to a machine's box: method, path and body in, status and body out.
    typealias Ask = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> (status: Int, body: Data)

    // COMPAT(0.7 bot-keys-keychain): machines' bots' keys this Mac's Keychain kept, given to their machines. Goes 3 months after 0.8.0.
    /// Keys this Mac kept for `machine`'s bots (an earlier Kuvo Code kept every bot's in your
    /// Keychain): each given to the machine (`ask`), then gone from your Keychain once it has it.
    /// Once this Mac's box has moved into a home of its own, the keys an earlier Kuvo Code kept are its
    /// helper's copies, which the app never reads: they come from the box (`kuvo/box/kept-keys`), and
    /// go from there once the machine has them.
    static func handOver(on machine: String, app: AppModel, ask: Ask) async {
        struct Kept: Decodable { var keys: [String: String] }
        let ownBox = OwnBoxHome.hasMoved ? app.box(SSHConnection.thisMac) : nil
        let names = ownBox == nil ? await Task.detached { IntegrationKeys.names }.value : []
        for bot in app.bots.list where bot.machine == machine && bot.project == nil {
            // This bot's own keys kept here, by their variables: from the box with their values, else
            // named in your Keychain, each read only once it's to go.
            var kept: [String: String]?
            if let ownBox { kept = (try? await ownBox.value(Kept.self, "GET", "kuvo/box/kept-keys?bot=\(bot.id)"))?.keys ?? [:] }
            let held = kept.map { Set($0.keys) } ?? Set(IntegrationKeys.variables(ofBot: bot.id, in: names))
            guard !held.isEmpty else { continue }
            for service in services {
                let variables = Integrations.keys(of: service.way).map { (name: $0.name, variable: IntegrationKeys.variable(service.id, $0.name, bot: bot.id)) }
                guard variables.allSatisfy({ held.contains($0.variable) }) else { continue }
                let values = if let kept {
                    Dictionary(uniqueKeysWithValues: variables.compactMap { key in kept[key.variable].map { (key.name, $0) } })
                } else {
                    await Task.detached {
                        Dictionary(uniqueKeysWithValues: variables.compactMap { key in IntegrationKeys.value(key.variable).map { (key.name, $0) } })
                    }.value
                }
                guard values.count == variables.count,
                      let (status, _) = try? await ask("PUT", path(bot, service), ["keys": values]), status == 200 else { continue }
                if let ownBox {
                    _ = try? await ownBox.send("DELETE", "kuvo/box/kept-keys?bot=\(bot.id)", body: JSONSerialization.data(withJSONObject: ["names": variables.map(\.variable)]))
                } else {
                    await Task.detached { for key in variables { IntegrationKeys.set(nil, for: key.variable) } }.value
                }
            }
        }
    }

    /// Its server connected again in its folder a moment after its keys changed on its machine,
    /// once the engine there has read them. (What a machine's box does ends with the SSH command
    /// that asked it; this Mac's, which keeps running, does it itself.)
    private static func reconnect(_ service: Integrations.Service, bot: Bot, app: AppModel) {
        guard let machine = bot.machine, let api = app.machines.engine(machine)?.api else { return }
        Task {
            try? await Task.sleep(for: .seconds(2))
            try? await api.connectMCP(service.id, directory: bot.directory)
        }
    }

    /// `kuvo/bots/<id>/keys`, and one integration's.
    private static func path(_ bot: Bot, _ service: Integrations.Service? = nil) -> String {
        "kuvo/bots/\(bot.id)/keys" + (service.map { "/\($0.id)" } ?? "")
    }

    /// A request to the box `bot` lives on, as a phone's goes: this Mac's, or its machine's while
    /// it's connected.
    private static func ask(_ bot: Bot, _ method: String, _ path: String, body: [String: Any]? = nil, app: AppModel) async throws -> (status: Int, body: Data) {
        if let machine = bot.machine, app.machines.engine(machine)?.isReady != true { throw Unreachable(machine: machine) }
        return try await app.box(bot.machine ?? BoxClient.mac).send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
    }

    private struct Unreachable: LocalizedError {
        var machine: String
        var errorDescription: String? { "\(machine) isn’t connected, so its bots’ keys can’t be changed now." }
    }

    /// Nil for a change its box made; else what it said.
    private static func refusal(_ status: Int, _ body: Data) -> String? {
        if (200..<300).contains(status) { return nil }
        return (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["message"] as? String ?? "It said no (\(status))."
    }
}
