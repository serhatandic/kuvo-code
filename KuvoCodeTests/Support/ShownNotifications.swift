@testable import KuvoCode

/// Notification Center as a test sees it: the notifications shown, by thread, as what the app
/// leaves there. Given to the app's `Notifier` while it lives; `done()` gives macOS's back.
@MainActor
final class ShownNotifications {
    private(set) var threads: [String]
    private let delivered = Notifier.shared.delivered
    private let removeDelivered = Notifier.shared.removeDelivered

    init(threads: [String]) {
        self.threads = threads
        Notifier.shared.delivered = { [weak self] in
            (self?.threads ?? []).enumerated().map { Notifier.Delivered(id: "n\($0.offset)-\($0.element)", thread: $0.element) }
        }
        Notifier.shared.removeDelivered = { [weak self] ids in
            guard let self else { return }
            self.threads = self.threads.enumerated().filter { !ids.contains("n\($0.offset)-\($0.element)") }.map(\.element)
            TestPulse.beat()
        }
    }

    func done() {
        Notifier.shared.delivered = delivered
        Notifier.shared.removeDelivered = removeDelivered
    }
}
