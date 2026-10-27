import Foundation

/// How a client names a file on a box for its `kuvo/file` route: by its path as written, byte for
/// byte, as the box's disk has it.
public enum FileAddresses {
    /// `file://` and the path, percent-encoded as written: never through a file URL, which spells
    /// "ş" as "s" and a mark, another name to a Linux machine's disk.
    public static func uri(_ path: String) -> String {
        "file://" + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)
    }

    /// The route that reads it ("kuvo/file?uri=…"): refused over `max` bytes, when given.
    public static func route(_ path: String, max: Int? = nil) -> String {
        route(uri: uri(path), max: max)
    }

    /// The same for a file already named by its URI (`file://…`, as an agent's step names it).
    public static func route(uri: String, max: Int? = nil) -> String {
        "kuvo/file?uri=" + query(uri) + (max.map { "&max=\($0)" } ?? "")
    }

    /// A URI as a query's value: what would end it or start another (`&+=?#`) encoded too.
    private static func query(_ uri: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?#")
        return uri.addingPercentEncoding(withAllowedCharacters: allowed) ?? uri
    }
}
