import AppKit
import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// The icons of the services a goal's steps, checks and what waits for you name (`site`), from
/// each site itself as `SiteIcons` loads and keeps them, for `ServiceMark`. Observed, so a mark
/// shows its icon once it comes; the monogram until then, and for a site with none.
@MainActor @Observable
final class ServiceIcons {
    static let shared = ServiceIcons()

    private var icons: [String: NSImage] = [:]
    @ObservationIgnored private var asked: Set<String> = []
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

    /// The mark as a picture, to sit in a line of text: its icon, or its letter.
    func inlineMark(_ site: String, scheme: ColorScheme) -> NSImage? {
        let icon = icon(site)
        let key = "\(site)|\(icon != nil)|\(scheme)"
        if let made = inline[key] { return made }
        let renderer = ImageRenderer(content: ServiceMark(icon: icon.map { Image(nsImage: $0) }, name: GoalPlanWords.service(site)).environment(\.colorScheme, scheme))
        renderer.scale = 2
        guard let image = renderer.nsImage else { return nil }
        inline[key] = image
        return image
    }
}

/// A service's mark, by its site: its icon once it's here, else its letter.
struct SiteServiceMark: View {
    let site: String

    var body: some View {
        ServiceMark(icon: ServiceIcons.shared.icon(site).map { Image(nsImage: $0) }, name: GoalPlanWords.service(site))
    }
}

/// A step's mark (`GoalPlanWords.mark(of:)`): the product it's about, or its service's.
struct StepServiceMark: View {
    let step: GoalPlan.Step

    var body: some View {
        switch GoalPlanWords.mark(of: step) {
        case .product(let id): ServiceMark(icon: BrandMark.image(id), name: id).foregroundStyle(.secondary)
        case .site(let site): SiteServiceMark(site: site)
        case nil: EmptyView()
        }
    }
}

/// A line that names a service, with its mark just before its name ("Add a ◼︎ Cloudflare API
/// token"), or before the line where the name isn't in it.
struct ServiceText: View {
    let text: String
    let site: String?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Self.text(text, site: site, scheme: scheme)
    }

    static func text(_ text: String, site: String?, scheme: ColorScheme) -> Text {
        guard let site, let mark = ServiceIcons.shared.inlineMark(site, scheme: scheme) else { return Text(text) }
        let picture = Text(Image(nsImage: mark)).baselineOffset(-2)
        let name = GoalPlanWords.service(site).lowercased()
        // The first word that is the service's name, or starts with it ("Stripe’s").
        if let word = text.split(separator: " ").first(where: { $0.lowercased().hasPrefix(name) }) {
            return Text("\(String(text[..<word.startIndex]))\(picture) \(String(text[word.startIndex...]))")
        }
        return Text("\(picture) \(text)")
    }
}
