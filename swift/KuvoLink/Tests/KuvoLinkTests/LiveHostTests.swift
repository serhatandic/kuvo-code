import Foundation
import Testing
@testable import KuvoLink

/// A host on a real relay, answering like the Mac does, for a phone (or the simulator) to pair
/// with: KUVO_TEST_HOST_RELAY names the relay, and the pairing link goes to KUVO_TEST_HOST_LINK
/// (a file). It serves for KUVO_TEST_HOST_SECONDS (20 by default).
@Suite(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_HOST_RELAY"] != nil))
struct LiveHostTests {
    @Test func answersPhones() async throws {
        let environment = ProcessInfo.processInfo.environment
        let relayURL = URL(string: environment["KUVO_TEST_HOST_RELAY"]!)!
        let key = LinkKey(), secret = RelaySecret()
        let link = PairingLink(relay: relayURL, host: secret.address, key: key.publicBytes, name: "Live host")
        let server = LinkServer(key: key, hello: HostHello(kind: .mac, name: "Live host", app: "0", engine: nil)) { _, _, hello in
            hello.pair == link.token.base64URL
        } handle: { request, _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": "text/plain"]))
                continuation.yield(.body(Data("hello from \(request.path)".utf8)))
                continuation.finish()
            }
        }
        let connection = try await WebSocketRelay.connect(to: relayURL, secret: secret)
        if let file = environment["KUVO_TEST_HOST_LINK"] { try link.url.absoluteString.write(toFile: file, atomically: true, encoding: .utf8) }
        let serving = Task { await server.serve(connection) }
        try await Task.sleep(for: .seconds(Double(environment["KUVO_TEST_HOST_SECONDS"] ?? "20") ?? 20))
        serving.cancel()
        connection.close()
    }
}
