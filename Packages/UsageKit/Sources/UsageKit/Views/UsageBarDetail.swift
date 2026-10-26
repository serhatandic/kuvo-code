import AppKit
import SwiftUI

/// Fork addition: what a bar in the Bars style opens into. The provider's plan, every one of its
/// metrics and its links, drawn like the bars themselves: the system's type, the provider's pastel
/// on a quiet track, no cards. Values and reset times flip between used/left and
/// countdown/exact on a click, as they do in the cards; spend and trend rows reveal the same
/// breakdowns on hover.
struct ProviderBarDetail: View {
    let group: ProviderGroup
    @Environment(LayoutStore.self) private var layout
    @Environment(WidgetDataStore.self) private var dataStore
    @Environment(\.resetClaims) private var resetClaims

    var body: some View {
        let providerID = group.provider.id
        BarDetailContent(
            provider: group.provider,
            plan: dataStore.plan(for: providerID),
            notice: dataStore.headerNotice(for: providerID),
            staleness: dataStore.stalenessHint(for: providerID),
            rows: (group.alwaysShownWidgets + group.expandedWidgets).compactMap(layout.descriptor(for:)).map(dataStore.data(for:)),
            links: group.provider.visibleLinks,
            refresh: { Task { await dataStore.refreshOnUserRequest(providerID: providerID) } },
            customize: {
                withAnimation(Motion.modeSwitch) {
                    layout.customizeProviderID = providerID
                    layout.isEditing = true
                }
            },
            toggleMeterStyle: { dataStore.meterStyle.toggle() },
            toggleResetDisplay: { dataStore.resetDisplayMode.toggle() }
        )
        .environment(\.resetClaim, resetClaims[providerID])
    }
}

/// The detail's drawing, apart from the stores it reads.
struct BarDetailContent: View {
    let provider: Provider
    let plan: String?
    let notice: String?
    let staleness: StalenessHint?
    let rows: [WidgetData]
    var links: [ProviderLink] = []
    var refresh: (() -> Void)?
    var customize: (() -> Void)?
    var toggleMeterStyle: (() -> Void)?
    var toggleResetDisplay: (() -> Void)?
    @Environment(\.colorScheme) private var scheme

    private var tint: Color { BarPalette.pastel(provider.id, scheme: scheme) }

    /// Rows in runs: amounts without a limit (Today, Yesterday, Last 30 Days) sit close together,
    /// and each limit stands apart.
    private var runs: [[WidgetData]] {
        var runs: [[WidgetData]] = []
        for data in rows {
            let isAmount = !data.isBounded && !(data.isChart && data.hasData)
            if isAmount, let last = runs.last?.last, !last.isBounded, !(last.isChart && last.hasData) {
                runs[runs.count - 1].append(data)
            } else {
                runs.append([data])
            }
        }
        return runs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            if plan != nil || staleness != nil {
                HStack(alignment: .firstTextBaseline) {
                    if let plan {
                        BarDetailText(plan, style: .label)
                    }
                    Spacer(minLength: 8)
                    if let staleness {
                        BarDetailText(staleness.label, style: .note, color: AnyShapeStyle(.orange))
                            .hoverTooltip(staleness.tooltip)
                    }
                }
            }
            if let notice {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(notice)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.subheadline)
                .foregroundStyle(.orange)
            }
            ForEach(Array(runs.enumerated()), id: \.offset) { _, run in
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(run.enumerated()), id: \.offset) { _, data in
                        if data.isChart, data.hasData {
                            BarTrendRow(data: data, tint: tint)
                        } else if data.isBounded {
                            BarMeterRow(data: data, tint: tint, toggleMeterStyle: toggleMeterStyle, toggleResetDisplay: toggleResetDisplay)
                        } else {
                            BarValueRow(data: data)
                        }
                    }
                }
            }
            footer
        }
        // The words start where the bar's do.
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(scheme == .dark ? 0.08 : 0.2), in: .rect(cornerRadius: ProviderBar.radius))
    }

    /// The provider's own pages, and refreshing or customizing it.
    @ViewBuilder
    private var footer: some View {
        if !links.isEmpty || refresh != nil || customize != nil {
            HStack(spacing: 12) {
                ForEach(links, id: \.self) { link in
                    Button {
                        if let url = URL(string: link.url) { NSWorkspace.shared.open(url) }
                    } label: {
                        HStack(spacing: 2) {
                            BarDetailText(link.label, style: .note)
                            Image(systemName: "arrow.up.right")
                                .font(.caption2)
                        }
                    }
                    .buttonStyle(BarDetailButtonStyle())
                    .accessibilityLabel("\(link.label), opens in browser")
                }
                Spacer(minLength: 8)
                if let refresh {
                    Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(BarDetailButtonStyle())
                        .hoverTooltip("Refresh \(provider.displayName)")
                }
                if let customize {
                    Button(action: customize) { Image(systemName: "slider.horizontal.3") }
                        .buttonStyle(BarDetailButtonStyle())
                        .hoverTooltip("Customize \(provider.displayName)")
                }
            }
            .font(.subheadline)
            .padding(.top, 1)
        }
    }
}

/// A limit: its name and reading, a slim bar in the provider's pastel with the even-pace tick,
/// and when it resets, or a warning when it's running out.
private struct BarMeterRow: View {
    let data: WidgetData
    let tint: Color
    var toggleMeterStyle: (() -> Void)?
    var toggleResetDisplay: (() -> Void)?

    var body: some View {
        // The reset countdown and the pace follow the clock; refresh them while the panel shows.
        if data.resetsAt != nil {
            TimelineView(.periodic(from: .now, by: 30)) { _ in content }
        } else {
            content
        }
    }

    private var content: some View {
        let state = data.meterState()
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                BarDetailText(data.title, style: .label)
                Spacer(minLength: 8)
                toggle(data.hasMeterStyleToggle ? toggleMeterStyle : nil, tooltip: data.meterStyleTooltip) {
                    BarDetailText(data.headline, style: .value)
                        .contentTransition(.numericText())
                }
            }
            BarDetailMeter(fraction: data.hasData ? data.fraction : 0, tick: data.paceTick(for: state), tint: tint)
                .hoverTooltip(state.tooltip)
            if data.boundedTrailingText() != nil || warning(state) != nil {
                HStack(alignment: .firstTextBaseline) {
                    if let reset = data.boundedTrailingText() {
                        toggle(data.hasResetLabel() ? toggleResetDisplay : nil, tooltip: data.resetTooltip()) {
                            BarDetailText(reset, style: .note)
                        }
                    }
                    Spacer(minLength: 8)
                    if let (text, severity) = warning(state) {
                        BarDetailText(text, style: .note, color: severity.map { $0 == .critical ? AnyShapeStyle(.red) : AnyShapeStyle(.orange) } ?? AnyShapeStyle(.secondary))
                            .hoverTooltip(state.tooltip)
                    }
                }
            }
        }
    }

    /// What the cards say beside the title as a limit nears: reached, running out (when), or the
    /// cushion left at reset; and the projection when Always Show Pacing is on.
    private func warning(_ state: WidgetData.MeterState) -> (String, WidgetData.MeterSeverity?)? {
        switch state {
        case .spent: ("Limit reached", .critical)
        case .runningOut(let eta, _): (eta ?? "Will reach limit", .critical)
        case .closeToLimit(let spare, _): (spare, .warning)
        case .healthy where data.alwaysShowPacing: state.tooltip.map { ($0, nil) }
        default: nil
        }
    }

    @ViewBuilder
    private func toggle(_ action: (() -> Void)?, tooltip: String?, @ViewBuilder label: () -> some View) -> some View {
        if let action {
            Button(action: action, label: label)
                .buttonStyle(.plain)
                .hoverTooltip(tooltip)
        } else {
            label().hoverTooltip(tooltip)
        }
    }
}

/// An amount without a limit: spend over a period, a balance, credits. Spend rows show which
/// models it went to on hover, and Codex's and Claude's resets their timeline, as in the cards.
private struct BarValueRow: View {
    let data: WidgetData
    @Environment(\.reduceAnimations) private var reduceAnimations
    @Environment(\.resetClaim) private var resetClaim
    @State private var hover = HoverPopoverState()

    private var hasPopover: Bool {
        data.hasModelBreakdown || (data.showsResetExpiries && data.hasData)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            BarDetailText(data.title, style: .label)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                if let severity = data.expirySeverity() {
                    Circle().fill(Theme.meterFill(severity)).frame(width: 5, height: 5)
                }
                BarDetailText(data.unboundedDetail, style: .value)
                    .contentTransition(.numericText())
            }
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(.quaternary)
                    .padding(.horizontal, -5)
                    .padding(.vertical, -3)
                    .opacity(hasPopover && (hover.overInline || hover.isPresented) ? 1 : 0)
            }
            .contentShape(Rectangle())
            .hoverTooltip(hasPopover ? nil : data.unboundedValueTooltip ?? data.unboundedSubtitle)
            .onContinuousHover { phase in
                guard hasPopover else { return hover.dismiss() }
                if case .active = phase { hover.inlineHover(true) } else { hover.inlineHover(false) }
            }
            .motionAwareHoverPopover(
                isPresented: Binding(get: { hasPopover && hover.isPresented }, set: { if !$0 { hover.dismiss() } }),
                reduceAnimations: reduceAnimations
            ) {
                if let breakdown = data.modelBreakdown {
                    ModelUsageDetail(title: data.title, breakdown: breakdown) { hover.detailHover($0) }
                } else if data.showsResetExpiries {
                    RateLimitResetsDetail(
                        count: data.resetCreditCount, expiries: data.expiriesAt,
                        onHoverChange: { hover.detailHover($0) },
                        onPinChange: { hover.setPinned($0) },
                        claim: resetClaim.flatMap { service in
                            service.isClaimable ? { expiry, request in
                                await service.claim(creditExpiringAt: expiry, redeemRequestID: request)
                            } : nil
                        },
                        confirmDetail: resetClaim?.confirmDetail
                    )
                }
            }
        }
        .onDisappear { hover.dismiss() }
    }
}

/// The usage trend: day by day, in the provider's pastel; hovering shows the full chart.
private struct BarTrendRow: View {
    let data: WidgetData
    let tint: Color
    @Environment(\.reduceAnimations) private var reduceAnimations
    @State private var hover = HoverPopoverState()

    var body: some View {
        let points = data.chartPoints
        let peak = max(1, points.map(\.value).max() ?? 1)
        HStack(alignment: .bottom) {
            BarDetailText(data.title, style: .label)
            Spacer(minLength: 8)
            HStack(alignment: .bottom, spacing: 1.5) {
                ForEach(points, id: \.label) { point in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(tint)
                        .frame(minWidth: 2, maxWidth: .infinity)
                        .frame(height: point.value > 0 ? max(3, 18 * min(1, point.value / peak)) : 1.5)
                }
            }
            .frame(maxWidth: 150)
            .frame(height: 18, alignment: .bottom)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                if case .active = phase { hover.inlineHover(true) } else { hover.inlineHover(false) }
            }
            .motionAwareHoverPopover(
                isPresented: Binding(get: { hover.isPresented }, set: { if !$0 { hover.dismiss() } }),
                reduceAnimations: reduceAnimations
            ) {
                UsageTrendDetail(title: data.title, points: points, note: data.chartNote) { hover.detailHover($0) }
            }
        }
        .onDisappear { hover.dismiss() }
    }
}

/// A slim bar: the share in the provider's pastel on a quiet track, and a tick where even use
/// over the period would be.
private struct BarDetailMeter: View {
    let fraction: Double
    let tick: Double?
    let tint: Color

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(tint)
                    .frame(width: fraction > 0 ? max(5, proxy.size.width * fraction) : 0)
            }
            .overlay(alignment: .leading) {
                if let tick {
                    RoundedRectangle(cornerRadius: 0.75)
                        .fill(Color.primary.opacity(0.5))
                        .frame(width: 1.5, height: 9)
                        .offset(x: min(max(proxy.size.width * tick - 0.75, 0), proxy.size.width - 1.5))
                }
            }
        }
        .frame(height: 5)
        .animation(Motion.spring, value: fraction)
        .accessibilityHidden(true)
    }
}

/// The detail's type: names and small print in the secondary shade, readings in lining digits.
private struct BarDetailText: View {
    enum Style { case label, value, note }

    let text: String
    let style: Style
    /// In place of the style's own shade, for a warning.
    var color: AnyShapeStyle?

    init(_ text: String, style: Style, color: AnyShapeStyle? = nil) {
        self.text = text
        self.style = style
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(style == .note ? .subheadline : .callout)
            .monospacedDigit()
            .foregroundStyle(color ?? (style == .value ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)))
            .lineLimit(1)
    }
}

/// Quiet text and icon buttons that brighten under the pointer.
private struct BarDetailButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        BarDetailButton(configuration: configuration)
    }

    private struct BarDetailButton: View {
        let configuration: Configuration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(isHovering ? .primary : .secondary)
                .opacity(configuration.isPressed ? 0.6 : 1)
                .contentShape(Rectangle())
                .onHover { isHovering = $0 }
        }
    }
}
