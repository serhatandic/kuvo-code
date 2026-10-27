import AppKit
import ClientDesign
import SwiftUI

/// A provider's mark, from the same logo set opencode's own apps use
/// (models.dev, by provider id). Monochrome, so it follows light and dark mode; `colored`
/// draws it in its maker's own color where it has one, for badges like the tabs'.
struct ProviderLogo: View {
    let id: String
    var size: CGFloat = 20
    /// In the maker's color (Anthropic's clay, Mistral's orange); black-and-white marks
    /// like OpenAI's keep the ink around them.
    var colored = false

    @State private var image: NSImage?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(.template)
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Text(String(id.prefix(1)).uppercased())
                    .font(.system(size: size * 0.55, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .modifier(MakerInk(color: colored ? Self.makerColor(id, in: scheme) : nil))
        .frame(width: size, height: size)
        .task(id: id) { image = await LogoCache.shared.logo(for: id) }
    }

    /// Makers whose marks have a color of their own, by logo id. The rest are black and
    /// white (OpenAI, xAI, GitHub, opencode) and aren't listed.
    private static let makerColors: [String: UInt32] = [
        "anthropic": 0xD97757, "google": 0x4285F4, "google-vertex": 0x4285F4, "mistral": 0xFA520F,
        "deepseek": 0x4D6BFE, "meta": 0x0866FF, "alibaba": 0xFF6A00, "xiaomi": 0xFF6900,
        "amazon-bedrock": 0xFF9900, "azure": 0x0078D4, "nvidia": 0x76B900, "perplexity": 0x20808D,
        "groq": 0xF55036,
    ]

    /// The maker's own color, if its mark has one: a little lighter in dark mode, so it
    /// holds on a dark tile.
    static func makerColor(_ id: String, in scheme: ColorScheme) -> Color? {
        guard let hex = makerColors[id] else { return nil }
        let color = Color(hex: hex)
        return scheme == .dark ? color.mix(with: .white, by: 0.15) : color
    }
}

/// The maker's color when there is one; otherwise the mark keeps whatever ink it's given.
private struct MakerInk: ViewModifier {
    let color: Color?

    func body(content: Content) -> some View {
        if let color { content.foregroundStyle(color) } else { content }
    }
}

/// Logos are tiny and shared by every row, so fetch each once and keep it.
actor LogoCache {
    static let shared = LogoCache()

    private var images: [String: NSImage] = [:]
    private var missing: Set<String> = []
    private var inflight: [String: Task<NSImage?, Never>] = [:]

    func logo(for id: String) async -> NSImage? {
        if let image = images[id] { return image }
        if missing.contains(id) { return nil }
        if let task = inflight[id] { return await task.value }

        let task = Task<NSImage?, Never> {
            guard let url = URL(string: "https://models.opencode.ai/logos/\(id).svg"),
                  let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = NSImage(data: data) else { return nil }
            image.isTemplate = true
            return image
        }
        inflight[id] = task
        let image = await task.value
        inflight[id] = nil
        if let image { images[id] = image } else { missing.insert(id) }
        return image
    }
}
