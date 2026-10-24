import Foundation
import OSLog
import ServiceManagement

/// Open at Login (Settings › General): Kuvo Code opens when you log in, in the background, without
/// its window, so this Mac's box (its engine, bots, sessions) is at work from then on. The same
/// login item as the usage item's Launch at Login: macOS keeps it, in System Settings › General ›
/// Login Items.
@MainActor @Observable
final class OpenAtLogin {
    /// One for Settings and a phone, so each sees what the other changed.
    static let shared = OpenAtLogin()

    private(set) var isOn = SMAppService.mainApp.status == .enabled
    /// Why it couldn't change, when macOS said no.
    private(set) var failure: String?

    /// As macOS has it now (changed in System Settings, say).
    func refresh() {
        isOn = SMAppService.mainApp.status == .enabled
    }

    func set(_ on: Bool) {
        AppInfo.neverInTests("Open at Login (macOS adds a login item and tells you)")
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            failure = nil
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "login").error("Open at Login didn't change: \(error.localizedDescription, privacy: .public)")
            failure = "macOS didn’t change it. Check System Settings › General › Login Items."
        }
        refresh()
    }
}
