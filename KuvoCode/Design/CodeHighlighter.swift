import JavaScriptCore

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
