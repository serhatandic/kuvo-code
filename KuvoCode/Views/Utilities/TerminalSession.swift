import AppKit
import Carbon
import ClientDesign
import OpenCodeKit
import SwiftTerm
import SwiftUI

/// A shell in the project folder (SwiftTerm, MIT): the login shell with the same
/// environment as Terminal, colored to match the app.
@Observable
final class TerminalSession: NSObject {
    let view: LocalProcessTerminalView
    /// What its tab says: what runs in it, else the command it was opened with, else its folder
    /// (`tabTitle`).
    private(set) var title: String
    /// What the tab says until what runs in it names itself.
    @ObservationIgnored private let untitled: String
    private(set) var isRunning = true
    /// Add to Message in the right-click menu, with the selected text.
    @ObservationIgnored var addToMessage: ((String) -> Void)?
    @ObservationIgnored private var appliedLook: (dark: Bool, focused: Bool)?
    /// It has been on screen: shown again, it takes the keyboard only in the card you work in.
    @ObservationIgnored var wasShown = false
    /// The machine it's a shell on, over SSH; nil for this Mac.
    let machine: String?

    /// A shell, typing `command` once it starts (so it stays a shell when the command ends).
    /// `label`: the tab's name until what runs names itself (the command's), else its folder's.
    init(directory: String, environment: [String: String], command: String? = nil, label: String? = nil) {
        view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        self.directory = directory
        machine = RemoteFolder.parse(directory)?.machine
        untitled = label ?? Self.folderName(RemoteFolder.parse(directory)?.path ?? directory, isStart: true)
        title = untitled
        var environment = environment
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["TERM_PROGRAM"] = "KuvoCode"
        if environment["LANG"] == nil { environment["LANG"] = "en_US.UTF-8" }
        self.environment = environment
        super.init()
        _ = Self.keys
        view.processDelegate = self
        view.font = Self.font
        // After the font: setting it puts SwiftTerm's own 500 lines back.
        view.getTerminal().changeHistorySize(Self.scrollback)
        // Scrolling works as anywhere else; a permanent scroll bar track is just clutter.
        for scroller in view.subviews.compactMap({ $0 as? NSScroller }) { scroller.isHidden = true }
        let menu = NSMenu()
        menu.delegate = self
        view.menu = menu
        if start(typing: command != nil), let command { view.send(txt: command + "\r") }
    }

    /// Watches the shell's process for its end: SwiftTerm stops watching it when the terminal's
    /// output ends first, and then never says it ended.
    func watchShell() {
        let shell = view.process.shellPid
        guard shell > 0 else { return }
        exit?.cancel()
        let source = DispatchSource.makeProcessSource(identifier: shell, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                var status: Int32 = 0
                // Whichever hears it first has the status: SwiftTerm, or this.
                let reaped = waitpid(shell, &status, WNOHANG) == shell
                self?.ended(status: reaped ? status : nil)
            }
        }
        source.activate()
        exit = source
        // Gone before it was watched (a shell that couldn't start, a command that ended at once).
        var status: Int32 = 0
        if waitpid(shell, &status, WNOHANG) == shell { ended(status: status) }
    }

    /// The shell ended, with its wait status when known.
    func ended(status: Int32?) {
        guard isRunning else { return }
        isRunning = false
        exit?.cancel()
        exit = nil
        guard !closed else { return }
        // Said in the terminal, rather than it going quiet: typing in it does nothing now.
        let machine = RemoteFolder.machine(of: directory)
        // ssh's own failure (the connection lost, or never made) is its exit status 255.
        let exited = status.map { ($0 & 0x7F) == 0 ? ($0 >> 8) & 0xFF : -1 }
        let ended = if let machine, exited == 255 {
            "Connection to \(AgentMail.shared.app?.machines.engine(machine)?.machine.name ?? machine) lost. Press Return to reconnect."
        } else {
            "Process completed. Press Return to start a new shell."
        }
        view.feed(text: "\r\n" + Self.note(ended) + "\r\n")
    }
}

/// Puts a session's terminal in the panel, on the card itself as in Rex: the card's color
/// edge to edge, with the text inset like the rest of the card. The view outlives the tab
/// being shown, so the shell keeps its state while you look at something else.
struct TerminalHost: View {
    let session: TerminalSession
    @Environment(\.colorScheme) private var scheme
    /// The card's focus: the terminal's color follows the card's as focus moves.
    @Environment(\.cardIsFocused) private var isFocused

    var body: some View {
        TerminalRepresentable(session: session, dark: scheme == .dark, focused: isFocused)
            // The right side already has room SwiftTerm keeps for its (hidden) scroll bar.
            .padding(.leading, 16)
            .padding(.top, 4)
            .padding(.bottom, 12)
            .background(Surface.cardFill(scheme, focused: isFocused))
    }
}

private struct TerminalRepresentable: NSViewRepresentable {
    let session: TerminalSession
    let dark: Bool
    let focused: Bool

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        session.apply(dark: dark, focused: focused)
        // A new terminal takes the keyboard, and one you go back to in the card you work in; the
        // panel coming in beside the conversation you type in leaves the keyboard there.
        if !session.wasShown || focused {
            DispatchQueue.main.async { session.view.window?.makeFirstResponder(session.view) }
        }
        session.wasShown = true
        context.coordinator.update(session.view, in: context)
        return session.view
    }

    func updateNSView(_ view: LocalProcessTerminalView, context: Context) {
        session.apply(dark: dark, focused: focused)
        context.coordinator.update(view, in: context)
    }

    func makeCoordinator() -> PanelVisibility { PanelVisibility() }
}
extension TerminalSession {
    /// The program a command runs, by its name: the last of commands run one after another, before
    /// any pipe, past `NAME=value` settings and what only sets up how it runs, without its folder.
    static func program(_ command: String) -> String? {
        let last = command.components(separatedBy: "&&").flatMap { $0.components(separatedBy: ";") }
            .last { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? command
        let run = last.split(separator: "|", maxSplits: 1).first ?? Substring(last)
        let setup: Set<Substring> = ["sudo", "env", "exec", "nohup", "time", "command"]
        guard let word = run.split(separator: " ").first(where: { !$0.contains("=") && !setup.contains($0) }) else { return nil }
        return (String(word) as NSString).lastPathComponent
    }

    /// Lines kept above the screen, for a long build's or test run's first lines.
    static let scrollback = 10_000

    @ObservationIgnored private let directory: String
    @ObservationIgnored private let environment: [String: String]
    /// Ended by closing its tab, rather than on its own.
    @ObservationIgnored private var closed = false
    /// Hears the shell's process end.
    @ObservationIgnored fileprivate var exit: DispatchSourceProcess?

    /// Starts the shell in the folder; false when the folder isn't there, and it started in the
    /// home folder instead, saying so. `typing`: a command is typed once it starts, which a
    /// machine's folder that's gone takes in rather than run in the home folder.
    @discardableResult
    private func start(typing: Bool = false) -> Bool {
        if let remote = RemoteFolder.parse(directory) {
            // A folder on a machine: the machine's own login shell, there, over SSH.
            let missing = Self.note("That folder isn’t there anymore: \(remote.path). This is your home folder.")
            let swallow = typing ? "; stty -echo; IFS= read -r _; stty echo" : ""
            let script = "cd \(SSHConnection.quoted(remote.path)) 2>/dev/null || { printf '%s\\r\\n' \(SSHConnection.quoted(missing))\(swallow); }; exec \"${SHELL:-/bin/sh}\" -l"
            let shell = SSHConnection(destination: remote.machine).invocation(running: script, extra: ["-t"])
            // ssh's own environment, which sends the terminal's kind along; this Mac's own box's
            // shell gets it too.
            let kind = environment.filter { ["TERM", "COLORTERM", "TERM_PROGRAM"].contains($0.key) }
            view.startProcess(
                executable: shell.executable,
                args: shell.arguments,
                environment: (shell.environment.map { $0.merging(kind) { $1 } } ?? environment).map { "\($0.key)=\($0.value)" },
                currentDirectory: shell.directory?.path ?? NSHomeDirectory()
            )
            started()
            return true
        }
        var isFolder: ObjCBool = false
        // SwiftTerm starts it in the app's own folder (/) when it can't go there, without a word.
        let there = FileManager.default.fileExists(atPath: directory, isDirectory: &isFolder) && isFolder.boolValue
        if !there { view.feed(text: Self.note("That folder isn’t there anymore: \(directory). This is your home folder.") + "\r\n") }
        let shell = environment["SHELL"] ?? "/bin/zsh"
        // A leading "-" in the process name makes it a login shell, as Terminal does.
        view.startProcess(
            executable: shell,
            environment: environment.map { "\($0.key)=\($0.value)" },
            execName: "-" + (shell as NSString).lastPathComponent,
            currentDirectory: there ? directory : NSHomeDirectory()
        )
        started()
        return there
    }

    /// Running if SwiftTerm started it, and watched for its end.
    private func started() {
        isRunning = view.process.running
        if isRunning { watchShell() }
    }

    /// Keys typed in a terminal: Option as Meta (Esc and the key, for a shell's word moves) except
    /// where your keyboard types a character with it (@ { } [ ] | ~ \ on Turkish, German and
    /// other layouts), and Return in one whose shell ended starts it again.
    private static let keys: Any? = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
        guard let view = event.window?.firstResponder as? LocalProcessTerminalView,
              let session = view.processDelegate as? TerminalSession else { return event }
        return session.typed(event) ? nil : event
    }

    /// Readies the terminal for a key typed in it; true when that's taken care of here.
    func typed(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.numericPad, .function, .capsLock])
        if !isRunning, event.keyCode == 36 || event.keyCode == 76, modifiers.isEmpty {
            restart()
            return true
        }
        view.optionAsMetaKey = Self.optionIsMeta(for: event)
        return false
    }

    /// Whether Option sends Esc and the key: not when it types a character of its own on your
    /// keyboard that's plain ASCII (on a US one, ⌥B's "∫" isn't wanted in a shell: word back is).
    /// A key that starts a character with the next (⌥N's ~ on a German keyboard) is asked of the
    /// keyboard layout, as `accent` does.
    static func optionIsMeta(for event: NSEvent, accent: (NSEvent) -> String? = KeyboardLayout.accent(of:)) -> Bool {
        guard event.modifierFlags.contains(.option), !event.modifierFlags.contains(.command) else { return true }
        let typed = event.characters?.isEmpty == false ? event.characters : accent(event)
        guard let typed, typed.count == 1, typed != event.charactersIgnoringModifiers, let scalar = typed.unicodeScalars.first,
              scalar.isASCII, (0x20..<0x7F).contains(scalar.value) else { return true }
        return false
    }

    /// A line the app writes in the terminal, dimmed, as Terminal's "[Process completed]".
    private static func note(_ text: String) -> String { "\u{1B}[2m[\(text)]\u{1B}[0m" }

    /// Return in a terminal whose shell ended starts a new one there (a machine's: reconnects).
    func restart() {
        guard !isRunning, !closed else { return }
        // Done with the old one: a job it left running in the background no longer writes here,
        // nor ends the new one as it closes.
        hangUp()
        view.terminate()
        view.feed(text: "\r\n")
        start()
    }

    /// Interrupts whatever runs in the shell (Control-C), then types `command`.
    func run(_ command: String) {
        view.send([0x03])
        Task {
            try? await Task.sleep(for: .milliseconds(300))
            view.send(txt: command + "\r")
        }
    }

    func terminate() {
        closed = true
        exit?.cancel()
        exit = nil
        guard isRunning else { return }
        hangUp()
        view.terminate()
        isRunning = false
    }

    /// Hung up, as closing a terminal window does: SwiftTerm sends at most a SIGTERM, which an
    /// interactive shell ignores, so it stayed running after its tab closed, with whatever it ran
    /// (a dev server holding its port). The terminal knows: what runs in front, and the shell that
    /// leads it.
    private func hangUp() {
        guard let terminal = view.process?.childfd, terminal >= 0 else { return }
        let front = tcgetpgrp(terminal)
        guard front > 0 else { return }
        let shell = getsid(front)
        killpg(front, SIGHUP)
        if shell > 0 { kill(shell, SIGHUP) }
    }

    /// Colors for the app's appearance: the card's own background, so the terminal is part of
    /// the card rather than a box in it, and an ANSI palette that stays readable on it. (Solid,
    /// not see-through: SwiftTerm draws reverse video from the background color.)
    func apply(dark: Bool, focused: Bool) {
        guard appliedLook.map({ $0 != (dark, focused) }) ?? true else { return }
        appliedLook = (dark, focused)
        let background = Surface.cardFillColor(dark: dark, focused: focused)
        view.nativeBackgroundColor = background
        view.layer?.backgroundColor = background.cgColor
        view.needsDisplay = true
        view.nativeForegroundColor = dark ? NSColor(white: 0.9, alpha: 1) : NSColor(white: 0.12, alpha: 1)
        view.caretColor = .controlAccentColor
        view.selectedTextBackgroundColor = NSColor.selectedTextBackgroundColor
        view.installColors(dark ? Self.darkPalette : Self.lightPalette)
    }

    /// A Nerd Font when one is installed (shell prompts draw icons with them), else SF Mono.
    private static let font: NSFont = {
        if let nerd = nerdFont(in: NSFontManager.shared.availableFontFamilies), let font = NSFont(name: nerd, size: 12) ?? NSFontManager.shared.font(withFamily: nerd, traits: [], weight: 5, size: 12) {
            return font
        }
        return NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    }()

    /// The Nerd Font to write in, of those installed: one with letters, not the symbols-only one
    /// installed for a prompt's icons (macOS takes the icons from it in any font).
    static func nerdFont(in families: [String]) -> String? {
        let lettered = families.filter { !$0.hasPrefix("Symbols") }
        return lettered.first { $0.contains("Nerd Font Mono") } ?? lettered.first { $0.contains("Nerd Font") || $0.hasSuffix(" NF") }
    }

    private static func palette(_ hex: [UInt32]) -> [SwiftTerm.Color] {
        hex.map { value in
            SwiftTerm.Color(red: UInt16((value >> 16) & 0xFF) * 257, green: UInt16((value >> 8) & 0xFF) * 257, blue: UInt16(value & 0xFF) * 257)
        }
    }

    private static let darkPalette = palette([
        0x000000, 0xCD3131, 0x0DBC79, 0xE5E510, 0x2472C8, 0xBC3FBC, 0x11A8CD, 0xE5E5E5,
        0x666666, 0xF14C4C, 0x23D18B, 0xF5F543, 0x3B8EEA, 0xD670D6, 0x29B8DB, 0xFFFFFF,
    ])

    private static let lightPalette = palette([
        0x000000, 0xCD3131, 0x107C10, 0x949800, 0x0451A5, 0xBC05BC, 0x0598BC, 0x555555,
        0x666666, 0xCD3131, 0x14A314, 0xB5BA00, 0x0451A5, 0xBC05BC, 0x0598BC, 0xA5A5A5,
    ])
}

/// The keyboard layout in use, for what a key types with Option.
nonisolated enum KeyboardLayout {
    /// The character a key that waits for the next one (an accent: ⌥N on a German keyboard)
    /// stands for on its own, with the modifiers it was pressed with.
    static func accent(of event: NSEvent) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        var dead: UInt32 = 0
        var length = 0
        var characters = [UniChar](repeating: 0, count: 4)
        var modifiers: UInt32 = 0
        if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey >> 8) }
        if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey >> 8) }
        let status = data.withUnsafeBytes { layout -> OSStatus in
            guard let layout = layout.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return -1 }
            return UCKeyTranslate(layout, event.keyCode, UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, characters.count, &length, &characters)
        }
        guard status == noErr, length > 0 else { return nil }
        return String(utf16CodeUnits: characters, count: length)
    }
}

/// Right-click: Add to Message, Copy and Paste.
extension TerminalSession: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let hasSelection = view.selectionActive
        let add = NSMenuItem(title: "Add to Message", action: hasSelection ? #selector(addSelection) : nil, keyEquivalent: "")
        add.target = self
        menu.addItem(add)
        menu.addItem(.separator())
        let copy = NSMenuItem(title: "Copy", action: hasSelection ? #selector(NSText.copy(_:)) : nil, keyEquivalent: "")
        copy.target = view
        menu.addItem(copy)
        let paste = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "")
        paste.target = view
        menu.addItem(paste)
    }

    /// The selection as a code block, without the blank space terminals pad lines with.
    @objc private func addSelection() {
        guard let selection = view.getSelection() else { return }
        let lines = selection.components(separatedBy: "\n").map { String($0.reversed().drop(while: \.isWhitespace).reversed()) }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
        guard !text.isEmpty else { return }
        addToMessage?("```\n\(text)\n```")
    }
}

extension TerminalSession: @preconcurrency LocalProcessTerminalViewDelegate {
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        // Only when it says something new, without the spinner some agents turn at its start: one
        // changing every tenth of a second would draw the tabs and the sidebar again as often.
        let steady = Self.tabTitle(title, otherwise: untitled)
        if self.title != steady { self.title = steady }
    }

    /// What a tab says, as Terminal and VS Code name theirs: what runs in it, by the title it
    /// sets, without the spinner or mark an agent keeps changing at its start (Braille dots, ✳);
    /// else `untitled`. A shell's own "user@host: ~/src/app" says only the folder ("app"), so two
    /// shells on one machine don't read alike, cut off at the same place; "npm@10.8.1" is no host.
    static func tabTitle(_ title: String, otherwise untitled: String) -> String {
        let marks: Set<Character> = ["✳", "✶", "✻", "✽", "✢", "✺", "·", "•", "●", "○", "◐", "◓", "◑", "◒", "⏺"]
        let kept = title.drop { $0.isWhitespace || marks.contains($0) || $0.unicodeScalars.allSatisfy { (0x2800...0x28FF).contains($0.value) } }
        var named = kept.trimmingCharacters(in: .whitespaces)
        // A shell's user@host (a container's host may start with a digit, when a folder follows);
        // a version, like npm@10.8.1, isn't one.
        if let shell = named.wholeMatch(of: /[\w.-]+@([\w.-]+)(?::\s*(.*))?/), shell.2 != nil || shell.1.first?.isLetter == true {
            named = shell.2.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        }
        if named.isEmpty { return untitled }
        return named.hasPrefix("/") || named.hasPrefix("~") ? folderName(named) : named
    }

    /// A folder as a tab names it: its last part, your home folder as ~, and the top as /. Where
    /// the terminal starts (`isStart`), a machine's home folder too, which its shell would call ~;
    /// once the shell names its folder, only its own home is ~.
    static func folderName(_ path: String, isStart: Bool = false) -> String {
        let path = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        if path == "/" { return "/" }
        if path == "~" || path == NSHomeDirectory() { return "~" }
        if isStart, path == "/root" || (path.wholeMatch(of: /\/(home|Users)\/[^\/]+/) != nil && path != "/Users/Shared") { return "~" }
        return (path as NSString).lastPathComponent
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    /// `exitCode`: SwiftTerm's, the shell's wait status as `waitpid` gives it.
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        ended(status: exitCode)
    }
}
