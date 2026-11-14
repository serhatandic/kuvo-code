import Foundation
import OpenCodeKit

/// Settings › Integrations of a computer, through its box (PROTOCOL.md, `kuvo/integrations` and
/// `kuvo/keys`), this Mac's as a machine's: the box adds and removes them, keeps their keys where
/// it keeps keys (this Mac's Keychain, through the app; a machine's own folder), and says how each
/// is doing. The app shows what it says.
extension AppModel {
    /// The box's id of a computer.
    private func boxID(_ box: SidebarBox) -> String { box.machine ?? BoxClient.mac }

    /// Those the box offers, in the page's order, with how each is doing there.
    func integrations(on box: SidebarBox) async throws -> Integrations.Listed {
        try await self.box(boxID(box)).value(Integrations.Listed.self, "GET", "kuvo/integrations")
    }

    /// The same, read again as Try Again does: this Mac's host interface started first when it
    /// isn't answering (it stopped, or never started), so keys its box couldn't reach are read again.
    func integrationsAgain(on box: SidebarBox) async throws -> Integrations.Listed {
        if box.machine == nil { await host.keepUp() }
        return try await integrations(on: box)
    }

    /// Added on `box`, as Connect (or Save, after its keys) does, with `keys` by their names
    /// (`CLIENT_ID`, `API_KEY`…) or those it has: one there already is written again as it is,
    /// so the engine reads its keys again, and with new keys its box connects its server again
    /// everywhere a moment later. It, as the box lists it now; what the box said, when it
    /// said no.
    @discardableResult
    func addIntegration(_ entry: Integrations.Entry, keys: [String: String]? = nil, on box: SidebarBox) async throws -> Integrations.Entry {
        struct Added: Decodable { var integration: Integrations.Entry }
        struct Given: Encodable { var keys: [String: String]? }
        let added = try await self.box(boxID(box)).value(Added.self, "POST", "kuvo/integrations/\(entry.id)", body: Given(keys: keys))
        // Back again: what its removal left to do on this machine, out of reach then, isn't done.
        if let machine = box.machine { machines.dropWaiting(marked: Machines.integrationMark(entry.id), on: machine) }
        if !entry.added { Analytics.shared.track("integration_added", ["integration": entry.id, "machine": BoxClient.isMachine(box.machine)]) }
        // The engine's settings as the box has them now, for the pages that show them.
        config(for: box).reload()
        return added.integration
    }

    /// Out of `box`'s settings, with its keys there, its sign-in, what its server kept and its
    /// bots' own keys for it, as Remove… does. Why not, when it couldn't be.
    func removeIntegration(_ id: String, on box: SidebarBox) async -> String? {
        defer { config(for: box).reload() }
        do {
            let (status, body) = try await self.box(boxID(box)).send("DELETE", "kuvo/integrations/\(id)")
            // Not there any more: nothing to take away.
            guard status >= 400, status != 404 else { return nil }
            return BoxRefusal(status: status, data: body).message
        } catch {
            return error.localizedDescription
        }
    }

    /// Its keys as `box` keeps them, by their names, for Change Key… to show: those it has.
    func integrationKeys(_ entry: Integrations.Entry, on box: SidebarBox) async -> [String: String] {
        struct Kept: Decodable { var value: String }
        var values: [String: String] = [:]
        for key in entry.keys ?? [] {
            let variable = IntegrationKeys.variable(entry.id, key.name)
            if let kept = try? await self.box(boxID(box)).value(Kept.self, "GET", "kuvo/keys/\(variable)") { values[key.name] = kept.value }
        }
        return values
    }
}
