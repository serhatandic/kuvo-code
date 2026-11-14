import XCTest
@testable import UsageKit

@MainActor
final class ShellEnvironmentSnapshotTests: XCTestCase {
    // The store's save → load roundtrip is asserted by
    // testRefreshTaskKeepsPreviousSnapshotWhenCaptureFails below.

    func testUndecodableSnapshotIsDiscarded() {
        let defaults = makeScratchDefaults()
        defaults.set(Data("not json".utf8), forKey: ShellEnvironmentSnapshotStore.storageKey)
        let store = ShellEnvironmentSnapshotStore(defaults: defaults)

        XCTAssertNil(store.load())
        XCTAssertNil(defaults.data(forKey: ShellEnvironmentSnapshotStore.storageKey))
    }

    func testCurrentIsNilWhenCaptureFailed() {
        // An empty capture means the spawn or parse failed (a real login shell always exports
        // PATH/HOME) — its "facts" must not be persisted as a snapshot.
        let shellEnvironment = LoginShellEnvironment(runner: FixedRunner(stdout: "no markers"))
        XCTAssertFalse(shellEnvironment.ensureCapturedForTesting(), "an empty capture must report failure")
        XCTAssertNil(ShellEnvironmentSnapshot.current(shellEnvironment: shellEnvironment))
    }

    func testCurrentCapturesOnlyDeclaredKeys() {
        let stdout = [
            "__OPENUSAGE_ENV_BEGIN__",
            "CLAUDE_CONFIG_DIR=~/.claude-work",
            "OPENROUTER_API_KEY=sk-or-secret",
            "PATH=/usr/bin",
            "__OPENUSAGE_ENV_END__",
        ].joined(separator: "\0")
        let shellEnvironment = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))
        XCTAssertTrue(shellEnvironment.ensureCapturedForTesting())

        let snapshot = ShellEnvironmentSnapshot.current(shellEnvironment: shellEnvironment)

        // Only the declared non-secret keys land in the snapshot — never API keys or tokens.
        XCTAssertEqual(snapshot?.values, ["CLAUDE_CONFIG_DIR": "~/.claude-work"])
    }

    func testRefreshTaskPersistsSnapshotAfterCapture() async {
        let defaults = makeScratchDefaults()
        let store = ShellEnvironmentSnapshotStore(defaults: defaults)
        let stdout = [
            "__OPENUSAGE_ENV_BEGIN__", "CODEX_HOME=/tmp/codex-home", "PATH=/usr/bin", "__OPENUSAGE_ENV_END__",
        ].joined(separator: "\0")
        let shellEnvironment = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))

        await store.startRefreshTask(shellEnvironment: shellEnvironment).value

        XCTAssertEqual(store.load()?.values, ["CODEX_HOME": "/tmp/codex-home"])
    }

    func testRefreshTaskKeepsPreviousSnapshotWhenCaptureFails() async {
        let defaults = makeScratchDefaults()
        let store = ShellEnvironmentSnapshotStore(defaults: defaults)
        let previous = ShellEnvironmentSnapshot(values: ["CODEX_HOME": "/tmp/old"], capturedAt: Date())
        store.save(previous)
        let shellEnvironment = LoginShellEnvironment(runner: FixedRunner(stdout: "capture failed"))

        await store.startRefreshTask(shellEnvironment: shellEnvironment).value

        XCTAssertEqual(store.load(), previous)
    }

    func testUpgradeDiscardsLegacySnapshotAndDiscoversCustomSwapLocations() async throws {
        for (key, value, root) in [
            ("XSWAP_HOME", "/test/custom-swap", "/test/custom-swap"),
            ("XDG_DATA_HOME", "/test/data", "/test/data/codex-swap")
        ] {
            let defaults = makeScratchDefaults()
            // Earlier builds never captured the Swap location keys, so missing values in their
            // saved copy cannot establish that the user has no custom folder.
            let legacy = ShellEnvironmentSnapshot(values: ["CODEX_HOME": "/test/main"], capturedAt: Date())
            defaults.set(try JSONEncoder().encode(legacy), forKey: "openusage.shellEnvSnapshot.v1")
            let store = ShellEnvironmentSnapshotStore(defaults: defaults)
            let launchSnapshot = store.load()
            XCTAssertNil(launchSnapshot, "An upgrade must capture the newly supported shell settings before startup")

            let stdout = [
                "__OPENUSAGE_ENV_BEGIN__", "PATH=/usr/bin", "CODEX_HOME=/test/main",
                "\(key)=\(value)", "__OPENUSAGE_ENV_END__",
            ].joined(separator: "\0")
            let shell = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))
            let captured = await Task.detached { shell.ensureCaptured() }.value
            XCTAssertTrue(captured)
            let reader = ProcessEnvironmentReader(
                processEnvironment: [:], shellEnvironment: shell, launchSnapshot: { launchSnapshot }
            )
            XCTAssertEqual(reader.value(for: key), value)

            let identity = try XCTUnwrap(CodexAccountIdentity(accountID: "workspace-a", email: "personal@example.com"))
            let files = FakeFiles([
                "/test/main/auth.json": CodexSwapAccountTests.credential(identity, token: "main-personal"),
                root + "/accounts.json": #"""
                {"schemaVersion":1,"mainHome":"/test/main","accounts":[
                  {"number":1,"alias":"Personal","home":"/test/personal",
                   "identity":{"accountId":"workspace-a","email":"personal@example.com"}}
                ]}
                """#,
            ])
            let accounts = CodexSwapAccount.discover(environment: reader, files: files,
                                                    home: URL(fileURLWithPath: "/test"))
            XCTAssertEqual(accounts.count, 1, "The custom registry must be visible on the first launch after upgrading")
            let auth = CodexAuthStore(environment: reader, files: files, keychain: FakeKeychain())
            let candidate = try XCTUnwrap(auth.loadAuthCandidates().first)
            XCTAssertTrue(candidate.readOnly, "Swap's shared login must remain read-only during the upgrade")
            XCTAssertNil(candidate.auth.tokens?.refreshToken)

            await store.startRefreshTask(shellEnvironment: shell).value
            XCTAssertEqual(store.load()?.values[key], value, "Later launches must retain the newly captured setting")
        }
    }

    // MARK: - ProcessEnvironmentReader layering (process env → snapshot pin for identity keys → live capture)

    func testReaderPrefersTheProcessEnvironment() {
        let reader = ProcessEnvironmentReader(
            processEnvironment: ["CODEX_HOME": "/tmp/exported"],
            shellEnvironment: LoginShellEnvironment(runner: FixedRunner(stdout: "unused")),
            launchSnapshot: { ShellEnvironmentSnapshot(values: ["CODEX_HOME": "/tmp/persisted"], capturedAt: Date()) }
        )

        XCTAssertEqual(reader.value(for: "CODEX_HOME"), "/tmp/exported")
    }

    func testReaderServesSnapshotFactsWhileTheCaptureIsCold() {
        // A main-thread read never triggers the capture, so this cold shell layer answers "unknown".
        let cold = LoginShellEnvironment(runner: FixedRunner(stdout: "unused"))
        let snapshot = ShellEnvironmentSnapshot(values: ["CODEX_HOME": "/tmp/persisted"], capturedAt: Date())
        let reader = ProcessEnvironmentReader(
            processEnvironment: [:],
            shellEnvironment: cold,
            launchSnapshot: { snapshot }
        )

        XCTAssertEqual(reader.value(for: "CODEX_HOME"), "/tmp/persisted")
        // A key the snapshot verifiably lacks reads as "no override" — pinned absent.
        XCTAssertNil(reader.value(for: "CLAUDE_CONFIG_DIR"))
    }

    func testReaderPinsIdentityKeysToTheSnapshotEvenAfterTheCaptureLands() {
        // The capture lands with a CHANGED export. Identity-relevant keys must keep reading the
        // launch snapshot for the whole session — otherwise the account identity (read at init from
        // the snapshot) and later provider refreshes (reading the fresh capture) would resolve
        // different homes and mis-stamp the shared cache. The new export applies from the next launch.
        let stdout = [
            "__OPENUSAGE_ENV_BEGIN__", "CODEX_HOME=/tmp/changed", "MY_API_KEY=sk-live", "PATH=/usr/bin", "__OPENUSAGE_ENV_END__",
        ].joined(separator: "\0")
        let warm = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))
        XCTAssertTrue(warm.ensureCapturedForTesting())
        let reader = ProcessEnvironmentReader(
            processEnvironment: [:],
            shellEnvironment: warm,
            launchSnapshot: { ShellEnvironmentSnapshot(values: ["CODEX_HOME": "/tmp/pinned"], capturedAt: Date()) }
        )

        XCTAssertEqual(reader.value(for: "CODEX_HOME"), "/tmp/pinned")
        // Non-identity keys (API keys and everything else) keep reading the live capture as before.
        XCTAssertEqual(reader.value(for: "MY_API_KEY"), "sk-live")
    }

    func testReaderFallsToTheLiveCaptureWhenNoSnapshotExists() {
        // A genuinely first launch: no snapshot yet, so identity keys read the live capture directly
        // (consistent for the session — the capture is one-time per process).
        let stdout = ["__OPENUSAGE_ENV_BEGIN__", "CODEX_HOME=/tmp/live", "__OPENUSAGE_ENV_END__"].joined(separator: "\0")
        let warm = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))
        XCTAssertTrue(warm.ensureCapturedForTesting())
        let reader = ProcessEnvironmentReader(
            processEnvironment: [:],
            shellEnvironment: warm,
            launchSnapshot: { nil }
        )

        XCTAssertEqual(reader.value(for: "CODEX_HOME"), "/tmp/live")
    }

    func testNonblockingReaderUsesOnlyCachedShellValuesOffMainThread() async {
        let cold = LoginShellEnvironment(runner: FixedRunner(
            stdout: ["__OPENUSAGE_ENV_BEGIN__", "CODEX_HOME=/tmp/live", "__OPENUSAGE_ENV_END__"].joined(separator: "\0")
        ))
        let reader = ProcessEnvironmentReader(
            processEnvironment: [:],
            shellEnvironment: cold,
            launchSnapshot: { nil },
            blocksOnShellCapture: false
        )

        let value = await Task.detached {
            reader.value(for: "CODEX_HOME")
        }.value

        XCTAssertNil(value)
        XCTAssertFalse(cold.capturedSuccessfully)
    }

    func testNonblockingReaderUsesAnExistingShellCapture() {
        let stdout = ["__OPENUSAGE_ENV_BEGIN__", "CODEX_HOME=/tmp/live", "__OPENUSAGE_ENV_END__"].joined(separator: "\0")
        let warm = LoginShellEnvironment(runner: FixedRunner(stdout: stdout))
        XCTAssertTrue(warm.ensureCapturedForTesting())
        let reader = ProcessEnvironmentReader(
            processEnvironment: [:],
            shellEnvironment: warm,
            launchSnapshot: { nil },
            blocksOnShellCapture: false
        )

        XCTAssertEqual(reader.value(for: "CODEX_HOME"), "/tmp/live")
    }

    private func makeScratchDefaults() -> UserDefaults {
        let suiteName = "OpenUsageTests.ShellEnvironmentSnapshot.\(UUID().uuidString)"
        let defaults = testDefaults(suiteName: suiteName)!
        return defaults
    }
}

private final class FixedRunner: ProcessRunning, @unchecked Sendable {
    let stdout: String

    init(stdout: String) { self.stdout = stdout }

    func run(executable: String, arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> ProcessResult {
        ProcessResult(exitCode: 0, stdout: stdout, stderr: "")
    }
}

private extension LoginShellEnvironment {
    /// Force the capture from the test's (main) thread by hopping off-main, since `ensureCaptured`
    /// refuses to spawn on the main thread.
    func ensureCapturedForTesting() -> Bool {
        let done = DispatchSemaphore(value: 0)
        var result = false
        DispatchQueue.global().async {
            result = self.ensureCaptured()
            done.signal()
        }
        done.wait()
        return result
    }
}
