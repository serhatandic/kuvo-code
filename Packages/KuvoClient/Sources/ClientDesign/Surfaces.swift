import SwiftUI

/// The window's materials in one place: the light the canvas carries, the cards' fills, the lit
/// edges that stand in for gray borders, the accent glass that marks what's yours or selected,
/// and the recessed well code sits in.
///
/// Glass over flat gray reads as muddy gray, so the canvas carries a faint warm-to-cool light
/// for the glass to pick up, and edges are lit (a bright rim along the top and a hairline
/// outside) instead of drawn with dark strokes.
public enum Surface {
    /// Slate, for hairlines and wells: a cool near-black reads cleaner than gray on white.
    public static let slate = Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255)

    /// The hairline just outside a card, pill or bubble.
    public static func hairline(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .black.opacity(0.45) : slate.opacity(0.07)
    }

    /// The lit top edge of a raised surface.
    public static func highlight(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white.opacity(0.13) : .white.opacity(0.8)
    }

    /// The tint over the window's behind-window glass, solid enough that other windows behind
    /// don't show as shapes. Dark mode lets some of the desktop's color through, but stays dark
    /// over a white window behind (thinner, the sidebar went mid-gray there and its gray text
    /// could hardly be read); light mode is a warm ivory with only a hint of it, since a dark
    /// wallpaper under thin glass turned the sidebar a murky olive gray beside the white cards.
    public static func canvasTint(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(white: 0.06, opacity: 0.7)
            : Color(red: 0xF6 / 255, green: 0xF4 / 255, blue: 0xEE / 255).opacity(0.86)
    }

    /// The canvas as one solid color, for a window that isn't glass.
    public static func canvasSolid(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(red: 0.075, green: 0.078, blue: 0.09) : Color(red: 0xF2 / 255, green: 0xF0 / 255, blue: 0xEA / 255)
    }

    /// The canvas's ambient light: warm from the top left, cool toward the bottom right, a few
    /// percent each, so the glass has some color to refract even over a gray desktop.
    public static func ambient(_ scheme: ColorScheme) -> LinearGradient {
        let warm = Color(red: 1, green: 0.62, blue: 0.42)
        let cool = Color(red: 0.42, green: 0.55, blue: 1)
        let strength = scheme == .dark ? 0.06 : 0.07
        return LinearGradient(
            stops: [
                .init(color: warm.opacity(strength), location: 0),
                .init(color: warm.opacity(strength * 0.25), location: 0.4),
                .init(color: cool.opacity(strength * 0.25), location: 0.6),
                .init(color: cool.opacity(strength), location: 1),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// The focused card is crisp (white in light mode, a deep cool gray in dark); the others are
    /// a warm ivory (a lighter cool gray in dark), which separates them without heavier borders.
    public static func cardFill(_ scheme: ColorScheme, focused: Bool) -> Color {
        #if os(macOS)
        Color(nsColor: cardFillColor(dark: scheme == .dark, focused: focused))
        #else
        Color(uiColor: cardFillColor(dark: scheme == .dark, focused: focused))
        #endif
    }

    /// The card's fill as one solid color, for content that paints its own background (the
    /// terminal) and has to blend into its card.
    public static func cardFillColor(dark: Bool, focused: Bool) -> PlatformColor {
        switch (dark, focused) {
        case (true, true): .srgb(0.094, 0.102, 0.122)
        case (true, false): .srgb(0.125, 0.133, 0.157)
        case (false, true): .white
        case (false, false): .srgb(0.976, 0.969, 0.945)
        }
    }

    /// A fade from clear to `color` between `start` and `end` (0 to 1 along the gradient) that
    /// eases in and out, so no edge shows where it begins or ends, as a straight one's does.
    public static func easedFade(_ color: Color, from start: CGFloat = 0, to end: CGFloat = 1) -> [Gradient.Stop] {
        (0...8).map { step in
            let t = CGFloat(step) / 8
            return .init(color: color.opacity(t * t * (3 - 2 * t)), location: start + (end - start) * t)
        }
    }

    /// A list's quieter ink (the sidebar's descriptions, its +), solid: blended with the glass or
    /// the canvas behind it, as `.secondary` is, it read under 4.5:1. About 6:1 in both schemes,
    /// and darker still with Increase Contrast.
    public static func listSecondary(_ scheme: ColorScheme, contrast: ColorSchemeContrast = .standard) -> Color {
        let more = contrast == .increased
        return scheme == .dark ? .white.opacity(more ? 0.72 : 0.56) : .black.opacity(more ? 0.75 : 0.6)
    }

    /// A list's quietest ink (a fold's chevron), solid too: about 3:1.
    public static func listTertiary(_ scheme: ColorScheme, contrast: ColorSchemeContrast = .standard) -> Color {
        let more = contrast == .increased
        return scheme == .dark ? .white.opacity(more ? 0.56 : 0.38) : .black.opacity(more ? 0.6 : 0.4)
    }

    /// The accent glass's fill: a soft wash of the accent color.
    public static func accentWash(_ scheme: ColorScheme, accent: Color = .accentColor) -> Color {
        accent.opacity(scheme == .dark ? 0.22 : 0.1)
    }

    /// The fill of a recessed well, like a code block, a step below the card.
    public static func well(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .black.opacity(0.3) : slate.opacity(0.035)
    }

    /// The well's inner border.
    public static func wellBorder(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white.opacity(0.07) : slate.opacity(0.07)
    }
}

extension View {
    /// A lit edge in place of a gray border: a bright highlight along the top that fades down
    /// the sides, and a hairline just outside. Apply after any clip, so the hairline shows.
    public func specularRim<S: InsettableShape>(_ shape: S, strength: Double = 1) -> some View {
        modifier(SpecularRim(shape: shape, strength: strength))
    }

    /// Accent glass, for what's yours or selected (your messages, the selected row, the send
    /// button): a soft accent wash with a luminous edge, white at the top into the accent.
    public func accentGlass<S: InsettableShape>(_ shape: S, isOn: Bool = true) -> some View {
        modifier(AccentGlass(shape: shape, isOn: isOn))
    }

    /// What you've picked from a list or a set of choices, drawn the same everywhere (the sidebar's
    /// rows and computers, Settings' pages, a bot's look and personality): accent glass under the
    /// one that's on, a soft fill under the pointer on the others. It starts `leading` in, so what
    /// hangs beside a row (the lines sub-sessions hang from) stays in view, and neither moves or
    /// resizes it. The one that's on changes at once, as in a Mac's sidebars.
    public func pickHighlight<S: InsettableShape>(_ shape: S, isOn: Bool, leading: CGFloat = 0) -> some View {
        modifier(PickHighlight(shape: shape, isOn: isOn, leading: leading))
    }

    /// The sidebar's inks, in both apps: `.secondary` and `.tertiary` inside it are the list's
    /// solid ones (`Surface.listSecondary`), readable on glass; its headings take `.primary`.
    public func listInks() -> some View {
        modifier(ListInks())
    }

    /// A text field drawn into the surface: sunken, with no bezel, like the sidebar's search. For
    /// fields outside a grouped form (a form's own fields stay native). While you type in it, it
    /// has the focus rim.
    public func wellField(cornerRadius: CGFloat = 10, isFocused: Bool = false) -> some View {
        modifier(WellField(cornerRadius: cornerRadius, isFocused: isFocused))
    }

    /// A recessed well, one step below the card, with a subtle inner border: for code, and for
    /// the rows of a form, which pass `isFocused` while you type in one of them.
    public func recessedWell<S: InsettableShape>(_ shape: S, isFocused: Bool = false) -> some View {
        modifier(RecessedWell(shape: shape, isFocused: isFocused))
    }

    /// What marks the well you're typing in, the same for every one: a rim in the accent color
    /// along its edge. The well's fill doesn't change.
    public func focusRim<S: InsettableShape>(_ shape: S, isOn: Bool) -> some View {
        modifier(FocusRim(shape: shape, isOn: isOn))
    }
}

private struct ListInks: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content.foregroundStyle(Color.primary, Surface.listSecondary(scheme, contrast: contrast),
                                Surface.listTertiary(scheme, contrast: contrast))
    }
}

private struct SpecularRim<S: InsettableShape>: ViewModifier {
    let shape: S
    let strength: Double
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        #if os(macOS)
        // Core Animation's layers: SwiftUI draws a gradient stroke on the CPU, and drew it again
        // on every frame a card moved (the panel sliding in took a fifth of its time there).
        content
            .overlay {
                RimLayers(shape: shape, light: NSColor(Surface.highlight(scheme).opacity(strength)),
                          hairline: NSColor(Surface.hairline(scheme).opacity(strength)))
                    .allowsHitTesting(false)
            }
        #else
        let light = Surface.highlight(scheme).opacity(strength)
        content
            .overlay {
                shape
                    .strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(color: light, location: 0),
                                .init(color: light.opacity(0.3), location: 0.12),
                                .init(color: .clear, location: 0.45),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                    .allowsHitTesting(false)
            }
            .overlay {
                shape
                    .inset(by: -0.5)
                    .strokeBorder(Surface.hairline(scheme).opacity(strength), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
        #endif
    }
}

#if os(macOS)
/// The lit edge as layers: the top's light, a gradient seen through the shape's 1-point border,
/// and the hairline just outside it. Moved, they're moved; resized, only their paths change.
private struct RimLayers<S: InsettableShape>: NSViewRepresentable {
    let shape: S
    let light: NSColor
    let hairline: NSColor

    func makeNSView(context: Context) -> RimView { RimView() }

    func updateNSView(_ view: RimView, context: Context) {
        view.paths = { bounds in
            // As strokeBorder draws: the border's middle half its width inside the edge; the
            // hairline's half its width inside an edge half a point out.
            (shape.inset(by: 0.5).path(in: bounds).cgPath, shape.inset(by: -0.25).path(in: bounds).cgPath)
        }
        view.colors = (light, hairline)
    }
}

final class RimView: NSView {
    var paths: ((CGRect) -> (CGPath, CGPath))? { didSet { needsLayout = true } }
    var colors: (light: NSColor, hairline: NSColor)? {
        didSet { if colors?.light != oldValue?.light || colors?.hairline != oldValue?.hairline { updateColors() } }
    }
    private let light = CAGradientLayer()
    private let border = CAShapeLayer()
    private let hairline = CAShapeLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        border.fillColor = nil
        border.strokeColor = NSColor.black.cgColor
        border.lineWidth = 1
        light.mask = border
        // Top to bottom (the layer's y runs up).
        light.startPoint = CGPoint(x: 0.5, y: 1)
        light.endPoint = CGPoint(x: 0.5, y: 0)
        light.locations = [0, 0.12, 0.45]
        hairline.fillColor = nil
        hairline.lineWidth = 0.5
        layer?.addSublayer(light)
        layer?.addSublayer(hairline)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        for piece in [light, border, hairline] as [CALayer] { piece.contentsScale = scale }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        guard let colors else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let top = colors.light.cgColor
            light.colors = [top, colors.light.withAlphaComponent(colors.light.alphaComponent * 0.3).cgColor, colors.light.withAlphaComponent(0).cgColor]
            hairline.strokeColor = colors.hairline.cgColor
        }
        CATransaction.commit()
    }

    override func layout() {
        super.layout()
        guard let paths else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // SwiftUI's paths run down from the top; the layers' y runs up.
        var flip = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -bounds.height)
        let (inner, outer) = paths(CGRect(origin: .zero, size: bounds.size))
        light.frame = bounds
        border.frame = light.bounds
        border.path = inner.copy(using: &flip)
        hairline.frame = bounds
        hairline.path = outer.copy(using: &flip)
        CATransaction.commit()
    }
}
#endif

private struct AccentGlass<S: InsettableShape>: ViewModifier {
    let shape: S
    let isOn: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accent) private var accent

    func body(content: Content) -> some View {
        content
            .background {
                if isOn { shape.fill(Surface.accentWash(scheme, accent: accent)) }
            }
            .overlay {
                if isOn {
                    shape
                        .strokeBorder(Self.edge(scheme, accent: accent), lineWidth: 1)
                        .allowsHitTesting(false)
                }
            }
    }

    /// Its luminous edge: white at the top into the accent.
    static func edge(_ scheme: ColorScheme, accent: Color) -> LinearGradient {
        LinearGradient(
            colors: [
                .white.opacity(scheme == .dark ? 0.2 : 0.85),
                accent.opacity(scheme == .dark ? 0.4 : 0.25),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

private struct PickHighlight<S: InsettableShape>: ViewModifier {
    let shape: S
    let isOn: Bool
    let leading: CGFloat
    @State private var isHovering = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accent) private var accent

    func body(content: Content) -> some View {
        content
            .background(alignment: .leading) {
                ZStack {
                    shape.fill(isOn ? Surface.accentWash(scheme, accent: accent) : Color.primary.opacity(isHovering ? 0.06 : 0))
                    if isOn {
                        shape.strokeBorder(AccentGlass<S>.edge(scheme, accent: accent), lineWidth: 1)
                    }
                }
                .padding(.leading, leading)
                // At once: faded with a tab switch's animation, the sidebar's had the whole
                // sidebar drawn again on each of its frames.
                .transaction(value: isOn) { $0.animation = nil }
            }
            .contentShape(shape)
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
            // So VoiceOver says which one is open or picked, too.
            .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

private struct WellField: ViewModifier {
    let cornerRadius: CGFloat
    let isFocused: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .focusEffectDisabled()
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Surface.well(scheme), in: .rect(cornerRadius: cornerRadius))
            .focusRim(.rect(cornerRadius: cornerRadius), isOn: isFocused)
    }
}

private struct RecessedWell<S: InsettableShape>: ViewModifier {
    let shape: S
    let isFocused: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .background(Surface.well(scheme), in: shape)
            .overlay {
                shape
                    .strokeBorder(Surface.wellBorder(scheme), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .focusRim(shape, isOn: isFocused)
    }
}

private struct FocusRim<S: InsettableShape>: ViewModifier {
    let shape: S
    let isOn: Bool
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content.overlay {
            if isOn {
                // The tint, so it follows the accent (Graphite too); full strength and wider with
                // Increase Contrast.
                shape
                    .strokeBorder(.tint.opacity(contrast == .increased ? 1 : 0.8), lineWidth: contrast == .increased ? 2 : 1.5)
                    .allowsHitTesting(false)
            }
        }
    }
}

extension EnvironmentValues {
    /// The accent the app is set to, for drawing that needs a color rather than the tint.
    @Entry public var accent: Color = .accentColor
    /// Whether the card this view is in is the focused one, for opaque fills inside it (a pinned
    /// header, the terminal) that have to match the card's own.
    @Entry public var cardIsFocused = true
}
