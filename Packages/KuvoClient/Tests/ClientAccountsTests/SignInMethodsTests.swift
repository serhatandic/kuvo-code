import ClientAccounts
import Foundation
import OpenCodeKit
import Testing

/// The ways to sign in and a sign-in's status, as both apps read the box's answers: what the box
/// offers (`Packages/KuvoLink/Vectors/sign-in.json`) comes through whole, in its order, each way
/// one a client can start, with its words and whether it's offered apart.
struct SignInMethodsTests {
    private static func vectors() throws -> [String: Any] {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/sign-in.json").standardized
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    @Test func theBoxsWaysInComeThroughInItsOrderWithItsWords() throws {
        let cases = try #require(try Self.vectors()["methods"] as? [[String: Any]])
        #expect(cases.count >= 5)
        for each in cases {
            let offered = try #require(each["offered"] as? [String: Any])
            let methods = try JSONDecoder().decode(SignInMethods.self, from: JSONSerialization.data(withJSONObject: offered))
            let said = try #require(offered["methods"] as? [[String: Any]])
            #expect(methods.methods.map(\.label) == said.map { $0["label"] as? String }, "\(each["provider"]!)")
            #expect(methods.methods.map(\.legacy) == said.map { $0["legacy"] as? Bool ?? false })
            #expect(methods.environment == offered["environment"] as? [String])
            // Each one a client starts as the engine lists it: its kind, its id, its questions.
            for (method, box) in zip(methods.methods, said) {
                switch method.method {
                case .oauth(let id, _, _): #expect(box["type"] as? String == "oauth" && box["id"] as? String == id)
                case .external(let id, _, _): #expect(box["type"] as? String == "external" && box["id"] as? String == id)
                case .key: #expect(box["type"] as? String == "key")
                default: Issue.record("\(each["provider"]!): \(method.method) isn't one a client can start")
                }
                #expect(method.method.form.count == (box["form"] as? [Any])?.count ?? 0)
            }
            // Legacy ones come after the others.
            #expect(methods.primary + methods.legacy == methods.methods)
        }
    }

    @Test func aFailedSignInsWordsComeWithItsStatus() throws {
        let json = #"{"status":"failed","message":"access_denied","failure":"The sign-in was turned down on its page. Try again to sign in."}"#
        let status = try JSONDecoder().decode(SignInStatus.self, from: Data(json.utf8))
        #expect(status.status == .failed)
        #expect(status.failure == "The sign-in was turned down on its page. Try again to sign in.")
        let pending = try JSONDecoder().decode(SignInStatus.self, from: Data(#"{"status":"pending","message":"Downloading… 40%","url":"https://example.com"}"#.utf8))
        #expect(pending.failure == nil && pending.url == "https://example.com")
    }

    @Test func itsRoutesNameTheAccountAndTheAttemptWhole() {
        #expect(SignInMethods.path(integration: "openai", agents: false) == "kuvo/sign-in/methods?integration=openai")
        #expect(SignInMethods.path(integration: "claude-code", agents: true) == "kuvo/sign-in/methods?integration=claude-code&agents=1")
        #expect(SignInStatus.path(integration: "a b", attempt: "att+1/&x", agents: false) == "kuvo/sign-in/status?integration=a%20b&attempt=att%2B1%2F%26x")
        #expect(SignInStatus.path(integration: "codex", attempt: "att_1", agents: true, wait: 20) == "kuvo/sign-in/status?integration=codex&attempt=att_1&agents=1&wait=20")
    }
}
