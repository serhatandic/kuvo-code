import AppKit
import Foundation
import KuvoVoice
import Observation

/// How voice input shows itself (Settings › General › Voice Input): in the composer, which
/// listens where you type (the default), or the voice field, which takes the window's place while
/// you speak. Both are the same voice input (`VoiceInput`), and hand the words to the composer
/// the same way.
enum VoiceStyle: String, CaseIterable, Identifiable {
    case composer, field

    static let key = "voiceStyle"
    var id: String { rawValue }

    static var current: VoiceStyle {
        UserDefaults.standard.string(forKey: key).flatMap(VoiceStyle.init(rawValue:)) ?? .composer
    }

    var title: String {
        switch self {
        case .composer: "In the Composer"
        case .field: "Voice Field"
        }
    }

    /// What it's for, beside its name.
    var purpose: String {
        switch self {
        case .composer: "for quick notes"
        case .field: "for longer thoughts"
        }
    }
}

/// Voice input, for every composer: one listens at a time, and what it heard goes into the
/// composer that started it, after what's written there. Nothing is sent until you send it.
@MainActor @Observable
final class Dictation {
    /// Listening, getting ready, or saying why it can't, until it's done or canceled.
    private(set) var voice: VoiceInput?
    /// The composer it writes into: its session's ID, or a new session's draft key.
    private(set) var owner: String?
    /// How it shows while it listens: as Settings said when it started.
    private(set) var style = VoiceStyle.composer
    @ObservationIgnored private var deliver: ((String) -> Void)?
    /// The composer in view, which the shortcut starts voice input for.
    @ObservationIgnored private var focused: (owner: String, deliver: (String) -> Void)?

    /// Listens for the composer `owner`; `deliver` gets what was said once it's done.
    func start(for owner: String, deliver: @escaping (String) -> Void) {
        cancel()
        let voice = VoiceInput()
        voice.ended = { [weak self, weak voice] words in
            guard let self, let voice, self.voice === voice else { return }
            let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty { self.deliver?(words) }
            self.close()
        }
        style = VoiceStyle.current
        self.voice = voice
        self.owner = owner
        self.deliver = deliver
        voice.start()
        Analytics.shared.track("voice_started", ["style": style.rawValue])
    }

    #if DEBUG
    /// KUVO_DEMO_VOICE: listening for `owner`, in `style`, with sample words, without the
    /// microphone (a demo copy mustn't ask for it).
    func showSample(for owner: String, style: VoiceStyle) {
        let voice = VoiceInput()
        voice.showSample(confirmed: "Make the timer pause when the window loses focus, and keep the", guess: "badge counting down while it’s paused")
        self.style = style
        self.voice = voice
        self.owner = owner
        deliver = { _ in }
    }
    #endif

    /// Done: what was said goes into the composer.
    func finish() { voice?.finish() }

    /// Nothing kept: the composer stays as it was.
    func cancel() {
        voice?.cancel()
        close()
    }

    func isListening(for owner: String?) -> Bool { voice != nil && self.owner == owner }

    /// The composer you're typing in says so (and where its words go), for the shortcut.
    func offer(_ owner: String, deliver: @escaping (String) -> Void) {
        focused = (owner, deliver)
    }

    /// It let the keyboard go: the shortcut has nowhere to start.
    func withdraw(_ owner: String) {
        if focused?.owner == owner { focused = nil }
    }

    /// The shortcut, pressed: finishes what's listening, or starts for the composer you're
    /// typing in. False when there's neither, so the key goes on to what has it.
    @discardableResult
    func toggleFromShortcut() -> Bool {
        if voice != nil {
            finish()
            return true
        }
        guard let focused else { return false }
        start(for: focused.owner, deliver: focused.deliver)
        return true
    }

    // MARK: The shortcut (⇧⌘Space)

    @ObservationIgnored private var shortcutMonitor: Any?
    /// When the shortcut started it, while it's held.
    @ObservationIgnored private var heldSince: Date?
    /// Held longer than this, letting go finishes it; a tap leaves it listening until a pause.
    private static let hold: TimeInterval = 0.4

    /// ⇧⌘Space in the composer you're typing in: held, it listens until you let go; tapped, until a
    /// pause or another tap. For the composer you're writing in.
    func installShortcut() {
        guard shortcutMonitor == nil else { return }
        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            guard event.keyCode == 49 else { return event }
            let isDown = event.type == .keyDown, isRepeat = isDown && event.isARepeat
            let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
            // Local monitors are called on the main thread.
            let taken = MainActor.assumeIsolated { self?.shortcut(isDown: isDown, isRepeat: isRepeat, commandShift: modifiers == [.command, .shift]) ?? false }
            return taken ? nil : event
        }
    }

    /// Space, down or up: whether the shortcut took it.
    private func shortcut(isDown: Bool, isRepeat: Bool, commandShift: Bool) -> Bool {
        if isDown, commandShift {
            if isRepeat { return voice != nil }
            let wasListening = voice != nil
            guard toggleFromShortcut() else { return false }
            heldSince = !wasListening && voice != nil ? Date() : nil
            return true
        }
        if !isDown, let since = heldSince {
            heldSince = nil
            if Date().timeIntervalSince(since) > Self.hold { finish() }
            return true
        }
        return false
    }

    private func close() {
        voice = nil
        owner = nil
        deliver = nil
    }

    /// What's written, with what was said after it, a space or a new line between as it reads.
    static func adding(_ words: String, to text: String) -> String {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return words }
        let separator = text.hasSuffix("\n") || text.hasSuffix(" ") ? "" : " "
        return text + separator + words
    }
}
