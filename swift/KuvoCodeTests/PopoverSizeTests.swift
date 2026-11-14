import AppKit
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The model picker's popover is as tall as the page it shows, after a longer one too: gone from a
/// long list to a short one (fewer models, a search nothing matches, Custom Auto), it gets shorter
/// with it, rather than keeping the long list's height with the short page sunk in its middle. The
/// engine's answers and its box's are stubbed (StubWeb, a box transport of the test's own); the
/// picker and its popover are real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PopoverSizeTests {
    static let engine = "http://127.0.0.1:47998"
    let catalog = Catalog()
    let box = OfferingBox()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: false)

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        catalog.box = BoxClient(box: BoxClient.mac, transport: box)
        window.isReleasedWhenClosed = false
    }

    /// Its box, saying every model the engine lists runs (`kuvo/models/offered`: its one account
    /// signed in), newest first.
    final class OfferingBox: BoxTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func offer(_ count: Int) { lock.withLock { self.count = count } }

        func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
            let count = lock.withLock { self.count }
            let offered: [String: Any] = ["models": stride(from: count, through: 1, by: -1).map { ["providerID": "anthropic", "id": "m\($0)", "name": "Model \($0)"] },
                                          "known": ["engine": true, "agents": true]]
            let body = request.path.hasPrefix("kuvo/models/offered") ? try? JSONSerialization.data(withJSONObject: offered) : nil
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: body == nil ? 404 : 200, headers: [:]))
                continuation.yield(.body(body ?? Data()))
                continuation.finish()
            }
        }
    }

    /// One provider you're signed in to, with `count` models.
    private func engine(models count: Int) async throws {
        let location = ["directory": "/"]
        let models = (1...count).map { number -> [String: Any] in
            ["id": "m\(number)", "modelID": "m\(number)", "providerID": "anthropic", "name": "Model \(number)",
             "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
             "time": ["released": number], "cost": [["input": 1, "output": 1]],
             "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]
        }
        let account: [String: Any] = ["id": "anthropic", "name": "Anthropic", "methods": [["type": "key"]],
                                      "connections": [["type": "credential", "credentialID": "cred_anthropic", "method": "key"]]]
        try StubWeb.answer(Self.engine + "/api/integration", json: ["location": location, "data": [account]])
        try StubWeb.answer(Self.engine + "/api/model", json: ["location": location, "data": models])
        try StubWeb.answer(Self.engine + "/api/model/default", json: ["location": location, "data": models[0]])
        try StubWeb.answer(Self.engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(Self.engine + "/api/command", json: ["location": location, "data": []])
        box.offer(count)
        await catalog.refresh()
    }

    /// The composer's chip, its picker open as the chip opens it.
    private struct Opener: View {
        let catalog: Catalog
        @State private var isOpen = true

        var body: some View {
            Text("Model 1")
                .frame(width: 200, height: 40)
                .popover(isPresented: $isOpen, arrowEdge: .bottom) {
                    ModelPicker(catalog: catalog, selection: ModelRef(id: "m1", providerID: "anthropic"), onSelect: { _ in }, close: { isOpen = false })
                        .popoverContent()
                }
        }
    }

    /// The popover's own window, once it shows (AppKit puts the window it opens from on screen).
    private var popover: NSWindow? {
        NSApp.windows.first { $0.isVisible && String(describing: type(of: $0)).contains("Popover") }
    }

    @Test func aShorterListMakesThePopoverShorter() async throws {
        // AppKit's word that a popover showed or a window changed size: look again then.
        let watching = [NSPopover.didShowNotification, NSWindow.didResizeNotification].map {
            NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main) { _ in TestPulse.beat() }
        }
        defer {
            watching.forEach(NotificationCenter.default.removeObserver)
            popover?.orderOut(nil)
            window.orderOut(nil)
            window.close()
            StubWeb.stop()
        }
        try await engine(models: 14)
        window.contentView = NSHostingView(rootView: Opener(catalog: catalog))
        window.orderBack(nil)

        // Open on the provider's long list, as tall as the picker's longest page.
        try await until { popover.map { $0.frame.height > 400 } ?? false }
        let long = try #require(popover)
        let tall = long.frame.height

        // Most of them gone while it's open (the engine's list changed): two rows. The popover gets
        // shorter, just the size of the short list, and keeps its width.
        try await engine(models: 2)
        try await until {
            guard let shown = popover, let host = shown.contentView else { return false }
            return shown.frame.height < tall - 150 && host.bounds.size == host.fittingSize
        }
        #expect(try #require(popover).frame.width == long.frame.width)
    }
}
