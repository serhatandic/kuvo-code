import XCTest
@testable import UsageKit

/// Covers `ProviderAuthRetry.requireSuccess`, the shared non-2xx triage the Claude/Codex/Grok mappers
/// and `CursorProvider` route through: 401/403 → the provider's auth-expired error, any other non-2xx →
/// the provider's request-failed error (carrying the status), and a 2xx returns without throwing.
final class ProviderAuthRetryTests: XCTestCase {
    private enum SampleError: Error, Equatable {
        case authExpired
        case requestFailed(Int)
    }

    private func requireSuccess(status: Int) throws {
        let response = HTTPResponse(statusCode: status, headers: [:], body: Data())
        try ProviderAuthRetry.requireSuccess(
            response,
            authExpired: SampleError.authExpired,
            requestFailed: { SampleError.requestFailed($0) }
        )
    }

    func testSuccessStatusesDoNotThrow() throws {
        for status in [200, 201, 204, 299] {
            try requireSuccess(status: status)
        }
    }

    func testUnauthorizedAndForbiddenThrowAuthExpired() {
        for status in [401, 403] {
            XCTAssertThrowsError(try requireSuccess(status: status)) { error in
                XCTAssertEqual(error as? SampleError, .authExpired)
            }
        }
    }

    func testOtherNon2xxThrowRequestFailedWithStatus() {
        for status in [400, 404, 429, 500, 503] {
            XCTAssertThrowsError(try requireSuccess(status: status)) { error in
                XCTAssertEqual(error as? SampleError, .requestFailed(status))
            }
        }
    }
}
