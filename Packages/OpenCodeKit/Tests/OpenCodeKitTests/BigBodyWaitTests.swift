import Foundation
import Testing
@testable import OpenCodeKit

/// A request with a big body (a video shared from the phone) waits for its answer as long again as
/// its body takes to go on a slow connection: nothing comes back until it's all there (#358).
@Suite struct BigBodyWaitTests {
    @Test func aBigBodyWaitsLongerForItsAnswer() async throws {
        // A request waits a second with nothing coming; the answer takes two. Its body takes three
        // more on a slow connection.
        let client = SlowAnswer.client(idle: 1)
        var request = try client.request("POST", "api/session/ses_1/prompt", body: Empty?.none)
        request.timeoutInterval = 1
        request.httpBody = Data(count: 3 * HTTPClient.slowUpload)
        _ = try await client.send(request, as: Empty.self)
    }

    @Test func aSmallBodyWaitsAsLongAsEver() async throws {
        let client = SlowAnswer.client(idle: 1)
        var request = try client.request("POST", "api/session/ses_1/prompt", body: Empty?.none)
        request.timeoutInterval = 1
        request.httpBody = Data(count: 1_000)
        await #expect(throws: URLError.self) { try await client.send(request, as: Empty.self) }
    }

    @Test func aLongerWaitAskedForIsKept() throws {
        var request = URLRequest(url: URL(string: "http://engine.invalid/api/x")!)
        request.timeoutInterval = 15 * 60
        request.httpBody = Data(count: 10 * HTTPClient.slowUpload)
        #expect(HTTPClient.waitingForBody(request, idle: 60).timeoutInterval == 15 * 60 + 10)
    }
}

/// Answers every request two seconds after it comes, with `{}`.
private final class SlowAnswer: URLProtocol, @unchecked Sendable {
    static func client(idle: TimeInterval) -> HTTPClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SlowAnswer.self]
        configuration.timeoutIntervalForRequest = idle
        return HTTPClient(endpoint: ServerEndpoint(url: URL(string: "http://engine.invalid")!, password: nil), session: URLSession(configuration: configuration))
    }

    private var answering: DispatchWorkItem?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() { answering?.cancel() }

    override func startLoading() {
        let answer = DispatchWorkItem { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        answering = answer
        DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: answer)
    }
}
