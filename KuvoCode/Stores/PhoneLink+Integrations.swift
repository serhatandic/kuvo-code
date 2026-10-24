import Foundation
import KuvoLink
import OpenCodeKit

/// Settings › Integrations for a phone (PROTOCOL.md, "Integrations"): this Mac's, added and
/// removed as the page does it, keys in your Keychain. A machine's bridge answers the same paths
/// for its own.
extension PhoneLink {
    func answerIntegrations(_ request: LinkRequest) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let path = URLComponents(string: request.path)?.percentEncodedPath ?? request.path
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map { String($0).removingPercentEncoding ?? String($0) }
        let method = request.method.uppercased()
        if parts.count == 2 {
            guard method == "GET" else { return (405, Data("{}".utf8)) }
            let config = app.config(for: .mac)
            config.reload()
            var answer: [String: Any] = ["integrations": await Self.entries(Integrations.all, app: app)]
            if let problem = config.problem { answer["problem"] = problem }
            return (200, Self.json(answer))
        }
        guard parts.count == 3, let service = Integrations.service(parts[2]) else { return (404, Data("{}".utf8)) }
        switch method {
        case "POST": return await add(service, request.body, app: app)
        case "DELETE":
            let config = app.config(for: .mac)
            config.reload()
            if let problem = config.problem { return (409, Self.message("The engine's settings file can't be changed from here: \(problem)")) }
            guard config.value(at: MCPSettings.path + [service.id]) != nil else { return (404, Data("{}".utf8)) }
            if let why = await app.removeIntegration(service, on: .mac) { return (409, Self.message(why)) }
            return (200, Data("{}".utf8))
        default: return (405, Data("{}".utf8))
        }
    }

    /// `POST kuvo/integrations/<id>` with `{keys?}`: added as Connect does, with the keys it needs
    /// given (or kept from before): `{integration}`, as it's listed.
    private func add(_ service: Integrations.Service, _ body: Data, app: AppModel) async -> (Int, Data) {
        if case .browser = service.way {
            return (409, Self.message("The agent uses \(service.title) on its site: sign in to it in the browser on this Mac."))
        }
        let config = app.config(for: .mac)
        config.reload()
        if let problem = config.problem { return (409, Self.message("The engine's settings file can't be changed from here: \(problem)")) }
        let keys = Integrations.keys(of: service.way)
        let given = ((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["keys"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
        if !keys.isEmpty {
            let complete = keys.allSatisfy { !(given[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            if complete {
                do {
                    try await app.saveIntegrationKeys(service, given, on: .mac)
                } catch {
                    return (500, Self.message(error.localizedDescription))
                }
            } else if !keys.allSatisfy({ IntegrationKeys.value(IntegrationKeys.variable(service.id, $0.name)) != nil }) {
                return (400, Self.message("\(service.title) needs \(keys.map(\.label).joined(separator: " and ")): send them as {\"keys\": {\"\(keys[0].name)\": …}}."))
            }
        }
        guard app.addIntegration(service, on: .mac) else { return (409, Self.message(config.problem ?? "It couldn't be added.")) }
        if !keys.isEmpty { Task { await app.reconnectAfterKeys(service, on: .mac) } }
        let entry = await Self.entries([service], app: app).first ?? [:]
        return (200, Self.json(["integration": entry]))
    }

    /// Each as `kuvo/integrations` lists it, with how it's doing on this Mac.
    private static func entries(_ services: [Integrations.Service], app: AppModel) async -> [[String: Any]] {
        let config = app.config(for: .mac)
        let api = app.api(for: .mac)
        let servers = (try? await api?.mcpServers()) ?? []
        let signedIn = Set(((try? await api?.credentialEntries()) ?? []).filter { $0.active && $0.isOAuth }.map(\.integrationID))
        // Which keys this Mac has, off the main thread: the Keychain can wait on you.
        let saved = await Task.detached {
            Set(services.flatMap { service in Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name) } }
                .filter { IntegrationKeys.value($0) != nil })
        }.value
        // Whether the browser here is signed in to the sites the agent uses, read now.
        if services.contains(where: { if case .browser = $0.way { true } else { false } }) { await SiteSignIns.shared.refreshMac() }
        // (`Integrations.all` is in the page's order, by kind.)
        return services.map { service in
            var entry = described(service)
            let added = config.value(at: MCPSettings.path + [service.id]) != nil
            entry["added"] = added
            let keys = Integrations.keys(of: service.way)
            if !keys.isEmpty { entry["keysSaved"] = keys.allSatisfy { saved.contains(IntegrationKeys.variable(service.id, $0.name)) } }
            if added {
                let server = servers.first { $0.name == service.id }
                entry["health"] = Integrations.health(service, server: server, off: Integrations.isOff(service, in: config), signedIn: signedIn,
                                                      waitsForCode: Integrations.waitsForCode(service)).rawValue
                if let integration = server?.integrationID { entry["signIn"] = integration }
            }
            if case .browser = service.way, let signed = SiteSignIns.shared.isSignedIn(service.id, on: nil) { entry["siteSignedIn"] = signed }
            return entry
        }
    }

    /// What it is and how it's added, as a computer's catalog has it (`MachineBox.integrationsJSON`
    /// writes the same for a machine).
    static func described(_ service: Integrations.Service) -> [String: Any] {
        var entry: [String: Any] = [
            "id": service.id, "title": service.title, "summary": service.summary, "kind": service.kind.rawValue,
            "symbol": service.symbol, "site": service.site, "how": IntegrationsSettings.how(service.way),
        ]
        switch service.way {
        case .official: entry["way"] = "official"
        case .officialToken(_, _, let help): entry["way"] = "token"; entry["help"] = help
        case .officialApp(_, let help): entry["way"] = "app"; entry["help"] = help; entry["redirect"] = Integrations.redirect
        case .package(_, _, let help, let by, _, let macOnly):
            entry["way"] = "package"
            entry["by"] = by
            if let help { entry["help"] = help }
            if macOnly { entry["macOnly"] = true }
        case .browser: entry["way"] = "browser"
        }
        let keys = Integrations.keys(of: service.way)
        if !keys.isEmpty { entry["keys"] = keys.map { ["name": $0.name, "label": $0.label, "prompt": $0.prompt] } }
        return entry
    }
}
