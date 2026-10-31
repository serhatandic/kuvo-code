import OpenCodeKit
import SwiftUI
import UsageKit

/// What works on this Mac while Kuvo Code's window is closed, at the foot of the usage item's panel
/// (`InBackground`): the sessions working, and the next wake-up, with Open Kuvo Code and Stop. The
/// first time, a note above it says the work goes on. Drawn as the panel draws its own cards: its
/// card surface, a hint card's type, buttons on glass capsules like the footer's Options.
struct BackgroundWorkCard: View {
    let app: AppModel
    @State private var stopping = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !InBackground.shared.noteSeen { note }
            work
        }
        .accessibilityElement(children: .contain)
    }

    /// Once: what Quit did. As the panel's own hint cards (`DismissableHintCard`), with ✕.
    private var note: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "menubar.arrow.up.rectangle")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Kuvo Code keeps working")
                    .font(.subheadline.weight(.semibold))
                Text("Your bots, goals and wake-ups go on with the window closed, and show here. To stop them, choose Stop.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button { InBackground.shared.noteSeen = true } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .panelCardSurface()
    }

    private var work: some View {
        let working = app.workspace.runningHere.map { app.workspace.session($0)?.title ?? "New Session" }
        let next = nextWakeUp
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Circle()
                        .fill(working.isEmpty ? Color.clear : Color.green)
                        .overlay(Circle().strokeBorder(working.isEmpty ? Color.secondary : Color.clear, lineWidth: 1.3))
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Text(working.isEmpty ? "Waiting in the background" : "Working in the background")
                        .font(.subheadline.weight(.semibold))
                }
                Group {
                    ForEach(Array(working.prefix(3).enumerated()), id: \.offset) { _, title in
                        line(title)
                    }
                    if working.count > 3 { line("and \(working.count - 3) more") }
                    // After an update, until the work moves to it.
                    if app.keeperMakesWay, !working.isEmpty { line("Updates once this is done") }
                    if let next { line(next) }
                    if working.isEmpty, next == nil {
                        Text("Nothing is running. A message or a wake-up starts the work again.")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.caption)
                .padding(.leading, 14)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            HStack(spacing: 8) {
                Button { InBackground.shared.leave() } label: {
                    Text("Open Kuvo Code").frame(maxWidth: .infinity)
                }
                .panelGlassButton()
                Button {
                    stopping = true
                    Task {
                        await InBackground.shared.stop(app)
                        stopping = false
                    }
                } label: {
                    Text("Stop…").frame(maxWidth: .infinity)
                }
                .panelGlassButton()
                .disabled(stopping)
                .opacity(stopping ? 0.5 : 1)
                .accessibilityLabel("Stop Background Work")
                .help("Stop the work in the background, and quit Kuvo Code. It starts again when you open Kuvo Code or log in.")
            }
        }
        .padding(12)
        .panelCardSurface()
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    /// The next wake-up due on this Mac, as "Scout wakes at 07:00".
    private var nextWakeUp: String? {
        let soonest = app.wakeUps.wakes.flatMap { key, wakes in wakes.map { (key, $0.due) } }
            .filter { $0.1 > .now }
            .min { $0.1 < $1.1 }
        guard let (key, due) = soonest else { return nil }
        let name = app.bots.bot(key)?.name ?? app.workspace.session(key)?.title ?? "A conversation"
        let time = Calendar.current.isDateInToday(due) ? due.formatted(date: .omitted, time: .shortened) : due.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        return "\(name) wakes at \(time)"
    }
}
