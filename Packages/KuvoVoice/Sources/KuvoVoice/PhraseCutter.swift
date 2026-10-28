import Foundation

/// The microphone's samples (16 kHz, mono) cut into phrases at the pauses between them, for
/// Whisper to write one at a time: only what has speech in it, never the silence around it, so a
/// long pause (minutes of thinking) gives Whisper nothing to make words up from.
///
/// It tells speech from quiet by how loud each short stretch is against the room's own noise:
/// the quietest of the last few seconds, so a fan or a café is learned within moments, and
/// speech, which always has gaps between its words, doesn't become it.
struct PhraseCutter {
    static let rate = 16_000
    /// Each stretch it weighs: 30 ms.
    static let frame = 480
    /// A pause this long ends a phrase.
    static let pause = 0.7
    /// A phrase is cut here even with no pause, so Whisper never gets more than one window.
    static let longest = 24.0
    /// Shorter than this in all, it was a click or a breath, not speech.
    static let shortest = 0.25
    /// Kept before speech starts and after it stops, so the first and last sounds aren't clipped.
    static let before = 0.3
    static let after = 0.2

    struct Phrase: Equatable {
        /// Where it starts in what was heard, in seconds.
        let start: Double
        let samples: [Float]
        var seconds: Double { Double(samples.count) / Double(PhraseCutter.rate) }
    }

    /// Samples not yet weighed (less than a frame).
    private var loose: [Float] = []
    /// Recent frames, for what's kept before speech starts.
    private var lead: [Float] = []
    /// The phrase under way, from just before its speech started.
    private var current: [Float] = []
    private var currentStart = 0.0
    private var speechFrames = 0
    private var quietFrames = 0
    /// How many samples it's weighed in all, for where each phrase starts.
    private var heard = 0
    /// How loud the last few seconds were, frame by frame, for the room's noise.
    private var recent: [Float] = []
    private static let remembered = 100

    /// Whether a phrase is under way.
    var isSpeaking: Bool { !current.isEmpty }
    /// The phrase under way so far, for a guess at its words while it goes on.
    var partial: Phrase? { current.isEmpty ? nil : Phrase(start: currentStart, samples: current) }

    /// Takes the next samples; gives back each phrase they finish.
    mutating func take(_ samples: [Float]) -> [Phrase] {
        loose += samples
        var finished: [Phrase] = []
        var at = 0
        while loose.count - at >= Self.frame {
            if let phrase = weigh(Array(loose[at..<at + Self.frame])) { finished.append(phrase) }
            at += Self.frame
        }
        loose.removeFirst(at)
        return finished
    }

    /// Listening ended: the phrase under way, if it had speech.
    mutating func flush() -> Phrase? {
        if !loose.isEmpty, isSpeaking { current += loose }
        loose = []
        return end()
    }

    private mutating func weigh(_ frame: [Float]) -> Phrase? {
        let rms = frame.withUnsafeBufferPointer(VoiceLevel.rms)
        heard += frame.count
        recent.append(rms)
        if recent.count > Self.remembered { recent.removeFirst() }
        // The room's noise: the quietest stretches of the last 3 s (never louder than a loud room,
        // so speech always stands out).
        let floor = min(recent.sorted()[recent.count * 15 / 100], 0.03)
        let isSpeech = rms > max(floor * 3.5, 0.006)

        guard isSpeaking else {
            if isSpeech {
                currentStart = Double(heard - frame.count - lead.count) / Double(Self.rate)
                current = lead + frame
                lead = []
                speechFrames = 1
                quietFrames = 0
            } else {
                lead += frame
                let keep = Int(Self.before * Double(Self.rate))
                if lead.count > keep { lead.removeFirst(lead.count - keep) }
            }
            return nil
        }
        current += frame
        if isSpeech {
            speechFrames += 1
            quietFrames = 0
        } else {
            quietFrames += 1
        }
        let quiet = Double(quietFrames * Self.frame) / Double(Self.rate)
        if quiet >= Self.pause || Double(current.count) / Double(Self.rate) >= Self.longest {
            return end()
        }
        return nil
    }

    private mutating func end() -> Phrase? {
        defer {
            current = []
            speechFrames = 0
            quietFrames = 0
        }
        guard !current.isEmpty, Double(speechFrames * Self.frame) / Double(Self.rate) >= Self.shortest else { return nil }
        // The pause that ended it goes, but for a little after the last sound.
        let trailing = max(0, quietFrames * Self.frame - Int(Self.after * Double(Self.rate)))
        return Phrase(start: currentStart, samples: Array(current.dropLast(trailing)))
    }
}
