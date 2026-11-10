import XCTest
@testable import UsageKit

extension ClaudeDesktopAuthStoreTests {
    @MainActor
    func testSwapDesktopOverlapKeepsTwoNamedIdentitiesAcrossDefaultSwitches() async throws {
        let fixture = try overlapFixture()
        let suite = "ClaudeOverlap.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(testDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let accounts = ProviderAccountsStore(defaults: defaults)
        let fixtureHome = home
        let observer = DefaultAccountObserver(environment: FakeEnvironment([:]), files: fixture.files,
            keychain: FakeKeychain(), homeDirectory: { fixtureHome })
        func discover() async -> ProviderAccountAssembly {
            await ProviderAccountAssembly.make(observer: observer, accountsStore: accounts,
                desktop: fixture.store, listDesktopOrganizationDirectories: { _ in [] })
        }
        setOverlapDefault(organization, files: fixture.files)
        let first = await discover()
        XCTAssertEqual(first.claudeCards.count, 2)
        XCTAssertEqual(Set(first.claudeCards.map(\.displayName)),
            ["Claude: Personal (same@example.com)", "Claude: Work (same@example.com)"])
        XCTAssertTrue(first.claudeCards.allSatisfy { $0.swapAccount != nil })
        let firstIDs = Dictionary(uniqueKeysWithValues: first.claudeCards.map { ($0.identityKey, $0.id) })
        func layout(_ cards: [ClaudeAccountCard]) -> LayoutStore {
            LayoutStore(registry: .from(ProviderCatalog.make(defaults: defaults, claudeCards: cards)), defaults: defaults)
        }
        let originalLayout = layout(first.claudeCards)
        let pin = first.claudeCards[0].id + ".session"
        originalLayout.setPinned(true, for: pin)
        _ = originalLayout.reorderProvider(dragged: first.claudeCards[1].id, target: first.claudeCards[0].id)
        let savedOrder = originalLayout.providerOrder
        let savedPins = originalLayout.pinnedMetricIDs
        XCTAssertTrue(savedPins.contains(pin))
        for selected in [otherOrganization, organization, otherOrganization] {
            setOverlapDefault(selected, files: fixture.files)
            let next = await discover()
            XCTAssertEqual(next.claudeCards.count, 2)
            XCTAssertEqual(Dictionary(uniqueKeysWithValues: next.claudeCards.map { ($0.identityKey, $0.id) }), firstIDs)
            let repeated = await discover()
            XCTAssertEqual(repeated.claudeCards, next.claudeCards)
            let restored = layout(next.claudeCards)
            XCTAssertEqual(restored.providerOrder, savedOrder)
            XCTAssertEqual(restored.pinnedMetricIDs, savedPins)
            XCTAssertTrue(next.claudeCards.allSatisfy { $0.swapAccount != nil && !$0.allowsUnattributedPiUsage })
        }
    }

    @MainActor
    func testOverlapFallsBackBothDirectionsWithoutUsingOtherOrganization() async throws {
        for desktopFirst in [true, false] {
            for rejected in [true, false] {
                let fixture = try overlapFixture()
                for (index, org) in [organization, otherOrganization].enumerated() {
                    let swap = try XCTUnwrap(ClaudeSwapAccount.discover(files: fixture.files, home: home)
                        .first { $0.organizationID == org })
                    let session = "session-\(index)"
                    setOverlapDefault(org, files: fixture.files)
                    let cli = "default-\(index)"
                    let keychain = ServiceKeychain(currentUserValues: ["Claude Code-credentials": cliCredentials(token: cli)])
                    // A wrong-identity preferred token must be rejected just like a revoked token.
                    fixture.files.files[swap.sessionDirectory + "/.credentials.json"] = cliCredentials(token: session)
                    let auth = ClaudeAuthStore(environment: FakeEnvironment([:]), files: fixture.files,
                        keychain: keychain, desktop: fixture.store, desktopOrganization: org,
                        expectedIdentityKey: swap.identityKey, desktopOnly: desktopFirst, swapAccount: swap)
                    XCTAssertEqual(Set(auth.loadCredentialCandidates().map(\.oauth.accessToken)),
                        [cli, session, "desktop-\(index)"])
                    let user = accountUUID
                    let wrongOrg = org == organization ? otherOrganization : organization
                    let preferred = desktopFirst ? "desktop-\(index)" : session
                    let fallback = desktopFirst ? session : "desktop-\(index)"
                    let http = RoutingHTTPClient { request in
                        let token = request.headers["Authorization"]?.replacingOccurrences(of: "Bearer ", with: "")
                        XCTAssertNotEqual(token, "session-\(1 - index)")
                        XCTAssertNotEqual(token, "desktop-\(1 - index)")
                        if request.url.path == "/api/oauth/profile" {
                            if token == cli || (token == preferred && rejected) {
                                return HTTPResponse(statusCode: 401, headers: [:], body: Data())
                            }
                            let profileOrg = token == preferred ? wrongOrg : org
                            return HTTPResponse(statusCode: 200, headers: [:], body: Data(
                                #"{"account":{"uuid":"\#(user)"},"organization":{"uuid":"\#(profileOrg)"}}"#.utf8))
                        }
                        XCTAssertEqual(request.url.path, "/api/oauth/usage")
                        XCTAssertEqual(token, fallback)
                        return HTTPResponse(statusCode: 200, headers: [:], body: Data(
                            #"{"five_hour":{"utilization":\#(20 + index * 50),"resets_at":"2099-01-01T00:00:00.000Z"}}"#.utf8))
                    }
                    let provider = ClaudeProvider(authStore: auth, usageClient: ClaudeUsageClient(httpClient: http),
                        logUsageScanner: ClaudeLogFixture.scanner(home: nil), pricing: { TestPricing.bundled })
                    let result = await provider.refresh()
                    XCTAssertNil(badge(result.lines, "Error"))
                    XCTAssertEqual(http.requests.filter { $0.isClaudeUsagePoll }.count, 1)
                }
            }
        }
    }

    @MainActor
    func testOverlapDiscardsStaleUsageDuringDefaultAndSessionChanges() async throws {
        let fixture = try overlapFixture()
        let swaps = ClaudeSwapAccount.discover(files: fixture.files, home: home)
        setOverlapDefault(organization, files: fixture.files)
        for (index, swap) in swaps.enumerated() {
            fixture.files.files[swap.sessionDirectory + "/.credentials.json"] = cliCredentials(token: "session-\(index)")
        }
        for (index, swap) in swaps.enumerated() {
            let path = swap.sessionDirectory + "/.credentials.json"
            let replacement = cliCredentials(token: "updated-\(index)")
            let user = accountUUID
            let switchedDefault = #"{"oauthAccount":{"accountUuid":"\#(user)","organizationUuid":"\#(otherOrganization)"}}"#
            let defaultPath = home.path + "/.claude.json"
            let http = RoutingHTTPClient { request in
                let token = request.headers["Authorization"] ?? ""
                if request.url.path == "/api/oauth/profile" {
                    return HTTPResponse(statusCode: 200, headers: [:], body: Data(
                        #"{"account":{"uuid":"\#(user)"},"organization":{"uuid":"\#(swap.organizationID)"}}"#.utf8))
                }
                XCTAssertEqual(request.url.path, "/api/oauth/usage")
                let stale = token == "Bearer session-\(index)"
                if stale {
                    fixture.files.files[path] = replacement
                    fixture.files.files[defaultPath] = switchedDefault
                }
                return HTTPResponse(statusCode: 200, headers: [:], body: Data(
                    #"{"five_hour":{"utilization":\#(stale ? 99 : 20 + index * 50),"resets_at":"2099-01-01T00:00:00.000Z"}}"#.utf8))
            }
            let auth = ClaudeAuthStore(environment: FakeEnvironment([:]), files: fixture.files,
                keychain: FakeKeychain(), desktop: fixture.store, desktopOrganization: swap.organizationID,
                expectedIdentityKey: swap.identityKey, swapAccount: swap)
            let provider = ClaudeProvider(authStore: auth, usageClient: ClaudeUsageClient(httpClient: http),
                logUsageScanner: ClaudeLogFixture.scanner(home: nil), pricing: { TestPricing.bundled })
            let result = await provider.refresh()
            guard case .progress(_, let used, _, _, _, _, _) = result.line(label: "Session") else {
                return XCTFail("Missing refreshed limits")
            }
            XCTAssertEqual(used, Double(20 + index * 50))
            XCTAssertEqual(fixture.files.files[path], replacement)
            XCTAssertEqual(http.requests.filter { $0.isClaudeUsagePoll }.count, 2)
        }
    }

    private func setOverlapDefault(_ org: String, files: FakeFiles) {
        files.files[home.path + "/.claude.json"] =
            #"{"oauthAccount":{"accountUuid":"\#(accountUUID)","organizationUuid":"\#(org)"}}"#
    }

    private func overlapFixture() throws -> DesktopFixture {
        let fixture = try makeFixture(activeOrganization: organization, v2: [
            cacheKey(organization: organization): tokenEntry("desktop-0", expiresIn: 3600),
            cacheKey(organization: otherOrganization): tokenEntry("desktop-1", expiresIn: 3600)
        ], accountUUID: accountUUID)
        fixture.files.files[home.path + "/.claude-swap-backup/sequence.json"] = #"""
        {"accounts":{
          "1":{"email":"same@example.com","uuid":"\#(accountUUID)","organizationUuid":"\#(organization)","organizationName":"Personal"},
          "2":{"email":"same@example.com","uuid":"\#(accountUUID)","organizationUuid":"\#(otherOrganization)","organizationName":"Work"}
        }}
        """#
        return fixture
    }
}
