import Foundation
import KuvoLink

/// A bot's keys of its own for a phone (PROTOCOL.md, "Bots' own keys"), as Edit Bot shows and
/// changes them, for a bot that lives on this Mac: in your Keychain. A machine's bot's are on that
/// machine, and its bridge answers the same paths for them.
extension PhoneLink {
    func answerBotKeys(_ request: LinkRequest) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let route = request.path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? request.path
        let parts = route.split(separator: "/", omittingEmptySubsequences: false).map { String($0).removingPercentEncoding }
        guard parts.count >= 4, let id = parts[2], let bot = app.bots.bot(id) else { return (404, Self.message("That bot isn't on this Mac.")) }
        if let machine = bot.machine { return (409, Self.message("\(bot.name) lives on \(machine): its keys are there, and \(machine) answers for them.")) }
        if bot.project != nil { return (409, Self.message("\(bot.name) works in a project, so it uses the keys that project's sessions use.")) }
        let method = request.method.uppercased()
        if parts.count == 4 {
            switch method {
            case "GET":
                let (own, shared) = await BotKeys.keychainStatus(of: bot.id)
                return (200, Self.json(["keys": BotKeys.services.map { ["integration": $0.id, "own": own.contains($0.id), "shared": shared.contains($0.id)] }]))
            case "DELETE":
                // All of them, as it leaves this Mac.
                for service in BotKeys.services { await BotKeys.remove(service, bot: bot, app: app) }
                return (200, Data("{}".utf8))
            default:
                return (405, Data("{}".utf8))
            }
        }
        guard parts.count == 5, let service = parts[4].flatMap({ id in BotKeys.services.first { $0.id == id } }) else {
            return (404, Self.message("A bot can't have a key of its own for that."))
        }
        let names = Integrations.keys(of: service.way)
        let own = await BotKeys.keychainStatus(of: bot.id).own.contains(service.id)
        switch method {
        case "GET":
            guard own else { return (404, Data("{}".utf8)) }
            let values = await Task.detached {
                Dictionary(uniqueKeysWithValues: names.map { ($0.name, IntegrationKeys.value(IntegrationKeys.variable(service.id, $0.name, bot: bot.id)) ?? "") })
            }.value
            return (200, Self.json(["keys": values]))
        case "PUT":
            let given = ((try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["keys"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
            guard names.allSatisfy({ !(given[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                return (400, Self.message("\(service.title) needs \(names.map(\.label).joined(separator: " and ")): send them as {\"keys\": {\"\(names[0].name)\": …}}."))
            }
            if let failure = await BotKeys.save(given, for: service, bot: bot, app: app) { return (500, Self.message(failure)) }
            let shared = await BotKeys.keychainStatus(of: bot.id).shared.contains(service.id)
            return (200, Self.json(["integration": service.id, "own": true, "shared": shared]))
        case "DELETE":
            guard own else { return (404, Data("{}".utf8)) }
            await BotKeys.remove(service, bot: bot, app: app)
            return (200, Data("{}".utf8))
        default:
            return (405, Data("{}".utf8))
        }
    }
}
