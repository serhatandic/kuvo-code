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

    /// Gone once background work is on: the keeper does at login what it opened Kuvo Code for,
    /// so Kuvo Code doesn’t open by itself as well.
    func retire() {
        guard SMAppService.mainApp.status == .enabled else { return }
        do {
            try SMAppService.mainApp.unregister()
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "login").error("Open at Login wasn't retired: \(error.localizedDescription, privacy: .public)")
        }
        refresh()
    }

    func set(_ on: Bool) {
        guard AppInfo.mayPrompt("Open at Login (macOS adds a login item and tells you)") else {
            failure = "This copy never asks macOS (KUVO_DEMO_NO_PROMPTS)."
            return
        }
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
