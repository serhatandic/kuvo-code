import OpenCodeKit
import SwiftUI

/// What works on this Mac while Kuvo Code's window is closed, at the foot of the usage item's panel
/// (`InBackground`): the sessions working, and the next wake-up, with Open Kuvo Code and Stop. The
/// first time, it starts with a note that the work goes on.
struct BackgroundWorkCard: View {
    let app: AppModel
    @State private var stopping = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !InBackground.shared.noteSeen { note }
            work
            HStack(spacing: 6) {
                Button { InBackground.shared.leave() } label: {
                    Text("Open Kuvo Code").frame(maxWidth: .infinity)
                }
                Button {
                    stopping = true
                    Task {
                        await InBackground.shared.stop(app)
                        stopping = false
                    }
                } label: {
                    Text("Stop…").frame(maxWidth: .infinity)
                }
                .disabled(stopping)
                .help("Stop Background Work (⌥⌘Q): the work stops until you open Kuvo Code or log in again")
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
        }
        .font(.caption)
        .accessibilityElement(children: .contain)
    }

    private var note: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Kuvo Code keeps working").fontWeight(.semibold)
            Text("Your bots, goals and wake-ups go on with the window closed, and this item shows them. To stop them, choose Stop.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("OK") { InBackground.shared.noteSeen = true }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var work: some View {
        let working = app.workspace.runningHere.map { app.workspace.session($0)?.title ?? "New Session" }
        let next = nextWakeUp
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Circle()
                    .fill(working.isEmpty ? Color.clear : Color.green)
                    .overlay(Circle().strokeBorder(working.isEmpty ? Color.secondary : Color.clear, lineWidth: 1.3))
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                Text(working.isEmpty ? "Waiting in the background" : "Working in the background").fontWeight(.semibold)
            }
            .accessibilityElement(children: .combine)
            ForEach(Array(working.prefix(3).enumerated()), id: \.offset) { _, title in
                line(title)
            }
            if working.count > 3 { line("and \(working.count - 3) more") }
            if let next { line(next) }
            if working.isEmpty, next == nil { line("Nothing is working now. Messages and new work start it again.") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.leading, 14)
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
