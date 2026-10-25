import AppKit

/// Panels and alerts that wait for an answer (`runModal`), opened so the rest of the app keeps going.
///
/// A modal loop started inside a main-actor task holds up every other main-actor task until it
/// closes: the run loop doesn't drain the main queue while it's nested in one of the queue's own
/// blocks. So a save panel or an error alert shown after an `await` stopped every conversation,
/// bot and wake-up on this Mac until it was answered. Started from a run loop block, it doesn't.
enum Modal {
    /// What `body`, which runs a modal loop, returns, with the loop run outside the current task.
    static func run<T: Sendable>(_ body: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            later { continuation.resume(returning: body()) }
        }
    }

    /// An error's alert, shown without holding anything up.
    static func show(_ error: Error) {
        // The test copy shows no window: a modal alert there would hold the run up for good.
        if AppInfo.isHostingTests {
            print("Modal.show (not shown in the test copy): \(error.localizedDescription)")
            return
        }
        later { _ = NSAlert(error: error).runModal() }
    }

    /// Runs `body` on the run loop's next turn, outside the task or event running now: for a menu
    /// or panel opened from one, so whatever opened it (a click, VoiceOver's press) is done first.
    static func later(_ body: @escaping () -> Void) {
        let main = CFRunLoopGetMain()
        CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) {
            MainActor.assumeIsolated(body)
        }
        CFRunLoopWakeUp(main)
    }
}
