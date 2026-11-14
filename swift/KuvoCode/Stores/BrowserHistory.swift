import AppKit
import Foundation

/// The sites the panel's browser has visited, for the new tab page's suggestions, with
/// each site's icon. Kept in `<support>/Browser`, a site per host (and port: two dev servers on
/// localhost are two), at most a few hundred.
@Observable
final class BrowserHistory {
    nonisolated struct Site: Codable, Identifiable, Hashable {
        var host: String
        var url: URL
        var title: String
        var visits: Int
        var lastVisit: Date
        var id: String { host }
    }

    private(set) var sites: [Site] = []
    private(set) var icons: [String: NSImage] = [:]
    @ObservationIgnored private var fetching: Set<String> = []

    private static let limit = 300
    private let folder: URL
    private var file: URL { folder.appending(path: "history.json") }
    private var iconFolder: URL { folder.appending(path: "Icons") }

    init(folder: URL = AppInfo.supportDirectory.appending(path: "Browser")) {
        self.folder = folder
        if let saved = JSONFile.read([Site].self, from: file) { sites = saved }
    }

    /// The most visited sites lately: visits count, and fade over a few weeks.
    func suggestions(_ count: Int) -> [Site] {
        let now = Date()
        func score(_ site: Site) -> Double {
            let days = now.timeIntervalSince(site.lastVisit) / 86_400
            return Double(site.visits) / (1 + days / 14)
        }
        return Array(sites.sorted { score($0) > score($1) }.prefix(count))
    }

    /// A page's site in the history: its host without "www.", with its port when it names one.
    static func key(for url: URL) -> String? {
        guard var host = url.host(), ["http", "https"].contains(url.scheme ?? "") else { return nil }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// The site a page is on, if it's been visited.
    func site(for url: URL?) -> Site? {
        guard let key = url.flatMap(Self.key) else { return nil }
        return sites.first { $0.host == key }
    }

    /// A finished page load; `iconURL` is the page's own icon if it names one.
    func record(_ url: URL, title: String, iconURL: URL?) {
        guard let key = Self.key(for: url) else { return }
        if let index = sites.firstIndex(where: { $0.host == key }) {
            sites[index].visits += 1
            sites[index].lastVisit = .now
            // The site's front page names it best; keep its title once seen.
            if url.path().count <= 1 || sites[index].title.isEmpty {
                sites[index].url = url
                sites[index].title = title
            }
        } else {
            sites.append(Site(host: key, url: url, title: title, visits: 1, lastVisit: .now))
            if sites.count > Self.limit {
                sites = Array(sites.sorted { $0.lastVisit > $1.lastVisit }.prefix(Self.limit))
            }
        }
        save()
        loadIcon(for: key, from: iconURL ?? URL(string: "/favicon.ico", relativeTo: url)?.absoluteURL)
    }

    /// Leaves a site out of the suggestions until it's visited again.
    func remove(_ site: Site) {
        sites.removeAll { $0.host == site.host }
        save()
    }

    func clear() {
        sites = []
        icons = [:]
        cleared += 1
        try? FileManager.default.removeItem(at: folder)
    }

    /// Goes up with each Clear: an icon on its way from before it isn't kept.
    @ObservationIgnored private var cleared = 0

    func icon(for site: Site) -> NSImage? {
        if let icon = icons[site.host] { return icon }
        if let image = NSImage(contentsOf: iconFolder.appending(path: site.host + ".png")) {
            icons[site.host] = image
            return image
        }
        return nil
    }

    private func loadIcon(for host: String, from url: URL?) {
        // One at a time for each site, since the last Clear: one on its way from before it doesn't
        // stop a new one.
        let key = "\(cleared) \(host)"
        guard let url, !fetching.contains(key) else { return }
        fetching.insert(key)
        let asked = cleared
        Task {
            defer { fetching.remove(key) }
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let image = NSImage(data: data), image.isValid,
                  let png = image.pngData(side: 64), cleared == asked else { return }
            try? FileManager.default.createDirectory(at: iconFolder, withIntermediateDirectories: true)
            try? png.write(to: iconFolder.appending(path: host + ".png"))
            icons[host] = NSImage(data: png)
        }
    }

    private func save() {
        JSONFile.write(sites, to: file)
    }
}

private extension NSImage {
    /// The image redrawn as a square PNG, for a small cache that loads fast.
    func pngData(side: CGFloat) -> Data? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}
