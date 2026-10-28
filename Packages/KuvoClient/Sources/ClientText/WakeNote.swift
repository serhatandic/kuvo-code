import Foundation

/// A wake-up's note as its line shows it, in both apps: what to do, first. An agent often starts
/// one with the conversation's own folder ("In /Users/…/salary-demo, check whether…"), which the
/// conversation already has: that goes. Any other path, and a note that starts otherwise, stays.
public enum WakeNote {
    public static func shown(_ note: String, folder: String?) -> String {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let folder, !folder.isEmpty,
              let regex = try? NSRegularExpression(pattern: #"^(?:[Ii]n\s+)?`?((?:/|~/)[^`\n]*?)`?\s*[,:]\s+(.+)$"#, options: [.dotMatchesLineSeparators]),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let pathRange = Range(found.range(at: 1), in: text), let restRange = Range(found.range(at: 2), in: text),
              isFolder(String(text[pathRange]), folder) else { return text }
        let rest = String(text[restRange])
        // "check whether…" reads as a sentence; a command ("npm test …") stays as typed.
        guard let first = rest.split(separator: " ").first, first.allSatisfy(\.isLetter), !commands.contains(String(first)) else { return rest }
        return rest.prefix(1).uppercased() + rest.dropFirst()
    }

    /// `path` is `folder` (written from home, "~/…", or with a slash at its end).
    private static func isFolder(_ path: String, _ folder: String) -> Bool {
        let trim = { (each: String) in each.count > 1 && each.hasSuffix("/") ? String(each.dropLast()) : each }
        let path = trim(path), folder = trim(folder)
        if path == folder { return true }
        return path.hasPrefix("~/") && folder.hasSuffix(String(path.dropFirst(1)))
    }

    private static let commands: Set<String> = ["npm", "npx", "pnpm", "yarn", "bun", "git", "gh", "curl", "make", "cargo", "go", "python", "python3", "node", "swift", "xcodebuild", "pytest", "ls", "cd", "open"]
}
