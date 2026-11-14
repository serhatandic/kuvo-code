import Foundation

/// A code block's language as people write it: "swift" is Swift, "ts" is TypeScript. One
/// without a language is just code.
public enum CodeLanguage {
    /// Before the language of a code block a reply is still writing, so the highlighter doesn't
    /// know it and leaves it plain (it would color it again each time it grew). Once it's done,
    /// its language changes, and Textual colors it then.
    public nonisolated static let writing = "kuvo-writing-"

    public static func name(of hint: String?) -> String {
        let hint = hint.map { $0.hasPrefix(writing) ? String($0.dropFirst(writing.count)) : $0 }
        guard let hint = hint?.trimmingCharacters(in: .whitespaces).lowercased(), !hint.isEmpty else { return "Code" }
        if let name = names[hint] { return name }
        // Unknown ones as written, capitalized: "elixir" is Elixir.
        return hint.prefix(1).uppercased() + hint.dropFirst()
    }

    private static let names: [String: String] = [
        "swift": "Swift", "objc": "Objective-C", "objective-c": "Objective-C",
        "js": "JavaScript", "javascript": "JavaScript", "jsx": "JSX", "mjs": "JavaScript", "cjs": "JavaScript",
        "ts": "TypeScript", "typescript": "TypeScript", "tsx": "TSX",
        "py": "Python", "python": "Python", "rb": "Ruby", "ruby": "Ruby",
        "go": "Go", "golang": "Go", "rs": "Rust", "rust": "Rust",
        "java": "Java", "kt": "Kotlin", "kotlin": "Kotlin", "scala": "Scala",
        "c": "C", "h": "C", "cpp": "C++", "c++": "C++", "cc": "C++", "hpp": "C++", "cs": "C#", "csharp": "C#",
        "php": "PHP", "dart": "Dart", "lua": "Lua", "r": "R", "zig": "Zig", "ex": "Elixir", "exs": "Elixir",
        "sh": "Shell", "shell": "Shell", "bash": "Bash", "zsh": "Zsh", "fish": "Fish", "console": "Terminal",
        "powershell": "PowerShell", "ps1": "PowerShell",
        "html": "HTML", "xml": "XML", "svg": "SVG", "css": "CSS", "scss": "SCSS", "sass": "Sass", "less": "Less",
        "json": "JSON", "jsonc": "JSON", "yaml": "YAML", "yml": "YAML", "toml": "TOML", "ini": "INI",
        "md": "Markdown", "markdown": "Markdown", "sql": "SQL", "graphql": "GraphQL", "gql": "GraphQL",
        "dockerfile": "Dockerfile", "docker": "Dockerfile", "makefile": "Makefile", "make": "Makefile",
        "diff": "Diff", "patch": "Diff", "text": "Text", "txt": "Text", "plaintext": "Text",
        "vue": "Vue", "svelte": "Svelte", "proto": "Protocol Buffers", "tf": "Terraform", "hcl": "HCL",
    ]
}

/// A line of code as it's set, monospaced, in a code block.
public enum CodeLine {
    /// How wide `line` is in a monospaced font with this advance: its characters times the
    /// advance, wide ones (Chinese, emoji) twice, and a tab to the next tab stop.
    public nonisolated static func width(of line: String, advance: CGFloat) -> CGFloat {
        var width: CGFloat = 0
        for character in line {
            if character == "\t" {
                width = ((width / tabStop).rounded(.down) + 1) * tabStop
                continue
            }
            let first = character.unicodeScalars.first!
            let isWide = first.value >= 0x2E80 || first.properties.isEmojiPresentation || character.unicodeScalars.contains("\u{FE0F}")
            width += isWide ? advance * 2 : advance
        }
        return width
    }

    /// Text's tab stops: AppKit's, every 28 points.
    private nonisolated static let tabStop: CGFloat = 28
}
