import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI
import KuvoLink
import Testing
@testable import KuvoCode

/// Renders of the goal start card for its draft page, from the app's own views, offscreen: PNGs
/// into KUVO_DRAFTS_OUT. Not a test of behavior; it runs only when that's set.
@MainActor
@Suite(.serialized) struct GoalStartCardRenders {
    let out = ProcessInfo.processInfo.environment["KUVO_DRAFTS_OUT"].map { URL(fileURLWithPath: $0) }
    let app = AppModel()
    let catalog = Catalog()
    let updates = Updates()
    let now = Date()

    init() {
        TestEnvironment.prepare()
        if let icons = ProcessInfo.processInfo.environment["KUVO_DRAFTS_ICONS"] {
            SiteIcons.shared.folder = URL(fileURLWithPath: icons)
        }
    }

    private var ms: Double { now.timeIntervalSince1970 * 1000 }

    /// The user's own draft: the iOS app, six steps, the paywall and the icon side by side.
    private var plan: GoalPlan {
        GoalPlan(id: "goal_ios", bot: "bot_mobile", name: "Mobile App Expert", session: "ses_bot",
                 goal: "An app that would print money — a subscription iOS app, from choosing the concept through App Store submission.",
                 title: "Profitable iOS app", state: .proposed,
                 steps: [
                    .init(id: "s1", text: "Pick the concept", state: .todo),
                    .init(id: "s2", text: "Build the core app", state: .todo, after: ["s1"]),
                    .init(id: "s3", text: "Paywall and subscriptions", state: .todo, site: "revenuecat.com", after: ["s2"]),
                    .init(id: "s4", text: "Icon and store screenshots", state: .todo, after: ["s2"]),
                    .init(id: "s5", text: "Test the whole flow", state: .todo, after: ["s3", "s4"]),
                    .init(id: "s6", text: "Submit to App Store", state: .todo, site: "appstoreconnect.apple.com", after: ["s5"]),
                 ],
                 checks: [
                    .init(id: "power", text: "Your Mac is on battery", detail: "The goal pauses if your Mac sleeps.", state: .needs, by: .box),
                    .init(id: "c1", text: "App Store Connect access", detail: "Needed at the submission step.", state: .needs, by: .bot, site: "appstoreconnect.apple.com",
                          action: .init(kind: .open, label: "Sign In", url: URL(string: "https://appstoreconnect.apple.com"))),
                    .init(id: "c2", text: "RevenueCat account", detail: "Needed at the paywall step.", state: .needs, by: .bot, site: "revenuecat.com",
                          action: .init(kind: .open, label: "Sign In", url: URL(string: "https://app.revenuecat.com"))),
                    .init(id: "r1", text: "Xcode 27.1", state: .ok, by: .bot),
                    .init(id: "r2", text: "Swift 6.4", state: .ok, by: .bot),
                    .init(id: "r3", text: "Simulators 18.5, 27.0", state: .ok, by: .bot),
                 ],
                 spend: [.init(what: "the Apple Developer Program", cap: 99, currency: "USD")],
                 public: [.init(id: "p1", text: "Publish the App Store listing", on: false)],
                 projects: ["the-app"], digest: .day, proposed: ms, alone: true,
                 folders: [.init(project: "the-app", folder: "/Users/me/Projects/the-app", shown: "~/Projects/the-app")])
    }

    private func shot(_ name: String, width: CGFloat, scheme: ColorScheme) async throws {
        guard let out else { return }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let root = GoalCard(plan: plan, box: BoxClient.mac)
            .environment(\.goalBox, BoxClient.mac)
            .environment(\.cardRoom, 2000)
            .padding(16)
            .background(Surface.cardFill(scheme, focused: true), in: .rect(cornerRadius: 18))
            .padding(12)
            .environment(\.colorScheme, scheme)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .environment(updates)
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: width, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        window.backgroundColor = scheme == .dark ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.94, alpha: 1)
        window.contentView = host
        for _ in 0..<20 {
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            window.setContentSize(NSSize(width: width, height: size.height))
            host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
            // Awaited, not a run loop turn: a step's app icon loading needs the main actor free.
            try await Task.sleep(for: .milliseconds(80))
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try #require(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appending(path: name + ".png"))
        window.contentView = nil
        window.close()
    }

    @Test func startCard() async throws {
        guard out != nil else { return }
        app.bots.take([ListedBot(id: "bot_mobile", session: "ses_bot", name: "Mobile App Expert", look: BotLook(color: .orange, shape: .round, face: .calm), folder: "/bots/bot_mobile")], from: BoxClient.mac)
        for (width, w) in [(CGFloat(780), "wide"), (440, "narrow")] {
            for (scheme, s) in [(ColorScheme.dark, "dark"), (.light, "light")] {
                try await shot("mac-start-\(w)-\(s)", width: width, scheme: scheme)
            }
        }
    }
}
