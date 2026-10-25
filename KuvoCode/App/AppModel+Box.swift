import Foundation
import KuvoLink
import OpenCodeKit

extension AppModel {
    /// A box's routes, for the app's stores, as a phone reaches them: this Mac's (`BoxClient.mac`),
    /// or a machine's by its id.
    func box(_ id: String) -> BoxClient {
        guard id == BoxClient.mac else {
            return BoxClient(box: id, transport: MachineBoxTransport(connection: SSHConnection(destination: id)))
        }
        // While the engine's down, the box's own routes still answer; the engine's say it's down.
        let endpoint = server?.endpoint ?? ServerEndpoint(url: URL(string: "http://127.0.0.1:9/")!, password: nil)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        let password = endpoint.password
        let agents = agents.address
        let link = phoneLink
        return BoxClient(box: id, transport: LocalBox { request in
            PhoneLink.respond(to: request, link: link, engine: base, password: password, agents: agents)
        })
    }

    /// What this Mac's box is started with, beside your shell's environment: the app's own
    /// kuvo-wake, with which it sends this Mac's wake-ups as a machine's keeper sends its own; the
    /// app's host interface, through which it keeps bots' keys in your Keychain (without it, it
    /// can't reach them, and says so, rather than keep them elsewhere); and Settings › Integrations'
    /// catalog with this Mac's own paths.
    func boxEnvironment(_ shell: [String: String]) async -> [String: String] {
        try? WakeUps.installCommand()
        var environment = shell
        environment["KUVO_WAKE_COMMAND"] = WakeUps.command.path
        environment["KUVO_KEYS_ON_HOST"] = "1"
        // A listener that couldn't start once gets a second try.
        var hosting = try? await host.start()
        if hosting == nil { hosting = try? await host.start() }
        if let hosting { environment.merge(hosting) { _, new in new } }
        MachineBox.writeMacCatalog()
        return environment
    }
}
