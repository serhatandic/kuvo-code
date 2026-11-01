import Foundation

/// A folder or file an agent asks to work in outside its project, as people know it: the engine
/// asks by a pattern ("/Users/me/notes/*"), the coding agents' bridge by paths. Shown as the folder
/// itself, with "~" for the home folder ("~/notes"); spoken without slashes or stars, as VoiceOver
/// reads a path bar ("Home, notes").
public enum OutsideFolders {
    /// "~/notes" for "/Users/me/notes/*" (with `home` "/Users/me"); "/" for the whole disk, and
    /// "Any folder" for "*". A path elsewhere stays whole. `home` is the computer's that asks (nil
    /// when it isn't known: a machine's, say).
    public static func shown(_ pattern: String, home: String?) -> String {
        let path = folder(of: pattern)
        if path.isEmpty { return "Any folder" }
        if let rest = underHome(path, home) { return rest.isEmpty ? "~" : "~/" + rest }
        return path
    }

    /// The same, as VoiceOver reads it: its folders in order, "Home" for the home folder.
    public static func spoken(_ pattern: String, home: String?) -> String {
        let path = folder(of: pattern)
        if path.isEmpty { return "Any folder" }
        if path == "/" { return "The whole disk" }
        if let rest = underHome(path, home) { return (["Home"] + parts(rest)).joined(separator: ", ") }
        return parts(path).joined(separator: ", ")
    }

    /// The path a pattern names: its trailing "/*" or "/**" (everything in it) gone, and a
    /// trailing slash; "" for everything ("*"). Another star stays, as it means another thing.
    private static func folder(of pattern: String) -> String {
        var path = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        if path == "*" || path == "**" { return "" }
        if let glob = ["/**", "/*"].first(where: path.hasSuffix) {
            path.removeLast(glob.count)
            if path.isEmpty { path = "/" }
        }
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// What's under the home folder ("" for it itself), or nil for a path elsewhere.
    private static func underHome(_ path: String, _ home: String?) -> String? {
        if path == "~" { return "" }
        if path.hasPrefix("~/") { return String(path.dropFirst(2)) }
        guard var home, !home.isEmpty else { return nil }
        while home.count > 1, home.hasSuffix("/") { home.removeLast() }
        if path == home { return "" }
        return path.hasPrefix(home + "/") ? String(path.dropFirst(home.count + 1)) : nil
    }

    private static func parts(_ path: String) -> [String] {
        path.split(separator: "/").map(String.init)
    }
}
