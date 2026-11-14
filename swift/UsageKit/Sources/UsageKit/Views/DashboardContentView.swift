import SwiftUI

/// The dashboard-only scrolling content. Screen switching, panel sizing, fixed bars, keyboard handling,
/// and close/reset behavior stay with `DashboardView`.
struct DashboardContentView: View {
    let container: AppContainer
    let layout: LayoutStore
    let reorderSpaceName: String
    let horizontalPadding: CGFloat
    let bottomGap: CGFloat

    @Binding var reorderLift: ReorderLift?
    @Binding var scrollPosition: ScrollPosition

    @AppStorage(DensitySetting.key) private var density = DensitySetting.regular
    @AppStorage(TotalSpendSetting.key) private var showTotalSpend = true
    @AppStorage(DashboardStyle.key) private var style = DashboardStyle.bars

    var body: some View {
        PopoverScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The one-time first-run hint sits above the provider sections (and above the
                // empty-state line, which a fresh install can hit while nothing has data yet).
                if container.onboarding.isCustomizeHintPending {
                    CustomizeHintCard()
                        // At the footer's inset, also over the bars, which sit closer to the edges.
                        .padding(.horizontal, showsBars ? horizontalPadding - ProviderBar.inset : 0)
                        .padding(.bottom, density.sectionSpacing)
                        .transition(.scale(scale: 0.95).combined(with: .opacity))
                }
                widgetContent
            }
            .animation(Motion.spring, value: container.onboarding.isCustomizeHintPending)
            // Bars sit close to the panel's edges, their corners concentric with its own.
            .padding(.horizontal, showsBars ? ProviderBar.inset : horizontalPadding)
            .padding(.top, showsBars ? ProviderBar.inset : density.contentTopPadding)
            .padding(.bottom, bottomGap)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($scrollPosition)
    }

    private var showsBars: Bool { style == .bars && (!layout.displayGroups.isEmpty || !HostLimits.shared.rows.isEmpty) }

    @ViewBuilder
    private var widgetContent: some View {
        if showsBars {
            UsageBarsView(reorderSpaceName: reorderSpaceName, reorderLift: $reorderLift)
        } else {
            cardContent
        }
    }

    @ViewBuilder
    private var cardContent: some View {
        // The cross-provider Total Spend ring stays visible whenever the user allows it and an enabled
        // provider can track spend, even before fresh data arrives or when every metric row is hidden.
        if showTotalSpend, layout.hasSpendCapableProvider {
            TotalSpendCard()
                .padding(.bottom, density.sectionSpacing)
        }
        if layout.displayGroups.isEmpty {
            EmptyDashboardView {
                withAnimation(Motion.modeSwitch) { layout.screen = .customize }
            }
        } else {
            WidgetGroupedListView(
                reorderSpaceName: reorderSpaceName,
                reorderLift: $reorderLift
            )
        }
    }
}
