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
