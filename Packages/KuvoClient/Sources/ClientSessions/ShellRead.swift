import OpenCodeKit

/// What a read of a background command's output found, as Output shows it in both apps.
public enum ShellRead: Equatable, Sendable {
    /// The end of what it has printed.
    case printed(String)
    /// Its engine no longer has it: it ended, and what it printed went with it. Nothing more to read.
    case ended
    /// It couldn't be read now (its computer away); a later read may.
    case unread

    /// What it has printed, when that was read.
    public var printed: String? {
        guard case .printed(let text) = self else { return nil }
        return text
    }
}

extension OpenCodeAPI {
    /// How much of the end of a command's output Output shows, in bytes.
    public static let shownShellOutput = 24_000

    /// The end of what command `id` has printed, as Output shows it: its last `shownShellOutput`
    /// bytes, from the first whole line in them (a progress line that redraws itself ends in a
    /// return). With no whole line in them (one long line, or none ended), all of them but the
    /// character the start cut in two. Ended when its engine says it has no such command (it ended
    /// and went); unread when it can't be read now (its computer is away).
    public func shellOutputEnd(of id: String, directory: String) async -> ShellRead {
        do {
            let size = try await shellOutput(id, limit: 1, directory: directory).size
            let start = max(0, size - Self.shownShellOutput)
            let read = try await shellOutput(id, from: start, limit: Self.shownShellOutput, directory: directory)
            var output = Substring(read.output)
            if start > 0 {
                let lines = output.firstIndex(where: \.isNewline).map { output[output.index(after: $0)...] }
                // The engine reads from a byte, so the first character may be half of one ("�").
                output = lines.flatMap { $0.allSatisfy(\.isNewline) ? nil : $0 } ?? output.drop { $0 == "\u{FFFD}" }
            }
            return .printed(String(output).trimmingCharacters(in: .newlines))
        } catch let error as ServerError where error.status == 404 && error.message.hasPrefix("Shell command not found") {
            // The engine's own word for it, not any 404 on the way (a link or relay's).
            return .ended
        } catch {
            return .unread
        }
    }
}
