import AppKit
import SwiftUI

/// How the dashboard lists providers: one compact bar each, or the full cards.
enum DashboardStyle: String, Hashable, Sendable, CaseIterable {
    case bars
    case cards

    static let key = "dashboardStyle"

    var label: String {
        switch self {
        case .bars: "Bars"
        case .cards: "Cards"
        }
    }
}

/// Which of a provider's limits its bar shows.
enum BarMetricSetting: String, Hashable, Sendable, CaseIterable {
    /// The limit with the least left: the one that stops you first.
    case tightest
    /// The first limit in the provider's card, in the order Customize sets.
    case first

    static let key = "barMetric"

    var label: String {
        switch self {
        case .tightest: "Closest to Its Limit"
        case .first: "First in Its Card"
        }
    }
}

/// The Bars style: a spend bar, then one bar per provider in a pastel of its brand color,
/// filled to the share its tightest limit shows (left or used, following the global setting), with the
/// provider's name on the fill and the number on the track. Hovering tells which limit it is
/// and when it resets; clicking opens every limit underneath, drawn the same way (`ProviderBarDetail`).
struct UsageBarsView: View {
    @Environment(AppContainer.self) private var container
    @Environment(LayoutStore.self) private var layout
    @Environment(WidgetDataStore.self) private var dataStore
    @AppStorage(BarMetricSetting.key) private var barMetric = BarMetricSetting.tightest
    @AppStorage(TotalSpendSetting.key) private var showTotalSpend = true
    let reorderSpaceName: String
    @Binding var reorderLift: ReorderLift?
    /// The provider whose full card is open under its bar.
    @State private var expanded: String?
    /// A card opening or folding with the panel: until the panel's done moving, the cards show
    /// only as much as the window has room for yet.
    @State private var fold: Fold?
    /// How tall each card is, all of it shown.
    @State private var detailHeights: [String: CGFloat] = [:]
    @Environment(\.panelHeightChange) private var panelHeightChange
    @Environment(\.popoverIsVisible) private var popoverIsVisible

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if showTotalSpend, layout.hasSpendCapableProvider {
                SpendBar()
                    .padding(.bottom, 4)
            }
            ForEach(layout.displayGroups) { group in
                VStack(alignment: .leading, spacing: 0) {
                    ProviderBar(
                        provider: group.provider,
                        reading: reading(for: group),
                        notice: dataStore.headerNotice(for: group.provider.id),
                        isExpanded: expanded == group.id
                    )
                    .onTapGesture { toggle(group.id) }
                    .contextMenu { menu(for: group) }
                    if expanded == group.id || fold?.closing == group.id {
                        // As tall as the panel has made room for, laid out with the window's own
                        // height, so the bars below never run under the footer or past the
                        // window's edge, however the window keeps up; cut at its bottom edge. The
                        // space above it folds with it.
                        detail(group)
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured(group.id, $0) }
                            .containerRelativeFrame(.vertical, alignment: .top) { length, _ in shown(group.id, in: length) }
                            .clipped()
                            .transition(.fold)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.spring, value: layout.displayGroups.map(\.provider.id))
        // A fold the panel closed on is over: the card is open or not, as it was going.
        .onChange(of: popoverIsVisible) { _, isVisible in
            if !isVisible { fold = nil }
        }
        // Nor one whose bar went, or the panel moving to another page.
        .onChange(of: layout.displayGroups.map(\.id)) { _, ids in
            if let fold, ![fold.opening, fold.closing].compactMap({ $0 }).allSatisfy(ids.contains) { self.fold = nil }
        }
        .onChange(of: layout.screen) { fold = nil }
        #if DEBUG
        .task(id: popoverIsVisible) {
            // KUVO_DEMO_FOLDS=<seconds>: the first bar's detail opens and folds eight times, to
            // watch the fold with no one clicking, once the panel shows.
            guard popoverIsVisible, let wait = ProcessInfo.processInfo.environment["KUVO_DEMO_FOLDS"].flatMap(Double.init) else { return }
            for _ in 0..<8 {
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled else { return }
                guard let first = layout.displayGroups.first?.id else { continue }
                toggle(first)
            }
        }
        #endif
    }

    private func detail(_ group: ProviderGroup) -> some View {
        ProviderBarDetail(group: group)
            .padding(.vertical, 4)
    }

    /// A card opening (`opening`), folding (`closing`), or one for the other, with the panel; once
    /// the panel's moving, how tall each is and `base`, the height of everything in the panel's
    /// scroll view but them.
    private struct Fold {
        var opening: String?
        var closing: String?
        var openingHeight: CGFloat = 0
        var closingHeight: CGFloat = 0
        var base: CGFloat?
    }

    /// Opens a provider's card, or folds it, with the panel. A card that opens is laid out first
    /// with no room, to learn how tall it is; then the panel grows by as much.
    private func toggle(_ id: String) {
        guard fold == nil else { return }
        if expanded == id {
            fold = Fold(closing: id)
            expanded = nil
            move()
        } else {
            fold = Fold(opening: id, closing: expanded)
            expanded = id
            if detailHeights[id] != nil { move() }
        }
    }

    private func measured(_ id: String, _ height: CGFloat) {
        let isNew = detailHeights[id] == nil
        detailHeights[id] = height
        if isNew, fold?.opening == id, fold?.base == nil { move() }
    }

    /// Moves the panel by the fold, or, where it can't move by as much (at its tallest), folds the
    /// card on its own.
    private func move() {
        guard var fold else { return }
        fold.openingHeight = fold.opening.flatMap { detailHeights[$0] } ?? 0
        fold.closingHeight = fold.closing.flatMap { detailHeights[$0] } ?? 0
        if let base = panelHeightChange(opening: fold.openingHeight, closing: fold.closingHeight, done: { self.fold = nil }) {
            fold.base = base
            self.fold = fold
        } else {
            withAnimation(Motion.spring) { self.fold = nil }
        }
    }

    /// How much of a card shows, in a scroll view `length` tall.
    private func shown(_ id: String, in length: CGFloat) -> CGFloat {
        let natural = detailHeights[id] ?? 0
        guard let fold else { return natural }
        guard let base = fold.base else { return fold.opening == id ? 0 : natural }
        let room = max(0, length - base)
        let opening = fold.openingHeight, closing = fold.closingHeight
        if fold.opening != nil, fold.closing != nil, opening != closing {
            // One opens as the other folds: shared out as far along as the panel is.
            let along = min(1, max(0, (room - closing) / (opening - closing)))
            return id == fold.opening ? along * opening : (1 - along) * closing
        }
        return min(id == fold.opening ? opening : closing, room)
    }

    /// The limit the bar shows, or the provider's first reading of any kind when it has no
    /// limits (a balance, say).
    private func reading(for group: ProviderGroup) -> WidgetData? {
        let rows = group.widgets.compactMap(layout.descriptor(for:)).map(dataStore.data(for:)).filter { $0.hasData && !$0.isChart }
        let meters = rows.filter(\.isBounded)
        switch barMetric {
        case .first:
            return meters.first ?? rows.first
        case .tightest:
            return meters.min { $0.remainingFraction < $1.remainingFraction } ?? rows.first
        }
    }

    @ViewBuilder
    private func menu(for group: ProviderGroup) -> some View {
        Button("Hide \(group.provider.displayName)") {
            container.enablement.setEnabled(false, for: group.provider.id)
        }
        Divider()
        Button("Refresh \(group.provider.displayName)") {
            Task { await dataStore.refreshOnUserRequest(providerID: group.provider.id) }
        }
        Button("Customize…") {
            withAnimation(Motion.modeSwitch) {
                layout.customizeProviderID = group.provider.id
                layout.isEditing = true
            }
        }
    }
}

/// One provider as a bar: a flat pastel fill on a quiet track, the mark and name, the number at
/// the end, in the system's own type. Text that crosses the fill's edge changes color with it, so
/// it reads on both sides. Its corners are the panel's less the space around it.
struct ProviderBar: View {
    let provider: Provider
    let reading: WidgetData?
    let notice: String?
    let isExpanded: Bool
    @State private var isHovering = false
    @Environment(\.self) private var environment
    @Environment(\.colorScheme) private var scheme

    static let height: CGFloat = 30
    /// The space between the panel's edges and the bars, and their corners: together the panel's
    /// own corners (`StatusItemController.cornerRadius`), so the bars sit concentric in it, as a
    /// menu's items do.
    static let inset: CGFloat = 6
    static let radius: CGFloat = 7

    private var fill: Color { BarPalette.pastel(provider.id, scheme: scheme) }

    private var fraction: Double {
        guard let reading, reading.isBounded else { return 0 }
        return reading.fraction
    }

    private var value: String {
        guard let reading else { return WidgetData.noDataHeadline }
        guard reading.isBounded else { return reading.menuBarValue }
        // Like every other percentage here, "89%" in any region (Turkey's pattern reads "%89").
        if reading.kind == .percent {
            return MetricFormatter.number(fraction * 100, kind: .percent, style: .row)
        }
        return reading.menuBarValue
    }

    private var help: String {
        var lines = [provider.displayName]
        if let reading {
            lines.append("\(reading.title): \(reading.isBounded ? reading.boundedHeadline : reading.valueText)")
            if let subtitle = reading.boundedSubtitle { lines.append(subtitle) }
        } else {
            lines.append("No data yet")
        }
        if let notice { lines.append(notice) }
        lines.append(isExpanded ? "Click to close" : "Click for every limit")
        return lines.joined(separator: "\n")
    }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width * fraction
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.primary.opacity(isHovering || isExpanded ? 0.09 : 0.055))
                Rectangle().fill(fill).frame(width: width)
                label(color: BarInk(fill.resolve(in: environment)).text)
                    .mask(alignment: .leading) { Rectangle().frame(width: width) }
                label(color: .primary)
                    .mask(alignment: .leading) {
                        HStack(spacing: 0) {
                            Color.clear.frame(width: width)
                            Rectangle()
                        }
                    }
            }
        }
        .frame(height: Self.height)
        .clipShape(.rect(cornerRadius: Self.radius))
        .contentShape(.rect(cornerRadius: Self.radius))
        .onHover { isHovering = $0 }
        .help(help)
        .animation(Motion.spring, value: fraction)
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private func label(color: Color) -> some View {
        HStack(spacing: 8) {
            Group {
                if let mark = ProviderMarks.mark(for: provider.id) {
                    ProviderIconShape(mark: mark, inset: 0.04).fill(color)
                } else {
                    Image(systemName: ProviderMarks.symbolFallback(for: provider.id))
                        .resizable()
                        .scaledToFit()
                        .foregroundStyle(color)
                }
            }
            .frame(width: 14, height: 14)
            Text(provider.displayName)
                .fontWeight(.medium)
                .lineLimit(1)
            Spacer(minLength: 6)
            if notice != nil {
                Image(systemName: "exclamationmark.triangle")
                    .font(.callout)
            }
            // The number stays whole; a long name gives way.
            Text(value)
                .monospacedDigit()
                .lineLimit(1)
                .layoutPriority(1)
        }
        .font(.body)
        .foregroundStyle(color)
        // The words start where the footer's do.
        .padding(.horizontal, 8)
        .frame(maxHeight: .infinity)
    }
}

/// The Bars style's look: soft pastels of each provider's brand color, flat, with the system's
/// own type at its text styles and numbers in lining digits, as Kuvo Code for iPhone shows them.
enum BarPalette {
    /// The brand color, mostly white: pastel in light mode, a touch deeper in dark mode so
    /// it doesn't glare. Brands without a hue (black or white marks, like Cursor's) get a
    /// soft gray instead, which sits with the pastels in either mode.
    static func pastel(_ providerID: String, scheme: ColorScheme) -> Color {
        let brand = TotalSpendPalette.color(for: providerID)
        var environment = EnvironmentValues()
        environment.colorScheme = scheme
        let resolved = brand.resolve(in: environment)
        let channels = [resolved.red, resolved.green, resolved.blue]
        if (channels.max() ?? 0) - (channels.min() ?? 0) < 0.08 {
            return Color(white: scheme == .dark ? 0.6 : 0.82)
        }
        return brand.mix(with: .white, by: scheme == .dark ? 0.42 : 0.58)
    }
}

/// What the providers cost over a period, as one bar: the total, and each provider's share as
/// a strip of its color along the bottom. Clicking steps through Today, Yesterday and the last
/// 30 days.
private struct SpendBar: View {
    @Environment(LayoutStore.self) private var layout
    @Environment(WidgetDataStore.self) private var dataStore
    @AppStorage(TotalSpendSetting.periodKey) private var periodRawValue = TotalSpendPeriod.today.rawValue

    private var period: TotalSpendPeriod { TotalSpendPeriod(rawValue: periodRawValue) ?? .today }

    private var projection: TotalSpendProjection {
        TotalSpendAggregator.total(for: period, providers: layout.spendCapableProviders, snapshots: dataStore.snapshots)
            .projection(for: .cost)
    }

    var body: some View {
        SpendBarBody(period: period, projection: projection)
            .onTapGesture {
                let all = TotalSpendPeriod.allCases
                let next = all[((all.firstIndex(of: period) ?? 0) + 1) % all.count]
                withAnimation(Motion.spring) { periodRawValue = next.rawValue }
            }
    }
}

/// The spend bar's drawing, apart from where its numbers come from.
struct SpendBarBody: View {
    let period: TotalSpendPeriod
    let projection: TotalSpendProjection
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(period.rawValue)
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 6)
                Text((projection.isEstimated ? "~" : "") + MetricFormatter.number(projection.centerValue, kind: .dollars, style: .full))
                    .monospacedDigit()
            }
            .font(.body)
            .padding(.horizontal, 8)
            .frame(maxHeight: .infinity)
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    ForEach(projection.slices) { slice in
                        Rectangle()
                            .fill(BarPalette.pastel(slice.provider.id, scheme: scheme))
                            .frame(width: projection.centerValue > 0 ? proxy.size.width * slice.displayAmount / projection.centerValue : 0)
                    }
                }
            }
            .frame(height: 3)
        }
        .frame(height: ProviderBar.height)
        .background(Color.primary.opacity(0.055))
        .clipShape(.rect(cornerRadius: ProviderBar.radius))
        .contentShape(.rect(cornerRadius: ProviderBar.radius))
        .help(help)
    }

    private var help: String {
        let lines = projection.slices.map { "\($0.provider.displayName): \(MetricFormatter.number($0.displayAmount, kind: .dollars, style: .full))" }
        return ([period.rawValue] + (lines.isEmpty ? ["Nothing spent"] : lines) + ["Click for another period"]).joined(separator: "\n")
    }
}

/// The text on a pastel fill: dark, unless a fill turns out deep enough to need white.
private struct BarInk {
    let luminance: Float

    init(_ color: Color.Resolved) {
        luminance = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue
    }

    var text: Color { luminance > 0.45 ? Color(white: 0.16) : .white }
}
