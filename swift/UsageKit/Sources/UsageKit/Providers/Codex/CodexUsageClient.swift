import Foundation

struct CodexRefreshResponse: Sendable, Equatable {
    var accessToken: String
    var refreshToken: String?
    var idToken: String?
}

struct CodexUsageClient: Sendable {
    static let clientID = "app_EMoamEEZ73f0CkXaXp7hrann"
    static let refreshURL = URL(string: "https://auth.openai.com/oauth/token")!
    static let usageURL = URL(string: "https://chatgpt.com/backend-api/wham/usage")!
    static let resetCreditsURL = URL(string: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")!
    static let consumeResetCreditURL = URL(string: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume")!

    var http: any HTTPClient

    init(http: any HTTPClient = URLSessionHTTPClient()) {
        self.http = http
    }

    func refreshToken(_ refreshToken: String) async throws -> CodexRefreshResponse {
        let body =
            "grant_type=refresh_token" +
            "&client_id=\(Self.clientID.urlFormEncoded)" +
            "&refresh_token=\(refreshToken.urlFormEncoded)"

        let response = try await http.send(HTTPRequest(
            method: "POST",
            url: Self.refreshURL,
            headers: ["Content-Type": "application/x-www-form-urlencoded"],
            body: Data(body.utf8),
            timeout: 15
        ))

        if response.statusCode == 400 || response.statusCode == 401 {
            let errorBody = ProviderParse.jsonObject(response.body)
            let code = errorBody?["error"].flatMap { errorValue -> String? in
                if let error = errorValue as? [String: Any] {
                    return error["code"] as? String ?? error["error"] as? String
                }
                return errorValue as? String
            } ?? errorBody?["code"] as? String

            switch code {
            case "refresh_token_expired":
                throw CodexAuthError.sessionExpired
            case "refresh_token_reused":
                throw CodexAuthError.tokenConflict
            case "refresh_token_invalidated":
                throw CodexAuthError.tokenRevoked
            default:
                // No recognized OAuth error code (often a non-JSON proxy/WAF page) — report the HTTP
                // status rather than asserting token expiry the user can't fix by re-logging in.
                throw CodexUsageError.requestFailed(response.statusCode)
            }
        }

        // A non-2xx that isn't a 400/401 (a 5xx, a gateway error) is a request failure, not an expired
        // token — surface the status. A 2xx whose body carries no usable access token is treated as a
        // dead session (re-login is the right remedy).
        guard (200..<300).contains(response.statusCode) else {
            throw CodexUsageError.requestFailed(response.statusCode)
        }
        guard let body = ProviderParse.jsonObject(response.body),
              let accessToken = body["access_token"] as? String,
              !accessToken.isEmpty
        else {
            throw CodexAuthError.tokenExpired
        }

        return CodexRefreshResponse(
            accessToken: accessToken,
            refreshToken: body["refresh_token"] as? String,
            idToken: body["id_token"] as? String
        )
    }

    func fetchUsage(accessToken: String, accountID: String?) async throws -> HTTPResponse {
        var headers = [
            "Authorization": "Bearer \(accessToken)",
            "Accept": "application/json",
            "User-Agent": HostApp.userAgent
        ]
        if let accountID, !accountID.isEmpty {
            headers["ChatGPT-Account-Id"] = accountID
        }

        return try await http.send(HTTPRequest(
            method: "GET",
            url: Self.usageURL,
            headers: headers,
            timeout: 10
        ))
    }

    /// On-demand rate-limit reset credits, including each credit's expiry — a separate endpoint from
    /// `usage` (the usage body's `rate_limit_reset_credits` carries only the count, no expiry list). The
    /// extra headers mirror the Codex desktop client, which the endpoint expects. Best-effort: the
    /// provider tolerates a failure here and falls back to the usage body's count.
    func fetchResetCredits(accessToken: String, accountID: String?) async throws -> HTTPResponse {
        var headers = [
            "Authorization": "Bearer \(accessToken)",
            "Accept": "application/json",
            "User-Agent": HostApp.userAgent,
            "OpenAI-Beta": "codex-1",
            "originator": "Codex Desktop"
        ]
        if let accountID, !accountID.isEmpty {
            headers["ChatGPT-Account-Id"] = accountID
        }

        return try await http.send(HTTPRequest(
            method: "GET",
            url: Self.resetCreditsURL,
            headers: headers,
            timeout: 10
        ))
    }

    /// Consumes (claims) one rate-limit reset credit — the protocol the Codex CLI uses, verified live
    /// and documented in docs/research/codex-reset-credit-claim.md. `redeemRequestID` is the caller's
    /// idempotency key (a UUID minted once per credit and reused on retry, so a retried claim can never
    /// burn a second credit — the server answers `already_redeemed`); `creditID` targets exactly one
    /// credit, never letting the server pick. The outcome rides in the 200 body's `code`
    /// (reset / already_redeemed / nothing_to_reset / no_credit) — see
    /// `CodexResetClaimService.outcome(fromConsume:)`.
    func consumeResetCredit(
        accessToken: String,
        accountID: String?,
        creditID: String,
        redeemRequestID: String
    ) async throws -> HTTPResponse {
        var headers = [
            "Authorization": "Bearer \(accessToken)",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": HostApp.userAgent,
            "OpenAI-Beta": "codex-1",
            "originator": "Codex Desktop"
        ]
        if let accountID, !accountID.isEmpty {
            headers["ChatGPT-Account-Id"] = accountID
        }

        let payload = ["redeem_request_id": redeemRequestID, "credit_id": creditID]
        let body = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return try await http.send(HTTPRequest(
            method: "POST",
            url: Self.consumeResetCreditURL,
            headers: headers,
            body: body,
            timeout: 15
        ))
    }

}

