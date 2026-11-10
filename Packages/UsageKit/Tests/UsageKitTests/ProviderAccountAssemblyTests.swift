import XCTest
import Synchronization
@testable import UsageKit

/// The launch account pass end to end: observer outcomes → account registry records → the per-card
/// identity map consumed by the snapshot cache stamp and the bare-id resolver.
@MainActor
final class ProviderAccountAssemblyTests: XCTestCase {
    private func makeScratchDefaults() -> UserDefaults {
        let suiteName = "OpenUsageTests.ProviderAccountAssembly.\(UUID().uuidString)"
        let defaults = testDefaults(suiteName: suiteName)!
        return defaults
    }

    func testResolvedFamiliesFeedIdentityKeysAndTheRegistry() async throws {
        let defaults = makeScratchDefaults()
        let store = ProviderAccountsStore(defaults: defaults)
        let observer = DefaultAccountObserver(
            environment: FakeEnvironment([:]),
            files: FakeFiles([
                // Claude resolved at the default home; Codex has credentials that name no account.
                "/Users/dev/.claude.json": #"{"oauthAccount": {"accountUuid": "ACCT-1", "emailAddress": "dev@example.com"}}"#,
                "/Users/dev/.codex/auth.json": #"{"tokens": {"access_token": "at-1"}}"#,
            ]),
            keychain: FakeKeychain(nil),
            homeDirectory: { URL(fileURLWithPath: "/Users/dev") }
        )

        let assembly = await ProviderAccountAssembly.make(observer: observer, accountsStore: store)

        XCTAssertEqual(assembly.identityKeysByCard, ["claude": "acct-1"])
        // The registry recorded the resolved account under the bare id, holding the default badge.
        let record = try XCTUnwrap(store.defaultBadgeHolder(family: "claude"))
        XCTAssertEqual(record.id, "claude")
        XCTAssertEqual(record.label, "dev@example.com")
        XCTAssertEqual(record.sources.map(\.kind), [.defaultHome])
        // An unresolved family claims no account: no record, no identity key.
        XCTAssertNil(store.defaultBadgeHolder(family: "codex"))
    }

    /// A family whose home facts aren't readable this launch (first Finder/Dock launch racing a
    /// slow shell) is left out of the pass entirely: not observed, not reconciled — while a family
    /// whose home override is already in the process environment still resolves.
    func testFamiliesOutsideThePassAreNeitherObservedNorReconciled() async {
        let defaults = makeScratchDefaults()
        let store = ProviderAccountsStore(defaults: defaults)
        let observer = DefaultAccountObserver(
            environment: FakeEnvironment([:]),
            files: FakeFiles([
                "/Users/dev/.claude.json": #"{"oauthAccount": {"accountUuid": "ACCT-1"}}"#,
                "/Users/dev/.codex/auth.json": #"{"tokens": {"access_token": "at-1", "account_id": "CODEX-1"}}"#,
            ]),
            keychain: FakeKeychain(nil),
            homeDirectory: { URL(fileURLWithPath: "/Users/dev") }
        )

        let assembly = await ProviderAccountAssembly.make(observer: observer, accountsStore: store, families: ["codex"])

        XCTAssertEqual(assembly.identityKeysByCard, ["codex": "codex-1"])
        XCTAssertNil(store.defaultBadgeHolder(family: "claude"), "an out-of-pass family must not be reconciled")
    }

    func testNothingObservedLeavesRegistryAndKeysEmpty() async {
        let defaults = makeScratchDefaults()
        let store = ProviderAccountsStore(defaults: defaults)
        let observer = DefaultAccountObserver(
            environment: FakeEnvironment([:]),
            files: FakeFiles([:]),
            keychain: FakeKeychain(nil),
            homeDirectory: { URL(fileURLWithPath: "/Users/dev") }
        )

        let assembly = await ProviderAccountAssembly.make(observer: observer, accountsStore: store)

        XCTAssertTrue(assembly.identityKeysByCard.isEmpty)
        XCTAssertTrue(store.records.isEmpty)
        XCTAssertNil(defaults.data(forKey: ProviderAccountsStore.storageKey), "no observations, no write")
    }

    func testFamilyDiscoveryRunsOffMainActor() async {
        let store = ProviderAccountsStore(defaults: makeScratchDefaults())
        let observer = DefaultAccountObserver(
            environment: FakeEnvironment([:]),
            files: BackgroundDiscoveryFiles(),
            keychain: FakeKeychain(nil),
            homeDirectory: { URL(fileURLWithPath: "/Users/dev") }
        )

        let assembly = await ProviderAccountAssembly.make(
            observer: observer,
            accountsStore: store,
            listCodexHomeDirectories: { path in
                guard path == "/Users/dev" else { return [] }
                return Thread.isMainThread ? [".codex-main"] : [".codex-background"]
            }
        )

        XCTAssertEqual(assembly.identityKeysByCard["claude"], "claude-id")
        XCTAssertEqual(assembly.codex.plainAuthHomes, ["/Users/dev/.codex-background"])
    }

    func testEstablishedCodexAccountsKeepDefaultIdentityWhenNoCardsAreDiscovered() async {
        let store = ProviderAccountsStore(defaults: makeScratchDefaults())
        store.reconcile(with: [
            .init(
                family: "codex", identityKey: "workspace-a|a@example.test", label: "A",
                sources: [.init(kind: .codexHome, anchor: "/Users/dev/.codex-a", holdsDefaultSource: false)]
            ),
            .init(
                family: "codex", identityKey: "workspace-b|b@example.test", label: "B",
                sources: [.init(kind: .codexHome, anchor: "/Users/dev/.codex-b", holdsDefaultSource: false)]
            ),
        ])
        let observer = DefaultAccountObserver(
            environment: FakeEnvironment([:]),
            files: CodexAuthAppearsAfterScan(),
            keychain: FakeKeychain(nil),
            homeDirectory: { URL(fileURLWithPath: "/Users/dev") }
        )

        let assembly = await ProviderAccountAssembly.make(
            observer: observer, accountsStore: store, families: ["codex"]
        )

        XCTAssertTrue(assembly.codexCards.isEmpty)
        XCTAssertEqual(assembly.identityKeysByCard["codex"], "default-account")
    }
}

private final class CodexAuthAppearsAfterScan: TextFileAccessing, Sendable {
    private let defaultHomeReads = Mutex(0)
    private let auth = #"{"tokens":{"access_token":"token","account_id":"default-account"}}"#

    func exists(_ path: String) -> Bool { false }

    func readTextIfPresent(_ path: String) throws -> String? {
        guard path == "/Users/dev/.codex/auth.json" else { return nil }
        let read = defaultHomeReads.withLock { count in
            count += 1
            return count
        }
        return read == 1 ? nil : auth
    }

    func readText(_ path: String) throws -> String {
        if let text = try readTextIfPresent(path) { return text }
        throw CocoaError(.fileReadNoSuchFile)
    }

    func writeText(_ path: String, _ text: String) throws {}
    func remove(_ path: String) throws {}
}

private struct BackgroundDiscoveryFiles: TextFileAccessing {
    func exists(_ path: String) -> Bool { false }

    func readTextIfPresent(_ path: String) throws -> String? {
        guard !Thread.isMainThread else { return nil }
        switch path {
        case "/Users/dev/.claude.json":
            return #"{"oauthAccount":{"accountUuid":"CLAUDE-ID"}}"#
        case "/Users/dev/.codex-background/auth.json":
            return #"{"tokens":{"access_token":"token","account_id":"workspace-1"}}"#
        default:
            return nil
        }
    }

    func readText(_ path: String) throws -> String {
        throw CocoaError(.fileReadNoSuchFile)
    }

    func writeText(_ path: String, _ text: String) throws {}
    func remove(_ path: String) throws {}
}
