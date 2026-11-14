import Foundation
import Testing
@testable import KuvoLink

/// A link's failure reaches the phone's screens in the link's own words.
struct LinkErrorWordsTests {
    @Test(arguments: [LinkError.hostOffline, .refused, .timedOut, .relayUnavailable, .closed])
    func keepsTheLinksWords(_ error: LinkError) {
        let failure = LinkURLProtocol.failure(for: error)
        #expect(failure.localizedDescription == error.localizedDescription)
        #expect(failure.userInfo[NSUnderlyingErrorKey] as? LinkError == error)
    }

    @Test func refusedAndOfflineStayApart() {
        let refused = LinkURLProtocol.failure(for: LinkError.refused)
        let offline = LinkURLProtocol.failure(for: LinkError.hostOffline)
        #expect(refused.code == offline.code)
        #expect(refused.localizedDescription != offline.localizedDescription)
    }
}
