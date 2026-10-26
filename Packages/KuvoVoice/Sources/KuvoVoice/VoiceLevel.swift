import Foundation

/// How loud you are, as the motion that answers your voice shows it: 0 (quiet) to 1, from each
/// stretch of the microphone's samples, rising at once and falling back gently, as a voice meter's
/// needle does.
public struct VoiceLevel: Equatable, Sendable {
    public private(set) var value: Double = 0
    /// Below this is quiet, in decibels (a room's hum); at `loud` it's full.
    var quiet: Double = -55
    var loud: Double = -12

    public init() {}

    /// The level of these samples (their RMS), taken in: up at once, down a little at a time.
    public mutating func take(rms: Float) {
        let decibels = 20 * log10(max(Double(rms), 1e-7))
        let heard = min(1, max(0, (decibels - quiet) / (loud - quiet)))
        value = heard > value ? value + (heard - value) * 0.6 : value + (heard - value) * 0.15
    }

    /// The RMS of a buffer of samples.
    public static func rms(_ samples: UnsafeBufferPointer<Float>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        return (sum / Float(samples.count)).squareRoot()
    }
}

/// When you've finished speaking: once you've said something, a pause of `seconds` without
/// speech ends it, as stopping talking ends dictation. Silence before you start never does.
public struct SpeechPause: Equatable, Sendable {
    /// How long a pause ends it.
    public var seconds: Double
    /// A level at or above this is speech.
    var speaking: Double = 0.22
    private var heardSpeech = false
    private var quietSince: Double?

    public init(seconds: Double = 1.8) {
        self.seconds = seconds
    }

    /// The level at `time` (seconds, the audio's own clock): whether you've finished.
    public mutating func take(level: Double, at time: Double) -> Bool {
        if level >= speaking {
            heardSpeech = true
            quietSince = nil
            return false
        }
        guard heardSpeech else { return false }
        if quietSince == nil { quietSince = time }
        return time - quietSince! >= seconds
    }

    /// New words came: you're still at it.
    public mutating func heardWords(at time: Double) {
        heardSpeech = true
        quietSince = nil
    }
}
