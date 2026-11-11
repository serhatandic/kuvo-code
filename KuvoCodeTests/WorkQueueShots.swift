import AppKit
import ClientSessions
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of the Work Queue (#243): the panel narrow (its tab "Work Queue · 24 items", In
/// progress, Next numbered, the rest as counts) and expanded (filter chips, the list, an item
/// open), the empty panel, and a reply naming items, drawn as their chips; light and dark. Only with
/// KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with
/// ONLY=KuvoCodeTests/WorkQueueShots). The queue is a stand-in for what a box tells.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct WorkQueueShots {
    init() { TestEnvironment.prepare() }

    private static let now = Date.now.timeIntervalSince1970 * 1000

    private static func item(_ number: Int, _ title: String, _ category: String, order: Double, working: Bool = false, note: String? = nil, value: Double? = nil, ago minutes: Double = 60, owner: String = "ses_lead") -> [String: Any] {
        var item: [String: Any] = [
            "id": "wqi_" + String(repeating: "s", count: 17) + String(format: "%03d", number % 1000), "number": number, "owner": owner, "title": title,
            "category": category, "order": order, "inProgress": working,
            "sessions": working ? [["session": "ses_lead", "title": "Work Queue panel", "working": true]] : [],
            "noteCount": 0, "fileCount": 0, "linkCount": 0,
            "created": ["at": now - 86_400_000 * 2, "by": ["user": true]],
            "updated": ["at": now - minutes * 60_000, "by": ["session": "ses_lead", "name": "Kuvo Foreman"]],
        ]
        var progress: [String: Any] = [:]
        if let note { progress["note"] = note }
        if let value { progress["value"] = value }
        if !progress.isEmpty { item["progress"] = progress }
        return item
    }

    static let items: [[String: Any]] = [
        item(243, "Work Queue: the panel and chat chips", "next", order: 1, working: true, note: "Drawing the two-pane view and the chips in replies", value: 0.6, ago: 8),
        item(212, "Box limits for every computer", "later", order: 5, working: true, note: "Checking the limits on the Linux machine", ago: 3, owner: "ses_child"),
        item(244, "A side panel for the phone", "next", order: 2),
        item(191, "Bot moves to a machine with its memory", "next", order: 3),
        item(305, "Moved-away conversations say where they went", "next", order: 4),
        item(181, "Sessions started elsewhere show their computer", "next", order: 5),
        item(236, "Scrolled-up conversations stay put", "next", order: 6),
        item(342, "Privacy manifests for the phone", "next", order: 7),
        item(363, "Voice input recovers from audio errors", "next", order: 8),
    ] + (0..<9).map { item(400 + $0, "Later idea \($0 + 1)", "later", order: Double($0)) }
      + (0..<6).map { item(500 + $0, "Parked idea \($0 + 1)", "parked", order: Double($0)) }
      + (0..<4).map { item(600 + $0, "Shipped \($0 + 1)", "done", order: Double($0)) }

    static var view: WorkQueueView {
        let json: [String: Any] = [
            "owner": "ses_lead",
            "categories": [["id": "next", "name": "Next", "builtIn": true], ["id": "later", "name": "Later", "builtIn": true], ["id": "parked", "name": "Parked", "builtIn": true], ["id": "done", "name": "Done", "builtIn": true]],
            "items": items,
            "owners": [["owner": "ses_lead", "kind": "session", "title": "Work Queue panel"], ["owner": "ses_child", "kind": "session", "title": "Box limits", "startedBy": "ses_lead"]],
            "removed": [],
        ]
        return try! JSONDecoder().decode(WorkQueueView.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static var emptyView: WorkQueueView {
        let json: [String: Any] = [
            "owner": "ses_lead",
            "categories": [["id": "next", "name": "Next", "builtIn": true], ["id": "later", "name": "Later", "builtIn": true], ["id": "parked", "name": "Parked", "builtIn": true], ["id": "done", "name": "Done", "builtIn": true]],
            "items": [], "owners": [["owner": "ses_lead", "kind": "session", "title": "Work Queue panel"]], "removed": [],
        ]
        return try! JSONDecoder().decode(WorkQueueView.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static var detail: WorkItemDetail {
        var whole = items[0]
        whole["body"] = """
        Replace the hand-kept backlog with a queue agents keep through tools.

        - **Collapsed**: a tab beside Changes, Files and Terminal, In progress first, Next numbered.
        - **Expanded**: filter chips over the list, the item beside it.
        - `#243` in a message shows as a chip.
        """
        whole["notes"] = [["at": now - 40 * 60_000, "by": ["session": "ses_lead", "name": "Kuvo Foreman"], "text": "Box side is done (#212 next)."],
                          ["at": now - 8 * 60_000, "by": ["session": "ses_lead", "name": "Kuvo Foreman"], "text": "Panel lists and moves work; chips next."]]
        whole["files"] = []
        whole["links"] = [["url": "https://www.kuvo.run/code/docs/work-queue/", "title": "Work Queue docs"]]
        whole["handed"] = []
        whole["noteCount"] = 2
        return try! JSONDecoder().decode(WorkItemDetail.self, from: JSONSerialization.data(withJSONObject: whole))
    }

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        for dark in [false, true] {
            let look = dark ? "dark" : "light"
            try await panel(width: 380, height: 640, dark: dark, open: false).write(to: URL(fileURLWithPath: out).appending(path: "collapsed-\(look).png"))
            try await panel(width: 760, height: 640, dark: dark, open: true).write(to: URL(fileURLWithPath: out).appending(path: "expanded-\(look).png"))
            try await panel(width: 380, height: 640, dark: dark, open: false, empty: true).write(to: URL(fileURLWithPath: out).appending(path: "empty-\(look).png"))
            try await chips(dark: dark).write(to: URL(fileURLWithPath: out).appending(path: "chip-in-chat-\(look).png"))
        }
    }

    private func panel(width: CGFloat, height: CGFloat, dark: Bool, open: Bool, empty: Bool = false) async throws -> Data {
        let app = AppModel()
        app.workQueues.app = app
        app.utilities.inView.session = "ses_lead"
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        app.workQueues.standIn(empty ? Self.emptyView : Self.view, for: key, details: [Self.detail])
        app.utilities.showWorkQueue()
        if open { app.workQueues.opened[app.utilities.panelKey] = WorkQueues.Opened(box: BoxClient.mac, id: Self.detail.item.id, number: 243) }
        let pane = UtilitiesPane(utilities: app.utilities, directory: nil, model: nil, environment: [:], isExpanded: PaneSwitch(isOn: { open }, set: { _ in }))
        return try await picture(pane.environment(app), width: width, height: height, dark: dark) {
            !open || app.workQueues.detail(box: BoxClient.mac, id: Self.detail.item.id, number: nil) != nil
        }
    }

    private func chips(dark: Bool) async throws -> Data {
        let app = AppModel()
        let refs = [243: WorkRef(id: "wqi_1", number: 243, title: "Work Queue: the panel and chat chips", category: "next", inProgress: true, owner: "ses_lead"),
                    244: WorkRef(id: "wqi_2", number: 244, title: "A side panel for the phone", category: "next", inProgress: false, owner: "ses_lead"),
                    212: WorkRef(id: "wqi_3", number: 212, title: "Box limits for every computer", category: "done", inProgress: false, owner: "ses_lead")]
        let reply = "Picked up #243 now; #244 waits on it, and #212 is merged. PR #12 and `#243` stay as written."
        let view = ReplyView(markdown: reply, parser: FileLinkingParser(folders: { [] }, refs: refs))
            .padding(16)
        return try await picture(view.environment(app), width: 560, height: 110, dark: dark) { true }
    }

    private func picture(_ content: some View, width: CGFloat, height: CGFloat, dark: Bool, ready: @escaping () -> Bool) async throws -> Data {
        let view = content
            .appLook()
            .environment(\.colorScheme, dark ? .dark : .light)
            .frame(width: width, height: height)
            .background(Color(nsColor: dark ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.97, alpha: 1)))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        try await until {
            DispatchQueue.main.async { TestPulse.beat() }
            return ready()
        }
        // Only for the picture: let it lay out and draw.
        try await Task.sleep(for: .seconds(1))
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try #require(rep.representation(using: .png, properties: [:]))
    }
}
