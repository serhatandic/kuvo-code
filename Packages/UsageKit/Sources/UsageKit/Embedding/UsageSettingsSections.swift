import AppKit
import KeyboardShortcuts
import SwiftUI
import UserNotifications

/// The usage panel's settings as sections of the host's own Settings page, so they live there:
/// the same stored settings as the panel's Settings screen, in the host's controls. (Fork
/// addition.) Theme and Launch at Login are left to the host's own Appearance and General.
public struct UsageSettingsSections: View {
    /// Under the last section (the host's credit line).
    let footer: Text?

    public init(footer: Text? = nil) { self.footer = footer }

    public var body: some View {
        if let container = UsageMenuBar.shared.container {
            Sections(container: container, footer: footer)
        } else {
            Section {
                if UsageMenuBar.shared.isRunning {
                    LabeledContent("Loading the usage settings…") { ProgressView().controlSize(.small) }
                } else {
                    Text("These show once the usage item is in the menu bar.")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                footer?.foregroundStyle(.secondary)
            }
        }
    }

    private struct Sections: View {
        let container: AppContainer
        let footer: Text?
        @AppStorage(TotalSpendSetting.key) private var showTotalSpend = true
        @AppStorage(DashboardStyle.key) private var dashboardStyle = DashboardStyle.bars
        @AppStorage(BarMetricSetting.key) private var barMetric = BarMetricSetting.tightest
        @AppStorage(DensitySetting.key) private var density = DensitySetting.regular
        @AppStorage(TimeFormatSetting.key) private var timeFormat = TimeFormatSetting.auto
        @AppStorage(ReduceAnimationsSetting.key) private var reduceAnimations = ReduceAnimationsSetting.fallback
        @AppStorage(LogLevelSetting.key) private var logLevel = LogLevelSetting.fallback
        @State private var confirmsReset = false
        /// The field reads the shortcut only when it appears: a reset gives it a new one.
        @State private var shortcutGeneration = 0
        /// macOS's say on the panel's alerts, while one of them is on.
        @State private var alerts = AlertsPermission.allowed
        private enum AlertsPermission { case allowed, denied, undecided }

        var body: some View {
            @Bindable var layout = container.layout
            @Bindable var store = container.dataStore
            @Bindable var notifications = container.notificationSettings
            @Bindable var privacy = container.privacy
            @Bindable var transparency = container.transparency

            Section {
                Picker("Menu bar shows", selection: $layout.menuBarStyle) {
                    ForEach(MenuBarStyle.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Providers as", selection: $dashboardStyle) {
                    ForEach(DashboardStyle.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                if dashboardStyle == .bars {
                    Picker("Each bar shows", selection: $barMetric) {
                        ForEach(BarMetricSetting.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                }
                Toggle("Show spend", isOn: $showTotalSpend)
                Picker("Density", selection: $density) {
                    ForEach(DensitySetting.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Toggle("Increase transparency", isOn: $transparency.increaseTransparency)
                    .disabled(transparency.secretCodeActive)
                Toggle("Reduce animations", isOn: $reduceAnimations)
                LabeledContent("Shortcut to open") {
                    ShortcutRecorderField(name: .togglePopover)
                        .id(shortcutGeneration)
                }
            } header: {
                Text("Panel")
            }

            Section {
                Picker("Show usage as", selection: $store.meterStyle) {
                    ForEach(WidgetDisplayMode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Reset times", selection: $store.resetDisplayMode) {
                    ForEach(ResetDisplayMode.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Picker("Time format", selection: $timeFormat) {
                    ForEach(TimeFormatSetting.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Toggle(isOn: $store.alwaysShowPacing) {
                    Text("Always show pacing")
                    Text("On every limit, not only those near it.")
                }
            } header: {
                Text("Limits")
            }

            Section {
                milestone(.underTenPercent, isOn: $notifications.underTenPercent)
                milestone(.healthyToClose, isOn: $notifications.healthyToClose)
                milestone(.closeToRunningOut, isOn: $notifications.closeToRunningOut)
                if notifications.anyEnabled, alerts != .allowed {
                    LabeledContent {
                        if alerts == .denied {
                            Button("Open System Settings") { AppNotifications.shared.openSystemNotificationsSettings() }
                        } else {
                            Button("Allow…") {
                                AppNotifications.shared.requestAuthorization()
                                Task { await checkAlerts() }
                            }
                        }
                    } label: {
                        Label {
                            Text(alerts == .denied ? "Notifications are off for \(HostApp.name)" : "\(HostApp.name) needs your OK to send them")
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                    }
                }
            } header: {
                Text("Notifications")
            }
            .onChange(of: notifications.anyEnabled) { _, on in
                if on { AppNotifications.shared.requestAuthorization() }
                Task { await checkAlerts() }
            }
            .task { await checkAlerts() }
            // Back from System Settings.
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                Task { await checkAlerts() }
            }

            Section {
                Toggle(isOn: $privacy.hideUsageWhileScreenSharing) {
                    Text("Hide while sharing your screen")
                    Text("The menu bar shows “\(HostApp.name)” instead of your usage.")
                }
                Picker("Log detail", selection: $logLevel) {
                    ForEach(LogLevelSetting.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .onChange(of: logLevel) {
                    AppLog.reloadLevel()
                    AppLog.info(.config, "Log level changed to \(logLevel.rawValue)")
                }
                LabeledContent("Usage log") {
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([LogFile.url]) }
                }
                LabeledContent("Usage settings") {
                    Button("Reset…") { confirmsReset = true }
                }
                .alert("Reset the usage settings?", isPresented: $confirmsReset) {
                    Button("Reset", role: .destructive) {
                        withAnimation(Motion.spring) { container.resetAllSettings(keepsAppearance: true) }
                        shortcutGeneration += 1
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Every setting here and in Customize goes back to how it started, and providers for the tools you have are turned on again. Your other computers get the same cards, meters, spend and notification settings.")
                }
            } header: {
                Text("Privacy and Logs")
            } footer: {
                footer?.foregroundStyle(.secondary)
            }
        }

        private func checkAlerts() async {
            guard container.notificationSettings.anyEnabled else { return alerts = .allowed }
            switch await AppNotifications.shared.authorizationStatus() {
            case .denied: alerts = .denied
            case .notDetermined: alerts = .undecided
            default: alerts = .allowed
            }
        }

        private func milestone(_ milestone: PaceMilestone, isOn: Binding<Bool>) -> some View {
            Toggle(isOn: isOn) {
                Text(milestone.settingLabel)
                Text(milestone.tooltip)
            }
        }
    }
}
