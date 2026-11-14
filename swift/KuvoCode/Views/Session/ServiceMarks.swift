import AppKit
import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// The icons of the services a goal's steps, checks and what waits for you name (`site`), from
/// each site itself as `SiteIcons` loads and keeps them, and of the apps they're done in (`app`),
/// from the box whose computer has the app; for `ServiceMark`. Observed, so a mark shows its icon
/// once it comes; the monogram until then, and for a site with none.
@MainActor @Observable
final class ServiceIcons {
    static let shared = ServiceIcons()

    private var icons: [String: NSImage] = [:]
    @ObservationIgnored private var asked: Set<String> = []
    /// A box's client, for the icons of apps on its computer: the app's, or a test's.
    @ObservationIgnored var boxes: ((String) -> BoxClient?)?
    /// Apps' icons, by box and the app's id there.
    private var apps: [String: NSImage] = [:]
    @ObservationIgnored private var askedApps: Set<String> = []
    /// Marks drawn into a sentence, by site, look and scheme.
    @ObservationIgnored private var inline: [String: NSImage] = [:]

    /// `site`'s icon, if it's here; asked for once otherwise.
    func icon(_ site: String) -> NSImage? {
        if let icon = icons[site] { return icon }
        guard let url = URL(string: "https://\(site)"), let key = SiteAddresses.site(of: url) else { return nil }
        if let icon = SiteIcons.shared.icon(for: key) { return icon }
        if asked.insert(site).inserted, !SiteIcons.shared.isKnown(key) {
            Task {
                let loaded = NotificationCenter.default.notifications(named: SiteIcons.loaded)
                SiteIcons.shared.load(url)
                for await note in loaded where note.object as? String == key {
                    if let icon = SiteIcons.shared.icon(for: key) { icons[site] = icon }
                    break
                }
            }
        }
        return nil
    }

    /// The icon of the app `id` on `box`'s computer, from that box (`kuvo/work/apps/icon`), if it's
    /// here; asked for once otherwise, and again once a box that couldn't be reached is shown again.
    func appIcon(_ id: String, on box: String) -> NSImage? {
        let key = "\(box)|\(id)"
        if let icon = apps[key] { return icon }
        if askedApps.insert(key).inserted, let client = boxes?(box) {
            Task {
                var query = URLComponents()
                query.queryItems = [URLQueryItem(name: "app", value: id)]
                let answer = try? await client.send("GET", "kuvo/work/apps/icon?" + (query.percentEncodedQuery ?? ""))
                if let answer, answer.status == 200, let icon = NSImage(data: answer.body) {
                    apps[key] = icon
                } else if (answer?.status ?? 502) >= 500 {
                    askedApps.remove(key)
                }
            }
        }
        return nil
    }

    /// A mark's icon, if it's here: the site's, or the app's on `box`'s computer.
    func icon(_ mark: GoalPlanWords.StepMark, on box: String) -> NSImage? {
        switch mark {
        case .site(let site): icon(site)
        case .app(let id, _): appIcon(id, on: box)
        }
    }

    /// The mark as a picture, to sit in a line of text: its icon, or its letter.
    func inlineMark(_ mark: GoalPlanWords.StepMark, on box: String, scheme: ColorScheme) -> NSImage? {
        let icon = icon(mark, on: box)
        let key = "\(box)|\(mark)|\(icon != nil)|\(scheme)"
        if let made = inline[key] { return made }
        let renderer = ImageRenderer(content: ServiceMark(icon: icon.map { Image(nsImage: $0) }, name: mark.name).environment(\.colorScheme, scheme))
        renderer.scale = 2
        guard let image = renderer.nsImage else { return nil }
        inline[key] = image
        return image
    }
}

extension GoalPlanWords.StepMark {
    /// Whose mark it is, for its letter: the service's, or the app's.
    var name: String {
        switch self {
        case .site(let site): GoalPlanWords.service(site)
        case .app(_, let name): name
        }
    }
}

extension EnvironmentValues {
    /// The box whose goal is shown, which has the apps its steps name.
    @Entry var goalBox = BoxClient.mac
}

/// A service's mark, by its site: its icon once it's here, else its letter.
struct SiteServiceMark: View {
    let site: String

    var body: some View {
        GoalServiceMark(mark: .site(site))
    }
}

/// A site's or an app's mark: its icon once it's here, else its letter.
struct GoalServiceMark: View {
    let mark: GoalPlanWords.StepMark
    @Environment(\.goalBox) private var box

    var body: some View {
        ServiceMark(icon: ServiceIcons.shared.icon(mark, on: box).map { Image(nsImage: $0) }, name: mark.name)
    }
}

/// A step's mark (`GoalPlanWords.mark(of:)`): the icon of the site it's done at, or of the app on
/// the computer it's done in, or nothing.
struct StepServiceMark: View {
    let step: GoalPlan.Step

    var body: some View {
        if let mark = GoalPlanWords.mark(of: step) { GoalServiceMark(mark: mark) }
    }
}

/// A line that names a service or an app, with its mark just before its name ("Add a ◼︎ Cloudflare
/// API token"), or before the line where the name isn't in it.
enum ServiceText {
    static func text(_ text: String, mark: GoalPlanWords.StepMark?, on box: String, scheme: ColorScheme) -> Text {
        guard let mark, let image = ServiceIcons.shared.inlineMark(mark, on: box, scheme: scheme) else { return Text(text) }
        let picture = Text(Image(nsImage: image)).baselineOffset(-2)
        // An app's first word ("Xcode", "Final" of "Final Cut Pro").
        let name = (mark.name.split(separator: " ").first.map(String.init) ?? mark.name).lowercased()
        // The first word that is the service's name, or starts with it ("Stripe’s").
        if let word = text.split(separator: " ").first(where: { $0.lowercased().hasPrefix(name) }) {
            return Text("\(String(text[..<word.startIndex]))\(picture) \(String(text[word.startIndex...]))")
        }
        return Text("\(picture) \(text)")
    }
}
