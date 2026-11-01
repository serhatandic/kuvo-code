import Foundation

/// What kind of file a name is, by its extension, and the symbol both apps draw it with where
/// they show a file without its own icon (the phone's Files and Changes; the Mac shows macOS's
/// icon for the file's type instead). One table, so a file reads as the same kind everywhere.
public enum FileKind: String, CaseIterable, Sendable {
    case code, text, data, table, picture, video, audio, document, archive, other

    /// "timer.js" is code, "notes.md" text, "Package.resolved" data; a name with no extension that
    /// builds or runs something (Makefile, Dockerfile) is code, and any other is other.
    public init(name: String) {
        let file = (name.split(separator: "/").last.map(String.init) ?? name).lowercased()
        if let kind = Self.names[file] {
            self = kind
            return
        }
        guard let dot = file.lastIndex(of: ".") else {
            self = .other
            return
        }
        // A dotfile (".gitignore", ".env") is its own name: settings in plain text.
        guard dot != file.startIndex else {
            self = .text
            return
        }
        self = Self.extensions[String(file[file.index(after: dot)...])] ?? .other
    }

    /// Its SF Symbol.
    public var symbol: String {
        switch self {
        case .code: "chevron.left.forwardslash.chevron.right"
        case .text: "doc.text"
        case .data: "curlybraces"
        case .table: "tablecells"
        case .picture: "photo"
        case .video: "film"
        case .audio: "waveform"
        case .document: "doc.richtext"
        case .archive: "doc.zipper"
        case .other: "doc"
        }
    }

    /// Whole names, before their extension decides.
    private static let names: [String: FileKind] = [
        "makefile": .code, "dockerfile": .code, "gemfile": .code, "podfile": .code, "rakefile": .code,
        "procfile": .code, "justfile": .code, "brewfile": .code, "vagrantfile": .code,
        "package.resolved": .data, "go.sum": .data, "cargo.lock": .data,
        "license": .text, "readme": .text, "changelog": .text, "authors": .text, "notice": .text,
    ]

    private static let extensions: [String: FileKind] = {
        var table: [String: FileKind] = [:]
        let kinds: [(FileKind, [String])] = [
            (.code, ["swift", "m", "mm", "h", "hpp", "c", "cc", "cpp", "cs", "go", "rs", "java", "kt", "kts", "scala",
                     "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro", "py", "rb", "php",
                     "dart", "lua", "r", "zig", "ex", "exs", "erl", "hs", "ml", "clj", "elm", "sh", "bash", "zsh",
                     "fish", "ps1", "html", "htm", "css", "scss", "sass", "less", "sql", "graphql", "gql", "proto",
                     "tf", "hcl", "nix", "wasm", "ipynb", "gradle", "cmake", "metal", "glsl"]),
            (.text, ["md", "markdown", "mdx", "txt", "text", "rst", "adoc", "org", "tex", "log", "rtf"]),
            (.data, ["json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
                     "xml", "plist", "lock", "entitlements", "xcconfig", "pbxproj", "properties", "db", "sqlite",
                     "sqlite3", "parquet"]),
            (.table, ["csv", "tsv", "xls", "xlsx", "numbers", "ods"]),
            (.picture, ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp", "tiff", "tif", "svg", "ico",
                        "icns", "psd", "sketch", "fig"]),
            (.video, ["mp4", "mov", "m4v", "webm", "mkv", "avi"]),
            (.audio, ["mp3", "m4a", "wav", "aac", "flac", "ogg", "aiff", "caf", "opus"]),
            (.document, ["pdf", "doc", "docx", "pages", "key", "ppt", "pptx", "odt", "epub"]),
            (.archive, ["zip", "gz", "tgz", "tar", "bz2", "xz", "zst", "7z", "rar", "dmg", "pkg", "jar", "ipa", "apk"]),
        ]
        for (kind, list) in kinds {
            for ext in list { table[ext] = kind }
        }
        return table
    }()
}
