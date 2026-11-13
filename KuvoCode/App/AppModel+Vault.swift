import ClientVault
import Foundation

extension AppModel {
    /// The vault's tools for this Mac's conversations, which its box lists and carries out
    /// (KuvoLink's PROTOCOL.md, "Vault"), and the fills its browser asks it for; and the sandbox's,
    /// alike ("Sandbox").
    func wireVault() {
        Vaults.shared.client = { [weak self] box in self?.box(box) }
        Sandboxes.shared.client = { [weak self] box in self?.box(box) }
        Vaults.shared.proof = { [weak self] machine in self?.phoneLink.vaultProof(machine: machine) }
        Vaults.shared.requestProof = { [weak self] machine, method, path, body in self?.phoneLink.vaultRequestProof(machine: machine, method: method, path: path, body: body) }
        // This Mac's vault, for the panel browser's sign-ins (those kept before it moved in), once
        // its box answers.
        Task {
            for _ in 0..<60 {
                if await Passwords.ready() { break }
                try? await Task.sleep(for: .seconds(10))
            }
        }
        #if DEBUG
        // KUVO_DEMO_VAULT: this Mac's vault with sample items, for a look at its pages.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_VAULT"] != nil {
            Task { [weak self] in
                await Self.seedDemoVault()
                // KUVO_DEMO_VAULT_ASK: the first bot asks the vault for that, as vault_ask does.
                guard let need = ProcessInfo.processInfo.environment["KUVO_DEMO_VAULT_ASK"] else { return }
                for _ in 0..<60 {
                    if let session = self?.bots.list.first?.sessionID {
                        _ = await BrowserTools.vault("vault_ask", ["need": need, "why": "To upload tonight’s build to TestFlight.", "site": "appstoreconnect.apple.com"], session)
                        return
                    }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
        #endif
        BrowserTools.vaultDefinitions = { [weak self] in
            if let kept = VaultTools.definitions { return kept }
            guard let self, let answer = try? await box(BoxClient.thisMac).send("GET", "kuvo/vault/tools"), answer.status == 200,
                  let tools = (try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any])?["tools"] as? [[String: Any]] else { return [] }
            VaultTools.definitions = tools
            return tools
        }
        BrowserTools.vault = { [weak self] name, arguments, caller in
            guard let self else { return ("Kuvo Code isn't ready yet.", true) }
            return await callBoxTool("kuvo/vault/tools", name, arguments, caller, unreachable: "This Mac's vault can't be reached now. Try again in a moment.", failed: "The vault couldn't do that")
        }
        // (Asked each time it's empty: the sandbox is set up as the box starts, and checked again.)
        BrowserTools.sandboxDefinitions = { [weak self] in
            if let kept = SandboxTools.definitions { return kept }
            guard let self, let answer = try? await box(BoxClient.thisMac).send("GET", "kuvo/sandbox/tools"), answer.status == 200,
                  let tools = (try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any])?["tools"] as? [[String: Any]] else { return [] }
            if !tools.isEmpty { SandboxTools.definitions = tools }
            return tools
        }
        BrowserTools.sandbox = { [weak self] name, arguments, caller in
            guard let self else { return ("Kuvo Code isn't ready yet.", true) }
            return await callBoxTool("kuvo/sandbox/tools", name, arguments, caller, unreachable: "This Mac's box can't be reached now. Try again in a moment.", failed: "The sandbox couldn't do that")
        }
        // The Work Queue's tools (KuvoLink's PROTOCOL.md, "The Work Queue"), and what agents are
        // told of them, in this Mac's box's own words.
        BrowserTools.workQueueDefinitions = { [weak self] in
            if let kept = WorkQueueTools.kept { return kept }
            guard let self, let answer = try? await box(BoxClient.thisMac).send("GET", "kuvo/work-queue/tools"), answer.status == 200,
                  let said = try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any],
                  let tools = said["tools"] as? [[String: Any]] else { return ([], "") }
            let kept = (tools, said["instructions"] as? String ?? "")
            WorkQueueTools.kept = kept
            return kept
        }
        BrowserTools.workQueue = { [weak self] name, arguments, caller in
            guard let self else { return ("Kuvo Code isn't ready yet.", true) }
            return await callBoxTool("kuvo/work-queue/tools", name, arguments, caller, unreachable: "This Mac's box can't be reached now. Try again in a moment.", failed: "The Work Queue couldn't do that")
        }
        BrowserTools.vaultFill = { [weak self] body in
            guard let self, let data = try? JSONSerialization.data(withJSONObject: body),
                  let answer = try? await box(BoxClient.thisMac).send("POST", "kuvo/vault/fill", body: data) else { return nil }
            return (answer.status, ((try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any]) ?? [:])
        }
    }

    /// One of the tools this Mac's box carries out for a conversation (`POST <route>`).
    private func callBoxTool(_ route: String, _ name: String, _ arguments: [String: Any], _ caller: String?, unreachable: String, failed: String) async -> (text: String, isError: Bool) {
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let answer = try? await box(BoxClient.thisMac).send("POST", route, body: data) else { return (unreachable, true) }
        let said = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any]
        guard answer.status == 200, let text = said?["text"] as? String else { return (said?["message"] as? String ?? "\(failed) (\(answer.status)).", true) }
        return (text, said?["isError"] as? Bool ?? false)
    }
}

#if DEBUG
extension AppModel {
    /// Sample items in this Mac's vault, once its box answers, made only where they aren't yet.
    static func seedDemoVault() async {
        for _ in 0..<60 {
            await Vaults.shared.refresh(BoxClient.mac)
            if Vaults.shared[BoxClient.mac].vault != nil { break }
            try? await Task.sleep(for: .seconds(2))
        }
        let have = Set((Vaults.shared[BoxClient.mac].vault?.items ?? []).map(\.name))
        let samples: [VaultDraft] = [
            .init(kind: .login, name: "App Store Connect", sites: ["appstoreconnect.apple.com"], username: "you@example.com", values: ["password": "sample-password-1"]),
            .init(kind: .key, name: "App Store Connect API key", sites: ["api.appstoreconnect.apple.com"], values: ["value": "sample-key-id", "issuer_id": "sample-issuer"]),
            .init(kind: .file, name: "AuthKey_7QX2.p8", fileName: "AuthKey_7QX2.p8", values: ["file": Data("-----BEGIN PRIVATE KEY-----\nsample\n-----END PRIVATE KEY-----\n".utf8).base64EncodedString()]),
            .init(kind: .login, name: "GitHub", sites: ["github.com"], username: "kuvo-bots", values: ["password": "sample-password-2"]),
            .init(kind: .note, name: "App Review contact", readable: true, values: ["text": "Alex Doe, +1 555 0100"]),
            .init(kind: .key, name: "Stripe test key", sites: ["api.stripe.com"], values: ["value": "sk_test_sample"]),
        ]
        for sample in samples where !have.contains(sample.name) {
            _ = try? await Vaults.shared.add(sample, on: BoxClient.mac)
        }
    }
}
#endif

/// The vault tools' definitions, as this Mac's box gave them: asked once a launch.
@MainActor
enum VaultTools {
    static var definitions: [[String: Any]]?
}

/// The sandbox's tool, as this Mac's box gave it, once it did.
@MainActor
enum SandboxTools {
    static var definitions: [[String: Any]]?
}

/// The Work Queue's tools and what agents are told of them, as this Mac's box gave them, once it did.
@MainActor
enum WorkQueueTools {
    static var kept: (tools: [[String: Any]], instructions: String)?
}
