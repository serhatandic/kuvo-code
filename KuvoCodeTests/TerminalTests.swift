import AppKit
import Foundation
import Observation
import SwiftTerm
import Testing
@testable import KuvoCode

/// The panel's terminal as you type and read in it: ⌥ types what your keyboard puts there (@ on a
/// Turkish keyboard, { on a German one) and is Meta otherwise; a long build's first lines are
/// still there to scroll back to; a shell or connection that ended says so, and Return starts it
/// again; a folder that's gone says so rather than the shell starting somewhere else unsaid; an
/// archived session's terminals end. Real shells, in a window of the test's own that never shows.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct TerminalTests {
    let folder = AppInfo.testRoot.appending(path: "Terminals/\(UUID().uuidString.prefix(8))")
    let shell = ["SHELL": "/bin/sh"]

    init() throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func done(_ sessions: TerminalSession...) {
        for session in sessions { session.terminate() }
        try? FileManager.default.removeItem(at: folder)
    }

    /// What the terminal shows, its scrollback too.
    private func shown(_ session: TerminalSession) -> String {
        String(decoding: session.view.getTerminal().getBufferAsData(kind: .normal), as: UTF8.self)
    }

    /// Takes what the terminal would send the shell.
    private final class Sent: TerminalViewDelegate {
        var bytes: [UInt8] = []
        func send(source: TerminalView, data: ArraySlice<UInt8>) { bytes += data }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }

    /// A key typed with Option, as the keyboard layout gives it.
    private func optionKey(_ typed: String, on key: String, code: UInt16) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: 0, context: nil, characters: typed, charactersIgnoringModifiers: key, isARepeat: false, keyCode: code))
    }

    private func type(_ event: NSEvent, in session: TerminalSession) -> [UInt8] {
        let sent = Sent()
        session.view.terminalDelegate = sent
        if !session.typed(event) { session.view.keyDown(with: event) }
        return sent.bytes
    }

    @Test func optionTypesWhatTheKeyboardPutsThereAndIsMetaOtherwise() throws {
        let session = TerminalSession(directory: folder.path, environment: shell)
        defer { done(session) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400), styleMask: [.titled], backing: .buffered, defer: true)
        window.contentView = session.view
        window.makeFirstResponder(session.view)

        // Turkish Q: ⌥Q is @. German: ⌥8 is {.
        #expect(type(try optionKey("@", on: "q", code: 12), in: session) == Array("@".utf8))
        #expect(type(try optionKey("{", on: "8", code: 28), in: session) == Array("{".utf8))
        // US: ⌥B would be ∫; in a shell it's word back, Esc B, as before. ⌥← too.
        #expect(type(try optionKey("∫", on: "b", code: 11), in: session) == [0x1B] + Array("b".utf8))
        let left = String(UnicodeScalar(UInt16(NSLeftArrowFunctionKey))!)
        #expect(type(try optionKey(left, on: left, code: 123), in: session) == [0x1B] + Array("b".utf8), "word back")
    }

    /// ⌥N on a German keyboard waits for the next key to make ~ (an accent key): not Meta either.
    /// The keyboard layout is asked what it stands for; here, as a German one answers.
    @Test func anOptionAccentKeyIsntMeta() throws {
        let tilde = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "n", isARepeat: false, keyCode: 45))
        #expect(!TerminalSession.optionIsMeta(for: tilde) { _ in "~" })
        #expect(TerminalSession.optionIsMeta(for: tilde) { _ in "˜" }, "a US keyboard's ⌥N accent isn't ASCII: Meta, as before")
    }

    @Test func aLongBuildsFirstLinesAreStillThere() {
        let session = TerminalSession(directory: folder.path, environment: shell)
        defer { done(session) }
        session.view.feed(text: (1...3_000).map { "build step \($0)\r\n" }.joined())
        let lines = shown(session).split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        #expect(lines.contains("build step 1"), "the first of 3,000 lines, past SwiftTerm's own 500")
        #expect(lines.contains("build step 3000"))
    }

    @Test func aShellThatEndedSaysSoAndReturnStartsItAgain() async throws {
        // `exit` typed as it starts; started again, the shell stays.
        let session = TerminalSession(directory: folder.path, environment: shell, command: "exit")
        defer { done(session) }
        await ended(session)
        #expect(shown(session).replacingOccurrences(of: "\n", with: "").contains("Process completed. Press Return to start a new shell."))
        let first = session.view.process.shellPid

        let enter = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        #expect(session.typed(enter), "Return is taken: there's no shell to send it to")
        #expect(session.isRunning, "a new one started, in the same tab")
        #expect(session.view.process.running && session.view.process.shellPid != first)
    }

    /// A tab says what runs in it, else its folder, as Terminal does: a shell's own
    /// "user@host: ~/dir" title names only the folder, so two shells on one machine tell apart.
    @Test func aTabIsNamedByWhatRunsInItElseItsFolder() {
        let session = TerminalSession(directory: folder.path, environment: shell)
        defer { done(session) }
        #expect(session.title == folder.lastPathComponent, "before the shell names it")
        session.view.feed(text: "\u{1b}]0;alice@devbox: ~/src/kuvo-web\u{07}")
        #expect(session.title == "kuvo-web")
        session.view.feed(text: "\u{1b}]0;alice@devbox: ~\u{07}")
        #expect(session.title == "~")
        session.view.feed(text: "\u{1b}]0;⠋ claude\u{07}")
        #expect(session.title == "claude")
        session.view.feed(text: "\u{1b}]0;alice@devbox\u{07}")
        #expect(session.title == folder.lastPathComponent)
        session.view.feed(text: "\u{1b}]0;alice@devbox: /\u{07}")
        #expect(session.title == "/", "the top folder, not home")
        session.view.feed(text: "\u{1b}]0;npm@10.8.1\u{07}")
        #expect(session.title == "npm@10.8.1", "a version, not a host")
        session.view.feed(text: "\u{1b}]0;root@3f2a9bc1d2e4: /app\u{07}")
        #expect(session.title == "app", "a container's host, digits first")
        session.view.feed(text: "\u{1b}]0;alice@devbox: /home/bob\u{07}")
        #expect(session.title == "bob", "someone else's home, by its name")
        // A machine's home folder, before its shell names it.
        #expect(TerminalSession.folderName("/home/alice", isStart: true) == "~")
        #expect(TerminalSession.folderName("/root", isStart: true) == "~")
        #expect(TerminalSession.folderName("/Users/Shared", isStart: true) == "Shared")
        #expect(TerminalSession.folderName("/home/alice/src/app/", isStart: true) == "app")
    }

    /// A terminal opened to run a command is named by the program that does the work: the last of
    /// commands run one after another, past what only sets up how it runs.
    @Test func aCommandsTabIsNamedByItsProgram() {
        #expect(TerminalSession.program("npm run dev") == "npm")
        #expect(TerminalSession.program("cd web && npm run dev") == "npm")
        #expect(TerminalSession.program("cd web; PORT=3000 bun dev") == "bun")
        #expect(TerminalSession.program("sudo /usr/bin/python3 serve.py") == "python3")
        #expect(TerminalSession.program("env DEBUG=1 node app.js | tee log") == "node")
    }

    /// Waits for the session's shell to end, as the terminal hears it.
    private func ended(_ session: TerminalSession) async {
        while session.isRunning {
            await withCheckedContinuation { (going: CheckedContinuation<Void, Never>) in
                withObservationTracking { _ = session.isRunning } onChange: { going.resume() }
            }
        }
    }

    /// A worktree removed in Settings, a project folder moved: the terminal says so, rather than
    /// the shell starting in / (or the home folder) and commands running there unsaid.
    @Test func aFolderThatsGoneSaysSo() {
        let gone = folder.appending(path: "removed-worktree").path
        let session = TerminalSession(directory: gone, environment: shell, command: "make clean")
        defer { done(session) }
        // The line as the terminal wraps it to its width.
        #expect(shown(session).replacingOccurrences(of: "\n", with: "").contains("That folder isn’t there anymore: \(gone). This is your home folder."))
    }

    /// The symbols-only Nerd Font, installed for a prompt's icons, has no letters to write in.
    @Test func theNerdFontWrittenInHasLetters() {
        #expect(TerminalSession.nerdFont(in: ["Menlo", "Symbols Nerd Font Mono"]) == nil)
        #expect(TerminalSession.nerdFont(in: ["Symbols Nerd Font Mono", "JetBrainsMono Nerd Font Mono"]) == "JetBrainsMono Nerd Font Mono")
    }

    /// Archived, a session's terminals end with their tabs: a dev server it ran no longer holds its
    /// port from a worktree that may be gone.
    @Test func anArchivedSessionsTerminalsEnd() async throws {
        let engine = StubEngine(port: 47_906)
        let app = AppModel()
        defer {
            engine.stop()
            app.utilities.closeAll()
            try? FileManager.default.removeItem(at: folder)
        }
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_dev", directory: folder.path)])
        engine.on("PATCH", "/api/session/*", json: [:])
        await app.workspace.refresh()
        app.utilities.inView = .init(session: "ses_dev")
        app.utilities.newTerminal(in: folder.path, environment: shell)
        let terminal = try #require(app.utilities.terminals.values.first)
        #expect(terminal.isRunning)

        #expect(await app.workspace.setArchived("ses_dev", true))
        await app.archivedChanged("ses_dev").value
        #expect(!terminal.isRunning)
        #expect(!app.utilities.tabs.contains { $0.owner == "ses_dev" && $0.kind == .terminal })
    }
}
