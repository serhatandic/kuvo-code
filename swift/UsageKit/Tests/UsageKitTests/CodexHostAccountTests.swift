import XCTest
import os
@testable import UsageKit

/// Fork: the Codex card reads the ChatGPT account signed in to the host before any login on the Mac,
/// and never renews or saves it.
@MainActor
final class CodexHostAccountTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let cliAuth = #"{"tokens":{"access_token":"cli-token","refresh_token":"cli-refresh"},"last_refresh":"2000-01-01T00:00:00Z"}"#
    private nonisolated static let weekly = Data(
        #"{"rate_limit":{"secondary_window":{"used_percent":58,"limit_window_seconds":604800,"reset_after_seconds":3600}}}"#.utf8
    )

    func testHostSignInComesFirstAndIsNeverRenewed() async {
        let host = HostBox(token: token(account: "acct-host", expiresIn: 3600))
        let files = FakeFiles(["/tmp/codex-home/auth.json": cliAuth])
        let http = usageRoutes(accepting: [host.token])

        let snapshot = await makeProvider(host: host, files: files, http: http).refresh()

        XCTAssertEqual(weeklyUsed(snapshot), 58)
        let usage = http.requests.filter { $0.url == CodexUsageClient.usageURL }
        XCTAssertEqual(usage.map { $0.headers["Authorization"] }, ["Bearer \(host.token)"])
        XCTAssertEqual(usage.first?.headers["ChatGPT-Account-Id"], "acct-host")
        XCTAssertFalse(http.requests.contains { $0.url == CodexUsageClient.refreshURL })
        XCTAssertEqual(files.files["/tmp/codex-home/auth.json"], cliAuth)
    }

    func testRejectedHostSignInDoesNotFallBackToTheCLILogin() async {
        let host = HostBox(token: token(account: "acct-host", expiresIn: 3600))
        let files = FakeFiles(["/tmp/codex-home/auth.json": cliAuth])
        let http = usageRoutes(accepting: ["cli-token"])

        let snapshot = await makeProvider(host: host, files: files, http: http).refresh()

        XCTAssertEqual(snapshot.errorCategory, .authExpired)
        XCTAssertEqual(host.rereads, 1)
        XCTAssertFalse(http.requests.contains { $0.headers["Authorization"] == "Bearer cli-token" })
        XCTAssertFalse(http.requests.contains { $0.url == CodexUsageClient.refreshURL })
        XCTAssertEqual(files.files["/tmp/codex-home/auth.json"], cliAuth)
    }

    func testLapsedHostTokenIsReadAgainFromTheHost() async {
        let renewed = token(account: "acct-host", expiresIn: 3600)
        let host = HostBox(token: token(account: "acct-host", expiresIn: -60), renewed: renewed)
        let http = usageRoutes(accepting: [renewed])

        let snapshot = await makeProvider(host: host, files: FakeFiles(), http: http).refresh()

        XCTAssertEqual(weeklyUsed(snapshot), 58)
        XCTAssertEqual(host.rereads, 1)
        XCTAssertEqual(http.requests.filter { $0.url == CodexUsageClient.usageURL }.map { $0.headers["Authorization"] },
                       ["Bearer \(renewed)"])
    }

    func testRejectedHostTokenIsReadAgainFromTheHost() async {
        let renewed = token(account: "acct-host", expiresIn: 7200)
        let host = HostBox(token: token(account: "acct-host", expiresIn: 3600), renewed: renewed)
        let http = usageRoutes(accepting: [renewed])

        let snapshot = await makeProvider(host: host, files: FakeFiles(), http: http).refresh()

        XCTAssertEqual(weeklyUsed(snapshot), 58)
        XCTAssertEqual(host.rereads, 1)
    }

    func testAccountCardsFollowTheHostSignIn() async {
        let host = HostBox(token: token(account: "acct-host", expiresIn: 3600))
        let files = FakeFiles(["/tmp/codex-home/auth.json": cliAuth])

        let other = usageRoutes(accepting: [host.token, "cli-token"])
        let otherCard = await makeProvider(host: host, files: files, http: other,
                                           expectedIdentity: CodexAccountIdentity(accountID: "acct-other", email: nil)).refresh()
        XCTAssertEqual(otherCard.errorCategory, .notLoggedIn)
        XCTAssertTrue(other.requests.isEmpty)

        let same = usageRoutes(accepting: [host.token])
        let sameCard = await makeProvider(host: host, files: files, http: same,
                                          expectedIdentity: CodexAccountIdentity(accountID: "acct-host", email: nil)).refresh()
        XCTAssertEqual(weeklyUsed(sameCard), 58)
    }

    func testOnlyASignInStandsForTheHostAccount() {
        let key = HostCredential(integrationID: "openai", secret: "sk-key")
        let signIn = HostCredential(integrationID: "openai", secret: "access", signedIn: true, accountID: "acct")
        let blank = HostCredential(integrationID: "openai", secret: "  ", signedIn: true)
        XCTAssertNil(HostAccounts.signIn(for: "openai", in: [key, blank]))
        XCTAssertEqual(HostAccounts.signIn(for: "openai", in: [key, signIn]), signIn)
        XCTAssertNil(HostAccounts.signIn(for: "xai", in: [signIn]))
        XCTAssertNil(CodexAuthStore(
            environment: FakeEnvironment([:]), files: FakeFiles(), keychain: FakeKeychain(), hostSignIn: { nil }
        ).hostCandidate())
    }

    // MARK: - Helpers

    private func makeProvider(
        host: HostBox, files: FakeFiles, http: RoutingHTTPClient,
        expectedIdentity: CodexAccountIdentity? = nil
    ) -> CodexProvider {
        let now = now
        return CodexProvider.isolated(
            localHistoryWait: .zero,
            authStore: CodexAuthStore(
                environment: FakeEnvironment(["CODEX_HOME": "/tmp/codex-home"]),
                files: files,
                keychain: FakeKeychain(),
                now: { now },
                expectedIdentity: expectedIdentity,
                hostSignIn: { host.credential },
                rereadHost: { host.reread() }
            ),
            usageClient: CodexUsageClient(http: http),
            now: { now }
        )
    }

    /// Answers the usage request for the given tokens and turns any other away.
    private func usageRoutes(accepting tokens: [String]) -> RoutingHTTPClient {
        let accepted = Set(tokens.map { "Bearer \($0)" })
        return RoutingHTTPClient { request in
            guard request.url == CodexUsageClient.usageURL else {
                return HTTPResponse(statusCode: 404, headers: [:], body: Data())
            }
            guard let auth = request.headers["Authorization"], accepted.contains(auth) else {
                return HTTPResponse(statusCode: 401, headers: [:], body: Data())
            }
            return HTTPResponse(statusCode: 200, headers: [:], body: Self.weekly)
        }
    }

    private func weeklyUsed(_ snapshot: ProviderSnapshot) -> Double? {
        guard case .progress(_, let used, _, _, _, _, _) = snapshot.line(label: "Weekly") else { return nil }
        return used
    }

    /// A JWT-shaped ChatGPT access token for `account`, expiring `expiresIn` seconds from `now`.
    private func token(account: String, expiresIn: TimeInterval) -> String {
        func b64url(_ string: String) -> String {
            Data(string.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let exp = Int(now.addingTimeInterval(expiresIn).timeIntervalSince1970)
        let payload = #"{"exp":\#(exp),"https://api.openai.com/auth":{"chatgpt_account_id":"\#(account)"}}"#
        return b64url(#"{"alg":"RS256","typ":"JWT"}"#) + "." + b64url(payload) + ".sig"
    }
}

/// The host's ChatGPT sign-in, which a re-read may replace with the engine's renewed token.
private final class HostBox: Sendable {
    private struct State {
        var token: String
        var renewed: String?
        var rereads = 0
    }

    private let state: OSAllocatedUnfairLock<State>

    init(token: String, renewed: String? = nil) {
        state = OSAllocatedUnfairLock(initialState: State(token: token, renewed: renewed))
    }

    var token: String { state.withLock { $0.token } }
    var rereads: Int { state.withLock { $0.rereads } }

    var credential: HostCredential {
        let token = token
        let account = ProviderParse.jwtPayload(token)
            .flatMap { DefaultAccountObserver.chatGPTAccountID(inIDTokenPayload: $0) }
        return HostCredential(integrationID: "openai", secret: token, signedIn: true, accountID: account)
    }

    func reread() {
        state.withLock {
            $0.rereads += 1
            if let renewed = $0.renewed { $0.token = renewed }
        }
    }
}
