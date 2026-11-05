import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Throwaway (not committed): stills of the real sidebar with bots overseeing sessions, into
/// KUVO_RENDERS_OUT. Runs only when that's set.
@MainActor
@Suite(.serialized) struct BotOversightRenders {
    let out = ProcessInfo.processInfo.environment["KUVO_RENDERS_OUT"].map { URL(fileURLWithPath: $0) }
    let engine = StubEngine(port: 47_934)
    let app: AppModel
    let updates = Updates()
    let now = Date().timeIntervalSince1970 * 1000

    init() throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: Bots.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        func bot(_ id: String, _ name: String, _ job: String, _ look: [String: String]) -> [String: Any] {
            ["id": id, "name": name, "job": job, "instructions": "", "jobInMemory": true, "look": look,
             "folder": Bots.root.appending(path: id).path, "sessionID": "ses_" + id, "created": "2026-11-01T09:00:00Z"]
        }
        try JSONSerialization.data(withJSONObject: [
            bot("bot_mobile", "Mobile App Expert", "Builds iOS apps", ["color": "orange", "shape": "gem", "face": "calm"]),
            bot("bot_ada", "Ada", "Keeps the website current", ["color": "mint", "shape": "round", "face": "calm"]),
        ]).write(to: Bots.file)
        Analytics.shared.noticeShown = true
        app = AppModel()
        app.workspace.api = engine.api
        app.bots.app = app
        app.botOversight.app = app
    }

    private func session(_ id: String, _ title: String, _ folder: String, _ at: Double, by: (String, String)? = nil) -> [String: Any] {
        let t = now - (100 - at) * 60_000
        var extra: [String: Any] = ["time": ["created": t, "updated": t + 1, "idle": t + 1, "viewed": t + 2]]
        if let by { extra["metadata"] = ["kuvo": ["by": ["bot": by.0, "name": by.1], "startedBy": "ses_" + by.0, "depth": 1]] }
        return StubEngine.session(id, title: title, directory: folder, created: t, extra: extra)
    }

    private let root = "/tmp/kuvo-renders/"

    private func world(many: Bool) async throws {
        let mobile = ("bot_mobile", "Mobile App Expert"), ada = ("bot_ada", "Ada")
        var list: [[String: Any]] = [
            session("ses_bot_mobile", "Mobile App Expert", Bots.root.appending(path: "bot_mobile").path, 99),
            session("ses_bot_ada", "Ada", Bots.root.appending(path: "bot_ada").path, 98),
            session("ses_core", "Build the core app", root + "the-app", 96, by: mobile),
            session("ses_mine", "Fix the onboarding copy", root + "the-app", 94),
            session("ses_lock", "Diagnose git lock", root + "the-app", 90, by: mobile),
            session("ses_concept", "Pick the concept", root + "the-app", 89, by: mobile),
            session("ses_log", "Write this week’s changelog", root + "kuvo-web", 93, by: ada),
            session("ses_icons", "Export the app icons", root + "kuvo-web", 85, by: mobile),
            session("ses_hero", "Hero image on the landing page", root + "kuvo-web", 80),
        ]
        if many {
            for (index, title) in ["Settings screen", "Widget for the home screen", "Sign in with Apple", "Crash on launch on iOS 17"].enumerated() {
                list.append(session("ses_many\(index)", title, root + "the-app", 88 - Double(index), by: index == 2 ? nil : mobile))
            }
        }
        engine.list(list, running: ["ses_core", "ses_log", "ses_concept", "ses_icons"])
        await app.workspace.refresh()
        app.workspace.noteMadeBy(root + "the-app", .init(bot: "bot_mobile", name: "Mobile App Expert"))
        UserDefaults.standard.set("", forKey: "collapsedProjects")
    }

    private final class Frame {
        let host: NSHostingView<AnyView>
        let window: NSWindow
        init(_ view: AnyView, size: CGSize, dark: Bool) {
            host = NSHostingView(rootView: view)
            window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.backgroundColor = dark ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.93, alpha: 1)
            window.contentView = host
            window.orderBack(nil)
            host.frame = NSRect(origin: .zero, size: size)
        }
        func settle(_ times: Int) async throws {
            for _ in 0..<times {
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(60))
            }
        }
        /// Each light's layers as they are `at` seconds into it: what Core Animation shows then.
        func freeze(at time: Double) {
            func walk(_ view: NSView) {
                if String(describing: type(of: view)) == "OverseerLightsView", let root = view.layer?.sublayers?.first {
                    for layer in root.sublayers ?? [] {
                        for key in layer.animationKeys() ?? [] {
                            guard let animation = layer.animation(forKey: key) else { continue }
                            let local = time
                            func apply(_ a: CAAnimation, base: Double) {
                                if let group = a as? CAAnimationGroup {
                                    for inner in group.animations ?? [] { apply(inner, base: base) }
                                } else if let k = a as? CAKeyframeAnimation, k.keyPath == "opacity", let values = k.values as? [NSNumber], let times = k.keyTimes {
                                    let p = min(max((local - base) / k.duration, 0), 1)
                                    var v = values.last!.doubleValue
                                    for i in 1..<times.count where p <= times[i].doubleValue {
                                        let t0 = times[i - 1].doubleValue, t1 = times[i].doubleValue
                                        let f = t1 > t0 ? (p - t0) / (t1 - t0) : 1
                                        v = values[i - 1].doubleValue + (values[i].doubleValue - values[i - 1].doubleValue) * f
                                        break
                                    }
                                    layer.opacity = Float(v)
                                } else if let b = a as? CABasicAnimation, b.keyPath == "position.y", let from = b.fromValue as? CGFloat, let to = b.toValue as? CGFloat {
                                    let p = min(max((local - base) / b.duration, 0), 1)
                                    let e = p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2
                                    layer.position.y = from + (to - from) * e
                                }
                            }
                            let begin = animation.beginTime - (layer.sublayers == nil ? 0 : 0)
                            let start = root.sublayers?.compactMap { $0.animation(forKey: $0.animationKeys()?.first ?? "")?.beginTime }.min() ?? begin
                            apply(animation, base: begin - start)
                            layer.removeAllAnimations()
                        }
                    }
                }
                for child in view.subviews { walk(child) }
            }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            walk(host)
            CATransaction.commit()
        }
        func write(to url: URL) throws {
            host.layoutSubtreeIfNeeded()
            host.display()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try #require(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        func close() {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
    }

    private func sidebar(width: CGFloat, height: CGFloat, dark: Bool) -> AnyView {
        AnyView(SidebarView()
            .environment(app)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(app.catalog)
            .environment(updates)
            .environment(\.colorScheme, dark ? .dark : .light)
            .frame(width: width, height: height)
            .background(dark ? Color(white: 0.13) : Color(white: 0.93)))
    }

    @Test func renders() async throws {
        guard let out else { return }
        defer {
            engine.stop()
            try? FileManager.default.removeItem(at: Bots.file)
            UserDefaults.standard.removeObject(forKey: "collapsedProjects")
        }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for (name, width, dark, moment, many) in [
            ("rest-light", 280.0, false, "rest", false), ("rest-dark", 280.0, true, "rest", false),
            ("light-light", 280.0, false, "light", false), ("light-dark", 280.0, true, "light", false),
            ("elbow-light", 280.0, false, "elbow", false), ("elbow-dark", 280.0, true, "elbow", false),
            ("needs-light", 280.0, false, "needs", false), ("needs-dark", 280.0, true, "needs", false),
            ("many-light", 280.0, false, "rest", true), ("narrow-dark", 212.0, true, "rest", false),
        ] {
            try await world(many: many)
            if moment == "needs" {
                app.workspace.handle(try engine.event("permission.asked", ["id": "per_1", "sessionID": "ses_core", "action": "edit", "resources": ["Paywall.swift"]]))
            }
            let frame = Frame(sidebar(width: width, height: 760, dark: dark), size: CGSize(width: width, height: 760), dark: dark)
            try await frame.settle(10)
            if moment == "light" || moment == "elbow" {
                app.botOversight.take([OversightMark(id: UUID().uuidString, bot: "bot_mobile", session: "ses_concept", kind: .read, at: now)])
                try await frame.settle(2)
                frame.freeze(at: moment == "light" ? 0.25 : 0.8)
            }
            try frame.write(to: out.appending(path: "\(name).png"))
            frame.close()
        }
    }
}
