import AppKit
import Foundation
import KuvoVoice
import Observation

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
    /// The composer whose mic shows the tip about more accurate voice input, once, after the first dictation.
    var tipFor: String?
    @ObservationIgnored private var deliver: ((String) -> Void)?
    /// The composer in view, which the shortcut starts voice input for.
    @ObservationIgnored private var focused: (owner: String, words: Words, deliver: (String) -> Void)?

    /// The words to listen for: the project's names, asked of its box.
    typealias Words = @Sendable () async -> [String]

    /// Listens for the composer `owner`, for `words`; `deliver` gets what was said once it's done.
    func start(for owner: String, words: @escaping Words = { [] }, deliver: @escaping (String) -> Void) {
        cancel()
        let voice = VoiceInput()
        voice.ended = { [weak self, weak voice] words in
            guard let self, let voice, self.voice === voice else { return }
            let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty {
                self.deliver?(words)
                if VoiceTip.takeTurn() { self.tipFor = owner }
            }
            self.close()
        }
        style = VoiceStyle.current
        self.voice = voice
        self.owner = owner
        self.deliver = deliver
        voice.start(words: words)
        Analytics.shared.track("voice_started", ["style": style.rawValue, "model": voice.usesWhisper ? "whisper" : "apple"])
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
    func offer(_ owner: String, words: @escaping Words, deliver: @escaping (String) -> Void) {
        focused = (owner, words, deliver)
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
        start(for: focused.owner, words: focused.words, deliver: focused.deliver)
        return true
    }

    // MARK: The shortcut (⇧⌘Space)

    @ObservationIgnored private var shortcutMonitor: Any?
    /// When the shortcut started it, while it's held.
    @ObservationIgnored private var heldSince: Date?
    /// Held longer than this, letting go finishes it; a tap leaves it listening until the next one.
    private static let hold: TimeInterval = 0.4

    /// ⇧⌘Space in the composer you're typing in: held, it listens until you let go; tapped, until
    /// another tap (or Done). For the composer you're writing in.
    func installShortcut() {
        guard shortcutMonitor == nil else { return }
        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            // Not in a sheet over the window, nor another window: where you type in a composer.
            guard event.keyCode == 49, event.window?.attachedSheet == nil, event.window?.isKeyWindow == true else { return event }
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
}
