import ClientDesign
import JavaScriptCore
import SwiftUI
import Textual

/// Colors code with Prism.js (bundled in Resources, MIT), off the main thread. Prism
/// hands back tokens rather than HTML, so a whole file is tokenized once and every line
/// keeps its exact text, which a diff needs.
actor CodeHighlighter {
    static let shared = CodeHighlighter()

    /// A run of text and its Prism token type ("keyword", "string", …), empty for plain.
    struct Run: Sendable, Hashable {
        var text: String
        var type: String
    }

    private var context: JSContext?
    private var failed = false
    private var cache: [Int: [[Run]]] = [:]

    /// `text` split into lines of runs, or nil when the language isn't known.
    func lines(of text: String, language: String) -> [[Run]]? {
        let key = text.hashValue ^ language.hashValue
        if let cached = cache[key] { return cached }
        guard let context = prepared(),
              let tokenize = context.objectForKeyedSubscript("kuvoTokenize"),
              let result = tokenize.call(withArguments: [text, language]), !result.isNull, !result.isUndefined,
              let pairs = result.toArray() as? [[Any]] else { return nil }
        var lines: [[Run]] = [[]]
        for pair in pairs {
            guard let piece = pair.first as? String else { continue }
            let type = pair.count > 1 ? (pair[1] as? String ?? "") : ""
            let parts = piece.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
            for (index, part) in parts.enumerated() {
                if index > 0 { lines.append([]) }
                if !part.isEmpty { lines[lines.count - 1].append(Run(text: String(part), type: type)) }
            }
        }
        if cache.count > 200 { cache.removeAll() }
        cache[key] = lines
        return lines
    }

    private func prepared() -> JSContext? {
        if let context { return context }
        guard !failed,
              let url = Bundle.main.url(forResource: "prism-bundle", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else {
            failed = true
            return nil
        }
        context.evaluateScript(source)
        // One of the bundled language plugins throws while loading; Prism works regardless.
        context.exception = nil
        // Flattens Prism's token tree to [text, type] pairs; the innermost type wins.
        context.evaluateScript("""
        function kuvoTokenize(text, language) {
          var grammar = Prism.languages[language];
          if (!grammar) return null;
          var out = [];
          function walk(token, type) {
            if (typeof token === "string") { out.push([token, type]); return; }
            if (Array.isArray(token)) { for (var i = 0; i < token.length; i++) walk(token[i], type); return; }
            var own = token.type;
            if (token.alias) own = Array.isArray(token.alias) ? token.alias[0] : token.alias;
            walk(token.content, own || token.type || type);
          }
          walk(Prism.tokenize(text, grammar), "");
          return out;
        }
        """)
        guard context.exception == nil else {
            failed = true
            return nil
        }
        self.context = context
        return context
    }

    /// Prism's name for a file's language, from its name.
    nonisolated static func language(for path: String) -> String? {
        let name = (path as NSString).lastPathComponent.lowercased()
        if name == "dockerfile" { return "docker" }
        if name == "makefile" { return "makefile" }
        switch (name as NSString).pathExtension {
        case "swift": return "swift"
        case "js", "mjs", "cjs": return "javascript"
        case "jsx": return "jsx"
        case "ts", "mts", "cts": return "typescript"
        case "tsx": return "tsx"
        case "py": return "python"
        case "rb": return "ruby"
        case "go": return "go"
        case "rs": return "rust"
        case "java": return "java"
        case "kt", "kts": return "kotlin"
        case "c", "h": return "c"
        case "cc", "cpp", "cxx", "hpp", "hh", "mm": return "cpp"
        case "m": return "objectivec"
        case "cs": return "csharp"
        case "json", "jsonc": return "json"
        case "yml", "yaml": return "yaml"
        case "toml": return "toml"
        case "md", "markdown": return "markdown"
        case "html", "htm", "xml", "svg", "plist", "xib", "storyboard": return "markup"
        case "css": return "css"
        case "scss": return "scss"
        case "sass": return "sass"
        case "less": return "less"
        case "sh", "bash", "zsh", "fish": return "bash"
        case "sql": return "sql"
        case "php": return "php"
        case "lua": return "lua"
        case "dart": return "dart"
        case "scala": return "scala"
        case "zig": return "zig"
        case "ex", "exs": return "elixir"
        case "erl": return "erlang"
        case "hs": return "haskell"
        case "graphql", "gql": return "graphql"
        case "pl", "pm": return "perl"
        case "ps1": return "powershell"
        case "tex": return "latex"
        default: return nil
        }
    }
}

/// Token colors for every piece of code in the app (diffs, files, replies): Xcode's in light
/// mode, and luminous pastels in dark mode (lavender, sky, mint, coral), which hold on a dark
/// surface where deep purples and blues sink into it.
enum CodeColors {
    static func color(for type: String, dark: Bool) -> Color? {
        switch type {
        case "keyword", "important", "atrule", "rule", "literal", "directive", "preprocessor":
            return dark ? Color(hex: 0xC3A6FF) : Color(hex: 0x9B2393)
        case "string", "char", "attr-value", "template-string", "url":
            return dark ? Color(hex: 0xFF9E87) : Color(hex: 0xC41A16)
        case "comment", "prolog", "doctype", "cdata", "block-comment", "doc-comment", "mark":
            return dark ? Color(hex: 0x7F8A9A) : Color(hex: 0x5D6C79)
        case "number", "boolean", "constant", "entity":
            return dark ? Color(hex: 0xF2D07E) : Color(hex: 0x1C00CF)
        case "class-name", "builtin", "namespace":
            return dark ? Color(hex: 0x7DC9FF) : Color(hex: 0x0B4F79)
        case "function", "function-variable", "function-name", "method":
            return dark ? Color(hex: 0x86E1C6) : Color(hex: 0x326D74)
        case "property", "attr-name", "key", "property-access":
            return dark ? Color(hex: 0xA9DCF7) : Color(hex: 0x3E8087)
        case "tag", "selector", "title":
            return dark ? Color(hex: 0xFF9CC4) : Color(hex: 0x9B2393)
        case "regex", "variable", "symbol":
            return dark ? Color(hex: 0xFFBE8C) : Color(hex: 0x6C36A9)
        case "inserted":
            return dark ? Color(hex: 0x8FD99A) : Color(hex: 0x1E7D32)
        case "deleted":
            return dark ? Color(hex: 0xFF8A80) : Color(hex: 0xC0392B)
        case "operator", "punctuation":
            return nil
        default:
            return nil
        }
    }

    /// The same palette for Textual, which draws the code blocks in replies and Markdown files.
    static let theme: StructuredText.HighlighterTheme = {
        let names = [
            "keyword", "important", "atrule", "literal", "directive", "preprocessor",
            "string", "char", "attr-value", "url", "regex",
            "comment", "prolog", "doctype", "cdata", "block-comment", "doc-comment", "mark",
            "number", "boolean", "constant", "entity",
            "class-name", "builtin", "namespace", "function", "function-name",
            "property", "attr-name", "tag", "selector", "variable", "inserted", "deleted",
        ]
        let bold: Set = ["keyword", "literal", "boolean", "mark"]
        var properties: [StructuredText.HighlighterTheme.TokenType: AnyTextProperty] = [:]
        for name in names {
            guard let light = color(for: name, dark: false), let dark = color(for: name, dark: true) else { continue }
            let color = DynamicColor(light: light, dark: dark)
            properties[.init(rawValue: name)] = bold.contains(name)
                ? AnyTextProperty(.foregroundColor(color), .fontWeight(.semibold))
                : AnyTextProperty(.foregroundColor(color))
        }
        return StructuredText.HighlighterTheme(
            foregroundColor: DynamicColor(light: Color(hex: 0x1F2328), dark: Color(hex: 0xE6E8EE)),
            backgroundColor: DynamicColor(.clear),
            tokenProperties: properties
        )
    }()
}
