import AppKit
import ClientSessions
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The model picker with two accounts of one coding agent, the same model starred from each: the
/// Starred list shows each once, saying whose it is, however you came to it; and picking one picks
/// that account's. Stars and conversations from before Claude Code's `default` went (the box lists
/// the model it stands for, known by that name too) still find that model on their account. The
/// agents' bridge and the box's answer are stubbed; the picker and the catalog are real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ModelPickerAccountsTests {
    static let bridge = "http://127.0.0.1:47945"
    /// Claude Code's own sign-in, and one you added and called Work: each lists the same models.
    nonisolated static let accounts = [("claude-code", "Claude Code"), ("claude-code@work", "Claude Code · Work")]
    let app = AppModel()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 520), styleMask: [.titled], backing: .buffered, defer: false)

    init() async {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        StubWeb.handle(Self.bridge + "/api/integration") { _, _ in
            StubWeb.json(["data": Self.accounts.map { id, name in
                ["id": id, "name": name, "methods": [], "connections": [["type": "credential", "credentialID": id, "method": "oauth"]],
                 "metadata": ["source": "agent", "agent": "claude-code", "installed": true] as [String: Any]] as [String: Any]
            }])
        }
        StubWeb.handle(Self.bridge + "/api/model") { _, _ in
            StubWeb.json(["data": Self.accounts.flatMap { account, _ in
                [("opus", "Opus 5.5", 3), ("sonnet", "Sonnet 5.5", 2)].map { id, name, released -> [String: Any] in
                    // (As the box lists them: no `default`, the model it stands for known by it.)
                    ["id": id, "providerID": account, "name": name, "family": "claude-\(id)", "aliases": id == "opus" ? ["default"] : [],
                     "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
                     "time": ["released": released], "cost": [["input": 0, "output": 0]],
                     "status": "active", "enabled": true, "limit": ["context": 200_000, "output": 32_000]]
                }
            }])
        }
        // Its box, saying both accounts' models run (`kuvo/models/offered`).
        let offered = try? JSONSerialization.data(withJSONObject: [
            "models": Self.accounts.flatMap { account, _ in [("opus", "Opus 5.5"), ("sonnet", "Sonnet 5.5")].map { ["providerID": account, "id": $0.0, "name": $0.1] } },
            "known": ["engine": true, "agents": true],
        ] as [String: Any])
        app.catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { continuation in
                let answered = request.path.hasPrefix("kuvo/models/offered")
                continuation.yield(.head(status: answered ? 200 : 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(answered ? offered ?? Data() : Data(#"{"message":"No such route."}"#.utf8)))
                continuation.finish()
            }
        })
        app.catalog.outsideAgents = app.agents
        app.agents.connect(ServerEndpoint(url: URL(string: Self.bridge)!, password: "test"), folderPrefix: "")
        await app.catalog.refreshAgents()
        // As one user had them: Opus and its default on the first account, its default on the other.
        UserDefaults.standard.set("claude-code/opus,claude-code/default,claude-code@work/default", forKey: "favoriteModels")
    }

    private func close() {
        window.orderOut(nil)
        window.close()
        app.agents.disconnect()
        UserDefaults.standard.removeObject(forKey: "favoriteModels")
        AXElement.reading(false)
        StubWeb.stop()
    }

    /// The picker as the composer's chip opens it, on its list, until it closes.
    private struct Opener: View {
        let catalog: Catalog
        let selection: ModelRef?
        let picked: (ModelRef) -> Void
        @State private var isOpen = true

        var body: some View {
            VStack {
                if isOpen {
                    ModelPicker(catalog: catalog, selection: selection, onSelect: picked, close: { isOpen = false }, scope: .all, startsOnList: true)
                }
            }
            .frame(width: 400, height: 520, alignment: .top)
        }
    }

    private func show(selection: ModelRef?, picked: @escaping (ModelRef) -> Void = { _ in }) {
        window.contentView = NSHostingView(rootView: Opener(catalog: app.catalog, selection: selection, picked: picked).environment(app.catalog))
        window.orderBack(nil)
        window.contentView?.layoutSubtreeIfNeeded()
    }

    /// What VoiceOver finds in the window, as it lays out now (and a beat for `until` to look again).
    private var elements: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView)
    }

    private var labels: [String] { elements.compactMap(\.label) }

    /// The list's rows for a model named `name`, as VoiceOver reads them.
    private func rows(_ name: String) -> [String] {
        labels.filter { $0.hasPrefix(name) }
    }

    /// A click on the first of what VoiceOver calls `label`, sent through the window.
    private func click(_ matches: (String) -> Bool) throws {
        let found = elements.first { $0.label.map(matches) == true }
        let element = try #require(found, "among \(labels)")
        let frame = element.frame
        let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
    }

    @Test func eachStarredRowSaysItsAccountAndPickingOnePicksThatAccount() async throws {
        defer { close() }
        var picked: ModelRef?
        show(selection: nil) { picked = $0 }

        try await until { rows("Opus 5.5").count == 2 }
        let starred = rows("Opus 5.5")
        #expect(starred.filter { $0.contains("Claude Code · Work") }.count == 1, "\(starred)")
        #expect(starred.filter { !$0.contains("Work") && $0.contains("Claude Code") }.count == 1, "\(starred)")

        // The added account's: what's picked is that account's model, as the session is sent it.
        try click { $0.hasPrefix("Opus 5.5") && $0.contains("Work") }
        try await until { picked != nil }
        #expect(picked == ModelRef(id: "opus", providerID: "claude-code@work"))
    }

    @Test func starsOnAModelAndItsDefaultAreOneRowEach() async throws {
        defer { close() }
        show(selection: nil)
        try await until { rows("Opus 5.5").count == 2 }
        // Three stars, two rows: the same model starred twice on one account is one.
        #expect(rows("Opus 5.5").count == 2, "\(rows("Opus 5.5"))")
        #expect(labels.allSatisfy { !$0.contains("Default") }, "nothing called Default: \(labels)")
    }

    /// The rows VoiceOver reads as Opus 5.5, with which of them it says is the model in use.
    private func opusRows() -> [(label: String, inUse: Bool)] {
        elements.compactMap { element in element.label.flatMap { $0.hasPrefix("Opus 5.5") ? ($0, element.isSelected) : nil } }
    }

    /// A conversation on `default` (all there was before): the row of the account it's on is the one
    /// with the check mark, and only that one; picking the other account's moves it there.
    @Test(arguments: ["claude-code", "claude-code@work"]) func theModelInUseIsMarkedOnItsOwnAccountsRowOnly(account: String) async throws {
        defer { close() }
        // Opens on the account's own page: its one Opus row is marked.
        show(selection: ModelRef(id: "default", providerID: account))
        try await until { rows("Sonnet 5.5").count == 1 }
        #expect(opusRows().map(\.inUse) == [true], "the account's own page: \(opusRows())")
        #expect(labels.allSatisfy { !$0.contains("Default") }, "nothing called Default: \(labels)")
        // Starred has both accounts' rows, one marked, on the right account.
        func starred() async throws -> [(label: String, inUse: Bool)] {
            try click { $0 == "Starred" }
            try await until { rows("Sonnet 5.5").isEmpty && opusRows().count == 2 }
            return opusRows()
        }
        var starredRows = try await starred()
        #expect(starredRows.filter(\.inUse).count == 1, "exactly one marked: \(starredRows)")
        #expect(starredRows.first(where: \.inUse)?.label.contains("Work") == (account == "claude-code@work"), "on \(account)'s row: \(starredRows)")
        // The other account's row, as the picker is opened on it: the mark is there.
        let other = account == "claude-code" ? "claude-code@work" : "claude-code"
        show(selection: ModelRef(id: "opus", providerID: other))
        try await until { rows("Sonnet 5.5").count == 1 }
        starredRows = try await starred()
        #expect(starredRows.filter(\.inUse).count == 1, "exactly one marked: \(starredRows)")
        #expect(starredRows.first(where: \.inUse)?.label.contains("Work") == (other == "claude-code@work"), "on \(other)'s row: \(starredRows)")
    }

    /// (Which model a new conversation on `default` starts on is its box's rule: the box's own
    /// tests, model-aliases.test.ts.)
    @Test func aConversationOnDefaultShowsTheModelItStandsFor() async throws {
        defer { close() }
        _ = app.catalog.offered
        try await until { app.catalog.offeredSaid != nil }
        for account in ["claude-code", "claude-code@work"] {
            let ref = ModelRef(id: "default", providerID: account, variant: "high")
            #expect(app.catalog.model(ref)?.name == "Opus 5.5")
            #expect(app.catalog.chipModel(ref)?.name == "Opus 5.5")
            // As its box says it (#572): the model `default` stands for, by its name.
            let said = SessionModelState(model: ref, name: "Opus 5.5", runs: true)
            #expect(app.catalog.chipModel(ref, in: .all, said: said)?.name == "Opus 5.5")
            #expect(!app.catalog.isUnavailable(ref))
            // Setting its effort isn't another model: nothing stops for it.
            #expect(app.catalog.isSameModel(ModelRef(id: "opus", providerID: account, variant: "low"), ref))
            #expect(!app.catalog.isSameModel(ModelRef(id: "sonnet", providerID: account), ref))
            #expect(!app.catalog.isSameModel(ModelRef(id: "opus", providerID: account == "claude-code" ? "claude-code@work" : "claude-code"), ref))
        }
    }

    /// What the window draws now, as it shows on screen: its layers, not what VoiceOver reads (a row
    /// can read right and still be drawn as it was on the page before).
    private func drawn() throws -> NSBitmapImageRep {
        window.displayIfNeeded()
        // Drawn as Core Animation commits it, as the screen's next frame would (`displayIfNeeded`
        // alone leaves that to a real frame landing).
        CATransaction.flush()
        let frame = try #require(window.contentView?.superview)
        let layer = try #require(frame.layer)
        let size = frame.bounds.size
        let context = try #require(CGContext(data: nil, width: Int(size.width * 2), height: Int(size.height * 2), bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.scaleBy(x: 2, y: 2)
        layer.render(in: context)
        return NSBitmapImageRep(cgImage: try #require(context.makeImage()))
    }

    /// Whether a mark (the model's maker's) is drawn at the start of the row VoiceOver calls `label`.
    private func drawsMark(_ matches: (String) -> Bool) throws -> Bool {
        let shown = elements
        guard let found = shown.first(where: { $0.label.map(matches) == true }) else {
            throw TestFailure("No such row among \(shown.compactMap(\.label))")
        }
        let row = window.convertFromScreen(found.frame)
        let image = try drawn()
        let height = window.frame.height
        var lightness: [CGFloat] = []
        for x in stride(from: row.minX + 10, to: row.minX + 28, by: 0.5) {
            for y in stride(from: row.minY + 2, to: row.maxY - 2, by: 0.5) {
                guard let color = image.colorAt(x: Int(x * 2), y: Int((height - y) * 2))?.usingColorSpace(.deviceRGB) else { continue }
                lightness.append((color.redComponent + color.greenComponent + color.blueComponent) / 3)
            }
        }
        return (lightness.max() ?? 0) - (lightness.min() ?? 0) > 0.25
    }

    /// Opened on the current model's own account (its row first), then turned to Starred: each row
    /// drawn as Starred's, with its maker's mark and its account, never as it was on that page.
    @Test func turningToStarredFromAnAccountsPageDrawsEachRowAsStarreds() async throws {
        defer { close() }
        show(selection: ModelRef(id: "default", providerID: "claude-code"))
        try await until { rows("Sonnet 5.5").count == 1 }
        #expect(try !drawsMark { $0.hasPrefix("Opus 5.5") }, "Claude Code's own page: no mark, its maker is the account's")

        try click { $0 == "Starred" }
        try await until { rows("Sonnet 5.5").isEmpty && rows("Opus 5.5").contains { $0.contains("Work") } }
        #expect(rows("Opus 5.5").count == 2, "one row for each account's: \(rows("Opus 5.5"))")
        #expect(try drawsMark { $0.hasPrefix("Opus 5.5") && !$0.contains("Work") }, "Claude Code's own, drawn as a Starred row")
        #expect(try drawsMark { $0.hasPrefix("Opus 5.5") && $0.contains("Work") })
    }

    /// Opened on the added account's own page, then Starred (as in the bug: its row there read
    /// "Opus 5.5, ⌘1", as on the page before), then back to that page.
    @Test func starredAfterAnAddedAccountsPageSaysWhoseEachRowIsAndBack() async throws {
        defer { close() }
        show(selection: ModelRef(id: "default", providerID: "claude-code@work"))
        try await until { rows("Sonnet 5.5").count == 1 }
        try click { $0 == "Starred" }
        try await until { rows("Sonnet 5.5").isEmpty && rows("Opus 5.5").count == 2 }
        let starred = rows("Opus 5.5")
        #expect(starred.filter { $0.contains("Claude Code · Work") }.count == 1, "the Work account's, saying so: \(starred)")
        #expect(starred.compactMap { $0.components(separatedBy: ", ").last }.sorted() == ["⌘1", "⌘2"], "one shortcut each: \(starred)")
        #expect(try drawsMark { $0.hasPrefix("Opus 5.5") && $0.contains("Work") })

        try click { $0 == "Claude Code · Work" }
        try await until { rows("Sonnet 5.5").count == 1 }
        #expect(rows("Opus 5.5").count == 1, "the account's own Opus 5.5 only: \(rows("Opus 5.5"))")
        #expect(try !drawsMark { $0.hasPrefix("Opus 5.5") }, "drawn as the account's page draws it, not as Starred did")
    }
}
