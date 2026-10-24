import AppKit
import SwiftUI
import Textual

// Find in a conversation (⌘F), the same in sessions and group chats: each place the words are is
// marked where it's written, the one you're on in orange, and a bar in the corner goes through
// them.

/// Find in one conversation: what you look for, every place it is, and the one you're on.
@Observable
final class ConversationFind {
    /// A part of a row's words, as it's shown: plain, or Markdown (a reply), which Find reads as
    /// it's drawn.
    enum Part: Sendable {
        case plain(String)
        case markdown(String)
    }

    struct Row: Sendable {
        var id: String
        /// One after another, as the row shows them.
        var parts: [Part]
    }

    /// A place the words are: in which row, which of the row's places it is, and how far down
    /// its words.
    struct Place: Sendable {
        var row: String
        var number: Int
        var fraction: CGFloat
    }

    var isOn = false
    var query = ""
    private(set) var places: [Place] = []
    private(set) var index = 0
    /// Goes up when Find is asked for again with its bar open, to take the keyboard.
    private(set) var focusRequests = 0
    @ObservationIgnored private var rowsFound: Set<String> = []
    @ObservationIgnored private var looking: Task<Void, Never>?
    @ObservationIgnored weak var scroller: ConversationScroller?

    var current: Place? { places.indices.contains(index) ? places[index] : nil }

    /// Every conversation's Find, for Escape, which closes an open one before it stops anything.
    @ObservationIgnored nonisolated(unsafe) private static var all = NSHashTable<ConversationFind>.weakObjects()

    init() { Self.all.add(self) }

    static var hasOpen: Bool { all.allObjects.contains(where: \.isOn) }

    /// Closes the open Find bars; whether there was one.
    static func closeOpen() -> Bool {
        let open = all.allObjects.filter(\.isOn)
        for find in open { find.isOn = false }
        return !open.isEmpty
    }

    /// What the rows' marks go by. Read where the rows are made, so they're made again when it
    /// changes: the marks are read later, as each row is laid out (`RowStack`), which SwiftUI
    /// doesn't see, so moving to another place, or finding more, showed in no row.
    var marksState: [AnyHashable] {
        [isOn, query, index, places.count, current?.row, current?.number]
    }

    /// Opens the bar (with `query`, when there's one to look for).
    func open(_ query: String? = nil) {
        if let query { self.query = query }
        if isOn { focusRequests += 1 }
        isOn = true
    }

    /// What a row marks: nothing when Find has no place in it.
    func highlight(for row: String) -> FindHighlight? {
        guard isOn, rowsFound.contains(row) else { return nil }
        return FindHighlight(query: query, current: current?.row == row ? current?.number : nil)
    }

    /// The place before or after the one you're on, in view.
    func step(_ by: Int) {
        guard !places.isEmpty else { return }
        index = (index + by + places.count) % places.count
        reveal()
    }

    private func reveal() {
        guard let current else { return }
        scroller?.reveal(current.row, at: current.fraction)
    }

    /// Looks in `rows` for the words, away from the main thread (it reads every reply). As you
    /// type, the first place found comes into view; as the conversation changes under it, the
    /// place you're on stays it. The looking, to wait for.
    @discardableResult
    func look(in rows: [Row], folders: [String], showsFirst: Bool) -> Task<Void, Never>? {
        looking?.cancel()
        let query = query
        guard isOn, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            rowsFound = []
            places = []
            index = 0
            return nil
        }
        let was = current
        looking = Task {
            let found = await Self.places(of: query, in: rows, folders: folders)
            guard !Task.isCancelled else { return }
            rowsFound = Set(found.map(\.row))
            places = found
            if showsFirst {
                index = 0
                reveal()
            } else {
                index = was.flatMap { was in found.firstIndex { $0.row == was.row && $0.number == was.number } } ?? min(index, max(found.count - 1, 0))
            }
        }
        return looking
    }

    @concurrent
    private nonisolated static func places(of query: String, in rows: [Row], folders: [String]) async -> [Place] {
        var found: [Place] = []
        for row in rows {
            if Task.isCancelled { return [] }
            let text = row.parts.map { part in
                switch part {
                case .plain(let text): text
                case .markdown(let markdown): FindText.shown(markdown: markdown, folders: folders)
                }
            }.joined(separator: "\n")
            let ranges = FindText.ranges(of: query, in: text)
            guard !ranges.isEmpty else { continue }
            let length = CGFloat(max(text.utf16.count, 1))
            for (number, range) in ranges.enumerated() {
                found.append(Place(row: row.id, number: number, fraction: CGFloat(range.lowerBound.utf16Offset(in: text)) / length))
            }
        }
        return found
    }
}

/// What Find marks in a piece of text: the words, and which of their places there is the one
/// you're on.
struct FindHighlight: Hashable, Sendable {
    var query: String
    /// The place you're on, counted from this text's first; nil when it's elsewhere.
    var current: Int?

    /// For texts shown one after another (a message's quote, then its words), what each marks:
    /// the place you're on counted from its own first.
    func spread(over texts: [String]) -> [FindHighlight] {
        var before = 0
        return texts.map { text in
            let count = FindText.ranges(of: query, in: text).count
            defer { before += count }
            var part = self
            part.current = current.flatMap { $0 >= before && $0 < before + count ? $0 - before : nil }
            return part
        }
    }
}

extension EnvironmentValues {
    /// Find's marks for the words in this row, while Find has places in it.
    @Entry var findHighlight: FindHighlight?
    /// Room over a conversation's first row for something on top of it (Find's bar).
    @Entry var conversationTopRoom: CGFloat = 0
}

/// Where words are in text, as Find sees them (case and accents aside), and marking them.
nonisolated enum FindText {
    /// Each place `query` is in `text`, in order.
    static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var found: [Range<String.Index>] = []
        var start = text.startIndex
        while start < text.endIndex,
              let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], range: start..<text.endIndex) {
            found.append(range)
            start = range.upperBound
        }
        return found
    }

    /// What `markdown` shows once drawn: its words without their marks, files by their names,
    /// formulas as one character each, as Find counts them. Kept, as Find reads every reply on
    /// each letter you type.
    static func shown(markdown: String, folders: [String]) -> String {
        let key = folders.joined(separator: "\n") + "\u{0}" + markdown as NSString
        if let known = cache.object(forKey: key) { return known as String }
        // As a reply reads it, with its math drawn, here away from the main thread: a formula as
        // one character, as it's drawn, or as written when it can't be.
        let math = MathSyntax(blockLanguage: MathText.blockLanguage) { formula, attributes in
            MathText.drawable(formula.latex) == nil ? nil : AttributedString("\u{FFFC}", attributes: attributes)
        }
        var text = (try? math.attributedString(markdown: markdown)) ?? AttributedString(markdown)
        for (range, _) in FileLinks.spans(in: text, folders: folders) {
            text.replaceSubrange(range, with: AttributedString(FileLinks.icon + " " + FileLinks.label(String(text[range].characters))))
        }
        let shown = searchable(text)
        cache.setObject(shown as NSString, forKey: key)
        return shown
    }

    /// The characters of `text` Find looks in: a formula of its own (a code block drawn as math)
    /// as object characters, as nothing in it can be marked.
    static func searchable(_ text: AttributedString) -> String {
        func isMath(_ intent: PresentationIntent?) -> Bool {
            intent?.components.contains { $0.kind == .codeBlock(languageHint: MathText.blockLanguage) } == true
        }
        guard text.runs[\.presentationIntent].contains(where: { isMath($0.0) }) else { return String(text.characters) }
        var plain = ""
        for (intent, range) in text.runs[\.presentationIntent] {
            let characters = text[range].characters
            plain += isMath(intent) ? String(repeating: "\u{FFFC}", count: characters.count) : String(characters)
        }
        return plain
    }

    /// NSCache is thread-safe.
    nonisolated(unsafe) private static let cache: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>()
        cache.countLimit = 5000
        return cache
    }()

    /// Every place yellow, the one you're on orange, in dark letters either way.
    static let place = Color(red: 1, green: 0.84, blue: 0.1)
    static let currentPlace = Color(red: 1, green: 0.52, blue: 0.12)
    /// Inline code's own background, which Markdown's code style gives it otherwise (and would
    /// draw over the marks): GitHub's.
    static let codeBackground = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 37 / 255, green: 38 / 255, blue: 42 / 255, alpha: 1)
            : NSColor(red: 247 / 255, green: 247 / 255, blue: 249 / 255, alpha: 1)
    })

    /// Marks the places in `text`. `inCode`: Markdown, whose inline code takes its background
    /// from here (drawn with ``InlineStyle/findMarks``).
    static func mark(_ text: inout AttributedString, _ highlight: FindHighlight, inCode: Bool = false) {
        if inCode {
            for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
                text[run.range].swiftUI.backgroundColor = codeBackground
            }
        }
        let plain = searchable(text)
        for (number, range) in ranges(of: highlight.query, in: plain).enumerated() {
            // From the start each time, as marking may move what an index points at.
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let upper = text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            text[lower..<upper].swiftUI.backgroundColor = number == highlight.current ? currentPlace : place
            text[lower..<upper].swiftUI.foregroundColor = .black
        }
    }

    /// `text`, marked by `highlight` when there is one.
    static func marked(_ text: AttributedString, _ highlight: FindHighlight?) -> AttributedString {
        guard let highlight else { return text }
        var text = text
        mark(&text, highlight)
        return text
    }
}

extension InlineStyle {
    /// GitHub's, without a background for inline code: Find's marks give it one, so marks in
    /// code show.
    static let findMarks = InlineStyle()
        .code(.monospaced, .fontScale(0.85))
        .strong(.fontWeight(.semibold))
        .link(.foregroundColor(DynamicColor(light: Color(red: 44 / 255, green: 101 / 255, blue: 207 / 255),
                                            dark: Color(red: 76 / 255, green: 142 / 255, blue: 248 / 255))))
}

/// The bar in the conversation's corner: the words, and a way through their places. Return
/// goes to the next, Shift-Return to the previous, Escape closes.
struct FindBar: View {
    @Bindable var find: ConversationFind
    /// Reading what came before, to look in it too.
    var isSearchingEarlier = false
    /// The conversation goes back further than what's been read: a way to look there too.
    var searchEarlier: (() -> Void)?
    @FocusState private var isFocused: Bool

    private var results: String {
        guard !find.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }
        guard !find.places.isEmpty else { return "No results" }
        return "\(find.index + 1) / " + find.places.count.counting("result")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Find in Conversation", text: $find.query)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .onKeyPress(.return, phases: .down) { press in
                        if Composer.isComposing { return .ignored }
                        find.step(press.modifiers.contains(.shift) ? -1 : 1)
                        return .handled
                    }
                    .onExitCommand(perform: close)
                Button("Done", systemImage: "xmark", action: close)
                    .buttonStyle(CardActionStyle())
                    .help("Done (Esc)")
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .frame(height: 38)
            Divider()
            HStack(spacing: 2) {
                Button("Previous", systemImage: "arrow.up") { find.step(-1) }
                    .buttonStyle(CardActionStyle())
                    .disabled(find.places.isEmpty)
                    .help("Previous Result (⇧Return)")
                Button("Next", systemImage: "arrow.down") { find.step(1) }
                    .buttonStyle(CardActionStyle())
                    .disabled(find.places.isEmpty)
                    .help("Next Result (Return)")
                if isSearchingEarlier {
                    Spinner(size: 11)
                        .padding(.leading, 6)
                } else if let searchEarlier, !find.query.isEmpty {
                    Button("Search Earlier", action: searchEarlier)
                        .buttonStyle(TextButtonStyle(outset: true))
                        .font(.caption.weight(.medium))
                        .padding(.leading, 6)
                        .help("Read the rest of the conversation, from its start, and look in it too")
                }
                Spacer(minLength: 8)
                Text(results)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .frame(height: 34)
        }
        .font(.callout)
        .frame(width: 300)
        // Over the conversation, as the command palette is: plain glass lets the words behind
        // it through.
        .background(.background.opacity(0.75), in: .rect(cornerRadius: 14))
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .onAppear { isFocused = true }
        .onChange(of: find.focusRequests) { isFocused = true }
    }

    private func close() {
        find.isOn = false
    }
}

extension View {
    /// Find in this conversation: its bar in the corner while it's open, looking again in
    /// `rows` as you type and as `version` says they changed.
    func conversationFind(_ find: ConversationFind, scroller: ConversationScroller, version: some Hashable,
                          isSearchingEarlier: Bool = false, searchEarlier: (() -> Void)? = nil,
                          folders: @escaping () -> [String] = { [] }, rows: @escaping () -> [ConversationFind.Row]) -> some View {
        modifier(FindModifier(find: find, scroller: scroller, version: version, isSearchingEarlier: isSearchingEarlier,
                              searchEarlier: searchEarlier, folders: folders, rows: rows))
    }
}

private struct FindModifier<Version: Hashable>: ViewModifier {
    let find: ConversationFind
    let scroller: ConversationScroller
    let version: Version
    let isSearchingEarlier: Bool
    let searchEarlier: (() -> Void)?
    let folders: () -> [String]
    let rows: () -> [ConversationFind.Row]

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if find.isOn {
                    FindBar(find: find, isSearchingEarlier: isSearchingEarlier, searchEarlier: searchEarlier)
                        .padding(.top, 10)
                        .padding(.trailing, 12)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .topTrailing)))
                }
            }
            .animation(.ui, value: find.isOn)
            // Room for the bar over the conversation's top, so it doesn't cover the first message.
            .environment(\.conversationTopRoom, find.isOn ? 56 : 0)
            .onAppear { find.scroller = scroller }
            .onChange(of: find.query) { look(showsFirst: true) }
            .onChange(of: find.isOn) { look(showsFirst: true) }
            .onChange(of: version) { if find.isOn { look(showsFirst: false) } }
    }

    private func look(showsFirst: Bool) {
        find.look(in: rows(), folders: folders(), showsFirst: showsFirst)
    }
}
